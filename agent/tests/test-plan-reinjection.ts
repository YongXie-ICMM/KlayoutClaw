/**
 * Tests for plan reinjection (issue #24, Phase 1 TRD overseer).
 *
 * Covers:
 *  - PlanManager extensions: turnsSinceExit, incrementTurnsSinceExit(),
 *    markVerified(), verificationCompleted, plan_verified event, reset on
 *    new plan activation.
 *  - createPlanReinjector(): skip rules + content shape.
 *  - prunePlanReinjections(): keep-only-most-recent filtering.
 *  - Static wiring check: cli.ts + rpc.ts both call incrementTurnsSinceExit.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const tmpDirs: string[] = [];

/**
 * Strip block / line comments before running static grep assertions.
 *
 * Without this, a commented-out `// .incrementTurnsSinceExit(` or an old
 * `/* createPlanReinjector( *\/` block would satisfy wiring checks. The
 * `(^|[^:])` guard on the line-comment regex preserves `http://` / `file://`
 * style URL schemes that happen to appear inside string literals — the
 * character preceding `//` must not be `:`.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-reinjection-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Set up a PlanManager with an active plan that has already exited plan mode
 * (so the reinjector's "only after exit" rule is satisfied).
 */
async function activatePlanAndExit(planContent: string) {
  const { PlanManager } = await import("../src/planning/index.js");
  const workspaceDir = makeWorkspace();
  const pm = new PlanManager(workspaceDir);
  const enter = pm.enterPlanMode("Test plan task");
  if (!enter || (enter as any).status === "error") {
    throw new Error("failed to enter plan mode");
  }
  // Write the plan body directly via PlanManager's file API.
  pm.writePlanContent(planContent);
  pm.exitPlanMode(true);
  return { pm, workspaceDir };
}

describe("PlanManager: reinjection support", () => {
  it("incrementTurnsSinceExit increments when a plan is active and not in plan mode", async () => {
    const { pm } = await activatePlanAndExit("step 1\nstep 2");
    expect(pm.inPlanMode).toBe(false);
    expect(pm.currentPlan).not.toBeNull();
    expect(pm.turnsSinceExit).toBe(0);
    pm.incrementTurnsSinceExit();
    expect(pm.turnsSinceExit).toBe(1);
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    expect(pm.turnsSinceExit).toBe(3);
  });

  it("incrementTurnsSinceExit is a no-op while inPlanMode is true (pre-exit)", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const pm = new PlanManager(makeWorkspace());
    const enter = pm.enterPlanMode("Draft");
    expect(enter).not.toBeNull();
    expect(pm.inPlanMode).toBe(true);
    expect(pm.currentPlan).not.toBeNull();
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    expect(pm.turnsSinceExit).toBe(0);
  });

  it("incrementTurnsSinceExit is a no-op when no plan is active", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const pm = new PlanManager(makeWorkspace());
    expect(pm.currentPlan).toBeNull();
    pm.incrementTurnsSinceExit();
    expect(pm.turnsSinceExit).toBe(0);
  });

  it("markVerified sets verificationCompleted and emits plan_verified event", async () => {
    const { pm } = await activatePlanAndExit("body");
    const events: any[] = [];
    pm.subscribe((ev) => events.push(ev));
    expect(pm.verificationCompleted).toBe(false);
    pm.markVerified();
    expect(pm.verificationCompleted).toBe(true);
    const verifiedEvents = events.filter((e) => e.type === "plan_verified");
    expect(verifiedEvents.length).toBe(1);
    expect(verifiedEvents[0].planId).toBe(pm.currentPlan!.id);
    expect(typeof verifiedEvents[0].timestamp).toBe("number");
  });

  it("activating a new plan after closePlanMode() also resets counters (runtime exit path)", async () => {
    // Real runtime exits plan mode via closePlanMode() from tools/plan.ts
    // (lines 251/279/308/390), not only exitPlanMode(). If the Executor
    // wires the reset in exitPlanMode but not in closePlanMode, the
    // runtime path would silently skip reset. activate → increment →
    // verify → closePlanMode → re-enter → both must be reset.
    const { pm } = await activatePlanAndExit("body v1");
    // Already exited via exitPlanMode inside helper. Simulate a second
    // plan drive-through that ends via closePlanMode.
    const p2 = pm.enterPlanMode("Second plan");
    expect(p2).not.toBeNull();
    // Bumps here would be no-ops because inPlanMode=true; exit first.
    const closed = pm.closePlanMode("approved");
    expect(closed).not.toBeNull();
    expect(pm.inPlanMode).toBe(false);
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    pm.markVerified();
    expect(pm.turnsSinceExit).toBe(3);
    expect(pm.verificationCompleted).toBe(true);

    // Now activate a NEW plan. Reset must fire regardless of how the
    // previous plan ended.
    const p3 = pm.enterPlanMode("Third plan");
    expect(p3).not.toBeNull();
    expect(pm.turnsSinceExit).toBe(0);
    expect(pm.verificationCompleted).toBe(false);
  });

  it("activating a new plan resets turnsSinceExit to 0 and verificationCompleted to false", async () => {
    const { pm } = await activatePlanAndExit("body");
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    pm.markVerified();
    expect(pm.turnsSinceExit).toBe(2);
    expect(pm.verificationCompleted).toBe(true);

    // Activate a new plan. enterPlanMode re-uses the cached slug; it still
    // calls _activatePlan which is the contract's reset point.
    const enter2 = pm.enterPlanMode("Second plan");
    expect(enter2).not.toBeNull();
    expect(pm.turnsSinceExit).toBe(0);
    expect(pm.verificationCompleted).toBe(false);
  });

  it("readPlanFile returns current plan content", async () => {
    const { pm } = await activatePlanAndExit("plan body line 1\nplan body line 2");
    const content = pm.readPlanFile();
    expect(content).toContain("plan body line 1");
    expect(content).toContain("plan body line 2");
  });
});

