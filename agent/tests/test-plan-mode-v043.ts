/**
 * Plan Mode v0.4.3 — Group 1 Foundation tests (Test Overseer owned).
 *
 * Covers spec §1.2–§1.7 (PlanManager new API, sandbox
 * wrappers, symlink-safe predicate, annotation mapping / plan-mode gate,
 * enter/exit tool factories, PLAN_MODE_INSTRUCTIONS) plus findings F1-F5.
 *
 * Implementation lives in:
 *   src/planning/index.ts      (PlanManager — qdevbot-parity + shims)
 *   src/planning/types.ts      (Plan, PlanTask, PlanEvent, PlanStatus)
 *   src/planning/sandbox.ts    (wrap*ForPlanMode + planModeBlockedTool)
 *   src/tools/annotations.ts   (canonicalToolName + getReadOnlyForPlanMode)
 *   src/tools/plan.ts          (createEnterPlanModeTool + createExitPlanModeTool
 *                               + PLAN_MODE_INSTRUCTIONS)
 *
 * ---------------------------------------------------------------------------
 * v0.4.4 REBASE NOTES (Task 2.19, T8 gate)
 * ---------------------------------------------------------------------------
 * v0.4.4 replaced several v0.4.3 plan-mode behaviours. The following tests
 * were either deleted or rebased in this file:
 *
 *   DELETED (obsolete invariants):
 *     - "plan file content matches the spec §1.2 template EXACTLY"
 *       → v0.4.4 spec §4.2 line 262: enterPlanMode writes an EMPTY file; the
 *         agent drafts into it via plansDir-scoped write/edit. The fixed
 *         template is gone.
 *     - "plan ID collision fallback → single -1 suffix (T33)"
 *     - "plan ID collision fallback → lands at -2 with two pre-existing files"
 *     - "plan ID collision exhaustion → throws when all 10 slots occupied"
 *       → v0.4.4 spec §4.3 PM-11 line 297: slug is now a word-slug
 *         (`<adj>-<noun>`), collisions retry 10 times and return a structured
 *         `{status: "error"}` (no throw, no `-N` suffix). Collision coverage
 *         migrated to tests/test-plan-slug.ts (T24 a/b/c/f).
 *     - "execute when already in plan mode → status:'already_in_plan_mode'"
 *       → v0.4.4 spec §4.3 PM-11 cache-first lookup line 295: repeat
 *         enter_plan_mode reuses the cached slug and returns plan_mode_active
 *         (same plan_id/plan_file). The "already_in_plan_mode" status is
 *         retired; slug-reuse coverage is in tests/test-plan-slug.ts.
 *
 *   REBASED (format change only):
 *     - `plan_id` regex: /^plan-\d+/ → /^[a-z]+-[a-z]+$/ (word-slug per PM-11)
 *     - "reenterPlanMode strips status marker" — removed the `# task` body
 *       assertion since v0.4.4 plan files start empty; only the marker-strip
 *       invariant is still applicable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ESM-safe fs spying: `vi.mock("fs", { spy: true })` replaces the module with
// a spy-proxy so `vi.spyOn(fs, "mkdirSync")` works at runtime. Without this,
// ESM namespace objects are non-configurable and spying throws at spy-setup
// time. The `spy: true` flag keeps the real implementation for calls we do
// not explicitly override — so the other tests that actually hit the fs (e.g.
// collision T33, symlink T36/T37, writePlanContent/readPlanFile round-trip)
// are unaffected.
vi.mock("fs", { spy: true });

import * as fs from "fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

// ---- System under test ---------------------------------------------------

import { PlanManager } from "../src/planning/index.js";
import type {
  Plan,
  PlanEvent,
  PlanEventListener,
  PlanEventType,
  PlanStatus,
  PlanTask,
} from "../src/planning/types.js";
import {
  wrapWriteForPlanMode,
  wrapEditForPlanMode,
  wrapBashForPlanMode,
  wrapMCPToolForPlanMode,
  planModeBlockedTool,
} from "../src/planning/sandbox.js";
import {
  canonicalToolName,
  getReadOnlyForPlanMode,
  TOOL_ANNOTATIONS,
} from "../src/tools/annotations.js";
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  PLAN_MODE_INSTRUCTIONS,
} from "../src/tools/plan.js";

// ---- Helpers -------------------------------------------------------------

/** Build a trivial stub tool that records its executions. */
function makeTool(name: string): AgentTool<any, any> {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text" as const, text: `${name} executed` }],
        details: {},
      };
    },
  } as AgentTool<any, any>;
}

/** Parse the JSON envelope from a blocked tool result. */
function parseBlockedResult(result: AgentToolResult<any>): any {
  const first = result.content?.[0];
  if (!first || first.type !== "text") {
    throw new Error("Expected text content");
  }
  return JSON.parse(first.text);
}

/** Parse the JSON data from a tool's success result (enter/exit). */
function parseOkResult(result: AgentToolResult<any>): any {
  const first = result.content?.[0];
  if (!first || first.type !== "text") {
    throw new Error("Expected text content");
  }
  return JSON.parse(first.text);
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "qlaybot-planv043-"));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
});

// =========================================================================
// 1. PlanManager — new API (spec §1.2)
// =========================================================================

