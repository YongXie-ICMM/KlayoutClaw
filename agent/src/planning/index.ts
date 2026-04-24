import * as fs from "fs";
import { join } from "path";
import { planSlugCache, slugCacheState } from "./slug-cache.js";
import type {
  Plan,
  PlanEvent,
  PlanEventListener,
  PlanStatus,
  PlanTask,
} from "./types.js";
import { generateWordSlug, MAX_SLUG_RETRIES } from "./word-slug.js";

export interface PlanEnterError {
  status: "error";
  message: string;
}

export type EnterPlanModeResult = Plan | PlanEnterError | null;
export type PlanPermissionMode = "default" | "plan";
export type PlanApprovalMode = "deferred" | "interactive" | "headless";

interface PlanStateMachineLike {
  getState(session: object): string | undefined;
  setState(session: object, state: string): void;
  getReplanCount(session: object): number;
  setInitialPlanHash(session: object, hash: string): void;
  planHash(bytes: Buffer): string;
  emitPlanFileWritten(planFilePath: string, planHash: string, bytes: number): void;
  transition(
    session: object,
    from: string,
    to: string,
    payload: Record<string, unknown>,
  ): void;
  /** PM-6 step 2 (Task 2.15): reset per-turn replan counter. Optional to
   *  preserve compatibility with legacy state-machine stubs used in tests. */
  resetReplanCount?(session: object): void;
}

export class PlanManager {
  private _inPlanMode = false;
  private _currentPlan: Plan | null = null;
  private _plansDir: string;
  private _listeners: PlanEventListener[] = [];
  private _sessionKey: object = this;
  private _permissionMode: PlanPermissionMode = "default";
  private _prePlanMode: PlanPermissionMode | null = null;
  private _stateMachine: PlanStateMachineLike | null = null;
  private _approvalMode: PlanApprovalMode = "deferred";
  private _turnsSinceExit = 0;
  private _verificationCompleted = false;
  /**
   * Set when the agent exits plan mode during an in-flight prompt turn
   * (e.g. via the `exit_plan_mode` tool). The next
   * `incrementTurnsSinceExit()` call — which fires on the same turn's
   * success path in cli / rpc / App.tsx — MUST be swallowed so that the
   * exit-turn itself doesn't count as post-exit turn 1. Reset on activate.
   */
  private _exitedInThisTurn = false;

  constructor(workspaceDir: string) {
    this._plansDir = join(workspaceDir, "plans");
  }

  get inPlanMode(): boolean {
    return this._inPlanMode;
  }

  get currentPlan(): Plan | null {
    return this._currentPlan;
  }

  get plansDir(): string {
    return this._plansDir;
  }

  get sessionKey(): object {
    return this._sessionKey;
  }

  get permissionMode(): PlanPermissionMode {
    return this._permissionMode;
  }

  get stateMachine(): PlanStateMachineLike | null {
    return this._stateMachine;
  }

  get planState(): string | undefined {
    return this._stateMachine?.getState(this._sessionKey);
  }

  get approvalMode(): PlanApprovalMode {
    return this._approvalMode;
  }

  get headless(): boolean {
    return this._approvalMode === "headless";
  }

  get turnsSinceExit(): number {
    return this._turnsSinceExit;
  }

  get verificationCompleted(): boolean {
    return this._verificationCompleted;
  }

  incrementTurnsSinceExit(): void {
    if (!this._currentPlan || this._inPlanMode) return;
    if (this._exitedInThisTurn) {
      // Swallow the bump for the turn the agent actually exited plan mode
      // in. Without this, the exit-turn becomes post-exit turn 1 and the
      // "turnsSinceExit === 0 means haven't taken a real turn yet" contract
      // breaks for any interval<=1 or any test that calls exit then a
      // single increment.
      this._exitedInThisTurn = false;
      return;
    }
    this._turnsSinceExit++;
  }

  /**
   * R3 finding #1 (2026-04-24): roll back the pre-prompt bump when
   * `session.prompt()` throws (abort, network error, model 5xx, tool
   * failure). Only successful turns should count toward the reinjection
   * cadence. Symmetric with `incrementTurnsSinceExit` — same gates, but
   * does NOT touch the exit-turn-swallow flag (`consumeExitSwallow` owns
   * that one-shot independently).
   */
  decrementTurnsSinceExit(): void {
    if (!this._currentPlan || this._inPlanMode) return;
    if (this._turnsSinceExit > 0) this._turnsSinceExit--;
  }

  markVerified(): void {
    this._verificationCompleted = true;
    this._emit({
      type: "plan_verified",
      planId: this._currentPlan?.id ?? "",
      timestamp: Date.now(),
    });
  }

  bindSession(session: object): void {
    this._sessionKey = session;
  }

  setHeadless(headless: boolean): void {
    this._approvalMode = headless ? "headless" : "interactive";
  }

  setApprovalMode(mode: PlanApprovalMode): void {
    this._approvalMode = mode;
  }

  attachStateMachine(stateMachine: PlanStateMachineLike): void {
    this._stateMachine = stateMachine;
  }

  capturePrePlanMode(): void {
    if (this._permissionMode !== "plan") {
      this._prePlanMode = this._permissionMode;
    }
    this._permissionMode = "plan";
    this._inPlanMode = true;
  }

  restorePrePlanMode(): void {
    this._permissionMode = this._prePlanMode ?? "default";
    this._prePlanMode = null;
    this._inPlanMode = this._permissionMode === "plan";
  }