describe("createPlanReinjector: skip rules", () => {
  it("returns messages unchanged when no current plan", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { createPlanReinjector } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const pm = new PlanManager(makeWorkspace());
    const phase = createPlanReinjector(pm, { interval: 3 });
    const msgs = [{ role: "user", content: "hi" }];
    const out = await phase(msgs as any);
    expect(out).toEqual(msgs);
  });

  it("returns messages unchanged when plan file is literally empty (post-exit overwrite)", async () => {
    // exitPlanMode(true) prepends a `> Status: **approved**` line, so the
    // plan file is NEVER literally empty even when activatePlanAndExit("")
    // is called. To test the "empty file → skip" contract honestly, we
    // must overwrite the plan file to empty AFTER exit.
    const { writeFileSync } = await import("node:fs");
    const { createPlanReinjector } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("placeholder body");
    // Forcibly empty the plan file on disk.
    writeFileSync(pm.currentPlan!.filePath, "", "utf-8");
    expect(pm.readPlanFile()).toBe("");
    const phase = createPlanReinjector(pm, { interval: 3 });
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    const msgs = [{ role: "user", content: "hi" }];
    const out = await phase(msgs as any);
    expect(out.length).toBe(msgs.length);
    expect(
      out.every(
        (m: any) => typeof m.content !== "string" || !m.content.includes("<plan-reinjection>"),
      ),
    ).toBe(true);
  });

  it("returns messages unchanged when plan file is whitespace-only", async () => {
    // Companion to the literal-empty case: whitespace-only content must
    // also skip injection. Overwrite the file after exit so the status
    // line doesn't mask the whitespace-only invariant.
    const { writeFileSync } = await import("node:fs");
    const { createPlanReinjector } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("placeholder");
    writeFileSync(pm.currentPlan!.filePath, "   \n\t\n  ", "utf-8");
    expect((pm.readPlanFile() ?? "").trim()).toBe("");
    const phase = createPlanReinjector(pm, { interval: 3 });
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    const msgs = [{ role: "user", content: "hi" }];
    const out = await phase(msgs as any);
    expect(out.length).toBe(msgs.length);
    expect(
      out.every(
        (m: any) => typeof m.content !== "string" || !m.content.includes("<plan-reinjection>"),
      ),
    ).toBe(true);
  });

  it("returns messages unchanged while inPlanMode is true", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { createPlanReinjector } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const pm = new PlanManager(makeWorkspace());
    pm.enterPlanMode("Draft");
    pm.writePlanContent("real plan content");
    // Still in plan mode.
    expect(pm.inPlanMode).toBe(true);
    const phase = createPlanReinjector(pm, { interval: 1 });
    const msgs = [{ role: "user", content: "hi" }];
    const out = await phase(msgs as any);
    expect(out).toEqual(msgs);
  });

  it("returns messages unchanged when verificationCompleted is true", async () => {
    const { createPlanReinjector } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("real plan");
    pm.markVerified();
    const phase = createPlanReinjector(pm, { interval: 3 });
    // Drive turnsSinceExit high enough to otherwise qualify.
    for (let i = 0; i < 6; i++) pm.incrementTurnsSinceExit();
    const msgs = [{ role: "user", content: "hi" }];
    const out = await phase(msgs as any);
    expect(out.length).toBe(msgs.length);
    expect(
      out.every(
        (m: any) => typeof m.content !== "string" || !m.content.includes("<plan-reinjection>"),
      ),
    ).toBe(true);
  });

  it("returns messages unchanged when turnsSinceExit === 0", async () => {
    const { createPlanReinjector } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("real plan");
    expect(pm.turnsSinceExit).toBe(0);
    const phase = createPlanReinjector(pm, { interval: 1 });
    const msgs = [{ role: "user", content: "hi" }];
    const out = await phase(msgs as any);
    expect(out).toEqual(msgs);
  });

  it("interval=0 disables reinjection entirely (even on turn 3)", async () => {
    const { createPlanReinjector } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("real plan");
    const phase = createPlanReinjector(pm, { interval: 0 });
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    pm.incrementTurnsSinceExit();
    const msgs = [{ role: "user", content: "hi" }];
    const out = await phase(msgs as any);
    expect(out).toEqual(msgs);
  });
});