describe("PlanManager — new API (spec §1.2)", () => {
  it("constructor with explicit workspaceDir sets plansDir = join(workspaceDir, \"plans\")", () => {
    const pm = new PlanManager(tmpRoot);
    expect(pm.plansDir).toBe(join(tmpRoot, "plans"));
  });

  // DELETED: "constructor with undefined workspaceDir defaults to
  // process.cwd()/plans (transitional F4)" — removed in Group 3 step 11.
  // The transitional `constructor(workspaceDir?: string)` shim is gone;
  // the constructor now requires an explicit workspaceDir.

  it("getters inPlanMode / currentPlan / plansDir return initial state before enterPlanMode", () => {
    const pm = new PlanManager(tmpRoot);
    expect(pm.inPlanMode).toBe(false);
    expect(pm.currentPlan).toBeNull();
    expect(pm.plansDir).toBe(join(tmpRoot, "plans"));
  });

  it("enterPlanMode creates plans dir, writes plan file, returns populated Plan", () => {
    const pm = new PlanManager(tmpRoot);
    const plan = pm.enterPlanMode("Design a Hall bar with 6 contacts");
    expect(plan).not.toBeNull();
    const p = plan as Plan;
    // v0.4.4 PM-11: plan_id is a word-slug (`<adj>-<noun>`), not `plan-<ts>`.
    expect(p.id).toMatch(/^[a-z]+-[a-z]+$/);
    expect(p.title).toBe("Design a Hall bar with 6 contacts");
    expect(p.task).toBe("Design a Hall bar with 6 contacts");
    expect(p.status).toBe("active");
    expect(p.tasks).toEqual([]);
    expect(p.filePath).toBe(join(tmpRoot, "plans", `${p.id}.md`));
    expect(typeof p.createdAt).toBe("number");
    expect(typeof p.updatedAt).toBe("number");
    expect(existsSync(p.filePath)).toBe(true);
    expect(existsSync(join(tmpRoot, "plans"))).toBe(true);
    expect(pm.inPlanMode).toBe(true);
    expect(pm.currentPlan).toEqual(p);
  });

  // DELETED (v0.4.4 Task 2.19): "plan file content matches the spec §1.2
  // template EXACTLY". v0.4.4 design spec §4.2 line 262 — enterPlanMode now
  // writes an EMPTY file; the agent populates it via plansDir-scoped
  // write/edit during `plan_drafting`. The fixed markdown template from
  // v0.4.3 is no longer part of the contract.

  it("enterPlanMode uses explicit title argument when provided", () => {
    const pm = new PlanManager(tmpRoot);
    const plan = pm.enterPlanMode("Task body", "My Custom Title");
    expect((plan as Plan).title).toBe("My Custom Title");
  });

  it("_deriveTitle: short task → verbatim", () => {
    const pm = new PlanManager(tmpRoot);
    const plan = pm.enterPlanMode("Small task");
    expect((plan as Plan).title).toBe("Small task");
  });

  it("_deriveTitle: long task (>60 chars, no sentence break) → first 57 chars + \"...\"", () => {
    const pm = new PlanManager(tmpRoot);
    const longTask =
      "This is a very long task description that definitely exceeds the sixty character limit imposed by derive";
    const plan = pm.enterPlanMode(longTask);
    const title = (plan as Plan).title;
    // 57 chars + "..." = 60 chars
    expect(title.length).toBe(60);
    expect(title.endsWith("...")).toBe(true);
    expect(title.slice(0, 57)).toBe(longTask.slice(0, 57));
  });

  it("_deriveTitle: multi-sentence task → first sentence only", () => {
    const pm = new PlanManager(tmpRoot);
    const plan = pm.enterPlanMode("First sentence. Second sentence. Third sentence.");
    expect((plan as Plan).title).toBe("First sentence");
  });

  // DELETED (v0.4.4 Task 2.19): three v0.4.3 collision tests that asserted
  // the `plan-${Date.now()}-N` fallback scheme
  //   - "plan ID collision fallback → single -1 suffix (T33)"
  //   - "plan ID collision fallback → lands at -2 with two pre-existing files"
  //   - "plan ID collision exhaustion → throws when all 10 slots occupied"
  // v0.4.4 design spec §4.3 PM-11 line 297: plan IDs are word-slugs
  // (`<adj>-<noun>`) generated by `generateWordSlug()`, and collisions retry
  // up to 10 times and return a structured `{status: "error"}` on exhaustion
  // (no throw, no `-N` suffix, no Date.now() semantics). Equivalent coverage
  // lives in tests/test-plan-slug.ts — T24 a/b/c (slug + cache) and T24 f
  // (structured collision error after 10 retries).

  it("enterPlanMode returns null on FS failure; does NOT mutate state; emits no event (D1)", () => {
    // Uses the top-level `vi.mock("fs", { spy: true })` to spy on writeFileSync.
    const pm = new PlanManager(tmpRoot);
    const events: PlanEvent[] = [];
    pm.subscribe((e) => events.push(e));

    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = pm.enterPlanMode("boom");
    expect(result).toBeNull();
    expect(pm.inPlanMode).toBe(false);
    expect(pm.currentPlan).toBeNull();
    expect(events.length).toBe(0);
  });

  it("enterPlanMode returns null when mkdirSync throws (D1 — full try/catch coverage)", () => {
    // Covers the other half of the D1 try/catch scope. The qdevbot manager
    // wraps BOTH mkdirSync + writeFileSync in the same try/catch; D1 requires
    // this to be preserved so we surface failure as a tool-result rather than
    // letting the exception escape the RPC transport.
    const pm = new PlanManager(tmpRoot);
    const events: PlanEvent[] = [];
    pm.subscribe((e) => events.push(e));

    vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied (mkdir)");
    });

    const result = pm.enterPlanMode("boom-mkdir");
    expect(result).toBeNull();
    expect(pm.inPlanMode).toBe(false);
    expect(pm.currentPlan).toBeNull();
    expect(events.length).toBe(0);
  });

  it("exitPlanMode(true) sets status=\"approved\", prepends status marker, returns plan", () => {
    const pm = new PlanManager(tmpRoot);
    const entered = pm.enterPlanMode("task") as Plan;
    const exited = pm.exitPlanMode(true);
    expect(exited).not.toBeNull();
    expect((exited as Plan).status).toBe("approved");
    expect(pm.inPlanMode).toBe(false);
    const content = readFileSync(entered.filePath, "utf-8");
    expect(content.startsWith("> Status: **approved**\n")).toBe(true);
  });

  it("exitPlanMode(false) sets status=\"abandoned\" and marker; exitPlanMode when cold returns null", () => {
    const pm = new PlanManager(tmpRoot);
    const entered = pm.enterPlanMode("task") as Plan;
    const exited = pm.exitPlanMode(false);
    expect((exited as Plan).status).toBe("abandoned");
    const content = readFileSync(entered.filePath, "utf-8");
    expect(content.startsWith("> Status: **abandoned**")).toBe(true);

    // Already cold → null
    expect(pm.exitPlanMode(true)).toBeNull();
  });

  it("enterPlanMode emits plan_created with matching planId on first enter", () => {
    // Spec §1.3 PlanEventType includes "plan_created"; final-gate review
    // required this be emitted on first enterPlanMode.
    const pm = new PlanManager(tmpRoot);
    const events: PlanEvent[] = [];
    pm.subscribe((e) => events.push(e));
    const plan = pm.enterPlanMode("task") as Plan;
    const created = events.filter((e) => e.type === "plan_created");
    expect(created.length).toBe(1);
    expect(created[0].planId).toBe(plan.id);
    expect(typeof created[0].timestamp).toBe("number");
  });

  it("plan_created fires before plan_mode_entered on first enter", () => {
    // Lifecycle ordering: the plan must exist (plan_created) before mode flips
    // to active (plan_mode_entered). Subscribers that key off "plan_mode_entered"
    // can then safely look up the plan via currentPlan or plansDir.
    const pm = new PlanManager(tmpRoot);
    const typesSeen: string[] = [];
    pm.subscribe((e) => typesSeen.push(e.type));
    pm.enterPlanMode("task");
    const createdIdx = typesSeen.indexOf("plan_created");
    const enteredIdx = typesSeen.indexOf("plan_mode_entered");
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(enteredIdx).toBeGreaterThanOrEqual(0);
    expect(createdIdx).toBeLessThan(enteredIdx);
  });

  it("reenterPlanMode does not re-emit plan_created (qdevbot parity)", () => {
    // plan_created fires only when a plan is CREATED (first enterPlanMode).
    // reenterPlanMode reactivates an existing plan — only plan_mode_entered
    // should fire, not plan_created.
    const pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("task");
    pm.exitPlanMode(true);
    const events: PlanEvent[] = [];
    pm.subscribe((e) => events.push(e));
    const plan = pm.reenterPlanMode();
    expect(plan).not.toBeNull();
    const createdAfterReenter = events.filter((e) => e.type === "plan_created");
    expect(createdAfterReenter.length).toBe(0);
    expect(events.some((e) => e.type === "plan_mode_entered")).toBe(true);
  });

  it("reenterPlanMode strips status marker from disk and re-emits plan_mode_entered", () => {
    // REBASED (v0.4.4 Task 2.19): the `contentAfter.startsWith("# task")`
    // assertion was removed because v0.4.4 spec §4.2 line 262 specifies
    // enterPlanMode writes an EMPTY plan file; the agent populates the body
    // during drafting. In this test the agent never drafts, so after the
    // marker is stripped the body is empty. The marker-strip invariant
    // itself is unchanged and still asserted.
    const pm = new PlanManager(tmpRoot);
    const entered = pm.enterPlanMode("task") as Plan;
    pm.exitPlanMode(true);
    let contentBefore = readFileSync(entered.filePath, "utf-8");
    expect(/^> Status:.*\n\n?/.test(contentBefore)).toBe(true);

    const events: PlanEvent[] = [];
    pm.subscribe((e) => events.push(e));

    const re = pm.reenterPlanMode();
    expect(re).not.toBeNull();
    expect(pm.inPlanMode).toBe(true);
    const contentAfter = readFileSync(entered.filePath, "utf-8");
    expect(/^> Status:/.test(contentAfter)).toBe(false);
    expect(events.some((e) => e.type === "plan_mode_entered")).toBe(true);
  });

  it("reenterPlanMode with no previous plan returns null", () => {
    const pm = new PlanManager(tmpRoot);
    expect(pm.reenterPlanMode()).toBeNull();
  });

  it("reenterPlanMode regex strictness: /^> Status:.*\\n\\n?/ strips both \\n\\n and \\n variants", () => {
    // Spec §1.2: "On reenterPlanMode → regex content.replace(/^> Status:.*\n\n?/, \"\") strips it."
    // Covers both branches of the \n\n? alternation.

    // Variant A: trailing blank line (two \n after the marker).
    const pmA = new PlanManager(tmpRoot);
    const enteredA = pmA.enterPlanMode("Title A") as Plan;
    // Directly overwrite the file with the exact marker + body we want.
    writeFileSync(
      enteredA.filePath,
      "> Status: **approved**\n\n# Title\nbody body\n",
      "utf-8",
    );
    // Exit state so reenterPlanMode actually runs its strip branch.
    pmA.exitPlanMode(true);
    // exitPlanMode may rewrite the marker — force the exact layout again then reenter.
    writeFileSync(
      enteredA.filePath,
      "> Status: **approved**\n\n# Title\nbody body\n",
      "utf-8",
    );
    const reA = pmA.reenterPlanMode();
    expect(reA).not.toBeNull();
    const contentA = readFileSync(enteredA.filePath, "utf-8");
    expect(contentA.startsWith("# Title")).toBe(true);
    expect(contentA.includes("> Status:")).toBe(false);

    // Variant B: no trailing blank line (single \n after the marker).
    // Fresh manager in a fresh workspace dir so the previous plan state doesn't bleed.
    const subRoot = mkdtempSync(join(tmpdir(), "qlaybot-planv043-regexB-"));
    try {
      const pmB = new PlanManager(subRoot);
      const enteredB = pmB.enterPlanMode("Title B") as Plan;
      pmB.exitPlanMode(false);
      writeFileSync(
        enteredB.filePath,
        "> Status: **abandoned**\n# Title\nbody",
        "utf-8",
      );
      const reB = pmB.reenterPlanMode();
      expect(reB).not.toBeNull();
      const contentB = readFileSync(enteredB.filePath, "utf-8");
      expect(contentB.startsWith("# Title")).toBe(true);
      expect(contentB.includes("> Status:")).toBe(false);
    } finally {
      rmSync(subRoot, { recursive: true, force: true });
    }
  });

  it("updatePlanTasks mutates plan, writes file, emits plan_updated; no-op with no current plan", () => {
    const pm = new PlanManager(tmpRoot);
    // No-op branch
    const eventsBefore: PlanEvent[] = [];
    pm.subscribe((e) => eventsBefore.push(e));
    pm.updatePlanTasks([{ id: "a", description: "x", status: "pending" }]);
    expect(eventsBefore.length).toBe(0);

    const entered = pm.enterPlanMode("task") as Plan;
    // Capture the on-disk content baseline AFTER initial plan write.
    const contentBefore = readFileSync(entered.filePath, "utf-8");

    // To prove `updatePlanTasks` actually rewrites the file on disk we use the
    // qdevbot `_writePlanFile` strip-branch: when the plan is active AND the
    // file starts with `> Status:`, the helper strips the marker. So we
    // pre-inject a leading status marker — `updatePlanTasks` should then
    // produce a file without it, and the content should match `contentBefore`.
    const tainted = `> Status: **approved**\n\n${contentBefore}`;
    writeFileSync(entered.filePath, tainted, "utf-8");
    expect(readFileSync(entered.filePath, "utf-8").startsWith("> Status:")).toBe(true);

    const updates: PlanEvent[] = [];
    pm.subscribe((e) => updates.push(e));
    const tasks: PlanTask[] = [
      { id: "t1", description: "Do X", status: "pending" },
      { id: "t2", description: "Do Y", status: "completed" },
    ];
    pm.updatePlanTasks(tasks);
    expect(pm.currentPlan?.tasks).toEqual(tasks);
    expect(updates.some((e) => e.type === "plan_updated" && e.planId === entered.id)).toBe(true);

    // Spec §1.2: updatePlanTasks calls _writePlanFile — this exercises the
    // strip-active branch (qdevbot manager.ts:211-214). After strip, the
    // on-disk content matches the pre-tainted baseline (marker removed).
    const contentAfter = readFileSync(entered.filePath, "utf-8");
    expect(contentAfter.startsWith("> Status:")).toBe(false);
    expect(contentAfter).toBe(contentBefore);
  });

  it("readPlanFile returns null when no current plan; returns null after external delete; returns content after writePlanContent", () => {
    const pm = new PlanManager(tmpRoot);
    expect(pm.readPlanFile()).toBeNull();

    const entered = pm.enterPlanMode("task") as Plan;
    expect(pm.readPlanFile()).not.toBeNull();

    unlinkSync(entered.filePath);
    // Divergence D4: writePlanContent does NOT auto-recreate on its own check,
    // but readPlanFile specifically returns null when the file is missing.
    expect(pm.readPlanFile()).toBeNull();

    // After writePlanContent, the file exists again and readPlanFile returns it.
    pm.writePlanContent("hello world");
    expect(pm.readPlanFile()).toBe("hello world");
  });

  it("subscribe returns a working unsubscribe; listener errors are swallowed", () => {
    const pm = new PlanManager(tmpRoot);
    const calls: string[] = [];
    const unsub = pm.subscribe((e) => {
      calls.push(e.type);
      throw new Error("listener blew up");
    });
    // First event, listener throws — should not propagate
    expect(() => pm.enterPlanMode("task")).not.toThrow();
    expect(calls).toContain("plan_mode_entered");
    unsub();
    const lengthAfterUnsub = calls.length;
    pm.exitPlanMode(true);
    expect(calls.length).toBe(lengthAfterUnsub);
  });
});

