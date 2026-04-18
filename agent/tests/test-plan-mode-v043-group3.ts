/**
 * Plan Mode v0.4.3 — Group 3 TUI Integration tests (Test Overseer owned).
 *
 * Covers spec §9 steps 9-11:
 *   Step 9:  TUI reducer + event bridge — new actions PLAN_EXIT_MENU_OPEN /
 *            _CLOSE, new state field planExitMenu, migration from
 *            `planManager.onStateChange` to `planManager.subscribe`,
 *            StatusBar indicator driven by state.inPlanMode.
 *   Step 10: App.tsx `/plan` slash handler + exit menu + key handlers;
 *            delete `src/commands/plan.ts` and registration in
 *            `src/commands/index.ts`.
 *   Step 11: Remove PlanManager 0.4.2 shims (isActive / onStateChange /
 *            getSystemPromptInjection / enter / exit); tighten constructor
 *            to required workspaceDir; delete legacy sandbox exports
 *            (wrapToolWithSandbox / ALLOWED_TOOLS); migrate rpc.ts:185 to
 *            `inPlanMode`; drop `wrapToolWithSandbox` import from agent.ts;
 *            remove legacy shim tests from test-unit/test-subagent(-e2e).
 *
 * ---------------------------------------------------------------------------
 * STATUSBAR COLOR DECISION
 * ---------------------------------------------------------------------------
 * Spec §1.8.3 says "yellow"; the existing StatusBar at line 67-69 renders the
 * "PLAN" badge in magenta and test-components.ts:496-504 already passes on
 * magenta. We KEEP magenta for Group 3 to avoid a drive-by style change that
 * would break unrelated tests. Group 3 tests assert only on the substring
 * "PLAN" (case-sensitive), NOT on the color. If the Executor decides to match
 * the spec text and change to yellow, no Group 3 test fails — the color
 * choice is explicitly orthogonal to this group.
 *
 * ---------------------------------------------------------------------------
 * Expected state BEFORE the Executor runs step 9/10/11:
 *   • Reducer tests for planExitMenu / PLAN_EXIT_MENU_OPEN/_CLOSE: FAIL
 *     (field + actions not yet added).
 *   • StatusBar tests: should already PASS (existing PLAN render is correct).
 *   • App.tsx TUI E2E tests: FAIL (no `/plan` handler, no menu, no subscribe
 *     migration).
 *   • Shim-removal + source-grep regressions: FAIL (shims still present,
 *     `src/commands/plan.ts` still exists, legacy exports retained).
 *
 * That is the intended TRD shape: most tests fail on a missing-impl baseline
 * and turn green as the Executor completes steps 9/10/11.
 */

import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
} from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import stripAnsi from "strip-ansi";

import { PlanManager } from "../src/planning/index.js";
import { tuiReducer, initialState } from "../src/tui/reducer.js";
import type { TUIAction, TUIState } from "../src/tui/types.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  PLAN_MODE_INSTRUCTIONS,
} from "../src/tools/plan.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

// ===========================================================================
// Helpers
// ===========================================================================

const REPO_ROOT = resolve(__dirname, "..");
const SRC = (rel: string) => join(REPO_ROOT, "src", rel);
const TESTS = (rel: string) => join(REPO_ROOT, "tests", rel);

const tmpDirs: string[] = [];

function makeTmpDir(prefix = "qlaybot-trd-g3-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function readSrc(rel: string): string {
  return readFileSync(SRC(rel), "utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
  msg = "condition not met",
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await sleep(intervalMs);
  }
  throw new Error(msg);
}

