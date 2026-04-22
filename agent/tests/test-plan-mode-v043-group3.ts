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
 * v0.4.4 REBASE NOTES (Task 2.19, T8 gate)
 * ---------------------------------------------------------------------------
 * v0.4.4 deleted the entire `/plan` slash-command trigger and repurposed the
 * 4-option exit menu (`PlanExitMenu.tsx` → `PlanApprovalMenu.tsx`). The
 * following describe blocks were removed from this file:
 *
 *   DELETED (v0.4.4 design spec §4.1 line 247 — `/plan` slash trigger gone):
 *     - "Group 3 · App /plan slash handler (T1, T11)"
 *       entire describe — T1 and T11 both drove plan-mode entry via the
 *       `/plan <task>` slash command, which v0.4.4 replaced with the
 *       `enter_plan_mode` tool call.
 *     - "Group 3 · App /plan exit menu open (T2)"
 *       T2 asserts `/plan` (no args) opens the v0.4.3 menu with labels
 *       "Clear context & execute / Execute / Revise / Do nothing". v0.4.4
 *       spec §4.3 PM-3 line 286 replaces the trigger (tool-call, not slash)
 *       AND the labels (approve_execute / approve_only / reject / abandon).
 *     - "Group 3 · App exit menu key handlers (T3-T7)"
 *       T3-T8 exercise the v0.4.3 menu handlers: key '1' → compact+EXECUTE,
 *       '2' → EXECUTE, '3' → reenterPlanMode, '4' → "Plan saved", Escape →
 *       "Plan saved". v0.4.4 spec §4.3 PM-3: the four actions are renamed
 *       (approve_execute / approve_only / reject / abandon) and the new
 *       menu is owned by `PlanApprovalMenu.tsx` (T31). EXECUTE_PROMPT and
 *       the compact-then-prompt wiring are gone — the v0.4.4 gate drives
 *       the turn directly via the exit-tool result, not via slash-command →
 *       prompt replay (spec §4.4 line 327 "TUI pause/resume mechanism").
 *     - "Group 3 · exit menu input gating"
 *       Both tests open the v0.4.3 menu via the `/plan` slash trigger (gone)
 *       and assert on `EXECUTE_PROMPT` text in `session.prompt` (gone).
 *       Menu-open input gating is re-tested against `PlanApprovalMenu`
 *       under the v0.4.4 component test (T31, separate file).
 *     - "Group 3 · /plan handles enterPlanMode returning null (D1)"
 *       Drives the failure path through the `/plan` slash command. The
 *       enter-tool D1 branch is still covered in test-plan-mode-v043.ts
 *       ("enterPlanMode returns null on FS failure; does NOT mutate state")
 *       and in test-plan-mode-v043.ts tool test ("execute when
 *       PlanManager.enterPlanMode returns null (D1 FS failure)").
 *
 *   DELETED (v0.4.4 design spec §4.1 — D3 invariant INVERTED):
 *     - "Group 3 · tool-path entry/exit bridge (T9, T10)" — T10 only
 *       (T9 retained). T10 asserts `exit_plan_mode({approved:true})` does
 *       NOT open the menu; v0.4.4 spec §4.1 line 247 + §4.4 line 327
 *       INVERT this: in interactive TUI mode the tool-call MUST open the
 *       approval menu (the gate is implemented inside the tool's
 *       `execute()` via `await waitForPlanApproval`). The "menu NOT opened"
 *       invariant is therefore obsolete.
 *
 *   DELETED (v0.4.4 source-grep regressions — App.tsx /plan handler gone):
 *     - "src/tui/components/App.tsx contains the /plan prefix check and
 *       dispatches PLAN_EXIT_MENU_OPEN" — §4.1 removed the `/plan` handler;
 *       the dispatch site moved to the approval-tool pipeline.
 *     - "BEHAVIORAL: submitting /plan <task> intercepts BEFORE
 *       CommandRegistry" — `/plan` route no longer exists.
 *
 *   RETAINED (v0.4.4-valid invariants):
 *     - reducer planExitMenu + PLAN_EXIT_MENU_OPEN/_CLOSE actions — still
 *       the actions `PlanApprovalMenu.tsx` dispatches in v0.4.4.
 *     - StatusBar PLAN indicator tied to state.inPlanMode.
 *     - T9 — `enter_plan_mode` tool returns plan_mode_active + subscribe
 *       bridge flips inPlanMode.
 *     - PlanManager shim-removal + source-grep regressions (no-legacy
 *       constructors, no `wrapToolWithSandbox`, etc.).
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

// DELETED (v0.4.4 Task 2.19): three describe blocks for the /plan slash
//   handler + v0.4.3 menu key handlers.
//   - describe("Group 3 · App /plan slash handler (T1, T11)")
//   - describe("Group 3 · App /plan exit menu open (T2)")
//   - describe("Group 3 · App exit menu key handlers (T3-T7)")
// Spec §4.1 line 247: v0.4.4 removed the /plan slash-command trigger.
// Plan mode is entered only via the enter_plan_mode tool call. The
// 4-option menu is repurposed (PlanExitMenu → PlanApprovalMenu, spec
// §4.3 PM-3 line 286) with new action names (approve_execute /
// approve_only / reject / abandon) and a new trigger (exit_plan_mode
// tool call opens the approval gate inside execute(), not a slash
// handler). EXECUTE_PROMPT / compact-then-prompt wiring is retired.
// See file header for the full rebase summary. T1/T11/T2 were the
// slash-entry tests; T3-T8 exercised the v0.4.3 menu labels and
// handlers; every assertion in those blocks is now obsolete.


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

  // DELETED (v0.4.4 Task 2.19): "T10 (D3 invariant): real exit_plan_mode
  //   tool returns plan_approved JSON; planExitMenu stays null (menu NOT
  //   opened)".
  // v0.4.4 design spec §4.1 line 247 + §4.4 line 327: the D3 invariant
  // ("tool exit must not open menu") is INVERTED. In interactive TUI mode,
  // `exit_plan_mode({approved: true})` now OPENS the approval menu as part
  // of the gate (implemented inside the tool's execute() via
  // `await waitForPlanApproval`). The v0.4.3 assertion that the menu stays
  // null on tool exit is therefore obsolete. In headless `-m` mode the menu
  // still does NOT open (PM-4 auto-approval) — that invariant is covered
  // separately by the headless-mode approval tests (Task 2.14 / T31).
  // T9 (enter_plan_mode returns plan_mode_active; subscribe bridge flips
  // inPlanMode) is retained above — that invariant is v0.4.4-valid.
});