// =========================================================================
// 2. PlanManager — backward-compat shims (findings F3/F4) — DELETED
// =========================================================================
//
// The 0.4.2 shim API (isActive, enter, exit, onStateChange,
// getSystemPromptInjection) was removed in Group 3 step 11 per spec §9
// step 11. The tests that validated those shims were deleted alongside
// them. The qdevbot-parity replacements (`inPlanMode`, `enterPlanMode`,
// `exitPlanMode`, `subscribe`) are still covered in section 1 above.

// =========================================================================
// 3. Sandbox — symlink-safe predicate (spec §1.4, T36/T37) via wrapWriteForPlanMode
// =========================================================================

describe("sandbox.isInsidePlansDir — symlink-safe (spec §1.4, T36/T37)", () => {
  // We exercise the predicate through wrapWriteForPlanMode so the test is
  // robust to whether the helper is exported. Each test enters plan mode
  // then attempts a write; if allowed, the wrapped tool's underlying execute
  // fires ("write executed" passthrough). If rejected, we get a blocked JSON.
  let pm: PlanManager;
  let plansDir: string;

  beforeEach(() => {
    pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("setup"); // ensures plansDir exists on disk for realpath
    plansDir = pm.plansDir;
  });

  it("absolute path INSIDE plans: allowed", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", {
      path: join(plansDir, "inside.txt"),
    });
    expect(result.content[0].text).toBe("write executed");
  });

  it("absolute path OUTSIDE plans: blocked", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const outsideAbs = join(tmpRoot, "outside.txt");
    const result = await wrapped.execute("1", { path: outsideAbs });
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
  });

  it("relative path INSIDE plans (resolved against cwd) allowed", async () => {
    // Use relative form by setting cwd = tmpRoot and path = "plans/x.txt"
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", {
      path: "plans/x.txt",
    });
    expect(result.content[0].text).toBe("write executed");
  });

  it("relative path OUTSIDE plans: blocked", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", { path: "other/y.txt" });
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
  });

  it("traversal plans/../etc/foo.txt: blocked", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    // When resolved against tmpRoot, this path leaves plansDir.
    const result = await wrapped.execute("1", { path: "plans/../etc/foo.txt" });
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
  });

  it("non-existent path INSIDE plans: accepted (walks up until existing ancestor)", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const missingDeep = join(plansDir, "does", "not", "exist", "yet.txt");
    const result = await wrapped.execute("1", { path: missingDeep });
    expect(result.content[0].text).toBe("write executed");
  });

  it("non-existent path OUTSIDE plans: rejected", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const missingOutside = join(tmpRoot, "nope", "deep", "file.txt");
    const result = await wrapped.execute("1", { path: missingOutside });
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
  });

  it("T36: symlink INSIDE plans pointing to an EXTERNAL dir is rejected via realpath", async () => {
    // External sibling dir (outside plansDir)
    const escapeDir = mkdtempSync(join(tmpdir(), "qlaybot-escape-"));
    try {
      const linkPath = join(plansDir, "escape");
      symlinkSync(escapeDir, linkPath, "dir");
      const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
      const result = await wrapped.execute("1", {
        path: join(linkPath, "evil.txt"),
      });
      const parsed = parseBlockedResult(result);
      expect(parsed.error).toBe("plan_mode_restricted");
      // Ensure the attacker's target did NOT receive a file — since the
      // base tool stub is a no-op, we verify the block path was taken by
      // inspecting the JSON envelope (evil.txt was never written).
      expect(existsSync(join(escapeDir, "evil.txt"))).toBe(false);
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
    }
  });

  it("T37: symlink INSIDE plans pointing to a sibling dir inside workspace but outside plans is rejected", async () => {
    const siblingDir = join(tmpRoot, "sibling");
    mkdirSync(siblingDir, { recursive: true });
    const linkPath = join(plansDir, "sibling_link");
    symlinkSync(siblingDir, linkPath, "dir");
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", {
      path: join(linkPath, "evil.txt"),
    });
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
  });

  it("plansDir itself (realpath equals plansDir) is considered inside (edge case)", async () => {
    // We simulate this by attempting to "write" to the plansDir itself.
    // The predicate should accept it (realpath equals plansAbs).
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", { path: plansDir });
    expect(result.content[0].text).toBe("write executed");
  });
});