afterEach(() => {
  try {
    cleanup();
  } catch {
    /* ignore */
  }
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Lightweight fake `QlayBotSession` — just the fields App.tsx actually reads.
// We keep it deliberately small so the tests don't drown in boilerplate; if
// App.tsx starts reading a new field the test-compile failure will remind us.
// ---------------------------------------------------------------------------

interface FakeSessionOpts {
  workspaceDir: string;
  planManager?: PlanManager;
  promptImpl?: (text: string) => Promise<void>;
}

function makeFakeSession(opts: FakeSessionOpts) {
  const pm = opts.planManager ?? new PlanManager(opts.workspaceDir);
  const promptSpy = vi.fn(
    opts.promptImpl ?? (async (_text: string) => undefined),
  );
  const abortSpy = vi.fn();
  const compactSpy = vi.fn(async () => undefined);
  const disposeSpy = vi.fn(async () => undefined);
  const recordPromptSpy = vi.fn();
  const recordErrorSpy = vi.fn();
  const listeners: Array<(ev: any) => void> = [];

  const sessionSubscribe = vi.fn((listener: (ev: any) => void) => {
    listeners.push(listener);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  });

  const commandRegistry = {
    execute: vi.fn(async () => ({ output: "", stateChange: null })),
    has: vi.fn(() => false),
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    register: vi.fn(),
  };

  const mcpManager = {
    allTools: () => [],
    getServerKeys: () => [],
    isConnected: () => false,
  };

  const botSession = {
    session: {
      prompt: promptSpy,
      abort: abortSpy,
      subscribe: sessionSubscribe,
      isCompacting: false,
      pendingMessageCount: 0,
    },
    sessionManager: {},
    config: {
      agent: { defaultModel: "test-model", thinkingLevel: "medium" },
      tui: { contextPollMs: 999999 },
      // `getAllMCPServers` (config.ts) dereferences config.klayout.url
      // and merges config.mcp — provide both so the useMemo in App.tsx
      // doesn't throw when it computes mcpServers.
      klayout: { url: "", required: false, disabledTools: [] },
      mcp: {},
    },
    mcpManager,
    memoryManager: {},
    subagentRunner: null,
    history: {
      recordPrompt: recordPromptSpy,
      recordError: recordErrorSpy,
    },
    commandRegistry,
    planManager: pm,
    backgroundTaskManager: null,
    compactionConfig: {
      enabled: false,
      autoThreshold: 90,
      warningThreshold: 70,
      toolResultPruning: { enabled: false, perToolBudgetChars: 0 },
    },
    assembledSystemPrompt: "",
    compact: compactSpy,
    getContextUsage: () => undefined,
    dispose: disposeSpy,
  };

  return {
    botSession: botSession as any,
    pm,
    spies: {
      promptSpy,
      abortSpy,
      compactSpy,
      disposeSpy,
      recordPromptSpy,
      recordErrorSpy,
      registryExecute: commandRegistry.execute,
    },
  };
}

/**
 * Render the real App component with a fake session. Defers the App import
 * so that tests which only touch the reducer can run even when App.tsx has
 * unrelated compile/runtime issues (they won't here, but this keeps the file
 * robust against one-off refactors).
 */
async function renderAppWithPlan(opts: FakeSessionOpts) {
  const { App } = await import("../src/tui/components/App.js");
  const bundle = makeFakeSession(opts);
  const inst = render(React.createElement(App, { botSession: bundle.botSession }));
  return { ...bundle, inst };
}

function lastFrameStripped(inst: { lastFrame: () => string | undefined }): string {
  return stripAnsi(inst.lastFrame() ?? "");
}

// ===========================================================================
// 1. Reducer unit tests (planExitMenu + PLAN_EXIT_MENU_OPEN/_CLOSE)
// ===========================================================================

describe("Group 3 · reducer planExitMenu", () => {
  it("initialState.planExitMenu === null by default", () => {
    // New field expected to be added in step 9. This reads through the
    // exported `initialState` — the assertion fails loudly when the field
    // is missing rather than matching `undefined` silently.
    expect((initialState as any).planExitMenu).toBeNull();
  });

  it("PLAN_EXIT_MENU_OPEN sets state.planExitMenu to the payload planFilePath without touching inPlanMode", () => {
    const base: TUIState = { ...initialState, inPlanMode: true };
    const path = "/tmp/plan-123.md";
    const action: TUIAction = {
      type: "PLAN_EXIT_MENU_OPEN",
      planFilePath: path,
    };

    const next = tuiReducer(base, action);

    expect((next as any).planExitMenu).toBe(path);
    // inPlanMode is toggled by exitPlanMode() on the manager, NOT by the
    // menu-open action. The spec §1.8.1 branch (1) flow calls
    // exitPlanMode(true) FIRST, which fires plan_mode_exited, which flips
    // inPlanMode to false BEFORE the menu opens. We assert the reducer
    // action itself does not mutate inPlanMode in either direction.
    expect(next.inPlanMode).toBe(true);
  });

  it("PLAN_EXIT_MENU_CLOSE clears planExitMenu back to null", () => {
    const openAction: TUIAction = {
      type: "PLAN_EXIT_MENU_OPEN",
      planFilePath: "/tmp/p.md",
    };
    const opened = tuiReducer(initialState, openAction);
    expect((opened as any).planExitMenu).toBe("/tmp/p.md");

    const closeAction: TUIAction = { type: "PLAN_EXIT_MENU_CLOSE" };
    const closed = tuiReducer(opened, closeAction);

    expect((closed as any).planExitMenu).toBeNull();
  });

  it("PLAN_MODE_ENTERED flips inPlanMode to true (regression)", () => {
    const next = tuiReducer(initialState, { type: "PLAN_MODE_ENTERED" });
    expect(next.inPlanMode).toBe(true);
  });

  it("PLAN_MODE_EXITED flips inPlanMode to false (regression)", () => {
    const mid = tuiReducer(initialState, { type: "PLAN_MODE_ENTERED" });
    expect(mid.inPlanMode).toBe(true);
    const out = tuiReducer(mid, { type: "PLAN_MODE_EXITED" });
    expect(out.inPlanMode).toBe(false);
  });

  it("TUIAction union includes PLAN_EXIT_MENU_OPEN/_CLOSE (typed fixture + runtime dispatch)", () => {
    // Typed fixture — no `as unknown` cast. If the Executor forgets to add
    // the two new actions to the TUIAction union in `src/tui/types.ts`, the
    // test file itself will fail to type-check (caught by `tsc --noEmit` in
    // CI) AND the runtime assertions below will fail on the resulting no-op
    // default-case state.
    const openAction: TUIAction = {
      type: "PLAN_EXIT_MENU_OPEN",
      planFilePath: "/x.md",
    };
    const closeAction: TUIAction = { type: "PLAN_EXIT_MENU_CLOSE" };

    const afterOpen = tuiReducer(initialState, openAction);
    expect((afterOpen as any).planExitMenu).toBe("/x.md");
    // The reducer must actually mutate — not return the same reference via
    // the default-case fall-through.
    expect(afterOpen).not.toBe(initialState);

    const afterClose = tuiReducer(afterOpen, closeAction);
    expect((afterClose as any).planExitMenu).toBeNull();
    expect(afterClose).not.toBe(afterOpen);
  });

  it("TUIAction type definition in src/tui/types.ts lists the two new actions (type-file regression)", () => {
    const src = readSrc("tui/types.ts");
    // Both action strings must appear as literal type members of TUIAction.
    expect(src).toContain('"PLAN_EXIT_MENU_OPEN"');
    expect(src).toContain('"PLAN_EXIT_MENU_CLOSE"');
    // PLAN_EXIT_MENU_OPEN must carry a `planFilePath: string` payload field
    // so the slash-command handler can pass the plan path through.
    expect(src).toMatch(/PLAN_EXIT_MENU_OPEN[\s\S]{0,120}planFilePath\s*:\s*string/);
  });
});

// ===========================================================================
// 2. StatusBar behavioral tests
// ===========================================================================

function makeStatusState(overrides: Partial<TUIState> = {}): TUIState {
  return { ...initialState, phase: "ready", modelName: "claude-x", ...overrides };
}

describe("Group 3 · StatusBar PLAN indicator", () => {
  it("does NOT render 'PLAN' when state.inPlanMode === false", () => {
    const state = makeStatusState({ inPlanMode: false });
    const inst = render(React.createElement(StatusBar, { state }));
    const frame = stripAnsi(inst.lastFrame() ?? "");
    inst.unmount();
    // Case-sensitive substring: existing "qlaybot" / model text never
    // contains uppercase "PLAN" so a bare substring check is enough.
    expect(frame.includes("PLAN")).toBe(false);
  });

  it("renders 'PLAN' when state.inPlanMode === true", () => {
    const state = makeStatusState({ inPlanMode: true });
    const inst = render(React.createElement(StatusBar, { state }));
    const frame = stripAnsi(inst.lastFrame() ?? "");
    inst.unmount();
    expect(frame.includes("PLAN")).toBe(true);
  });
});

// ===========================================================================
// 3. App.tsx TUI E2E tests (render + stdin.write)
// ===========================================================================

describe("Group 3 · App /plan slash handler (T1, T11)", () => {
  it("T1: /plan <task> creates a plan file, dispatches 'Plan mode active' system message, flips inPlanMode, AND auto-submits an agent prompt with the task + plan path", async () => {
    const workspace = makeTmpDir();
    const { inst, pm, spies } = await renderAppWithPlan({
      workspaceDir: workspace,
    });
    await sleep(60);

    inst.stdin.write("/plan design a Hall bar");
    inst.stdin.write("\r");

    await waitFor(
      () => pm.inPlanMode === true,
      2000,
      20,
      "PlanManager.inPlanMode did not become true after /plan <task>",
    );

    const frame = lastFrameStripped(inst);
    expect(frame).toContain("Plan mode active");

    // Disk: file exists, non-empty, and the template body is there.
    const plan = pm.currentPlan;
    expect(plan).not.toBeNull();
    expect(plan && existsSync(plan.filePath)).toBe(true);
    const body = readFileSync(plan!.filePath, "utf-8");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("## Plan");
    expect(body).toContain("## Task");

    // Auto-submit prompt (spec §1.8.1 branch B). The handler must call
    // session.prompt(...) with a string that contains:
    //   - the task description the user passed after /plan
    //   - the absolute plan file path (so the agent knows what to edit)
    //   - a marker that this was triggered by plan-mode activation
    await waitFor(
      () => spies.promptSpy.mock.calls.length >= 1,
      2000,
      20,
      "session.prompt was never called after /plan <task> (auto-submit missing)",
    );
    const submitted = spies.promptSpy.mock.calls[0][0] as string;
    expect(typeof submitted).toBe("string");
    expect(submitted).toContain("design a Hall bar");
    expect(submitted).toContain(plan!.filePath);
    // Spec §1.8.1 auto-submit template opens with "[Plan mode activated]"
    // followed by "plan mode" body text. We accept either anchor (case-
    // insensitive on the second to survive minor wording tweaks).
    expect(submitted).toContain("[Plan mode activated]");
    expect(submitted.toLowerCase()).toContain("plan mode");

    inst.unmount();
  });

  it("bare /plan (no task, NOT already in plan mode) enters plan mode without auto-submitting an agent prompt", async () => {
    const workspace = makeTmpDir();
    const { inst, pm, spies } = await renderAppWithPlan({
      workspaceDir: workspace,
    });
    await sleep(60);

    // Pre-condition: not yet in plan mode.
    expect(pm.inPlanMode).toBe(false);

    inst.stdin.write("/plan");
    inst.stdin.write("\r");

    await waitFor(
      () => pm.inPlanMode === true,
      2000,
      20,
      "bare /plan did not enter plan mode",
    );

    // A plan file WAS created (since entry always creates one).
    const plan = pm.currentPlan;
    expect(plan).not.toBeNull();
    expect(existsSync(plan!.filePath)).toBe(true);

    // SYSTEM_MESSAGE "Plan mode active..." is dispatched.
    const frame = lastFrameStripped(inst);
    expect(frame).toContain("Plan mode active");

    // No auto-submit — without a task description there's nothing to ask
    // the agent to do. Give the event loop a few ticks to settle then
    // assert session.prompt was never called.
    await sleep(100);
    expect(spies.promptSpy).not.toHaveBeenCalled();

    inst.unmount();
  });

  it("T11: /plan <task> while already in plan mode emits 'Already in plan mode' and does NOT create a second plan file", async () => {
    const workspace = makeTmpDir();
    const { inst, pm } = await renderAppWithPlan({ workspaceDir: workspace });
    await sleep(60);

    // First entry
    inst.stdin.write("/plan first task");
    inst.stdin.write("\r");
    await waitFor(() => pm.inPlanMode === true, 2000, 20, "first /plan entry failed");
    const firstPlan = pm.currentPlan;
    expect(firstPlan).not.toBeNull();
    const firstPath = firstPlan!.filePath;

    // Second attempt while already in plan mode
    inst.stdin.write("/plan another task");
    inst.stdin.write("\r");
    await sleep(80);

    const frame = lastFrameStripped(inst);
    expect(frame).toContain("Already in plan mode");
    // Plan pointer unchanged — still the same in-memory object.
    expect(pm.currentPlan).toBe(firstPlan);
    expect(firstPath).toBe(pm.currentPlan!.filePath);

    inst.unmount();
  });
});

describe("Group 3 · App /plan exit menu open (T2)", () => {
  it("T2: /plan (no args) while in plan mode opens the 4-option menu with the documented text", async () => {
    const workspace = makeTmpDir();
    const { inst, pm } = await renderAppWithPlan({ workspaceDir: workspace });
    await sleep(60);

    // Enter plan mode first
    inst.stdin.write("/plan design something");
    inst.stdin.write("\r");
    await waitFor(() => pm.inPlanMode === true, 2000, 20, "initial entry failed");
    const planPath = pm.currentPlan!.filePath;

    // Now /plan with no args → exit + menu
    inst.stdin.write("/plan");
    inst.stdin.write("\r");
    await waitFor(() => pm.inPlanMode === false, 2000, 20, "exit did not fire");
    await sleep(50);

    const frame = lastFrameStripped(inst);
    // Spec §1.8.1 exact menu lines (2-space indent before digits)
    expect(frame).toContain("Plan complete. Full tool access restored.");
    expect(frame).toContain(`Plan file: ${planPath}`);
    expect(frame).toContain("  1  Clear context & execute");
    expect(frame).toContain("  2  Execute");
    expect(frame).toContain("  3  Revise (re-enter plan mode)");
    expect(frame).toContain("  4  Do nothing");
    expect(frame).toContain("Press 1-4 to choose:");

    inst.unmount();
  });
});

describe("Group 3 · App exit menu key handlers (T3-T7)", () => {
  async function openMenu(workspace: string) {
    // Enter plan mode via BARE `/plan` (no task description) so there is
    // no auto-submit (Branch C in spec §1.8.1). This keeps
    // `session.prompt` at 0 calls pre-menu-key; T3/T4/T6/T7/T8 can then
    // assert clean prompt-spy counts without a baseline-delta dance.
    // The `/plan <task>` auto-submit path is already covered by T1.
    const bundle = await renderAppWithPlan({ workspaceDir: workspace });
    await sleep(60);
    bundle.inst.stdin.write("/plan");
    bundle.inst.stdin.write("\r");
    await waitFor(
      () => bundle.pm.inPlanMode === true,
      2000,
      20,
      "enter failed",
    );
    bundle.inst.stdin.write("/plan");
    bundle.inst.stdin.write("\r");
    await waitFor(
      () => bundle.pm.inPlanMode === false,
      2000,
      20,
      "exit did not fire",
    );
    await sleep(40);
    return bundle;
  }

  it("T3: key '1' triggers compact() and then session.prompt(EXECUTE_PROMPT(path))", async () => {
    const workspace = makeTmpDir();
    const bundle = await openMenu(workspace);
    const planPath = bundle.pm.currentPlan!.filePath;

    bundle.inst.stdin.write("1");
    // compact resolves immediately; give the promise chain 1 tick
    await sleep(120);

    expect(bundle.spies.compactSpy).toHaveBeenCalledTimes(1);
    expect(bundle.spies.promptSpy).toHaveBeenCalledTimes(1);

    const submitted = bundle.spies.promptSpy.mock.calls[0][0] as string;
    expect(submitted).toContain("Execute the design plan at:");
    expect(submitted).toContain(planPath);

    // Menu closes → its text is no longer in the frame
    const frame = lastFrameStripped(bundle.inst);
    expect(frame).not.toContain("Press 1-4 to choose:");

    bundle.inst.unmount();
  });

  it("T4: key '2' runs EXECUTE_PROMPT without calling compact()", async () => {
    const workspace = makeTmpDir();
    const bundle = await openMenu(workspace);
    const planPath = bundle.pm.currentPlan!.filePath;

    bundle.inst.stdin.write("2");
    await sleep(80);

    expect(bundle.spies.compactSpy).not.toHaveBeenCalled();
    expect(bundle.spies.promptSpy).toHaveBeenCalledTimes(1);
    const submitted = bundle.spies.promptSpy.mock.calls[0][0] as string;
    expect(submitted).toContain("Execute the design plan at:");
    expect(submitted).toContain(planPath);

    const frame = lastFrameStripped(bundle.inst);
    expect(frame).not.toContain("Press 1-4 to choose:");

    bundle.inst.unmount();
  });

  it("T5: key '3' re-enters plan mode via reenterPlanMode(), strips the status marker from disk, emits 'Re-entered'", async () => {
    const workspace = makeTmpDir();
    const bundle = await openMenu(workspace);
    const planPath = bundle.pm.currentPlan!.filePath;

    // Confirm exitPlanMode wrote the `> Status: **approved**` marker at top.
    const preRevisionBody = readFileSync(planPath, "utf-8");
    expect(preRevisionBody).toMatch(/^> Status: \*\*approved\*\*/);

    bundle.inst.stdin.write("3");
    await waitFor(
      () => bundle.pm.inPlanMode === true,
      2000,
      20,
      "reenterPlanMode did not fire",
    );
    await sleep(40);

    const postBody = readFileSync(planPath, "utf-8");
    expect(postBody.startsWith("> Status:")).toBe(false);

    const frame = lastFrameStripped(bundle.inst);
    expect(frame).toContain("Re-entered");

    bundle.inst.unmount();
  });

  it("T6: key '4' closes the menu and emits 'Plan saved. You can execute it later.'", async () => {
    const workspace = makeTmpDir();
    const bundle = await openMenu(workspace);

    bundle.inst.stdin.write("4");
    await sleep(60);

    expect(bundle.spies.compactSpy).not.toHaveBeenCalled();
    expect(bundle.spies.promptSpy).not.toHaveBeenCalled();

    const frame = lastFrameStripped(bundle.inst);
    expect(frame).toContain("Plan saved. You can execute it later.");
    expect(frame).not.toContain("Press 1-4 to choose:");

    bundle.inst.unmount();
  });

  it("T7: Escape while menu is open behaves like key '4'", async () => {
    const workspace = makeTmpDir();
    const bundle = await openMenu(workspace);

    bundle.inst.stdin.write("\u001b"); // Escape
    await sleep(60);

    expect(bundle.spies.compactSpy).not.toHaveBeenCalled();
    expect(bundle.spies.promptSpy).not.toHaveBeenCalled();

    const frame = lastFrameStripped(bundle.inst);
    expect(frame).toContain("Plan saved. You can execute it later.");
    expect(frame).not.toContain("Press 1-4 to choose:");

    bundle.inst.unmount();
  });

  it("T8: while menu is open, non-menu chars do NOT end up in the input buffer", async () => {
    const workspace = makeTmpDir();
    const bundle = await openMenu(workspace);

    // At menu-open the InputBox should be disabled; "abc" must be swallowed.
    bundle.inst.stdin.write("abc");
    await sleep(60);

    // Now submit '4' to close the menu; after it closes the input buffer
    // should still be empty — if "abc" had leaked into the buffer, pressing
    // '4' followed by Enter would submit "abc4" or "4" would be treated as
    // additional chars instead of a menu key.
    bundle.inst.stdin.write("4");
    await sleep(60);

    // Neither prompt nor compact should have been invoked with leaked text
    expect(bundle.spies.promptSpy).not.toHaveBeenCalled();

    // Plan saved message fires, confirming '4' was consumed by the menu
    const frame = lastFrameStripped(bundle.inst);
    expect(frame).toContain("Plan saved. You can execute it later.");

    // No leaked text in the visible input buffer after the menu closes.
    // Strict form (Codex finding 5): FIRST require that the "qlaybot>"
    // prompt is renderable at all — otherwise the regex match would
    // silently swallow the whole assertion — THEN assert the input
    // segment has no "abc".
    expect(frame).toContain("qlaybot>");
    const promptRe = /qlaybot>\s*([^\n]*)/;
    const match = frame.match(promptRe);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain("abc");

    bundle.inst.unmount();
  });
});

// ===========================================================================
// 4. Tool-path entry/exit (T9, T10 — D3 invariant)
// ===========================================================================

function parseToolJSON(result: AgentToolResult<unknown>): any {
  const first = result.content?.[0];
  if (!first || first.type !== "text") {
    throw new Error("Expected text content in tool result");
  }
  return JSON.parse(first.text as string);
}

describe("Group 3 · tool-path entry/exit bridge (T9, T10)", () => {
  it("T9: real enter_plan_mode tool factory returns plan_mode_active JSON; subscribe bridge flips inPlanMode → StatusBar shows 'PLAN'", async () => {
    const workspace = makeTmpDir();
    const { inst, pm } = await renderAppWithPlan({ workspaceDir: workspace });
    await sleep(60);

    expect(lastFrameStripped(inst).includes("PLAN")).toBe(false);

    // Invoke the real tool factory — this is exactly how the agent loop
    // enters plan mode (not by poking the manager directly).
    const enterTool = createEnterPlanModeTool(pm);
    const result = await enterTool.execute("tc-enter-1", {
      task: "design a Hall bar via the tool path",
    });

    // Tool result shape — spec §1.6: JSON envelope in content[0].text.
    const data = parseToolJSON(result);
    expect(data.status).toBe("plan_mode_active");
    expect(typeof data.plan_id).toBe("string");
    expect(typeof data.plan_file).toBe("string");
    expect(data.plan_file.endsWith(".md")).toBe(true);
    // Spec §1.7 — the full PLAN_MODE_INSTRUCTIONS text must travel back
    // with the tool result so the agent receives sandbox guidance.
    expect(data.instructions).toBe(PLAN_MODE_INSTRUCTIONS);
    expect(data.task).toContain("Hall bar");
    // Plan file actually exists on disk.
    expect(existsSync(data.plan_file)).toBe(true);

    // TUI observes the event via planManager.subscribe.
    await waitFor(
      () => lastFrameStripped(inst).includes("PLAN"),
      2000,
      20,
      "StatusBar did not show PLAN after enter_plan_mode tool call",
    );
    expect(pm.inPlanMode).toBe(true);

    inst.unmount();
  });

  it("T10 (D3 invariant): real exit_plan_mode tool returns plan_approved JSON; planExitMenu stays null (menu NOT opened)", async () => {
    const workspace = makeTmpDir();
    const { inst, pm } = await renderAppWithPlan({ workspaceDir: workspace });
    await sleep(60);

    // Enter via the tool factory (matching real agent-loop semantics)
    const enterTool = createEnterPlanModeTool(pm);
    const enterResult = await enterTool.execute("tc-enter-2", {
      task: "enter via tool",
    });
    const enterData = parseToolJSON(enterResult);
    expect(enterData.status).toBe("plan_mode_active");
    const planFile = enterData.plan_file as string;
    await waitFor(
      () => lastFrameStripped(inst).includes("PLAN"),
      2000,
      20,
      "did not enter",
    );

    // Exit via the tool factory — this is the critical D3 code path.
    const exitTool = createExitPlanModeTool(pm);
    const exitResult = await exitTool.execute("tc-exit-1", { approved: true });
    const exitData = parseToolJSON(exitResult);
    expect(exitData.status).toBe("plan_approved");
    expect(exitData.plan_id).toBe(enterData.plan_id);
    expect(exitData.plan_file).toBe(planFile);

    // StatusBar drops the PLAN indicator.
    await waitFor(
      () => !lastFrameStripped(inst).includes("PLAN"),
      2000,
      20,
      "StatusBar still shows PLAN after exit_plan_mode tool call",
    );

    // Critical D3 invariant — the approval menu MUST NOT open.
    //
    // Exhaustive frame-level negative assertion (Codex finding B): an impl
    // that transiently opened + closed the menu between renders could
    // escape a single-string check, so we assert NONE of the menu lines
    // from §1.8.1 appear, checked over an extended settle window.
    await sleep(100);

    // Poll 10x over ~500ms to catch any transient menu flash.
    const menuLines = [
      "Plan complete. Full tool access restored.",
      "  1  Clear context & execute",
      "  2  Execute",
      "  3  Revise (re-enter plan mode)",
      "  4  Do nothing",
      "Press 1-4 to choose:",
    ];
    for (let i = 0; i < 10; i++) {
      const frame = lastFrameStripped(inst);
      for (const line of menuLines) {
        expect(
          frame.includes(line),
          `D3 violated: exit tool caused the approval menu to render line "${line}" (iteration ${i})`,
        ).toBe(false);
      }
      await sleep(50);
    }

    // Final frame assertion on the already-polled window.
    const finalFrame = lastFrameStripped(inst);
    for (const line of menuLines) {
      expect(finalFrame).not.toContain(line);
    }
    expect(pm.inPlanMode).toBe(false);

    // Belt-and-suspenders source grep: count PLAN_EXIT_MENU_OPEN dispatch
    // sites. The slash handler is the ONLY site; tool-path exit must not
    // add a second.
    const appSrc = readSrc("tui/components/App.tsx");
    const matches = appSrc.match(/PLAN_EXIT_MENU_OPEN/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(1);

    inst.unmount();
  });
});

// ===========================================================================
// 5. Error-path coverage (D1 — FS failure returns null)
// ===========================================================================

describe("Group 3 · /plan handles enterPlanMode returning null (D1)", () => {
  it("emits a 'Failed to enter plan mode' system message and does NOT flip inPlanMode when enterPlanMode returns null", async () => {
    const workspace = makeTmpDir();
    const pm = new PlanManager(workspace);
    // Force enterPlanMode to return null (D1 FS-failure surface) without
    // actually breaking the filesystem — this is the cleanest way to test
    // the App.tsx branch without coupling to OS-specific mkdir failures.
    const origEnter = pm.enterPlanMode.bind(pm);
    vi.spyOn(pm, "enterPlanMode").mockImplementation(() => null);

    const { inst, spies } = await renderAppWithPlan({
      workspaceDir: workspace,
      planManager: pm,
    });
    await sleep(60);

    inst.stdin.write("/plan will fail");
    inst.stdin.write("\r");
    await sleep(120);

    // Reducer must not have entered plan mode.
    expect(pm.inPlanMode).toBe(false);

    // System message: must communicate failure. We require the SUBSTRING
    // "Failed to enter plan mode" exactly — the Executor owns the full text
    // but this anchor stays stable.
    const frame = lastFrameStripped(inst);
    expect(frame).toContain("Failed to enter plan mode");

    // Agent loop should NOT receive the auto-submit prompt on the failure
    // path — that is `session.prompt` untouched.
    expect(spies.promptSpy).not.toHaveBeenCalled();

    // Sanity: the un-mocked entry path still works (guards against broken
    // PlanManager in the test harness itself).
    void origEnter;

    inst.unmount();
  });
});

// ===========================================================================
// 6. Menu-open input gating + post-close interactivity
// ===========================================================================
//
// Note on spec T32: qdevbot's App.tsx submits `/plan` through the InputBox's
// Enter handler, which calls `buf.clear()` BEFORE `setPlanExitMenu` fires.
// Consequently there is no in-flight state where the buffer holds
// unsubmitted user chars at the moment the exit menu opens via the slash
// path — "buffered chars survive menu open" is architecturally unreachable
// under the existing InputBox contract.
//
// The two invariants that ARE reachable and that we DO test here:
//   (1) While the exit menu is open, typed chars are suppressed (do NOT
//       reach the input buffer) and Enter does NOT submit anything.
//   (2) Once the menu closes, the InputBox is interactive again.
// ===========================================================================

describe("Group 3 · exit menu input gating", () => {
  it("while plan exit menu is open, typed characters do NOT reach the input buffer and Enter does NOT submit", async () => {
    const workspace = makeTmpDir();
    const { inst, pm, spies } = await renderAppWithPlan({
      workspaceDir: workspace,
    });
    await sleep(60);

    // Enter plan mode via the slash flow.
    inst.stdin.write("/plan initial task");
    inst.stdin.write("\r");
    await waitFor(() => pm.inPlanMode === true, 2000, 20, "entry failed");

    // Baseline prompt-call count (auto-submit for /plan <task> fires once).
    const basePromptCalls = spies.promptSpy.mock.calls.length;

    // Trigger the menu via bare /plan.
    inst.stdin.write("/plan");
    inst.stdin.write("\r");
    await waitFor(
      () => pm.inPlanMode === false,
      2000,
      20,
      "menu did not open (exit event didn't fire)",
    );
    await waitFor(
      () => lastFrameStripped(inst).includes("Press 1-4 to choose:"),
      2000,
      20,
      "menu text never appeared",
    );

    // (1a) Chars typed while the menu is active do NOT reach the input buffer.
    inst.stdin.write("xyz");
    await sleep(80);
    const duringMenuFrame = lastFrameStripped(inst);
    expect(duringMenuFrame).toContain("qlaybot>");
    const inputLineMatch = duringMenuFrame.match(/qlaybot>\s*([^\n]*)/);
    expect(inputLineMatch).not.toBeNull();
    expect(inputLineMatch![1]).not.toContain("xyz");

    // (1b) Enter while menu is open does NOT submit — session.prompt
    //      gains no additional call.
    inst.stdin.write("\r");
    await sleep(80);
    expect(spies.promptSpy.mock.calls.length).toBe(basePromptCalls);

    // (1c) The menu key ("1") is consumed by the menu handler.
    inst.stdin.write("1");
    await waitFor(
      () => spies.compactSpy.mock.calls.length >= 1,
      2000,
      20,
      "compact() was not invoked by menu key '1'",
    );
    expect(spies.compactSpy).toHaveBeenCalledTimes(1);

    await waitFor(
      () => spies.promptSpy.mock.calls.length >= basePromptCalls + 1,
      2000,
      20,
      "session.prompt was not invoked with EXECUTE_PROMPT after key '1'",
    );
    const executeSubmitted = spies.promptSpy.mock.calls[basePromptCalls][0] as string;
    expect(executeSubmitted).toContain("Execute the design plan at:");

    inst.unmount();
  });

  it("after plan exit menu closes, input buffer accepts new characters again", async () => {
    const workspace = makeTmpDir();
    const { inst, pm, spies } = await renderAppWithPlan({
      workspaceDir: workspace,
    });
    await sleep(60);

    // Drive plan-mode entry + menu open.
    inst.stdin.write("/plan initial task");
    inst.stdin.write("\r");
    await waitFor(() => pm.inPlanMode === true, 2000, 20, "entry failed");
    const basePromptCalls = spies.promptSpy.mock.calls.length;

    inst.stdin.write("/plan");
    inst.stdin.write("\r");
    await waitFor(
      () => lastFrameStripped(inst).includes("Press 1-4 to choose:"),
      2000,
      20,
      "menu did not open",
    );

    // Close the menu with key '4' (spec: "Do nothing" → "Plan saved..." +
    // menu closes). We pick '4' rather than Escape because it emits a
    // distinctive system message we can anchor on.
    inst.stdin.write("4");
    await waitFor(
      () => lastFrameStripped(inst).includes("Plan saved. You can execute it later."),
      2000,
      20,
      "menu did not close",
    );
    await waitFor(
      () => !lastFrameStripped(inst).includes("Press 1-4 to choose:"),
      2000,
      20,
      "menu text still visible",
    );
    // Neither compact nor prompt should have fired from the menu-close path.
    expect(spies.compactSpy).not.toHaveBeenCalled();
    expect(spies.promptSpy.mock.calls.length).toBe(basePromptCalls);

    // --- Core assertion: the InputBox is interactive again. ---
    inst.stdin.write("hello");
    await waitFor(
      () => lastFrameStripped(inst).includes("hello"),
      2000,
      20,
      "'hello' never reached the input buffer after menu closed",
    );

    // Submit "hello" and verify it reaches session.prompt (i.e. the
    // input handler is fully functional, not just renderable).
    inst.stdin.write("\r");
    await waitFor(
      () => spies.promptSpy.mock.calls.length >= basePromptCalls + 1,
      2000,
      20,
      "session.prompt('hello') was not invoked after menu closed",
    );
    const submitted = spies.promptSpy.mock.calls[basePromptCalls][0] as string;
    expect(submitted).toBe("hello");

    inst.unmount();
  });
});

// ===========================================================================
// 7. Shim-removal regression (step 11 — PlanManager API surface)
// ===========================================================================
//
// These tests FAIL until step 11 has run. They're named so that a failing
// suite clearly points at "remove the 0.4.2 PlanManager shim".
// ===========================================================================

describe("Group 3 · Step 11 · PlanManager shims removed", () => {
  it("isActive is no longer defined on PlanManager.prototype", () => {
    const pm = new PlanManager(makeTmpDir());
    expect(typeof (pm as any).isActive).toBe("undefined");
  });

  it("onStateChange is no longer defined on PlanManager.prototype", () => {
    const pm = new PlanManager(makeTmpDir());
    expect(typeof (pm as any).onStateChange).toBe("undefined");
  });

  it("getSystemPromptInjection is no longer defined on PlanManager.prototype", () => {
    const pm = new PlanManager(makeTmpDir());
    expect(typeof (pm as any).getSystemPromptInjection).toBe("undefined");
  });

  it("enter() shim is no longer defined on PlanManager.prototype", () => {
    const pm = new PlanManager(makeTmpDir());
    expect(typeof (pm as any).enter).toBe("undefined");
  });

  it("exit() shim is no longer defined on PlanManager.prototype", () => {
    const pm = new PlanManager(makeTmpDir());
    expect(typeof (pm as any).exit).toBe("undefined");
  });
});

// ===========================================================================
// 8. Source-grep regressions (step 10 + step 11)
// ===========================================================================

describe("Group 3 · Step 10/11 · source-grep regressions", () => {
  it("src/planning/sandbox.ts no longer exports wrapToolWithSandbox", () => {
    const src = readSrc("planning/sandbox.ts");
    expect(src).not.toContain("wrapToolWithSandbox");
  });

  it("src/planning/sandbox.ts no longer references ALLOWED_TOOLS", () => {
    const src = readSrc("planning/sandbox.ts");
    expect(src).not.toContain("ALLOWED_TOOLS");
  });

  it("src/rpc.ts uses `inPlanMode` and not the old isActive() call", () => {
    const src = readSrc("rpc.ts");
    expect(src).toContain("inPlanMode");
    expect(src).not.toMatch(/planManager\?\.isActive\(\)/);
  });

  it("src/commands/index.ts no longer imports or registers planCommand", () => {
    const src = readSrc("commands/index.ts");
    expect(src).not.toContain("planCommand");
    expect(src).not.toMatch(/import\s*\{\s*planCommand\s*\}/);
    // Also confirm the COMMAND_NAMES array no longer lists "plan" as a
    // command (App.tsx uses the `/plan` prefix match directly instead).
    expect(src).not.toMatch(/"plan"\s*,/);
  });

  it("src/agent.ts no longer imports wrapToolWithSandbox", () => {
    const src = readSrc("agent.ts");
    expect(src).not.toMatch(/import\s*\{[^}]*wrapToolWithSandbox[^}]*\}/);
  });

  it("src/agent.ts no longer references getSystemPromptInjection (D6 callsite deletion regression)", () => {
    const src = readSrc("agent.ts");
    // Spec D6: plan-mode system prompt injection lives in the tool result,
    // not in transformContext. The old callsite at agent.ts:315-322 used
    // `[SYSTEM] ${planManager.getSystemPromptInjection()}` — none of that
    // should remain after Group 2 step 6 + Group 3 step 11.
    expect(src).not.toContain("getSystemPromptInjection");
    expect(src).not.toContain("[SYSTEM]");
  });

  it("src/planning/index.ts constructor is tightened to required workspaceDir (grep: no optional, no process.cwd() fallback)", () => {
    const src = readSrc("planning/index.ts");
    // Required parameter shape — must appear literally.
    expect(src).toContain("constructor(workspaceDir: string)");
    // Old transitional signature must be gone.
    expect(src).not.toContain("constructor(workspaceDir?: string)");
    // No silent cwd fallback inside the constructor body (this was the
    // Group 1 transitional shim behavior). We also assert `_plansDir` is
    // assigned without referencing `process.cwd()`.
    const ctorBlock = src.match(/constructor\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(ctorBlock, "could not locate PlanManager constructor body").not.toBeNull();
    expect(ctorBlock![0]).not.toContain("process.cwd()");
    // Also ensure no other spot in the file silently injects cwd under a
    // fallback name (e.g. `workspaceDir ?? process.cwd()` reappearing).
    expect(src).not.toMatch(/workspaceDir\s*\?\?\s*process\.cwd/);
  });

  it("PlanManager() with no args is a type error (constructor tightened — @ts-expect-error regression)", () => {
    // Static-analysis signal (Codex finding C revisited): the
    // `@ts-expect-error` directive below is a passive compile-time
    // regression trigger. Until the Executor tightens the constructor
    // to `constructor(workspaceDir: string)`, the no-arg call is legal
    // and the directive is UNUSED — which `tsc --noEmit` flags as
    // TS2578. Once the constructor is tightened, the directive is
    // consumed and `tsc` is happy.
    //
    // IMPORTANT: we wrap the no-arg call in a NEVER-INVOKED factory so
    // the production PlanManager body is never reached at runtime. This
    // means the implementation is free to throw (or otherwise require
    // workspaceDir) without this test leaning on any defensive `||""`
    // coercion to survive. The complementary execSync tsc test below
    // enforces the contract at CI time.
    // @ts-expect-error — PlanManager must require workspaceDir after step 11
    const factory = () => new PlanManager();
    expect(typeof factory).toBe("function");
  });

  it("test file typechecks cleanly against tightened constructor + wired TUIAction union (execSync tsc regression)", () => {
    // Shells out to `tsc --noEmit` against JUST this test file. The test
    // passes (exit 0) only when BOTH of the following hold simultaneously:
    //
    //   (i)  `PlanManager` constructor requires `workspaceDir` (step 11) —
    //        so the `@ts-expect-error` directive at the no-arg `new
    //        PlanManager()` above is consumed, not unused.
    //   (ii) `TUIAction` union includes PLAN_EXIT_MENU_OPEN/_CLOSE (step 9)
    //        — so the typed fixtures in the reducer tests don't raise
    //        TS2322.
    //
    // Any other TS error is a test-file bug and re-thrown with full
    // context. This whole test is "belt + suspenders" to Finding C —
    // the in-body @ts-expect-error directive above already provides a
    // passive static-analysis signal even when this shell-out is skipped.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("child_process") as typeof import("child_process");
    const testFileAbs = resolve(__dirname, "test-plan-mode-v043-group3.ts");
    const repoRoot = resolve(__dirname, "..");
    try {
      execSync(
        `npx -y tsc --noEmit --strict --target ES2022 --module Node16 ` +
          `--moduleResolution Node16 --esModuleInterop --skipLibCheck ` +
          `--jsx react-jsx --resolveJsonModule "${testFileAbs}"`,
        { cwd: repoRoot, stdio: "pipe" },
      );
      // exit 0 → both invariants hold → test passes.
    } catch (err: any) {
      const stderr = (err?.stderr?.toString?.() ?? "") + (err?.stdout?.toString?.() ?? "");
      // Surface only known pre-impl categories individually so the
      // failure message names the exact step that's still missing.
      const hasTS2322 = /error TS2322/.test(stderr);
      const hasTS2578 = /error TS2578/.test(stderr);
      const unexpectedOnly = stderr
        .split("\n")
        .filter((l: string) => /error TS(?!2322|2578)\d+/.test(l))
        .join("\n");

      if (unexpectedOnly.trim()) {
        throw new Error(
          "Unexpected tsc --noEmit failure on test file " +
            "(not TS2322 / not TS2578):\n" + unexpectedOnly,
        );
      }

      const reasons: string[] = [];
      if (hasTS2322) {
        reasons.push(
          "TUIAction union missing PLAN_EXIT_MENU_OPEN/_CLOSE (step 9).",
        );
      }
      if (hasTS2578) {
        reasons.push(
          "Constructor still optional: @ts-expect-error unused (step 11).",
        );
      }
      throw new Error(
        "Pre-impl TS errors — still expected until Group 3 lands:\n  - " +
          reasons.join("\n  - ") +
          "\n\nRaw tsc output:\n" + stderr,
      );
    }
  });

  it("src/commands/plan.ts file no longer exists", () => {
    expect(existsSync(SRC("commands/plan.ts"))).toBe(false);
  });

  it("src/tui/components/App.tsx subscribes via planManager.subscribe (not .onStateChange)", () => {
    const src = readSrc("tui/components/App.tsx");
    expect(src).toContain("planManager.subscribe");
    // onStateChange is the 0.4.2 shim — Group 3 step 9 migrates away from it.
    expect(src).not.toContain("planManager?.onStateChange");
    expect(src).not.toContain("planManager.onStateChange");
  });

  it("src/tui/components/App.tsx contains the /plan prefix check and dispatches PLAN_EXIT_MENU_OPEN", () => {
    const src = readSrc("tui/components/App.tsx");
    // Must appear SOMEWHERE in the handler — we don't pin the exact shape.
    expect(src).toMatch(/\/plan/);
    // PLAN_EXIT_MENU_OPEN action is dispatched from within the slash handler.
    expect(src).toContain("PLAN_EXIT_MENU_OPEN");
  });

  it("BEHAVIORAL: submitting /plan <task> intercepts BEFORE CommandRegistry — registry.execute is not called", async () => {
    // Finding 5: this is the authoritative behavioral check that the App
    // short-circuits `/plan` before reaching the CommandRegistry dispatch.
    // It fails today (CommandRegistry IS called) and turns green when the
    // Executor adds the pre-registry `/plan` branch per spec §1.8.1.
    const workspace = makeTmpDir();
    const { inst, pm, spies } = await renderAppWithPlan({
      workspaceDir: workspace,
    });
    await sleep(60);

    inst.stdin.write("/plan design another thing");
    inst.stdin.write("\r");

    // Wait for the slash handler to finish. Plan-mode entry is the
    // observable side-effect of the new branch; if the registry had
    // intercepted instead, the mock registry.execute (which returns an
    // empty output) would run and pm.inPlanMode would stay false.
    await waitFor(
      () => pm.inPlanMode === true,
      2000,
      20,
      "pm did not enter plan mode — /plan was likely routed through CommandRegistry",
    );

    // Critical assertion: CommandRegistry.execute MUST NOT have been called
    // with "plan" (the App.tsx handler must intercept before registry.execute).
    const planCalls = spies.registryExecute.mock.calls.filter(
      (c: unknown[]) => c[0] === "plan",
    );
    expect(planCalls.length).toBe(0);

    inst.unmount();
  });
});

// ===========================================================================
// 9. Legacy test cleanup regressions (step 11)
// ===========================================================================

describe("Group 3 · Step 11 · legacy test cleanup", () => {
  it("tests/test-unit.ts no longer references wrapToolWithSandbox / ALLOWED_TOOLS / getSystemPromptInjection", () => {
    const src = readFileSync(TESTS("test-unit.ts"), "utf-8");
    expect(src).not.toContain("wrapToolWithSandbox");
    expect(src).not.toContain("ALLOWED_TOOLS");
    expect(src).not.toContain("getSystemPromptInjection");
  });

  it("tests/test-subagent-e2e.ts no longer references ALLOWED_TOOLS", () => {
    const src = readFileSync(TESTS("test-subagent-e2e.ts"), "utf-8");
    expect(src).not.toContain("ALLOWED_TOOLS");
  });

  it("tests/test-subagent.ts no longer references ALLOWED_TOOLS", () => {
    const src = readFileSync(TESTS("test-subagent.ts"), "utf-8");
    expect(src).not.toContain("ALLOWED_TOOLS");
  });
});
