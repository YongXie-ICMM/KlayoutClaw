/**
 * PlanManager — qdevbot-parity plan mode (v0.4.3).
 *
 * Ports `qdevbot/src/planning/manager.ts` (behavioral parity, spec §1.2).
 *
 * Divergence D1: enterPlanMode catches FS errors internally and returns null
 * (rather than throwing) so the tool wrapper can surface `{status:"error"}`.
 */

import * as fs from "fs";
import { join } from "path";
import type {
  Plan,
  PlanEvent,
  PlanEventListener,
  PlanTask,
} from "./types.js";

export class PlanManager {
  private _inPlanMode = false;
  private _currentPlan: Plan | null = null;
  private _plansDir: string;
  private _listeners: PlanEventListener[] = [];

  constructor(workspaceDir: string) {
    this._plansDir = join(workspaceDir, "plans");
  }

  // ---- getters -----------------------------------------------------------

  /** Whether the agent is currently in plan mode. */
  get inPlanMode(): boolean {
    return this._inPlanMode;
  }

  /** The current active plan, if any. */
  get currentPlan(): Plan | null {
    return this._currentPlan;
  }

  /** Directory where plan files are stored. */
  get plansDir(): string {
    return this._plansDir;
  }

  // ---- new API (qdevbot-parity) -----------------------------------------

  /**
   * Enter plan mode. Creates a new plan file on disk.
   * Returns the created plan, or null on FS failure (divergence D1).
   *
   * Plan-ID collision resolution: tries `plan-<ts>.md`, then `-1` through `-9`
   * if pre-existing. If all 10 slots collide → throw (spec §1.2; this throw is
   * INTENTIONALLY outside the D1 try/catch so the caller sees a hard error for
   * genuinely pathological scenarios).
   */
  enterPlanMode(task: string, title?: string): Plan | null {
    const baseId = `plan-${Date.now()}`;

    // Resolve a free planId — probe up to 10 suffix slots. Collision
    // exhaustion propagates as a thrown Error by design.
    let planId: string | null = null;
    let candidatePath: string | null = null;
    const primaryPath = join(this._plansDir, `${baseId}.md`);
    if (!fs.existsSync(primaryPath)) {
      planId = baseId;
      candidatePath = primaryPath;
    } else {
      for (let i = 1; i <= 9; i++) {
        const suffixed = `${baseId}-${i}`;
        const suffixedPath = join(this._plansDir, `${suffixed}.md`);
        if (!fs.existsSync(suffixedPath)) {
          planId = suffixed;
          candidatePath = suffixedPath;
          break;
        }
      }
    }
    if (planId === null || candidatePath === null) {
      throw new Error(
        `PlanManager.enterPlanMode: all 10 plan-id slots are occupied for base "${baseId}" — this should be unreachable outside pathological test scenarios.`,
      );
    }

    const planTitle = title || this._deriveTitle(task);

    const plan: Plan = {
      id: planId,
      title: planTitle,
      task,
      status: "active",
      tasks: [],
      filePath: candidatePath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const content = this._buildPlanFileContent(plan);

    // Divergence D1: wrap ONLY the mkdirSync + writeFileSync in try/catch so
    // genuine FS errors (EACCES, disk full) surface as null without mutating
    // state. The collision-exhaustion throw above MUST propagate — that path
    // is outside this try/catch by design.
    try {
      if (!fs.existsSync(this._plansDir)) {
        fs.mkdirSync(this._plansDir, { recursive: true });
      }
      fs.writeFileSync(candidatePath, content, "utf-8");
    } catch {
      // Swallow: no state mutation, no event emission, caller receives null.
      return null;
    }

    // Emit `plan_created` BEFORE `plan_mode_entered` so subscribers can
    // distinguish a first-time plan creation (here) from a re-entry of an
    // existing plan (handled by `reenterPlanMode`, which only emits
    // `plan_mode_entered` — matching qdevbot manager.ts:111).
    // Placed inside the D1 success path: on FS failure above, neither event
    // fires, preserving the "no partial mutation" invariant.
    this._emit({
      type: "plan_created",
      planId: plan.id,
      timestamp: Date.now(),
    });

    this._currentPlan = plan;
    this._inPlanMode = true;
    this._emit({
      type: "plan_mode_entered",
      planId: plan.id,
      timestamp: Date.now(),
    });

    return plan;
  }

  /**
   * Exit plan mode. Optionally marks the plan as approved or abandoned.
   * Returns null when not currently in plan mode or no current plan.
   */
  exitPlanMode(approved: boolean = true): Plan | null {
    if (!this._inPlanMode || !this._currentPlan) return null;

    const plan = this._currentPlan;
    plan.status = approved ? "approved" : "abandoned";
    plan.updatedAt = Date.now();

    this._writePlanFile(plan);

    this._inPlanMode = false;
    this._emit({
      type: "plan_mode_exited",
      planId: plan.id,
      timestamp: Date.now(),
    });

    return plan;
  }

  /**
   * Re-enter plan mode with the most recent plan (for revision).
   * Strips the `> Status: ...` marker from the on-disk file.
   */
  reenterPlanMode(): Plan | null {
    if (this._inPlanMode) return this._currentPlan;
    if (!this._currentPlan) return null;

    this._currentPlan.status = "active";
    this._currentPlan.updatedAt = Date.now();
    this._inPlanMode = true;

    this._writePlanFile(this._currentPlan);

    this._emit({
      type: "plan_mode_entered",
      planId: this._currentPlan.id,
      timestamp: Date.now(),
    });
    return this._currentPlan;
  }

  /** Update the current plan's tasks. No-op when no current plan. */
  updatePlanTasks(tasks: PlanTask[]): void {
    if (!this._currentPlan) return;
    this._currentPlan.tasks = tasks;
    this._currentPlan.updatedAt = Date.now();
    this._writePlanFile(this._currentPlan);
    this._emit({
      type: "plan_updated",
      planId: this._currentPlan.id,
      timestamp: Date.now(),
    });
  }

  /** Read the current plan file; null when no plan or file absent (D4). */
  readPlanFile(): string | null {
    if (!this._currentPlan) return null;
    if (!fs.existsSync(this._currentPlan.filePath)) return null;
    return fs.readFileSync(this._currentPlan.filePath, "utf-8");
  }

  /**
   * Write arbitrary content to the current plan file.
   * No-op when no current plan (D4 — caller must re-enter to recreate).
   */
  writePlanContent(content: string): void {
    if (!this._currentPlan) return;
    fs.writeFileSync(this._currentPlan.filePath, content, "utf-8");
    this._currentPlan.updatedAt = Date.now();
    this._emit({
      type: "plan_updated",
      planId: this._currentPlan.id,
      timestamp: Date.now(),
    });
  }

  /** Subscribe to plan events. Returns an unsubscribe function. */
  subscribe(listener: PlanEventListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  // ---- private helpers ---------------------------------------------------

  private _emit(event: PlanEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors so one misbehaving subscriber cannot break
        // the chain for the others.
      }
    }
  }