// =========================================================================
// 4. Sandbox wrappers — plan-mode enforcement (spec §1.4)
// =========================================================================

describe("sandbox wrappers — plan-mode enforcement (spec §1.4)", () => {
  let pm: PlanManager;
  let plansDir: string;

  beforeEach(() => {
    pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("sandbox-test"); // plansDir materialised
    plansDir = pm.plansDir;
  });

  // ---------------- wrapWriteForPlanMode ----------------

  it("wrapWriteForPlanMode: NOT in plan mode → passthrough", async () => {
    const pmCold = new PlanManager(tmpRoot);
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pmCold, tmpRoot);
    const result = await wrapped.execute("1", { path: join(tmpRoot, "x.txt") });
    expect(result.content[0].text).toBe("write executed");
  });

  it("wrapWriteForPlanMode: in plan mode + outside path → blocked JSON envelope", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", { path: join(tmpRoot, "out.txt") });
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
    expect(typeof parsed.message).toBe("string");
    expect(typeof parsed.hint).toBe("string");
    expect(parsed.hint).toContain("exit_plan_mode");
  });

  it("wrapWriteForPlanMode: in plan mode + absolute inside path → passthrough", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", {
      path: join(plansDir, "sub.md"),
    });
    expect(result.content[0].text).toBe("write executed");
  });

  it("wrapWriteForPlanMode: in plan mode + file_path parameter form → same predicate", async () => {
    const wrappedInside = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const insideRes = await wrappedInside.execute("1", {
      file_path: join(plansDir, "via-file_path.txt"),
    });
    expect(insideRes.content[0].text).toBe("write executed");

    const wrappedOutside = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const outsideRes = await wrappedOutside.execute("1", {
      file_path: join(tmpRoot, "o.txt"),
    });
    expect(parseBlockedResult(outsideRes).error).toBe("plan_mode_restricted");
  });

  // ---------------- wrapEditForPlanMode ----------------

  it("wrapEditForPlanMode: NOT in plan mode → passthrough", async () => {
    const pmCold = new PlanManager(tmpRoot);
    const wrapped = wrapEditForPlanMode(makeTool("edit"), pmCold, tmpRoot);
    const result = await wrapped.execute("1", { path: join(tmpRoot, "x.txt") });
    expect(result.content[0].text).toBe("edit executed");
  });

  it("wrapEditForPlanMode: in plan mode + outside → blocked with \"Cannot edit\" phrasing", async () => {
    const wrapped = wrapEditForPlanMode(makeTool("edit"), pm, tmpRoot);
    const result = await wrapped.execute("1", { path: join(tmpRoot, "o.txt") });
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
    expect(parsed.message).toContain("Cannot edit");
    expect(parsed.hint).toContain("exit_plan_mode");
  });

  it("wrapEditForPlanMode: in plan mode + inside → passthrough", async () => {
    const wrapped = wrapEditForPlanMode(makeTool("edit"), pm, tmpRoot);
    const result = await wrapped.execute("1", {
      path: join(plansDir, "sub.md"),
    });
    expect(result.content[0].text).toBe("edit executed");
  });

  // ---------------- wrapBashForPlanMode ----------------

  it("wrapBashForPlanMode: in plan mode → always blocked (regardless of args)", async () => {
    const wrapped = wrapBashForPlanMode(makeTool("bash"), pm);
    const r1 = await wrapped.execute("1", { command: "ls" });
    const r2 = await wrapped.execute("2", { command: "cat /etc/passwd" });
    expect(parseBlockedResult(r1).error).toBe("plan_mode_restricted");
    expect(parseBlockedResult(r2).error).toBe("plan_mode_restricted");
  });

  it("wrapBashForPlanMode: NOT in plan mode → passthrough", async () => {
    const pmCold = new PlanManager(tmpRoot);
    const wrapped = wrapBashForPlanMode(makeTool("bash"), pmCold);
    const result = await wrapped.execute("1", { command: "ls" });
    expect(result.content[0].text).toBe("bash executed");
  });

  // ---------------- Envelope shape ----------------

  it("blocked envelope hint matches spec §1.4 literal string EXACTLY", async () => {
    const wrapped = wrapWriteForPlanMode(makeTool("write"), pm, tmpRoot);
    const result = await wrapped.execute("1", { path: join(tmpRoot, "x.txt") });
    const parsed = parseBlockedResult(result);
    expect(parsed.hint).toBe(
      "You are in plan mode. Only the plan file can be modified. Use exit_plan_mode to leave plan mode first.",
    );
  });
});