// ===========================================================================
// 5. Error-path coverage (D1 — FS failure returns null)
// ===========================================================================

// DELETED (v0.4.4 Task 2.19): two describe blocks that exercised the
//   /plan slash-command entry path:
//   - describe("Group 3 · /plan handles enterPlanMode returning null (D1)")
//   - describe("Group 3 · exit menu input gating")
// Spec §4.1 line 247 removed the /plan slash-command trigger. The D1
// FS-failure branch is still covered in test-plan-mode-v043.ts — see
// "enterPlanMode returns null on FS failure" (manager-level) and
// "execute when PlanManager.enterPlanMode returns null (D1 FS failure)"
// (tool-level). The menu-open input-gating invariant is re-tested for
// v0.4.4 against PlanApprovalMenu in the component tests (T31).



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

  // DELETED (v0.4.4 Task 2.19): two source-grep/behavioral regressions that
  //   required the `/plan` slash handler to exist in App.tsx:
  //   - "src/tui/components/App.tsx contains the /plan prefix check and
  //      dispatches PLAN_EXIT_MENU_OPEN"
  //   - "BEHAVIORAL: submitting /plan <task> intercepts BEFORE
  //      CommandRegistry — registry.execute is not called"
  // Spec §4.1 line 247 removed the `/plan` slash trigger. The
  // `PLAN_EXIT_MENU_OPEN` action still exists and is dispatched by the
  // approval-gate (inside the tool pipeline) in v0.4.4, so the action-
  // survives invariant lives in the reducer tests at the top of this file.
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