  enterPlanMode(task: string, title?: string): EnterPlanModeResult {
    const planTitle = title || this._deriveTitle(task);

    try {
      fs.mkdirSync(this._plansDir, { recursive: true });
    } catch {
      return null;
    }

    const session = this._sessionKey;
    const cached = planSlugCache.get(session);
    if (cached) {
      const filePath = join(this._plansDir, `${cached}.md`);
      try {
        const state = slugCacheState.getState(session);
        if (!fs.existsSync(filePath) || state === "terminal") {
          fs.writeFileSync(filePath, "", "utf-8");
        }
      } catch {
        return null;
      }

      slugCacheState.markActive(session);
      return this._activatePlan(
        this._buildPlan(cached, filePath, task, planTitle),
        false,
      );
    }

    for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
      const slug = generateWordSlug();
      const filePath = join(this._plansDir, `${slug}.md`);
      if (fs.existsSync(filePath)) continue;

      try {
        fs.writeFileSync(filePath, "", "utf-8");
      } catch {
        return null;
      }

      planSlugCache.set(session, slug);
      slugCacheState.markActive(session);
      return this._activatePlan(
        this._buildPlan(slug, filePath, task, planTitle),
        true,
      );
    }

    return {
      status: "error",
      message: "Failed to create plan file: slug collision after 10 retries",
    };
  }

  exitPlanMode(approved: boolean = true): Plan | null {
    if (!this._inPlanMode || !this._currentPlan) return null;

    const plan = this._currentPlan;
    plan.status = approved ? "approved" : "abandoned";
    plan.updatedAt = Date.now();

    this._writePlanFile(plan);

    this._inPlanMode = false;
    this._permissionMode = "default";
    this._prePlanMode = null;
    this._emit({
      type: "plan_mode_exited",
      planId: plan.id,
      timestamp: Date.now(),
    });

    return plan;
  }

  closePlanMode(status: PlanStatus = "approved"): Plan | null {
    if (!this._currentPlan) return null;

    this._currentPlan.status = status;
    this._currentPlan.updatedAt = Date.now();
    this._inPlanMode = false;
    this._permissionMode = this._prePlanMode ?? "default";
    this._prePlanMode = null;
    this._emit({
      type: "plan_mode_exited",
      planId: this._currentPlan.id,
      timestamp: Date.now(),
    });
    return this._currentPlan;
  }

  /**
   * Arm the one-shot "exit-turn swallow" for the next bump. Called by the
   * runtime `exit_plan_mode` tool handler when plan mode exits mid-turn
   * (via a tool call inside an in-flight `session.prompt()`). The next
   * `incrementTurnsSinceExit()` call is swallowed so the exit-turn itself
   * doesn't count as post-exit turn 1.
   *
   * Kept as a separate method (rather than armed automatically inside
   * `exitPlanMode`/`closePlanMode`) because the test contract exercises
   * those methods directly, with an immediate synchronous bump, and
   * expects the bump to count. Only the mid-turn tool path should arm
   * the swallow.
   */
  markExitedInThisTurn(): void {
    this._exitedInThisTurn = true;
  }

  /**
   * Clear the one-shot exit-turn swallow flag without touching the turn
   * counter. Use on code paths that run a prompt-cycle but don't own a
   * matching `incrementTurnsSinceExit()` call — e.g., the TUI `/plan <task>`
   * auto-submit. Prevents a lingering armed flag from eating the next real
   * user turn.
   */
  consumeExitSwallow(): void {
    this._exitedInThisTurn = false;
  }

  reenterPlanMode(): Plan | null {
    if (this._inPlanMode) return this._currentPlan;
    if (!this._currentPlan) return null;

    this._currentPlan.status = "active";
    this._currentPlan.updatedAt = Date.now();
    this.capturePrePlanMode();

    this._writePlanFile(this._currentPlan);

    this._emit({
      type: "plan_mode_entered",
      planId: this._currentPlan.id,
      timestamp: Date.now(),
    });
    return this._currentPlan;
  }

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

  readPlanFile(): string | null {
    if (!this._currentPlan) return null;
    if (!fs.existsSync(this._currentPlan.filePath)) return null;
    return fs.readFileSync(this._currentPlan.filePath, "utf-8");
  }

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

  subscribe(listener: PlanEventListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  private _activatePlan(plan: Plan, emitCreated: boolean): Plan {
    if (emitCreated) {
      this._emit({
        type: "plan_created",
        planId: plan.id,
        timestamp: Date.now(),
      });
    }

    this._currentPlan = plan;
    this._turnsSinceExit = 0;
    this._verificationCompleted = false;
    this._exitedInThisTurn = false;
    this.capturePrePlanMode();
    this._stateMachine?.setState(this._sessionKey, "plan_drafting");
    this._emit({
      type: "plan_mode_entered",
      planId: plan.id,
      timestamp: Date.now(),
    });

    return plan;
  }

  private _buildPlan(
    id: string,
    filePath: string,
    task: string,
    title: string,
  ): Plan {
    const now = Date.now();
    return {
      id,
      title,
      task,
      status: "active",
      tasks: [],
      filePath,
      createdAt: now,
      updatedAt: now,
    };
  }

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
      content = content.replace(/^> Status:.*\n\n?/, "");
      fs.writeFileSync(plan.filePath, content, "utf-8");
    }
  }
}