describe("createPlanReinjector: cadence (interval=3)", () => {
  it("injects at turns 3, 6, 9 and skips at turns 1, 2, 4, 5, 7, 8", async () => {
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("the plan body");
    const phase = createPlanReinjector(pm, { interval: 3 });

    const expected: Record<number, boolean> = {
      1: false,
      2: false,
      3: true,
      4: false,
      5: false,
      6: true,
      7: false,
      8: false,
      9: true,
    };

    for (let turn = 1; turn <= 9; turn++) {
      pm.incrementTurnsSinceExit();
      expect(pm.turnsSinceExit).toBe(turn);
      const msgs = [{ role: "user", content: `prompt-${turn}` }];
      const out = await phase(msgs as any);
      // Reminder is inserted BEFORE the terminal user message, so search
      // the whole array rather than only checking the last element.
      const injected =
        out.length > msgs.length &&
        out.some(
          (m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN),
        );
      expect(injected).toBe(expected[turn]);
    }
  });

  it("interval=10 skips at turn 3 and injects at turn 10", async () => {
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("plan");
    const phase = createPlanReinjector(pm, { interval: 10 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();
    let out = await phase([{ role: "user", content: "x" }] as any);
    expect(out.length).toBe(1);

    for (let i = 3; i < 10; i++) pm.incrementTurnsSinceExit();
    expect(pm.turnsSinceExit).toBe(10);
    out = await phase([{ role: "user", content: "x" }] as any);
    expect(out.length).toBe(2);
    // Reminder at index 0 (before the terminal user message at index 1).
    expect((out[0].content as string)).toContain(PLAN_REINJECTION_OPEN);
  });
});

describe("createPlanReinjector: cadence correctness (R2 finding #1)", () => {
  it("with interval=3: fires on turn 3 (not 4), absent on turns 1-2", async () => {
    // Explicit regression for the off-by-one bug (R2 F1). With pre-increment
    // semantics (bump BEFORE transformContext runs), turnsSinceExit=3 on turn
    // 3 → 3%3=0 → fire. Previously the increment was post-prompt so
    // transformContext saw turnsSinceExit=2 on turn 3 and fired on turn 4.
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("plan body");
    const phase = createPlanReinjector(pm, { interval: 3 });

    const userMsg = () => [{ role: "user", content: "prompt" }];

    pm.incrementTurnsSinceExit(); // turn 1
    let out = await phase(userMsg() as any);
    expect(out.some((m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN))).toBe(false);

    pm.incrementTurnsSinceExit(); // turn 2
    out = await phase(userMsg() as any);
    expect(out.some((m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN))).toBe(false);

    pm.incrementTurnsSinceExit(); // turn 3
    expect(pm.turnsSinceExit).toBe(3);
    out = await phase(userMsg() as any);
    expect(out.some((m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN))).toBe(true);
  });

  it("exit-turn swallow: pre-prompt increment is a no-op while inPlanMode; first real post-exit turn fires at interval=1", async () => {
    // With Option A (pre-prompt increment), the bump for the exit turn is
    // naturally suppressed by the _inPlanMode guard — incrementTurnsSinceExit
    // is a no-op when inPlanMode=true. After consumeExitSwallow clears the
    // flag, the first real post-exit turn's increment fires normally.
    const { PlanManager } = await import("../src/planning/index.js");
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const pm = new PlanManager(makeWorkspace());
    pm.enterPlanMode("Task");
    pm.writePlanContent("step 1\nstep 2");

    // Simulate pre-prompt increment on the exit turn (plan mode is still active).
    pm.incrementTurnsSinceExit(); // no-op: inPlanMode=true
    expect(pm.turnsSinceExit).toBe(0); // counter unchanged

    // Simulate exit_plan_mode tool call inside the prompt.
    pm.exitPlanMode(true);         // _inPlanMode → false
    pm.markExitedInThisTurn();     // arm the swallow flag
    pm.consumeExitSwallow();       // clear flag (no counter change needed)
    expect(pm.turnsSinceExit).toBe(0); // exit turn still not counted ✓

    // First real post-exit turn.
    const phase = createPlanReinjector(pm, { interval: 1 });
    pm.incrementTurnsSinceExit(); // now active, bumps to 1
    expect(pm.turnsSinceExit).toBe(1);
    const out = await phase([{ role: "user", content: "next?" }] as any);
    // interval=1 → fires on turn 1.
    expect(out.some((m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN))).toBe(true);
  });
});

describe("createPlanReinjector: content shape", () => {
  it("inserts a meta user message BEFORE the terminal user message with plan content, markers, and verification instruction", async () => {
    const {
      createPlanReinjector,
      PLAN_REINJECTION_OPEN,
      PLAN_REINJECTION_CLOSE,
    } = await import("../src/compaction/plan-reinjector.js");
    const planBody = "# Heading\n1. step one\n2. step two with details";
    const { pm } = await activatePlanAndExit(planBody);
    const phase = createPlanReinjector(pm, { interval: 3 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();
    // Use a realistic conversation that ends with a user turn (the common case).
    const msgs = [
      { role: "user", content: "what's next?" },
      { role: "assistant", content: "working on it" },
      { role: "user", content: "can you continue?" },
    ];
    const out = await phase(msgs as any);
    expect(out.length).toBe(msgs.length + 1);
    // Prefix messages preserved in order.
    expect(out[0]).toEqual(msgs[0]);
    expect(out[1]).toEqual(msgs[1]);
    // Reminder at index 2 (before the terminal user message).
    const reminder = out[2] as any;
    expect(reminder.role).toBe("user");
    expect(reminder.isMeta).toBe(true);
    expect(typeof reminder.content).toBe("string");
    // Terminal user message remains last.
    expect(out[3]).toEqual(msgs[2]);

    const text = reminder.content as string;

    expect(text).toContain(PLAN_REINJECTION_OPEN);
    expect(text).toContain(PLAN_REINJECTION_CLOSE);
    // Constants are sane.
    expect(PLAN_REINJECTION_OPEN).toBe("<plan-reinjection>");
    expect(PLAN_REINJECTION_CLOSE).toBe("</plan-reinjection>");
    // OPEN marker on its own line.
    expect(text.split("\n")).toContain(PLAN_REINJECTION_OPEN);
    // system-reminder wrapper present.
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("</system-reminder>");
    // Full plan body included.
    expect(text).toContain("# Heading");
    expect(text).toContain("1. step one");
    expect(text).toContain("2. step two with details");
    // Status-check instruction.
    expect(text).toContain(
      "briefly state done / in-progress / not started for each plan item",
    );
    // How-to-stop hint.
    expect(text).toContain("/plan verify");
  });
});

describe("createPlanReinjector: reminder placement (Finding 1)", () => {
  it("reminder is placed BEFORE the terminal user message in a multi-turn conversation", async () => {
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("plan body");
    const phase = createPlanReinjector(pm, { interval: 3 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();

    const msgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "first assistant reply" },
      { role: "user", content: "second user turn (terminal)" },
    ];
    const out = await phase(msgs as any);
    expect(out.length).toBe(msgs.length + 1);
    // Terminal user message must remain the last message.
    const last = out[out.length - 1] as any;
    expect(last.content).toBe("second user turn (terminal)");
    expect(last.role).toBe("user");
    // Reminder is immediately before the terminal user message.
    const reminderMsg = out[out.length - 2] as any;
    expect(reminderMsg.content).toContain(PLAN_REINJECTION_OPEN);
    expect(reminderMsg.role).toBe("user");
    expect(reminderMsg.isMeta).toBe(true);
  });

  it("single-user-message input: reminder placed before the user message, user message stays last", async () => {
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("plan");
    const phase = createPlanReinjector(pm, { interval: 3 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();

    const userMsg = { role: "user", content: "user request" };
    const out = await phase([userMsg] as any);
    expect(out.length).toBe(2);
    // Reminder at index 0 (before the user message).
    expect((out[0] as any).content).toContain(PLAN_REINJECTION_OPEN);
    expect((out[0] as any).isMeta).toBe(true);
    // User message at index 1 (last).
    expect(out[1]).toEqual(userMsg);
  });

  it("fallback: no terminal user message → reminder prepended at index 0", async () => {
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("plan");
    const phase = createPlanReinjector(pm, { interval: 3 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();

    // Messages with no user role — the fallback path prepends the reminder.
    const msgs = [{ role: "assistant", content: "assistant-only message" }];
    const out = await phase(msgs as any);
    expect(out.length).toBe(msgs.length + 1);
    expect((out[0] as any).content).toContain(PLAN_REINJECTION_OPEN);
    expect((out[0] as any).isMeta).toBe(true);
    // Original message follows.
    expect(out[1]).toEqual(msgs[0]);
  });
});

describe("createPlanReinjector: post-verify silence", () => {
  it("does not inject after markVerified, even when turns cross the interval", async () => {
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("plan body");
    const phase = createPlanReinjector(pm, { interval: 3 });
    // Cross the interval once (would normally inject).
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();
    const firstOut = await phase([{ role: "user", content: "q" }] as any);
    // Reminder is inserted before the terminal user message (not at end).
    expect(
      firstOut.some(
        (m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN),
      ),
    ).toBe(true);

    pm.markVerified();

    // Continue turns — no further injections.
    for (let i = 3; i < 6; i++) pm.incrementTurnsSinceExit();
    expect(pm.turnsSinceExit).toBe(6);
    const secondOut = await phase([{ role: "user", content: "q" }] as any);
    expect(secondOut.length).toBe(1);
    expect(
      secondOut.every(
        (m: any) => typeof m.content !== "string" || !m.content.includes(PLAN_REINJECTION_OPEN),
      ),
    ).toBe(true);
  });
});

describe("prunePlanReinjections", () => {
  it("keeps only the most recent reinjection; preserves non-reinjection messages in order", async () => {
    const {
      prunePlanReinjections,
      PLAN_REINJECTION_OPEN,
      PLAN_REINJECTION_CLOSE,
    } = await import("../src/compaction/plan-reinjector.js");

    const mkInjection = (n: number) => ({
      role: "user",
      isMeta: true,
      content: `${PLAN_REINJECTION_OPEN}\nReinjection #${n}\nplan body v${n}\n${PLAN_REINJECTION_CLOSE}`,
    });

    const messages = [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "reply 1" },
      mkInjection(1),
      { role: "user", content: "turn 2" },
      { role: "assistant", content: "reply 2" },
      mkInjection(2),
      { role: "user", content: "turn 3" },
      mkInjection(3),
      { role: "assistant", content: "reply 3" },
    ];

    const out = prunePlanReinjections(messages as any);
    const injections = out.filter(
      (m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN),
    );
    expect(injections.length).toBe(1);
    expect((injections[0].content as string)).toContain("Reinjection #3");

    // Non-reinjection messages preserved in original relative order.
    const nonInjections = out.filter(
      (m: any) => !(typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN)),
    );
    expect(nonInjections.map((m: any) => m.content)).toEqual([
      "turn 1",
      "reply 1",
      "turn 2",
      "reply 2",
      "turn 3",
      "reply 3",
    ]);

    // The surviving injection should appear where the latest one did,
    // after "turn 3" and before "reply 3".
    const turn3Idx = out.findIndex((m: any) => m.content === "turn 3");
    const reply3Idx = out.findIndex((m: any) => m.content === "reply 3");
    const survivorIdx = out.findIndex(
      (m: any) => typeof m.content === "string" && m.content.includes("Reinjection #3"),
    );
    expect(survivorIdx).toBeGreaterThan(turn3Idx);
    expect(survivorIdx).toBeLessThan(reply3Idx);
  });

  it("leaves messages with non-string content untouched", async () => {
    const { prunePlanReinjections, PLAN_REINJECTION_OPEN, PLAN_REINJECTION_CLOSE } =
      await import("../src/compaction/plan-reinjector.js");
    const structured = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    };
    const injection = {
      role: "user",
      isMeta: true,
      content: `${PLAN_REINJECTION_OPEN}\nonly\n${PLAN_REINJECTION_CLOSE}`,
    };
    const messages = [structured, injection, structured];
    const out = prunePlanReinjections(messages as any);
    // Structured messages preserved (both instances).
    const structuredSurvivors = out.filter((m: any) => Array.isArray(m.content));
    expect(structuredSurvivors.length).toBe(2);
    // Single injection survives.
    const injectionSurvivors = out.filter(
      (m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN),
    );
    expect(injectionSurvivors.length).toBe(1);
  });

  it("is a no-op when there are zero reinjections", async () => {
    const { prunePlanReinjections } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "there" },
    ];
    const out = prunePlanReinjections(messages as any);
    expect(out).toEqual(messages);
  });
});

describe("createPlanReinjector: abandoned/completed plan status (Finding 2)", () => {
  it("plan marked abandoned does not trigger reinjection even when cadence and all other gates pass", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const pm = new PlanManager(makeWorkspace());
    pm.enterPlanMode("Test plan");
    pm.writePlanContent("plan body");
    pm.exitPlanMode(false); // abandoned
    expect(pm.currentPlan?.status).toBe("abandoned");
    expect(pm.inPlanMode).toBe(false);

    const phase = createPlanReinjector(pm, { interval: 3 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();
    const msgs = [{ role: "user", content: "q" }];
    const out = await phase(msgs as any);
    expect(out).toEqual(msgs);
    expect(
      out.every(
        (m: any) => typeof m.content !== "string" || !m.content.includes(PLAN_REINJECTION_OPEN),
      ),
    ).toBe(true);
  });

  it("plan marked completed does not trigger reinjection even when cadence and all other gates pass", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const pm = new PlanManager(makeWorkspace());
    pm.enterPlanMode("Test plan");
    pm.writePlanContent("plan body");
    pm.closePlanMode("completed");
    expect(pm.currentPlan?.status).toBe("completed");
    expect(pm.inPlanMode).toBe(false);

    const phase = createPlanReinjector(pm, { interval: 3 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();
    const msgs = [{ role: "user", content: "q" }];
    const out = await phase(msgs as any);
    expect(out).toEqual(msgs);
    expect(
      out.every(
        (m: any) => typeof m.content !== "string" || !m.content.includes(PLAN_REINJECTION_OPEN),
      ),
    ).toBe(true);
  });

  it("plan with active/approved status still triggers reinjection normally", async () => {
    const { createPlanReinjector, PLAN_REINJECTION_OPEN } = await import(
      "../src/compaction/plan-reinjector.js"
    );
    const { pm } = await activatePlanAndExit("plan body");
    // exitPlanMode(true) sets status to "approved".
    expect(pm.currentPlan?.status).toBe("approved");
    const phase = createPlanReinjector(pm, { interval: 3 });
    for (let i = 0; i < 3; i++) pm.incrementTurnsSinceExit();
    const msgs = [{ role: "user", content: "q" }];
    const out = await phase(msgs as any);
    expect(out.length).toBe(msgs.length + 1);
    expect(
      out.some(
        (m: any) => typeof m.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN),
      ),
    ).toBe(true);
  });
});

describe("Wiring check: cli.ts and rpc.ts call incrementTurnsSinceExit", () => {
  // We assert the literal CALL syntax `.incrementTurnsSinceExit(` (trailing
  // open-paren) so that a stray comment, dead import, or bare identifier
  // reference can't satisfy the check. We additionally assert the call site
  // appears AFTER the first `session.prompt(` invocation in the file — a
  // proxy for "the counter is bumped on the user-prompt path, not in some
  // unrelated init block." Both files invoke the agent via
  // `botSession.session.prompt(...)`, so `session.prompt(` is the anchor.
  // Helper: slice a named function's body out of a source string. Starts at
  // the declaration and ends at the next top-level function declaration
  // (or EOF). Good enough for grep-style scoping on pre-formatted TS.
  function sliceFnBody(src: string, fnDecl: string): string {
    const start = src.indexOf(fnDecl);
    if (start < 0) return "";
    const after = src.slice(start + fnDecl.length);
    const nextFnRel = after.search(
      /\n(?:export\s+)?(?:async\s+)?function\s+/,
    );
    return nextFnRel >= 0 ? after.slice(0, nextFnRel) : after;
  }

  it("agent/src/cli.ts runJSON bumps counter BEFORE the primary prompt so transformContext sees the correct turn (R2 fix)", () => {
    // R2 fix: increment must be BEFORE session.prompt so transformContext
    // (running inside prompt) sees the already-incremented counter. Was
    // after, causing cadence to fire one turn later than documented.
    const p = resolve(__dirname, "..", "src", "cli.ts");
    expect(existsSync(p)).toBe(true);
    const src = stripComments(readFileSync(p, "utf-8"));
    const body = sliceFnBody(src, "function runJSON");
    expect(body.length).toBeGreaterThan(0);
    const primaryIdx = body.indexOf(".prompt(args.message)");
    expect(primaryIdx).toBeGreaterThanOrEqual(0);
    const incIdx = body.indexOf(".incrementTurnsSinceExit(");
    expect(incIdx).toBeGreaterThanOrEqual(0);
    // Increment must appear BEFORE the primary prompt call.
    expect(incIdx).toBeLessThan(primaryIdx);
    // Exactly-once invariant: one user turn = one bump.
    const matches = body.match(/\.incrementTurnsSinceExit\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it("agent/src/cli.ts runInteractivePlain rl.on('line') handler bumps counter BEFORE session.prompt( (R2 fix)", () => {
    // R2 fix: increment must be BEFORE session.prompt so transformContext
    // sees the correct turn number. Previously after, causing off-by-one.
    const p = resolve(__dirname, "..", "src", "cli.ts");
    const src = stripComments(readFileSync(p, "utf-8"));
    const fnBody = sliceFnBody(src, "function runInteractivePlain");
    expect(fnBody.length).toBeGreaterThan(0);
    const lineHandler = fnBody.match(
      /rl\.on\(\s*["']line["']\s*,\s*async[\s\S]*?\n\s*\}\);/,
    );
    expect(lineHandler).toBeTruthy();
    const body = lineHandler![0];
    const promptIdx = body.indexOf("session.prompt(");
    const incIdx = body.indexOf(".incrementTurnsSinceExit(");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(incIdx).toBeGreaterThanOrEqual(0);
    // Increment must appear BEFORE the prompt call.
    expect(incIdx).toBeLessThan(promptIdx);
    // Exactly-once inside the line handler.
    const matches = body.match(/\.incrementTurnsSinceExit\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('agent/src/rpc.ts case "prompt" block bumps counter BEFORE session.prompt( (R2 fix)', () => {
    // R2 fix: increment must be BEFORE session.prompt so transformContext
    // sees the correct turn number.
    const p = resolve(__dirname, "..", "src", "rpc.ts");
    expect(existsSync(p)).toBe(true);
    const src = stripComments(readFileSync(p, "utf-8"));
    const m = src.match(/case\s+"prompt"\s*:\s*\{[\s\S]*?\bbreak;/);
    expect(m).toBeTruthy();
    const body = m![0];
    const promptIdx = body.indexOf("session.prompt(");
    const incIdx = body.indexOf(".incrementTurnsSinceExit(");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(incIdx).toBeGreaterThanOrEqual(0);
    // Increment must appear BEFORE the prompt call.
    expect(incIdx).toBeLessThan(promptIdx);
    // Exactly-once inside the `case "prompt"` block.
    const matches = body.match(/\.incrementTurnsSinceExit\(/g) || [];
    expect(matches.length).toBe(1);
  });
});

describe("Wiring check: TUI prompt path bumps counter", () => {
  // Codex round 9: plan §2.4 only specified cli.ts and rpc.ts, but the
  // main TUI prompt path runs through App.tsx:handleSubmit → botSession
  // .session.prompt. The cleanest fix is to centralize the counter bump
  // inside agent.ts's `promptWithRecovery` wrapper (agent.ts:~576), which
  // wraps session.prompt for ALL consumers (cli, rpc, TUI). This test
  // accepts EITHER:
  //   (a) centralized bump inside agent.ts's promptWithRecovery wrapper,
  //       OR
  //   (b) explicit bump inside App.tsx's handleSubmit callback.
  // If neither is wired, the TUI misses every turn and reinjection never
  // fires in interactive mode.
  const agentTsPath = resolve(__dirname, "..", "src", "agent.ts");
  const appTsxPath = resolve(
    __dirname,
    "..",
    "src",
    "tui",
    "components",
    "App.tsx",
  );

  // Extract the promptWithRecovery wrapper from agent.ts, anchored on
  // its literal identifier. The wrapper is an async function expression
  // assigned to `(session as any).prompt`.
  function extractPromptWrapperBody(src: string): string | null {
    const m = src.match(
      /promptWithRecovery[\s\S]*?\{[\s\S]*?\n\s{0,4}\};/,
    );
    return m ? m[0] : null;
  }

  // Extract App.tsx's handleSubmit useCallback arrow body.
  function extractHandleSubmitBody(src: string): string | null {
    const m = src.match(
      /handleSubmit\s*=\s*useCallback\s*\(\s*async[\s\S]*?\n\s{2,4}\},/,
    );
    return m ? m[0] : null;
  }

  it("either agent.ts promptWithRecovery OR App.tsx handleSubmit bumps counter BEFORE the prompt (R2 fix)", () => {
    // R2 fix: increment must be BEFORE the prompt call so transformContext
    // (running inside session.prompt) sees the already-incremented counter.
    const agentSrc = stripComments(readFileSync(agentTsPath, "utf-8"));
    const appSrc = stripComments(readFileSync(appTsxPath, "utf-8"));
    const wrapperBody = extractPromptWrapperBody(agentSrc);
    const submitBody = extractHandleSubmitBody(appSrc);

    const agentHasBump =
      wrapperBody !== null &&
      /\.incrementTurnsSinceExit\s*\(/.test(wrapperBody);
    const appHasBump =
      submitBody !== null &&
      /\.incrementTurnsSinceExit\s*\(/.test(submitBody);

    // At least one location must instrument the TUI turn.
    expect(agentHasBump || appHasBump).toBe(true);

    // Whichever scope has the bump must satisfy the before-prompt ordering.
    const chosen = agentHasBump ? wrapperBody! : submitBody!;
    const promptIdx = chosen.indexOf("session.prompt(") >= 0
      ? chosen.indexOf("session.prompt(")
      : chosen.search(/\brawPrompt\s*\(/);
    expect(promptIdx).toBeGreaterThanOrEqual(0);

    const incIdx = chosen.indexOf(".incrementTurnsSinceExit(");
    expect(incIdx).toBeGreaterThanOrEqual(0);
    // R2 fix: increment must be BEFORE the prompt call.
    expect(incIdx).toBeLessThan(promptIdx);

    // Exactly-once inside whichever scope owns the bump.
    const matches = chosen.match(/\.incrementTurnsSinceExit\(/g) || [];
    expect(matches.length).toBe(1);
  });
});

describe("Wiring check: agent.ts registers the reinjector in transformContext", () => {
  // Static grep trio. A behavioral test would require spinning up
  // createDesignSession, which pulls in model clients + API keys in this
  // codebase — too heavy for a unit test. These three greps together
  // guarantee that (a) the reinjector is constructed, (b) the resulting
  // phase is bound to a `planReinjector` identifier that transformContext
  // can reference, and (c) the prune helper is also wired in so stale
  // reinjections get cleaned up during compaction.
  const agentSrcPath = resolve(__dirname, "..", "src", "agent.ts");

  it("agent/src/agent.ts constructs the reinjector via createPlanReinjector(", () => {
    expect(existsSync(agentSrcPath)).toBe(true);
    const src = stripComments(readFileSync(agentSrcPath, "utf-8"));
    expect(src).toContain("createPlanReinjector(");
  });

  it("agent/src/agent.ts binds the phase to a planReinjector identifier", () => {
    const src = stripComments(readFileSync(agentSrcPath, "utf-8"));
    expect(src).toContain("planReinjector");
  });

  it("agent/src/agent.ts references prunePlanReinjections", () => {
    const src = stripComments(readFileSync(agentSrcPath, "utf-8"));
    expect(src).toContain("prunePlanReinjections");
  });

  it("agent/src/agent.ts invokes planReinjector( and prunePlanReinjections( inside the transformContext closure body", () => {
    // Proves ATTACHMENT, not PROXIMITY. A fixed char window after
    // `transformContext` would still pass if the invocation landed just
    // after the closure ends. Extract the actual closure body using the
    // same brace/arrow pattern that test-plan-mode-v043-group2.ts
    // (line ~915) uses as a precedent, then grep inside that body.
    // Extract the actual closure body using the same regex precedent as
    // test-plan-mode-v043-group2.ts (line ~915): `transformContext = async`
    // through the matching `\n  };\n`. This scopes the greps to the body
    // proper, so a call placed just after the closure would NOT satisfy it.
    const src = stripComments(readFileSync(agentSrcPath, "utf-8"));
    const fn = src.match(/transformContext\s*=\s*async[\s\S]*?\n\s*\};?\n/);
    expect(fn).toBeTruthy();
    const body = fn![0];
    expect(body).toMatch(/planReinjector\s*\(/);
    expect(body).toMatch(/prunePlanReinjections\s*\(/);
  });

  it("agent/src/agent.ts transformContext runs phases in the corrected order (autoRecall < stateLoader < planReinjector)", () => {
    // Corrected order (round-10 fix, reconciles bug #8 + issue #24):
    //   prunePlanReinjections → toolResultPruner (pruner) → autoRecall
    //   → stateLoader → planReinjector
    //
    // Rationale (two invariants must hold simultaneously):
    //
    //   1. Bug #8 (see agent/tests/test-tier1-bugs.ts:60-74): autoRecall
    //      MUST run BEFORE stateLoader. autoRecall keys on the last user
    //      message; if stateLoader injects a <compaction-state> block
    //      first, that block becomes the "last user message" and
    //      contaminates the memory-search query. Preserve the existing
    //      regression: iAutoRecall < iStateLoader.
    //
    //   2. Issue #24: planReinjector appends a large plan blob as a meta
    //      user message. It must run LAST so neither autoRecall nor
    //      stateLoader ever sees the plan text as the user's query /
    //      state input. Preserve: iPlanReinj is the final phase.
    //
    // Combined chain: prune → pruner → autoRecall → stateLoader → planReinj.
    const src = stripComments(readFileSync(agentSrcPath, "utf-8"));
    const fn = src.match(/transformContext\s*=\s*async[\s\S]*?\n\s*\};?\n/);
    expect(fn).toBeTruthy();
    const body = fn![0];
    const iPrune = body.indexOf("prunePlanReinjections(");
    const iPruner = body.indexOf("pruner(");
    const iAutoRecall = body.indexOf("autoRecall(");
    const iStateLoader = body.indexOf("stateLoader(");
    const iPlanReinj = body.indexOf("planReinjector(");
    expect(iPrune).toBeGreaterThanOrEqual(0);
    expect(iPruner).toBeGreaterThanOrEqual(0);
    expect(iAutoRecall).toBeGreaterThanOrEqual(0);
    expect(iStateLoader).toBeGreaterThanOrEqual(0);
    expect(iPlanReinj).toBeGreaterThanOrEqual(0);
    expect(iPrune).toBeLessThan(iPruner);
    expect(iPruner).toBeLessThan(iAutoRecall);
    expect(iAutoRecall).toBeLessThan(iStateLoader);
    expect(iStateLoader).toBeLessThan(iPlanReinj);
  });

  it("agent/src/agent.ts transformContext threads return values through planReinjector + prunePlanReinjections", () => {
    // Ordering tests above pass even if the Executor writes
    // `planReinjector(transformed);` and discards the return. The phase
    // contract is that each step's output feeds the next — assignment
    // back to a local variable is mandatory. Regex requires an identifier
    // on the LHS of `=` followed by `await planReinjector(`. prunePlan
    // Reinjections may or may not be async; the await is optional.
    const src = stripComments(readFileSync(agentSrcPath, "utf-8"));
    const fn = src.match(/transformContext\s*=\s*async[\s\S]*?\n\s*\};?\n/);
    expect(fn).toBeTruthy();
    const body = fn![0];
    expect(body).toMatch(/\w+\s*=\s*await\s+planReinjector\s*\(/);
    expect(body).toMatch(/\w+\s*=\s*(?:await\s+)?prunePlanReinjections\s*\(/);
  });

  it("agent/src/agent.ts passes reinjectionInterval into createPlanReinjector(", () => {
    // Proves config propagation end-to-end: the createPlanReinjector( call
    // must receive an argument that references `reinjectionInterval`. A
    // hardcoded `3` literal fails this regex. Scoped to the whole file
    // (rather than transformContext body) because createPlanReinjector is
    // typically constructed outside the closure and the returned phase
    // is what gets referenced inside. `[^)]*` is permissive enough to
    // allow patterns like `{ interval: config.plan.reinjectionInterval }`.
    const src = stripComments(readFileSync(agentSrcPath, "utf-8"));
    expect(src).toMatch(/createPlanReinjector\([^)]*reinjectionInterval[^)]*\)/s);
  });
});

describe("Wiring check: /plan verify slash command invokes markVerified()", () => {
  // /plan is intercepted inline in App.tsx (v0.4.3 Group 3, line ~452)
  // before the CommandRegistry. A behavioral test would require booting
  // the Ink TUI, which is prohibitively heavy for a unit test. Instead
  // extract the `/plan` if-block body and prove that the verify branch
  // exists AND calls markVerified(). The block is anchored by its exact
  // condition `text === "/plan" || text.startsWith("/plan ")`.
  const appSrcPath = resolve(
    __dirname,
    "..",
    "src",
    "tui",
    "components",
    "App.tsx",
  );

  it("App.tsx /plan intercept + markVerified() both present (tight scoping deferred to sub-branch test)", () => {
    // Coarse presence check only. A prior version of this test used a
    // range regex terminating on the literal `Route slash commands`
    // comment; stripComments() deletes that comment, which forced a
    // production workaround (a test-only `_section` string). The next
    // test (`/plan verify sub-branch`) provides the real tight scoping —
    // it proves the verify discriminator, markVerified(), and return
    // all live inside the correct sub-branch. Here we only require that
    // both the /plan intercept AND a markVerified( call exist in
    // App.tsx; ordering/scope is enforced below.
    expect(existsSync(appSrcPath)).toBe(true);
    const src = stripComments(readFileSync(appSrcPath, "utf-8"));
    expect(src).toMatch(/text\s*===\s*["']\/plan["']/);
    expect(src).toMatch(/markVerified\s*\(/);
  });

  it("App.tsx /plan verify sub-branch calls markVerified() and returns", () => {
    // Sub-branch scope: a stub that always calls markVerified() (or puts
    // it in the wrong branch) would satisfy the coarse block test above.
    // Here we isolate the verify branch specifically — anchored on a
    // `verify` discriminator in a condition — and require that THAT
    // branch body contains both `markVerified(` and an early `return`
    // so it doesn't fall through to other /plan branches.
    //
    // The conditional can look like any of:
    //   if (taskDesc === "verify") { ... }
    //   if (text === "/plan verify") { ... }
    //   if (args[0] === "verify") { ... }
    //   else if (... "verify" ...) { ... }
    // Regex permissively matches any `if`/`else if` whose condition
    // mentions the literal string "verify", then captures the body up to
    // the matching close-brace at the same indent level (approximated by
    // lazy `[\s\S]*?` + `\n      }` — App.tsx indents at 6 spaces inside
    // the onSubmit handler).
    const src = stripComments(readFileSync(appSrcPath, "utf-8"));
    const m = src.match(
      /(?:else\s+)?if\s*\([^)]*["']verify["'][^)]*\)\s*\{[\s\S]*?\n\s{4,10}\}/,
    );
    expect(m).toBeTruthy();
    const branch = m![0];
    expect(branch).toMatch(/markVerified\s*\(/);
    expect(branch).toMatch(/\breturn\b/);
  });
});

describe("Wiring check: /plan status TUI intercept (Finding 3)", () => {
  // Static grep tests matching the /plan verify pattern. Behavioral tests
  // would require booting the Ink TUI; static checks prove the intercept
  // exists and has the correct structure.
  const appSrcPath = resolve(
    __dirname,
    "..",
    "src",
    "tui",
    "components",
    "App.tsx",
  );

  it("App.tsx /plan status branch dispatches SYSTEM_MESSAGE and returns without creating a plan", () => {
    const src = stripComments(readFileSync(appSrcPath, "utf-8"));
    const m = src.match(
      /(?:else\s+)?if\s*\([^)]*["']status["'][^)]*\)\s*\{[\s\S]*?\n\s{4,10}\}/,
    );
    expect(m).toBeTruthy();
    const branch = m![0];
    // Must dispatch a SYSTEM_MESSAGE (not create a plan).
    expect(branch).toMatch(/SYSTEM_MESSAGE/);
    // Must return early so it doesn't fall through to plan-creation code.
    expect(branch).toMatch(/\breturn\b/);
  });

  it("App.tsx /plan status branch handles the no-plan case with 'No active plan.' message", () => {
    const src = stripComments(readFileSync(appSrcPath, "utf-8"));
    const m = src.match(
      /(?:else\s+)?if\s*\([^)]*["']status["'][^)]*\)\s*\{[\s\S]*?\n\s{4,10}\}/,
    );
    expect(m).toBeTruthy();
    const branch = m![0];
    expect(branch).toContain("No active plan.");
  });

  it("App.tsx /plan status branch includes plan title, id, and status in the active-plan case", () => {
    const src = stripComments(readFileSync(appSrcPath, "utf-8"));
    const m = src.match(
      /(?:else\s+)?if\s*\([^)]*["']status["'][^)]*\)\s*\{[\s\S]*?\n\s{4,10}\}/,
    );
    expect(m).toBeTruthy();
    const branch = m![0];
    expect(branch).toMatch(/pm\.currentPlan/);
    expect(branch).toMatch(/\.status/);
    expect(branch).toMatch(/\.title/);
    expect(branch).toMatch(/\.id/);
  });
});

describe("Wiring check: runInteractivePlain slash intercept (R2 finding #2)", () => {
  // Static grep tests confirming that runInteractivePlain intercepts /commands
  // via parseCommand before falling through to session.prompt. This gives
  // /plan verify|status a working path in plain CLI mode.
  const cliSrcPath = resolve(__dirname, "..", "src", "cli.ts");

  function sliceFnBody(src: string, fnDecl: string): string {
    const start = src.indexOf(fnDecl);
    if (start < 0) return "";
    const after = src.slice(start + fnDecl.length);
    const nextFnRel = after.search(/\n(?:export\s+)?(?:async\s+)?function\s+/);
    return nextFnRel >= 0 ? after.slice(0, nextFnRel) : after;
  }

  it("runInteractivePlain rl.on('line') handler calls parseCommand( before session.prompt(", () => {
    const src = stripComments(readFileSync(cliSrcPath, "utf-8"));
    const fnBody = sliceFnBody(src, "function runInteractivePlain");
    const lineHandler = fnBody.match(
      /rl\.on\(\s*["']line["']\s*,\s*async[\s\S]*?\n\s*\}\);/,
    );
    expect(lineHandler).toBeTruthy();
    const body = lineHandler![0];
    const parseIdx = body.indexOf("parseCommand(");
    const promptIdx = body.indexOf("session.prompt(");
    expect(parseIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    // parseCommand intercept must appear BEFORE the session.prompt call
    // so slash commands are routed to the registry, not sent to the model.
    expect(parseIdx).toBeLessThan(promptIdx);
  });

  it("runInteractivePlain slash intercept returns early (does not fall through to session.prompt)", () => {
    const src = stripComments(readFileSync(cliSrcPath, "utf-8"));
    const fnBody = sliceFnBody(src, "function runInteractivePlain");
    const lineHandler = fnBody.match(
      /rl\.on\(\s*["']line["']\s*,\s*async[\s\S]*?\n\s*\}\);/,
    );
    expect(lineHandler).toBeTruthy();
    const body = lineHandler![0];
    // The slash intercept must contain a return statement so it doesn't
    // fall through to the main session.prompt user-turn path.
    const parseIdx = body.indexOf("parseCommand(");
    const promptIdx = body.indexOf("session.prompt(");
    // Find the first `return` after parseCommand and before session.prompt
    const returnInIntercept = body.indexOf("return;", parseIdx);
    expect(returnInIntercept).toBeGreaterThanOrEqual(0);
    expect(returnInIntercept).toBeLessThan(promptIdx);
  });

  it("plain text input still reaches session.prompt (regression)", () => {
    // The slash intercept must only trigger for inputs starting with '/'.
    // Plain text must still go to session.prompt (regression check).
    const src = stripComments(readFileSync(cliSrcPath, "utf-8"));
    const fnBody = sliceFnBody(src, "function runInteractivePlain");
    const lineHandler = fnBody.match(
      /rl\.on\(\s*["']line["']\s*,\s*async[\s\S]*?\n\s*\}\);/,
    );
    expect(lineHandler).toBeTruthy();
    const body = lineHandler![0];
    // The slash intercept must be gated on input.startsWith("/") so
    // plain text bypasses it.
    expect(body).toMatch(/input\.startsWith\s*\(\s*["']\//);
    // session.prompt( must still exist in the handler (the non-slash path).
    expect(body).toContain("session.prompt(");
  });
});

describe("Settings: plan.reinjectionInterval default + override", () => {
  // loadConfig() produces the effective config after merging settings.json.
  // We cast to `any` so the test compiles before the Executor adds the
  // field to QlayBotConfig — the behavioral contract is what's pinned.
  it("loadConfig() with an empty config dir defaults plan.reinjectionInterval to 3", async () => {
    const { loadConfig } = await import("../src/config.js");
    const emptyDir = makeWorkspace();
    const config = loadConfig(emptyDir) as any;
    expect(config.plan).toBeDefined();
    expect(config.plan.reinjectionInterval).toBe(3);
  });

  it("loadConfig() applies plan.reinjectionInterval override from settings.json", async () => {
    // An Executor could hardcode `3` in agent.ts and satisfy the default
    // test. This test writes settings.json with a non-default value (5)
    // and asserts the override propagates, proving the field is actually
    // read from disk and flows into the merged config.
    const { writeFileSync } = await import("node:fs");
    const { loadConfig } = await import("../src/config.js");
    const dir = makeWorkspace();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ plan: { reinjectionInterval: 5 } }),
      "utf-8",
    );
    const config = loadConfig(dir) as any;
    expect(config.plan).toBeDefined();
    expect(config.plan.reinjectionInterval).toBe(5);
  });

  it("loadConfig() honours plan.reinjectionInterval=0 (disabled) from settings.json", async () => {
    // The disable-knob path. interval=0 must propagate cleanly; the unit
    // test of createPlanReinjector already verifies that 0 disables the
    // phase, but that's only useful if config actually delivers 0.
    const { writeFileSync } = await import("node:fs");
    const { loadConfig } = await import("../src/config.js");
    const dir = makeWorkspace();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ plan: { reinjectionInterval: 0 } }),
      "utf-8",
    );
    const config = loadConfig(dir) as any;
    expect(config.plan.reinjectionInterval).toBe(0);
  });
});