  private _deriveTitle(task: string): string {
    const firstSentence = task.split(/[.!?\n]/)[0].trim();
    if (firstSentence.length <= 60) return firstSentence;
    return firstSentence.slice(0, 57) + "...";
  }

  private _buildPlanFileContent(plan: Plan): string {
    const lines = [
      `# ${plan.title}`,
      "",
      "## Task",
      plan.task,
      "",
      "## Plan",
      "",
      "<!-- The agent will fill in the plan during plan mode -->",
      "",
      "## Tasks",
      "",
      "<!-- Checklist of implementation tasks -->",
      "",
    ];
    return lines.join("\n");
  }

  private _writePlanFile(plan: Plan): void {
    if (!fs.existsSync(plan.filePath)) {
      // File vanished — recreate from template.
      const content = this._buildPlanFileContent(plan);
      fs.writeFileSync(plan.filePath, content, "utf-8");
      return;
    }

    let content = fs.readFileSync(plan.filePath, "utf-8");

    if (plan.status !== "active") {
      const statusLine = `> Status: **${plan.status}**\n`;
      if (content.startsWith("> Status:")) {
        content = content.replace(/^> Status:.*\n/, statusLine);
      } else {
        content = statusLine + "\n" + content;
      }
      fs.writeFileSync(plan.filePath, content, "utf-8");
    } else if (content.startsWith("> Status:")) {
      // Re-entering active mode — strip the marker + optional blank line.
      content = content.replace(/^> Status:.*\n\n?/, "");
      fs.writeFileSync(plan.filePath, content, "utf-8");
    }
  }
}