// =========================================================================
// 5. annotations — canonicalToolName (spec §1.5, finding F1)
// =========================================================================

describe("annotations — canonicalToolName (spec §1.5, finding F1)", () => {
  it("klayout_native_screenshot → screenshot (F1 critical fix)", () => {
    expect(canonicalToolName("klayout_native_screenshot")).toBe("screenshot");
  });

  it("klayout_native_get_layout_info → get_layout_info", () => {
    expect(canonicalToolName("klayout_native_get_layout_info")).toBe(
      "get_layout_info",
    );
  });

  it("klayout_geometry_add_rect → add_rect", () => {
    expect(canonicalToolName("klayout_geometry_add_rect")).toBe("add_rect");
  });

  it("klayout_nanodevice_flakedetect_align → flakedetect_align", () => {
    expect(canonicalToolName("klayout_nanodevice_flakedetect_align")).toBe(
      "flakedetect_align",
    );
  });

  it("klayout_display_toggle_layer → toggle_layer", () => {
    expect(canonicalToolName("klayout_display_toggle_layer")).toBe(
      "toggle_layer",
    );
  });

  it("bash (no prefix) → bash unchanged", () => {
    expect(canonicalToolName("bash")).toBe("bash");
  });

  it("add_rect (already canonical) → add_rect unchanged", () => {
    expect(canonicalToolName("add_rect")).toBe("add_rect");
  });
});

// =========================================================================
// 6. annotations — getReadOnlyForPlanMode (spec §1.5, finding F2)
// =========================================================================

describe("annotations — getReadOnlyForPlanMode (spec §1.5, finding F2)", () => {
  it.each([
    ["get_layout_info"],
    ["screenshot"],
    ["route_inspect"],
    ["validate_pixel_size"],
  ])("native readonly %s is allowed with empty reasons", (name) => {
    const result = getReadOnlyForPlanMode(name);
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("namespaced name klayout_native_screenshot resolves to allowed (F1 x F2)", () => {
    const result = getReadOnlyForPlanMode("klayout_native_screenshot");
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it.each([
    ["create_layout"],
    ["save_layout"],
    ["execute_script"],
    ["auto_route"],
    ["close_layout_view"],
    ["evaluate_design"], // F2: reclassified readwrite
  ])("native readwrite %s is denied with reasons=[\"readwrite: true\"]", (name) => {
    const result = getReadOnlyForPlanMode(name);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(["readwrite: true"]);
  });

  it.each([
    ["klayout_geometry_add_rect"],
    ["klayout_display_toggle_layer"],
    ["klayout_nanodevice_routing_place_pads"],
    ["klayout_image_list_images"],
  ])("domain tool %s resolves to denied (readwrite)", (name) => {
    const result = getReadOnlyForPlanMode(name);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(["readwrite: true"]);
  });

  it("unknown tool → {allowed:false, reasons:[no annotation for \"<name>\"]}", () => {
    const result = getReadOnlyForPlanMode("does_not_exist");
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(['no annotation for "does_not_exist"']);
  });

  it("unknown namespaced tool → reason references canonicalized name", () => {
    const result = getReadOnlyForPlanMode("klayout_native_unknown");
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(['no annotation for "unknown"']);
  });

  it("annotation present but neither readonly nor readwrite → specific reason string", () => {
    // Inject a synthetic annotation with neither field set, then exercise the lookup.
    const synthetic = { name: "__synthetic_neither__" };
    TOOL_ANNOTATIONS.push(synthetic as any);
    try {
      const result = getReadOnlyForPlanMode("__synthetic_neither__");
      expect(result.allowed).toBe(false);
      expect(result.reasons).toEqual([
        "annotation present but neither readonly nor readwrite",
      ]);
    } finally {
      const idx = TOOL_ANNOTATIONS.indexOf(synthetic as any);
      if (idx >= 0) TOOL_ANNOTATIONS.splice(idx, 1);
    }
  });
});

// =========================================================================
// 7. Sandbox — wrapMCPToolForPlanMode + planModeBlockedTool (spec §1.5)
// =========================================================================

describe("sandbox — wrapMCPToolForPlanMode + planModeBlockedTool (spec §1.5)", () => {
  it("NOT in plan mode: passes through regardless of tool classification", async () => {
    const pm = new PlanManager(tmpRoot);
    const wrapped = wrapMCPToolForPlanMode(
      makeTool("klayout_native_create_layout"),
      pm,
    );
    const result = await wrapped.execute("1", {});
    expect(result.content[0].text).toBe(
      "klayout_native_create_layout executed",
    );
  });

  it("in plan mode + readonly tool (klayout_native_screenshot) → passthrough", async () => {
    const pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("task");
    const wrapped = wrapMCPToolForPlanMode(
      makeTool("klayout_native_screenshot"),
      pm,
    );
    const result = await wrapped.execute("1", {});
    expect(result.content[0].text).toBe("klayout_native_screenshot executed");
  });

  it("in plan mode + readwrite tool (klayout_native_create_layout) → blocked", async () => {
    const pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("task");
    const wrapped = wrapMCPToolForPlanMode(
      makeTool("klayout_native_create_layout"),
      pm,
    );
    const result = await wrapped.execute("1", {});
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
    expect(parsed.tool).toBe("klayout_native_create_layout");
    expect(parsed.reasons).toEqual(["readwrite: true"]);
    expect(typeof parsed.message).toBe("string");
    expect(parsed.message.startsWith("Tool ")).toBe(true);
    expect(typeof parsed.hint).toBe("string");
  });

  it("blocked envelope includes tool name, reasons, message, hint", () => {
    const result = planModeBlockedTool("weird_tool", ["readwrite: true"]);
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
    expect(parsed.tool).toBe("weird_tool");
    expect(parsed.reasons).toEqual(["readwrite: true"]);
    expect(typeof parsed.message).toBe("string");
    expect(parsed.message).toContain("weird_tool");
    expect(typeof parsed.hint).toBe("string");
  });

  it("in plan mode + unknown tool → blocked with \"no annotation for\" reasons", async () => {
    const pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("task");
    const wrapped = wrapMCPToolForPlanMode(makeTool("never_heard_of_this"), pm);
    const result = await wrapped.execute("1", {});
    const parsed = parseBlockedResult(result);
    expect(parsed.error).toBe("plan_mode_restricted");
    expect(parsed.reasons).toEqual(['no annotation for "never_heard_of_this"']);
  });
});

// =========================================================================
// 8. tools/plan.ts — enter_plan_mode (spec §1.6, D1)
// =========================================================================

describe("tools/plan.ts — enter_plan_mode (spec §1.6, D1)", () => {
  it("tool shape: name, label, description, parameters schema are correct", () => {
    const pm = new PlanManager(tmpRoot);
    const tool = createEnterPlanModeTool(pm);
    expect(tool.name).toBe("enter_plan_mode");
    expect(tool.label).toBe("Enter Plan Mode");
    expect(typeof tool.description).toBe("string");
    expect((tool.description as string).length).toBeGreaterThan(0);
    // TypeBox schema with required task + optional reason
    const schema: any = tool.parameters;
    expect(schema.type).toBe("object");
    expect(schema.properties?.task).toBeDefined();
    expect(schema.properties?.reason).toBeDefined();
    expect(schema.required).toEqual(["task"]);
  });

  it("execute when cold → status:\"plan_mode_active\" + plan_id + plan_file + instructions + task + reason", async () => {
    const pm = new PlanManager(tmpRoot);
    const tool = createEnterPlanModeTool(pm);
    const result = await (tool as any).execute("call-1", {
      task: "my task",
      reason: "because I said so",
    });
    const body = parseOkResult(result);
    expect(body.status).toBe("plan_mode_active");
    expect(typeof body.plan_id).toBe("string");
    // v0.4.4 PM-11: plan_id is a word-slug (`<adj>-<noun>`).
    expect(body.plan_id).toMatch(/^[a-z]+-[a-z]+$/);
    expect(typeof body.plan_file).toBe("string");
    expect(body.plan_file).toContain("plans");
    expect(body.instructions).toBe(PLAN_MODE_INSTRUCTIONS);
    expect(body.task).toBe("my task");
    expect(body.reason).toBe("because I said so");
    expect(pm.inPlanMode).toBe(true);
  });

  it("execute when already in plan mode → reuses cached slug; same plan_id/plan_file", async () => {
    // REBASED (v0.4.4 Task 2.19): design spec §4.3 PM-11 cache-first lookup
    // (line 295) — repeat enter_plan_mode while already in plan mode no
    // longer returns `status:"already_in_plan_mode"` (that status is retired).
    // Instead the cached slug is reused, the existing plan file is
    // preserved, and the tool returns another `plan_mode_active` response
    // with the SAME plan_id + plan_file. Active-state slug reuse invariant
    // is covered in detail by tests/test-plan-slug.ts. We assert the
    // tool-surface of that invariant here.
    const pm = new PlanManager(tmpRoot);
    const tool = createEnterPlanModeTool(pm);
    const firstRes = parseOkResult(
      await (tool as any).execute("call-1", { task: "first" }),
    );
    const firstId = firstRes.plan_id;

    const secondRes = parseOkResult(
      await (tool as any).execute("call-2", { task: "second" }),
    );
    expect(secondRes.status).toBe("plan_mode_active");
    expect(secondRes.plan_id).toBe(firstId);
    expect(secondRes.plan_file).toBe(firstRes.plan_file);
  });

  it("execute when PlanManager.enterPlanMode returns null (D1 FS failure) → status:\"error\"", async () => {
    const pm = new PlanManager(tmpRoot);
    // Force enterPlanMode to return null to simulate D1
    vi.spyOn(pm, "enterPlanMode").mockReturnValue(null);
    const tool = createEnterPlanModeTool(pm);
    const result = await (tool as any).execute("call-1", { task: "fail" });
    const body = parseOkResult(result);
    expect(body.status).toBe("error");
    expect(typeof body.message).toBe("string");
    expect(body.message.startsWith("Failed to create plan file")).toBe(true);
  });

  it("PLAN_MODE_INSTRUCTIONS is KLayout-adapted per spec §1.7", () => {
    expect(typeof PLAN_MODE_INSTRUCTIONS).toBe("string");
    // Core phrases
    expect(PLAN_MODE_INSTRUCTIONS).toContain("plan mode");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("klayout_get_layout_info");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("screenshot");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("route_inspect");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("readonly: true");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("src/tools/annotations.ts");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("exit_plan_mode");
  });
});

// =========================================================================
// 9. tools/plan.ts — exit_plan_mode (spec §1.6)
// =========================================================================

describe("tools/plan.ts — exit_plan_mode (spec §1.6)", () => {
  it("tool shape: name, label, optional approved + summary", () => {
    const pm = new PlanManager(tmpRoot);
    const tool = createExitPlanModeTool(pm);
    expect(tool.name).toBe("exit_plan_mode");
    expect(tool.label).toBe("Exit Plan Mode");
    const schema: any = tool.parameters;
    expect(schema.type).toBe("object");
    expect(schema.properties?.approved).toBeDefined();
    expect(schema.properties?.summary).toBeDefined();
    // approved and summary are optional — required array missing or doesn't include them
    const required = schema.required ?? [];
    expect(required.includes("approved")).toBe(false);
    expect(required.includes("summary")).toBe(false);
  });

  it("execute when not in plan mode → status:\"not_in_plan_mode\"", async () => {
    const pm = new PlanManager(tmpRoot);
    const tool = createExitPlanModeTool(pm);
    const result = await (tool as any).execute("call-1", {});
    const body = parseOkResult(result);
    expect(body.status).toBe("not_in_plan_mode");
    expect(typeof body.message).toBe("string");
  });

  it("execute with approved unspecified (default true) → status:\"plan_approved\" + plan_id + plan_file + summary + message", async () => {
    const pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("task");
    const tool = createExitPlanModeTool(pm);
    const result = await (tool as any).execute("call-1", {});
    const body = parseOkResult(result);
    expect(body.status).toBe("plan_approved");
    expect(typeof body.plan_id).toBe("string");
    expect(typeof body.plan_file).toBe("string");
    expect(typeof body.summary).toBe("string");
    expect(typeof body.message).toBe("string");
    expect(pm.inPlanMode).toBe(false);
  });

  it("execute with approved:false → status:\"plan_abandoned\" + plan_id + message", async () => {
    const pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("task");
    const tool = createExitPlanModeTool(pm);
    const result = await (tool as any).execute("call-1", { approved: false });
    const body = parseOkResult(result);
    expect(body.status).toBe("plan_abandoned");
    expect(typeof body.plan_id).toBe("string");
    expect(typeof body.message).toBe("string");
    expect(pm.inPlanMode).toBe(false);
  });

  it("execute with summary threads through to response", async () => {
    const pm = new PlanManager(tmpRoot);
    pm.enterPlanMode("task");
    const tool = createExitPlanModeTool(pm);
    const result = await (tool as any).execute("call-1", {
      summary: "my custom summary text",
    });
    const body = parseOkResult(result);
    expect(body.summary).toBe("my custom summary text");
  });
});

// =========================================================================
// 10. F5 backward-compat exports — DELETED
// =========================================================================
//
// `wrapToolWithSandbox` and `ALLOWED_TOOLS` were removed from
// `src/planning/sandbox.ts` in Group 3 step 11 per spec §9 step 11. The
// tests for those legacy exports were deleted alongside them. The
// qdevbot-parity replacement surface (wrapWriteForPlanMode,
// wrapEditForPlanMode, wrapBashForPlanMode, wrapMCPToolForPlanMode,
// planModeBlockedTool) is covered in sections 3-6 above.

// =========================================================================
// 11. src/planning/types.ts — export surface
// =========================================================================

describe("planning/types.ts — exported type surface (spec §1.3)", () => {
  it("Plan and PlanTask interfaces accept spec-shaped literals; PlanStatus union compiles", () => {
    // Type-level assertions: if any of these interfaces fail to export or the
    // PlanStatus union loses a member, TypeScript fails to compile this file.
    // Runtime assertions confirm the literal values round-trip.
    const status: PlanStatus = "active";
    const sample: Plan = {
      id: "plan-1",
      title: "t",
      task: "x",
      status,
      tasks: [],
      filePath: "/tmp/p.md",
      createdAt: 1,
      updatedAt: 2,
    };
    expect(sample.id).toBe("plan-1");
    expect(sample.status).toBe("active");
    expect(sample.tasks).toEqual([]);
    expect(sample.filePath).toBe("/tmp/p.md");

    const task: PlanTask = {
      id: "t1",
      description: "d",
      status: "pending",
    };
    expect(task.id).toBe("t1");
    expect(task.status).toBe("pending");

    // Exercise each PlanStatus union value — compile fails if the union drops a member.
    const statuses: PlanStatus[] = ["active", "approved", "completed", "abandoned"];
    expect(statuses.length).toBe(4);
  });

  it("PlanEvent + PlanEventType + PlanEventListener are exported and compose correctly", () => {
    // Exercise each PlanEventType union variant.
    const types: PlanEventType[] = [
      "plan_mode_entered",
      "plan_mode_exited",
      "plan_created",
      "plan_updated",
    ];
    expect(types.length).toBe(4);

    // A literal PlanEvent has {type, planId?, timestamp}.
    const eventA: PlanEvent = { type: "plan_mode_entered", timestamp: 1 };
    const eventB: PlanEvent = {
      type: "plan_updated",
      planId: "plan-42",
      timestamp: 2,
    };
    expect(eventA.type).toBe("plan_mode_entered");
    expect(eventA.planId).toBeUndefined();
    expect(eventB.planId).toBe("plan-42");

    // PlanEventListener is `(event: PlanEvent) => void`.
    const received: PlanEvent[] = [];
    const listener: PlanEventListener = (e) => {
      received.push(e);
    };
    listener(eventA);
    listener(eventB);
    expect(received.length).toBe(2);
    expect(received[0].type).toBe("plan_mode_entered");
    expect(received[1].planId).toBe("plan-42");
  });
});
