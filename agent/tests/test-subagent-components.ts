/**
 * v0.4 Phase G: SubagentPanel TUI Components + Reducer Actions
 *
 * Test-Reinforced Development -- Overseer test suite.
 * All tests call real implementation functions that the Executor must create.
 * Every test should FAIL until the implementation is complete.
 *
 * Covers SCC-G1 through SCC-G20i (28 spec compliance items).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// --- Contract types ---
import type {
  SubagentTUIEntry,
  SubagentSegment,
  FocusState,
} from "../src/types/v04-contracts.js";

// --- Test helpers ---
import { stripAnsi, pressKey, waitForFrame } from "./helpers/ink-helpers.js";

// --- Implementation imports (Executor must add new action types + state fields) ---
import { tuiReducer, initialState } from "../src/tui/reducer.js";
import type { TUIState, TUIAction } from "../src/tui/types.js";

// --- StatusBar (already exists, needs "N sub" badge) ---
import { StatusBar } from "../src/tui/components/StatusBar.js";

// --- SubagentPanel (Executor must create) ---
let SubagentPanel: React.ComponentType<{
  state: TUIState;
  dispatch: (action: TUIAction) => void;
}>;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("../src/tui/components/SubagentPanel.js");
  SubagentPanel = mod.SubagentPanel ?? mod.default;
} catch {
  SubagentPanel = undefined as unknown as typeof SubagentPanel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dispatch a sequence of actions through the reducer, returning final state. */
function reduceActions(actions: TUIAction[], startState?: TUIState): TUIState {
  let state = startState ?? initialState;
  for (const action of actions) {
    state = tuiReducer(state, action);
  }
  return state;
}

/** Create a mock SubagentTUIEntry for testing. */
function makeEntry(overrides?: Partial<SubagentTUIEntry>): SubagentTUIEntry {
  return {
    id: "sub-1",
    toolCallId: "tc-1",
    role: "analyst",
    task: "Analyze the layout for DRC violations",
    status: "running",
    startTime: Date.now() - 5000,
    segments: [],
    ...overrides,
  };
}

/** Build a TUIState with subagent fields populated. */
function stateWithSubagents(
  entries: SubagentTUIEntry[],
  overrides?: Partial<TUIState>,
): TUIState {
  return {
    ...initialState,
    subagents: entries,
    subagentPanelOpen: true,
    subagentSummaryIndex: 0,
    subagentInspectId: null,
    subagentInspectScroll: 0,
    subagentInjectMode: false,
    subagentInjectTarget: null,
    subagentInjectValue: "",
    ...overrides,
  } as TUIState;
}

/** Build a state where subagent panel is open at summary level. */
function summaryState(entries: SubagentTUIEntry[]): TUIState {
  return stateWithSubagents(entries, {
    focusState: "subagent-summary" as FocusState,
    subagentPanelOpen: true,
  });
}

/** Build a state where inspect window is open for a specific subagent. */
function inspectState(entries: SubagentTUIEntry[], inspectId: string): TUIState {
  return stateWithSubagents(entries, {
    focusState: "subagent-inspect" as FocusState,
    subagentPanelOpen: true,
    subagentInspectId: inspectId,
  });
}

// ==========================================================================
// Group 1: Reducer -- Subagent State Management (~8 tests)
// ==========================================================================

describe("Group 1: Reducer -- Subagent State Management", () => {
  it("SCC-G17: TOGGLE_SUBAGENT_PANEL opens panel and sets focusState to subagent-summary", () => {
    const state = tuiReducer(initialState, {
      type: "TOGGLE_SUBAGENT_PANEL",
    } as TUIAction);

    expect((state as any).subagentPanelOpen).toBe(true);
    expect(state.focusState).toBe("subagent-summary");
  });

  it("SCC-G17: TOGGLE_SUBAGENT_PANEL closes panel and returns focusState to input", () => {
    // First open the panel
    const opened = stateWithSubagents([], {
      focusState: "subagent-summary" as FocusState,
      subagentPanelOpen: true,
    });

    const state = tuiReducer(opened, {
      type: "TOGGLE_SUBAGENT_PANEL",
    } as TUIAction);

    expect((state as any).subagentPanelOpen).toBe(false);
    expect(state.focusState).toBe("input");
  });

  it("SCC-G18: SUBAGENT_PLACEHOLDER creates entry with toolCallId", () => {
    const state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-42",
      role: "analyst",
      task: "Check DRC",
    } as TUIAction);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs).toHaveLength(1);
    expect(subs[0].toolCallId).toBe("tc-42");
    expect(subs[0].role).toBe("analyst");
    expect(subs[0].task).toBe("Check DRC");
    expect(subs[0].status).toBe("running");
    expect(subs[0].segments).toEqual([]);
    // id should initially be the toolCallId (placeholder)
    expect(subs[0].id).toBe("tc-42");
  });

  it("SCC-G19/G20: SUBAGENT_START updates entry id from toolCallId to subagentId", () => {
    // Create placeholder first
    const withPlaceholder = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-42",
      role: "analyst",
      task: "Check DRC",
    } as TUIAction);

    // Now the real subagentId arrives via the runner "started" event
    const state = tuiReducer(withPlaceholder, {
      type: "SUBAGENT_START",
      subagentId: "sub-real-7",
      toolCallId: "tc-42",
    } as TUIAction);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe("sub-real-7");
    expect(subs[0].toolCallId).toBe("tc-42");
    // status stays running
    expect(subs[0].status).toBe("running");
  });

  it("SCC-G5: SUBAGENT_THINKING/TEXT/TOOL_START/TOOL_END append segments in order", () => {
    // Build up a subagent with multiple segment types
    const state = reduceActions([
      { type: "SUBAGENT_PLACEHOLDER", toolCallId: "tc-1", role: "analyst", task: "test" },
      { type: "SUBAGENT_START", subagentId: "sub-1", toolCallId: "tc-1" },
      { type: "SUBAGENT_THINKING", subagentId: "sub-1", text: "Let me analyze..." },
      { type: "SUBAGENT_TEXT", subagentId: "sub-1", text: "Found an issue." },
      { type: "SUBAGENT_TOOL_START", subagentId: "sub-1", toolName: "read_file", args: '{"path":"/a.gds"}' },
      { type: "SUBAGENT_TOOL_END", subagentId: "sub-1", toolName: "read_file", result: "ok" },
    ] as TUIAction[]);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    const segments = subs[0].segments;
    // TOOL_START adds a tool_call segment; TOOL_END updates it in-place
    expect(segments).toHaveLength(3);
    expect(segments[0].type).toBe("thinking");
    expect((segments[0] as any).text).toBe("Let me analyze...");
    expect(segments[1].type).toBe("text");
    expect((segments[1] as any).text).toBe("Found an issue.");
    expect(segments[2].type).toBe("tool_call");
    expect((segments[2] as any).toolName).toBe("read_file");
    expect((segments[2] as any).status).toBe("done");
    expect((segments[2] as any).result).toBe("ok");
  });

  it("SCC-G5: SUBAGENT_TOOL_END updates existing tool_call segment status to done", () => {
    const state = reduceActions([
      { type: "SUBAGENT_PLACEHOLDER", toolCallId: "tc-1", role: "a", task: "t" },
      { type: "SUBAGENT_START", subagentId: "sub-1", toolCallId: "tc-1" },
      { type: "SUBAGENT_TOOL_START", subagentId: "sub-1", toolName: "bash", args: '{"cmd":"ls"}' },
      { type: "SUBAGENT_TOOL_END", subagentId: "sub-1", toolName: "bash", result: "file.txt" },
    ] as TUIAction[]);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    const segments = subs[0].segments;
    // Should have exactly 1 tool_call segment, updated in-place
    const toolSegs = segments.filter((s: SubagentSegment) => s.type === "tool_call");
    expect(toolSegs).toHaveLength(1);
    expect((toolSegs[0] as any).status).toBe("done");
    expect((toolSegs[0] as any).result).toBe("file.txt");
  });

  it("SUBAGENT_END updates status, tokenUsage, and endTime", () => {
    const state = reduceActions([
      { type: "SUBAGENT_PLACEHOLDER", toolCallId: "tc-1", role: "a", task: "t" },
      { type: "SUBAGENT_START", subagentId: "sub-1", toolCallId: "tc-1" },
      {
        type: "SUBAGENT_END",
        subagentId: "sub-1",
        status: "completed",
        findings: 3,
        warnings: 1,
        tokenUsage: "12k in / 4k out",
      },
    ] as TUIAction[]);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs[0].status).toBe("completed");
    expect(subs[0].findings).toBe(3);
    expect(subs[0].warnings).toBe(1);
    expect(subs[0].tokenUsage).toBe("12k in / 4k out");
    expect(subs[0].endTime).toBeGreaterThan(0);
  });

  it("SCC-G3: SUBAGENT_NAVIGATE moves summaryIndex up and down with clamping", () => {
    const base = summaryState([
      makeEntry({ id: "sub-1" }),
      makeEntry({ id: "sub-2" }),
      makeEntry({ id: "sub-3" }),
    ]);

    // Start at index 0, navigate down twice
    let state = tuiReducer(base, {
      type: "SUBAGENT_NAVIGATE",
      direction: "down",
    } as TUIAction);
    expect((state as any).subagentSummaryIndex).toBe(1);

    state = tuiReducer(state, {
      type: "SUBAGENT_NAVIGATE",
      direction: "down",
    } as TUIAction);
    expect((state as any).subagentSummaryIndex).toBe(2);

    // Clamp at bottom
    state = tuiReducer(state, {
      type: "SUBAGENT_NAVIGATE",
      direction: "down",
    } as TUIAction);
    expect((state as any).subagentSummaryIndex).toBe(2);

    // Navigate back up
    state = tuiReducer(state, {
      type: "SUBAGENT_NAVIGATE",
      direction: "up",
    } as TUIAction);
    expect((state as any).subagentSummaryIndex).toBe(1);
  });

  it("SCC-G4: SUBAGENT_INSPECT changes focus to subagent-inspect and sets inspectId", () => {
    const base = summaryState([
      makeEntry({ id: "sub-1" }),
      makeEntry({ id: "sub-2" }),
    ]);

    const state = tuiReducer(base, {
      type: "SUBAGENT_INSPECT",
      subagentId: "sub-2",
    } as TUIAction);

    expect(state.focusState).toBe("subagent-inspect");
    expect((state as any).subagentInspectId).toBe("sub-2");
  });

  it("SCC-G6: SUBAGENT_INSPECT_NAV switches between subagents", () => {
    const entries = [
      makeEntry({ id: "sub-1" }),
      makeEntry({ id: "sub-2" }),
      makeEntry({ id: "sub-3" }),
    ];
    const base = inspectState(entries, "sub-2");

    // Right: sub-2 -> sub-3
    let state = tuiReducer(base, {
      type: "SUBAGENT_INSPECT_NAV",
      direction: "right",
    } as TUIAction);
    expect((state as any).subagentInspectId).toBe("sub-3");

    // Right again: wraps or clamps at end
    state = tuiReducer(state, {
      type: "SUBAGENT_INSPECT_NAV",
      direction: "right",
    } as TUIAction);
    // Clamp at last entry
    expect((state as any).subagentInspectId).toBe("sub-3");

    // Left: sub-3 -> sub-2
    state = tuiReducer(state, {
      type: "SUBAGENT_INSPECT_NAV",
      direction: "left",
    } as TUIAction);
    expect((state as any).subagentInspectId).toBe("sub-2");
  });

  it("SCC-G7: SUBAGENT_INSPECT_SCROLL adjusts scroll position", () => {
    const base = inspectState([makeEntry({ id: "sub-1" })], "sub-1");

    let state = tuiReducer(base, {
      type: "SUBAGENT_INSPECT_SCROLL",
      direction: "down",
    } as TUIAction);
    expect((state as any).subagentInspectScroll).toBe(1);

    state = tuiReducer(state, {
      type: "SUBAGENT_INSPECT_SCROLL",
      direction: "down",
    } as TUIAction);
    expect((state as any).subagentInspectScroll).toBe(2);

    state = tuiReducer(state, {
      type: "SUBAGENT_INSPECT_SCROLL",
      direction: "up",
    } as TUIAction);
    expect((state as any).subagentInspectScroll).toBe(1);

    // Clamp at 0
    state = tuiReducer(state, {
      type: "SUBAGENT_INSPECT_SCROLL",
      direction: "up",
    } as TUIAction);
    expect((state as any).subagentInspectScroll).toBe(0);

    state = tuiReducer(state, {
      type: "SUBAGENT_INSPECT_SCROLL",
      direction: "up",
    } as TUIAction);
    expect((state as any).subagentInspectScroll).toBe(0);
  });
});

// ==========================================================================
// Group 1b: State Lifecycle (SCC-G20g/h/i)
// ==========================================================================

describe("Group 1b: State Lifecycle", () => {
  it("SCC-G20g: Completed results survive panel close/reopen", () => {
    // Create a completed subagent
    let state = reduceActions([
      { type: "SUBAGENT_PLACEHOLDER", toolCallId: "tc-1", role: "analyst", task: "check" },
      { type: "SUBAGENT_START", subagentId: "sub-1", toolCallId: "tc-1" },
      { type: "SUBAGENT_TEXT", subagentId: "sub-1", text: "Done." },
      { type: "SUBAGENT_END", subagentId: "sub-1", status: "completed", findings: 2, warnings: 0, tokenUsage: "5k" },
    ] as TUIAction[]);

    // Open panel
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" } as TUIAction);
    const subsBeforeClose = (state as any).subagents as SubagentTUIEntry[];
    expect(subsBeforeClose).toHaveLength(1);
    expect(subsBeforeClose[0].status).toBe("completed");

    // Close panel
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" } as TUIAction);
    expect((state as any).subagentPanelOpen).toBe(false);

    // Reopen panel
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" } as TUIAction);
    const subsAfterReopen = (state as any).subagents as SubagentTUIEntry[];
    expect(subsAfterReopen).toHaveLength(1);
    expect(subsAfterReopen[0].status).toBe("completed");
    expect(subsAfterReopen[0].segments).toHaveLength(1);
    expect((subsAfterReopen[0].segments[0] as any).text).toBe("Done.");
  });

  it("SCC-G20h: Runner events accumulate while panel is closed", () => {
    // Panel starts closed (default). Events arrive:
    let state = reduceActions([
      { type: "SUBAGENT_PLACEHOLDER", toolCallId: "tc-1", role: "analyst", task: "check" },
      { type: "SUBAGENT_START", subagentId: "sub-1", toolCallId: "tc-1" },
      { type: "SUBAGENT_THINKING", subagentId: "sub-1", text: "Thinking..." },
      { type: "SUBAGENT_TEXT", subagentId: "sub-1", text: "Result." },
    ] as TUIAction[]);

    // Panel is still closed
    expect((state as any).subagentPanelOpen ?? false).toBe(false);

    // Open panel -- all events should be reflected
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" } as TUIAction);
    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs).toHaveLength(1);
    expect(subs[0].segments).toHaveLength(2);
  });

  it("SCC-G20i: Inspect scroll position survives close/reopen", () => {
    const entries = [makeEntry({
      id: "sub-1",
      segments: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
        { type: "text", text: "line 3" },
      ],
    })];
    let state = inspectState(entries, "sub-1");

    // Scroll down twice
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" } as TUIAction);
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" } as TUIAction);
    expect((state as any).subagentInspectScroll).toBe(2);

    // Step 1: FOCUS_ESCAPE from inspect goes to summary (SCC-G8)
    state = tuiReducer(state, { type: "FOCUS_ESCAPE" } as TUIAction);
    expect(state.focusState).toBe("subagent-summary");
    expect((state as any).subagentInspectScroll).toBe(2);

    // Step 2: FOCUS_ESCAPE from summary closes panel, focus returns to input (SCC-G9)
    state = tuiReducer(state, { type: "FOCUS_ESCAPE" } as TUIAction);
    expect(state.focusState).toBe("input");
    expect((state as any).subagentPanelOpen ?? false).toBe(false);

    // Step 3: Reopen panel at summary
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" } as TUIAction);
    expect((state as any).subagentPanelOpen).toBe(true);
    expect(state.focusState).toBe("subagent-summary");

    // Step 4: Re-enter inspect for the same subagent
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT", subagentId: "sub-1" } as TUIAction);
    expect(state.focusState).toBe("subagent-inspect");

    // Step 5: Scroll position should be preserved through the close/reopen cycle
    expect((state as any).subagentInspectScroll).toBe(2);
  });
});

// ==========================================================================
// Group 2: Reducer -- Inject/Kill Actions (~3 tests)
// ==========================================================================

describe("Group 2: Reducer -- Inject/Kill Actions", () => {
  it("SCC-G10: SUBAGENT_INJECT_START sets inject mode and focus to subagent-inject", () => {
    const base = summaryState([makeEntry({ id: "sub-1", status: "running" })]);

    const state = tuiReducer(base, {
      type: "SUBAGENT_INJECT_START",
      subagentId: "sub-1",
    } as TUIAction);

    expect(state.focusState).toBe("subagent-inject");
    expect((state as any).subagentInjectMode).toBe(true);
    expect((state as any).subagentInjectTarget).toBe("sub-1");
  });

  it("SCC-G12: SUBAGENT_INJECT_CANCEL clears inject mode and returns focus", () => {
    const base = stateWithSubagents([makeEntry({ id: "sub-1" })], {
      focusState: "subagent-inject" as FocusState,
      subagentInjectMode: true,
      subagentInjectTarget: "sub-1",
      subagentInjectValue: "partial input",
    });

    const state = tuiReducer(base, {
      type: "SUBAGENT_INJECT_CANCEL",
    } as TUIAction);

    expect((state as any).subagentInjectMode).toBe(false);
    expect((state as any).subagentInjectTarget).toBeNull();
    expect((state as any).subagentInjectValue).toBe("");
    // Focus should return to summary or inspect (wherever inject was triggered from)
    expect(
      state.focusState === "subagent-summary" || state.focusState === "subagent-inspect"
    ).toBe(true);
  });

  it("SCC-G13: SUBAGENT_KILL sets status to partial with error message", () => {
    const state = reduceActions([
      { type: "SUBAGENT_PLACEHOLDER", toolCallId: "tc-1", role: "analyst", task: "t" },
      { type: "SUBAGENT_START", subagentId: "sub-1", toolCallId: "tc-1" },
      { type: "SUBAGENT_KILL", subagentId: "sub-1" },
    ] as TUIAction[]);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs[0].status).toBe("partial");
    expect(subs[0].errorMessage).toBe("Killed by user");
    expect(subs[0].endTime).toBeGreaterThan(0);
  });

  it("SCC-G11: SUBAGENT_INJECT_SUBMIT adds injected segment to target subagent", () => {
    const base = stateWithSubagents(
      [makeEntry({
        id: "sub-1",
        status: "running",
        segments: [{ type: "text", text: "working..." }],
      })],
      {
        focusState: "subagent-inject" as FocusState,
        subagentInjectMode: true,
        subagentInjectTarget: "sub-1",
        subagentInjectValue: "focus on layer 5",
      },
    );

    const state = tuiReducer(base, {
      type: "SUBAGENT_INJECT_SUBMIT",
    } as TUIAction);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    const injected = subs[0].segments.filter((s: SubagentSegment) => s.type === "injected");
    expect(injected).toHaveLength(1);
    expect((injected[0] as any).text).toBe("focus on layer 5");
    // After submit, inject mode should be cleared
    expect((state as any).subagentInjectMode).toBe(false);
  });
});

// ==========================================================================
// Group 3: StatusBar Badge (~2 tests)
// ==========================================================================

describe("Group 3: StatusBar Badge", () => {
  it("SCC-G15: StatusBar shows magenta 'N sub' when N>0 running subagents", () => {
    const state = stateWithSubagents([
      makeEntry({ id: "sub-1", status: "running" }),
      makeEntry({ id: "sub-2", status: "completed" }),
      makeEntry({ id: "sub-3", status: "running" }),
    ], { phase: "ready" as any });

    const { lastFrame } = render(React.createElement(StatusBar, { state }));
    const output = stripAnsi(lastFrame() ?? "");

    // Should show "2 sub" (2 running)
    expect(output).toContain("2 sub");
  });

  it("SCC-G16: StatusBar shows nothing when 0 running subagents", () => {
    const state = stateWithSubagents([
      makeEntry({ id: "sub-1", status: "completed" }),
      makeEntry({ id: "sub-2", status: "error" }),
    ], { phase: "ready" as any });

    const { lastFrame } = render(React.createElement(StatusBar, { state }));
    const output = stripAnsi(lastFrame() ?? "");

    // Should NOT contain "sub" badge
    expect(output).not.toContain("sub");
  });
});

// ==========================================================================
// Group 4: SubagentPanel Component Rendering (~8 tests)
// ==========================================================================

describe("Group 4: SubagentPanel Component Rendering", () => {
  it("SCC-G1: Summary bar shows correct status icons per subagent", () => {
    const state = summaryState([
      makeEntry({ id: "sub-1", role: "analyst", status: "running" }),
      makeEntry({ id: "sub-2", role: "builder", status: "completed" }),
      makeEntry({ id: "sub-3", role: "reviewer", status: "error" }),
      makeEntry({ id: "sub-4", role: "checker", status: "partial" }),
    ]);

    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { lastFrame } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );
    const output = lastFrame() ?? "";
    const plain = stripAnsi(output);

    // Icons: running=bullet, completed=check, error=cross, partial=half
    expect(plain).toMatch(/[●\u25CF]/); // running
    expect(plain).toMatch(/[✓\u2713]/); // completed
    expect(plain).toMatch(/[✗\u2717]/); // error
    expect(plain).toMatch(/[◐\u25D0]/); // partial
  });

  it("SCC-G2: Summary bar shows role name, truncated task, elapsed time, token count", () => {
    const state = summaryState([
      makeEntry({
        id: "sub-1",
        role: "analyst",
        task: "Analyze the layout for DRC violations in all metal layers",
        status: "completed",
        startTime: Date.now() - 65000, // 65 seconds ago
        endTime: Date.now(),
        tokenUsage: "15k",
      }),
    ]);

    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { lastFrame } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );
    const plain = stripAnsi(lastFrame() ?? "");

    expect(plain).toContain("analyst");
    // Task should be truncated (not the full 57-char string)
    expect(plain).toContain("Analyze");
    // Should show elapsed time (1m or similar)
    expect(plain).toMatch(/1m|65s|1:05/);
    // Should show token count
    expect(plain).toContain("15k");
  });

  it("SCC-G5: Inspect window renders segments in order: thinking, text, tool_call, injected", () => {
    const entry = makeEntry({
      id: "sub-1",
      segments: [
        { type: "thinking", text: "Analyzing layout..." },
        { type: "text", text: "Found 3 issues." },
        { type: "tool_call", toolName: "read_file", args: "{}", status: "done", result: "ok" },
        { type: "injected", text: "Focus on layer 5" },
      ],
    });
    const state = inspectState([entry], "sub-1");

    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { lastFrame } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );
    const plain = stripAnsi(lastFrame() ?? "");

    expect(plain).toContain("Analyzing layout");
    expect(plain).toContain("Found 3 issues");
    expect(plain).toContain("read_file");
    expect(plain).toContain("Focus on layer 5");
  });

  it("Inspect window renders inject input field when in inject mode", () => {
    const state = stateWithSubagents(
      [makeEntry({ id: "sub-1", status: "running" })],
      {
        focusState: "subagent-inject" as FocusState,
        subagentPanelOpen: true,
        subagentInspectId: "sub-1",
        subagentInjectMode: true,
        subagentInjectTarget: "sub-1",
        subagentInjectValue: "",
      },
    );

    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { lastFrame } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );
    const plain = stripAnsi(lastFrame() ?? "");

    // Should show an input prompt for injection
    expect(plain).toMatch(/inject|message|>|>>>/i);
  });

  it("SCC-G14: i/k only work on running subagents (completed entries are inert)", () => {
    // First verify inject WORKS on a running subagent
    const runningBase = summaryState([
      makeEntry({ id: "sub-run", status: "running" }),
    ]);

    const afterInjectRunning = tuiReducer(runningBase, {
      type: "SUBAGENT_INJECT_START",
      subagentId: "sub-run",
    } as TUIAction);

    // Should enter inject mode for a running subagent
    expect((afterInjectRunning as any).subagentInjectMode).toBe(true);
    expect(afterInjectRunning.focusState).toBe("subagent-inject");

    // Now verify inject is BLOCKED on a completed subagent
    const completedBase = summaryState([
      makeEntry({ id: "sub-done", status: "completed" }),
    ]);

    const afterInjectCompleted = tuiReducer(completedBase, {
      type: "SUBAGENT_INJECT_START",
      subagentId: "sub-done",
    } as TUIAction);

    // Should NOT enter inject mode for a completed subagent
    expect((afterInjectCompleted as any).subagentInjectMode).toBe(false);
    expect(afterInjectCompleted.focusState).not.toBe("subagent-inject");

    // Kill on completed subagent should also be a no-op
    const afterKill = tuiReducer(completedBase, {
      type: "SUBAGENT_KILL",
      subagentId: "sub-done",
    } as TUIAction);

    const subs = (afterKill as any).subagents as SubagentTUIEntry[];
    // Status should remain "completed", not change to "partial"
    expect(subs[0].status).toBe("completed");
  });

  it("SCC-G7a: Ctrl+T in inspect toggles expanded/collapsed detail view", () => {
    // When focus is subagent-inspect, TOGGLE_DETAIL_VIEW should toggle expansion
    const base = inspectState(
      [makeEntry({
        id: "sub-1",
        segments: [{ type: "thinking", text: "long thought..." }],
      })],
      "sub-1",
    );

    // Initially collapsed
    expect(base.toolDetailExpanded).toBe(false);

    const toggled = tuiReducer(base, {
      type: "TOGGLE_DETAIL_VIEW",
    } as TUIAction);

    expect(toggled.toolDetailExpanded).toBe(true);
    expect(toggled.thinkingExpanded).toBe(true);
  });

  it("Summary bar highlights selected entry (selected index)", () => {
    const entries = [
      makeEntry({ id: "sub-1", role: "analyst" }),
      makeEntry({ id: "sub-2", role: "builder" }),
    ];

    // Render with index 0 selected
    const state0 = summaryState(entries);
    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { lastFrame: lastFrame0, unmount: unmount0 } = render(
      React.createElement(SubagentPanel, { state: state0, dispatch }),
    );
    const output0 = lastFrame0() ?? "";
    const plain0 = stripAnsi(output0);
    expect(plain0).toContain("analyst");
    expect(plain0).toContain("builder");

    // The selected row (index 0, "analyst") should have a visual indicator
    // Split into lines and find rows containing role names
    const lines0 = plain0.split("\n");
    const analystLine0 = lines0.find((l: string) => l.includes("analyst")) ?? "";
    const builderLine0 = lines0.find((l: string) => l.includes("builder")) ?? "";
    // Selected row should have a marker (e.g., ">", "▸", or bold/inverse ANSI)
    // that the non-selected row does not have
    expect(analystLine0).not.toBe(builderLine0.replace("builder", "analyst"));
    unmount0();

    // Render with index 1 selected -- navigate down
    const state1 = tuiReducer(state0, {
      type: "SUBAGENT_NAVIGATE",
      direction: "down",
    } as TUIAction);
    expect((state1 as any).subagentSummaryIndex).toBe(1);
    const { lastFrame: lastFrame1, unmount: unmount1 } = render(
      React.createElement(SubagentPanel, { state: state1, dispatch }),
    );
    const output1 = lastFrame1() ?? "";
    const plain1 = stripAnsi(output1);

    // Now builder (index 1) should be selected, analyst should not be
    const lines1 = plain1.split("\n");
    const analystLine1 = lines1.find((l: string) => l.includes("analyst")) ?? "";
    const builderLine1 = lines1.find((l: string) => l.includes("builder")) ?? "";

    // The selection indicator should have moved: analyst row changes, builder row changes
    expect(analystLine1).not.toBe(analystLine0);
    expect(builderLine1).not.toBe(builderLine0);
    unmount1();
  });

  it("Empty panel shows placeholder message when no subagents", () => {
    const state = summaryState([]);

    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { lastFrame } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );
    const plain = stripAnsi(lastFrame() ?? "");

    // Should show some placeholder indicating no subagents
    expect(plain).toMatch(/no subagent|empty|none/i);
  });
});

// ==========================================================================
// Group 5: Focus Routing (~4 tests)
// ==========================================================================

describe("Group 5: Focus Routing", () => {
  it("SCC-G9: Escape from summary closes panel and returns focus to input", () => {
    const base = summaryState([makeEntry({ id: "sub-1" })]);

    // FOCUS_ESCAPE when in subagent-summary should close panel
    const state = tuiReducer(base, { type: "FOCUS_ESCAPE" } as TUIAction);

    expect(state.focusState).toBe("input");
    expect((state as any).subagentPanelOpen).toBe(false);
  });

  it("SCC-G8: Escape from inspect returns to summary", () => {
    const base = inspectState([makeEntry({ id: "sub-1" })], "sub-1");

    const state = tuiReducer(base, { type: "FOCUS_ESCAPE" } as TUIAction);

    expect(state.focusState).toBe("subagent-summary");
    expect((state as any).subagentInspectId).toBeNull();
  });

  it("SCC-G17: Ctrl+S toggle (TOGGLE_SUBAGENT_PANEL) from input opens, from summary closes", () => {
    // From input -> opens panel
    let state = tuiReducer(initialState, {
      type: "TOGGLE_SUBAGENT_PANEL",
    } as TUIAction);
    expect((state as any).subagentPanelOpen).toBe(true);
    expect(state.focusState).toBe("subagent-summary");

    // From summary -> closes panel
    state = tuiReducer(state, {
      type: "TOGGLE_SUBAGENT_PANEL",
    } as TUIAction);
    expect((state as any).subagentPanelOpen).toBe(false);
    expect(state.focusState).toBe("input");
  });

  it("SCC-G20e: Panel-to-panel switch: Ctrl+S -> Ctrl+N closes subagent, opens config", () => {
    // Open subagent panel
    let state = tuiReducer(initialState, {
      type: "TOGGLE_SUBAGENT_PANEL",
    } as TUIAction);
    expect(state.focusState).toBe("subagent-summary");

    // Now open config panel (CONFIG_PANEL_OPEN should close subagent panel)
    state = tuiReducer(state, {
      type: "CONFIG_PANEL_OPEN",
      tab: "settings",
    } as TUIAction);

    expect(state.focusState).toBe("config-panel");
    // Subagent panel should be closed when config panel opens
    expect((state as any).subagentPanelOpen).toBe(false);
  });
});

// ==========================================================================
// Group 6: Focus Exclusivity (~4 tests)
// ==========================================================================

describe("Group 6: Focus Exclusivity", () => {
  it("SCC-G20a/b/c: When subagent-summary is focused, input keys do not leak", () => {
    // This is a behavioral test: verify that the focus state prevents
    // input-level actions from taking effect.
    const base = summaryState([makeEntry({ id: "sub-1" })]);

    // Typing characters while in subagent-summary should not change inputText
    // (The component should not forward these to input handlers)
    expect(base.focusState).toBe("subagent-summary");
    expect(base.inputText).toBe("");

    // FOCUS_UP/DOWN in subagent-summary should navigate subagents, not input history
    const afterDown = tuiReducer(base, {
      type: "SUBAGENT_NAVIGATE",
      direction: "down",
    } as TUIAction);
    // inputText should remain unchanged
    expect(afterDown.inputText).toBe("");
  });

  it("SCC-G20d: Escape from subagent-summary returns to input, does not abort agent", () => {
    const base = summaryState([makeEntry({ id: "sub-1" })]);
    // Set phase to streaming to verify escape doesn't abort the agent
    const streaming = { ...base, phase: "streaming" as const };

    const state = tuiReducer(streaming, { type: "FOCUS_ESCAPE" } as TUIAction);

    expect(state.focusState).toBe("input");
    // Phase should still be streaming (escape closes panel, doesn't abort)
    expect(state.phase).toBe("streaming");
  });

  it("SCC-G20f: ConfigPanel edit interrupted by Ctrl+S exits cleanly", () => {
    // Start in config panel, editing a value
    const editing: TUIState = {
      ...initialState,
      focusState: "config-panel" as FocusState,
      configPanel: {
        ...initialState.configPanel,
        open: true,
        tab: "settings",
        editing: true,
        editValue: "partial edit",
      },
    };

    // Toggle subagent panel (Ctrl+S) while editing config
    const state = tuiReducer(editing, {
      type: "TOGGLE_SUBAGENT_PANEL",
    } as TUIAction);

    // Config panel should be closed, editing cancelled
    expect(state.configPanel.open).toBe(false);
    expect(state.configPanel.editing).toBe(false);
    // Subagent panel should now be open
    expect((state as any).subagentPanelOpen).toBe(true);
    expect(state.focusState).toBe("subagent-summary");
  });
});

// ==========================================================================
// Group 7: ID Mapping lifecycle (SCC-G18/G19/G20, integration)
// ==========================================================================

describe("Group 7: ID Mapping Lifecycle", () => {
  it("SCC-G18/G19/G20: Full lifecycle - placeholder -> start -> events -> end", () => {
    const state = reduceActions([
      // Phase 1: delegate tool starts, creates placeholder with toolCallId
      { type: "SUBAGENT_PLACEHOLDER", toolCallId: "tc-99", role: "reviewer", task: "Review routing" },
      // Phase 2: runner emits "started", mapping toolCallId -> subagentId
      { type: "SUBAGENT_START", subagentId: "sub-real-42", toolCallId: "tc-99" },
      // Phase 3: subsequent events use subagentId
      { type: "SUBAGENT_THINKING", subagentId: "sub-real-42", text: "Checking routes..." },
      { type: "SUBAGENT_TEXT", subagentId: "sub-real-42", text: "3 routes found." },
      { type: "SUBAGENT_TOOL_START", subagentId: "sub-real-42", toolName: "get_layout_info", args: "{}" },
      { type: "SUBAGENT_TOOL_END", subagentId: "sub-real-42", toolName: "get_layout_info", result: "layers: 5" },
      { type: "SUBAGENT_END", subagentId: "sub-real-42", status: "completed", findings: 3, warnings: 0, tokenUsage: "8k" },
    ] as TUIAction[]);

    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs).toHaveLength(1);

    const entry = subs[0];
    // Final id should be the subagentId
    expect(entry.id).toBe("sub-real-42");
    // toolCallId preserved for traceability
    expect(entry.toolCallId).toBe("tc-99");
    // Status completed
    expect(entry.status).toBe("completed");
    // Segments: thinking + text + tool_call (1, updated in-place) = 3
    expect(entry.segments.length).toBeGreaterThanOrEqual(3);
    expect(entry.findings).toBe(3);
    expect(entry.tokenUsage).toBe("8k");
    expect(entry.endTime).toBeGreaterThan(0);
  });
});

// ==========================================================================
// Group 8: SubagentPanel Key Routing (4 tests)
// ==========================================================================

describe("Group 8: SubagentPanel Key Routing", () => {
  it("Up/Down in summary dispatches SUBAGENT_NAVIGATE", () => {
    const state = summaryState([
      makeEntry({ id: "sub-1", role: "analyst" }),
      makeEntry({ id: "sub-2", role: "builder" }),
    ]);
    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { stdin } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );

    pressKey(stdin, "down");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_NAVIGATE",
      direction: "down",
    });

    pressKey(stdin, "up");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_NAVIGATE",
      direction: "up",
    });
  });

  it("Enter in summary dispatches SUBAGENT_INSPECT", () => {
    const entries = [
      makeEntry({ id: "sub-1", role: "analyst" }),
      makeEntry({ id: "sub-2", role: "builder" }),
    ];
    const state = summaryState(entries);
    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { stdin } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );

    pressKey(stdin, "enter");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_INSPECT",
      subagentId: entries[(state as any).subagentSummaryIndex].id,
    });
  });

  it("i key in summary dispatches SUBAGENT_INJECT_START on running entry", () => {
    const entries = [
      makeEntry({ id: "sub-1", role: "analyst", status: "running" }),
    ];
    const state = summaryState(entries);
    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { stdin } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );

    // 'i' is not in KEY_MAP, write directly to stdin
    stdin.write("i");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_INJECT_START",
      subagentId: entries[(state as any).subagentSummaryIndex].id,
    });
  });

  it("k key in summary dispatches SUBAGENT_KILL on running entry", () => {
    const entries = [
      makeEntry({ id: "sub-1", role: "analyst", status: "running" }),
    ];
    const state = summaryState(entries);
    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { stdin } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );

    // 'k' is not in KEY_MAP, write directly to stdin
    stdin.write("k");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_KILL",
      subagentId: entries[(state as any).subagentSummaryIndex].id,
    });
  });
});

// ==========================================================================
// Group 9: Inspect Window Key Routing (2 tests)
// ==========================================================================

describe("Group 9: Inspect Window Key Routing", () => {
  it("Left/Right in inspect dispatches SUBAGENT_INSPECT_NAV", () => {
    const entries = [
      makeEntry({ id: "sub-1", role: "analyst" }),
      makeEntry({ id: "sub-2", role: "builder" }),
    ];
    const state = inspectState(entries, "sub-1");
    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { stdin } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );

    pressKey(stdin, "left");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_INSPECT_NAV",
      direction: "left",
    });

    pressKey(stdin, "right");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_INSPECT_NAV",
      direction: "right",
    });
  });

  it("Up/Down in inspect dispatches SUBAGENT_INSPECT_SCROLL", () => {
    const entries = [
      makeEntry({
        id: "sub-1",
        role: "analyst",
        segments: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
          { type: "text", text: "line 3" },
        ],
      }),
    ];
    const state = inspectState(entries, "sub-1");
    expect(SubagentPanel).toBeDefined();
    const dispatch = vi.fn();
    const { stdin } = render(
      React.createElement(SubagentPanel, { state, dispatch }),
    );

    pressKey(stdin, "up");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_INSPECT_SCROLL",
      direction: "up",
    });

    pressKey(stdin, "down");
    expect(dispatch).toHaveBeenCalledWith({
      type: "SUBAGENT_INSPECT_SCROLL",
      direction: "down",
    });
  });
});

// ---------------------------------------------------------------------------
// Finding 1 (code-review-issue-23) — delegate placeholder parses both new and
// legacy args. The reducer's SUBAGENT_PLACEHOLDER is idempotent, so the
// fields written on the first tool_execution_start must be correct; if they
// aren't, the panel shows "unknown / empty" forever.
//
// R2 finding #2 — parseDelegatePlaceholder now also resolves the effective
// role name (so unknown subagent_type values display as "general-purpose",
// matching what the runner actually runs).
// ---------------------------------------------------------------------------
import { parseDelegatePlaceholder } from "../src/tui/delegate-placeholder.js";
import type { SubagentConfig } from "../src/types/v04-contracts.js";

function makePlaceholderCfg(overrides?: Partial<SubagentConfig>): SubagentConfig {
  return {
    enabled: true, logDir: "/tmp", maxLogFiles: 10,
    roles: {
      designer: {
        label: "Designer", promptFile: "subagent/designer.md", workspaceFiles: [],
        baseTools: ["read", "write"], customTools: ["submit_result"],
        mcpAccess: "full", maxTurns: 100, maxTokens: 200000,
      },
    },
    ...overrides,
  };
}

describe("Finding 1: parseDelegatePlaceholder", () => {
  it("new schema: {subagent_type, prompt} (known role) → role=subagent_type, task=prompt", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ subagent_type: "designer", prompt: "design a Hall bar" }),
      makePlaceholderCfg(),
    );
    expect(fields).not.toBeNull();
    expect(fields!.role).toBe("designer");
    expect(fields!.task).toBe("design a Hall bar");
  });

  it("legacy schema: {role, task} (known role) → role=role, task=task", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ role: "designer", task: "design a Hall bar" }),
      makePlaceholderCfg(),
    );
    expect(fields).not.toBeNull();
    expect(fields!.role).toBe("designer");
    expect(fields!.task).toBe("design a Hall bar");
  });

  it("new schema preferred over legacy when both present", () => {
    const cfg = makePlaceholderCfg({
      roles: {
        designer: makePlaceholderCfg().roles.designer,
        scout: {
          label: "Scout", promptFile: "", workspaceFiles: [],
          baseTools: ["read"], customTools: ["submit_result"],
          mcpAccess: "shared-readonly", maxTurns: 50, maxTokens: 100000,
        },
      },
    });
    const fields = parseDelegatePlaceholder(
      JSON.stringify({
        subagent_type: "scout",
        prompt: "scout task",
        role: "designer",
        task: "designer task",
      }),
      cfg,
    );
    expect(fields!.role).toBe("scout");
    expect(fields!.task).toBe("scout task");
  });

  it("neither field present → falls back to general-purpose / empty", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ description: "oops" }),
      makePlaceholderCfg(),
    );
    expect(fields!.role).toBe("general-purpose");
    expect(fields!.task).toBe("");
  });

  it("already-object args (not a JSON string) are accepted", () => {
    const fields = parseDelegatePlaceholder(
      { subagent_type: "designer", prompt: "analyze" },
      makePlaceholderCfg(),
    );
    expect(fields!.role).toBe("designer");
    expect(fields!.task).toBe("analyze");
  });

  it("malformed JSON string returns null (caller falls back to 'started' event)", () => {
    expect(parseDelegatePlaceholder("{not json", makePlaceholderCfg())).toBeNull();
  });

  it("dispatching placeholder built from new-schema args yields correct panel entry", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ subagent_type: "general-purpose", prompt: "read README" }),
      makePlaceholderCfg(),
    )!;
    let state = initialState;
    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-new",
      role: fields.role,
      task: fields.task,
    } as TUIAction);
    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs).toHaveLength(1);
    expect(subs[0].role).toBe("general-purpose");
    expect(subs[0].task).toBe("read README");
    expect(subs[0].status).toBe("running");
  });

  it("legacy placeholder remains correct end-to-end (regression)", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ role: "designer", task: "legacy task" }),
      makePlaceholderCfg(),
    )!;
    let state = initialState;
    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-legacy",
      role: fields.role,
      task: fields.task,
    } as TUIAction);
    const subs = (state as any).subagents as SubagentTUIEntry[];
    expect(subs[0].role).toBe("designer");
    expect(subs[0].task).toBe("legacy task");
  });
});

describe("R2 finding #2: placeholder shows effective role, not raw args", () => {
  it("new schema, unknown subagent_type → placeholder shows 'general-purpose'", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ subagent_type: "totally-made-up", prompt: "do something" }),
      makePlaceholderCfg(),
    );
    expect(fields!.role).toBe("general-purpose");
    expect(fields!.task).toBe("do something");
  });

  it("legacy schema, unknown role → placeholder shows 'general-purpose'", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ role: "nonexistent", task: "legacy unknown" }),
      makePlaceholderCfg(),
    );
    expect(fields!.role).toBe("general-purpose");
    expect(fields!.task).toBe("legacy unknown");
  });

  it("new schema, omitted role → placeholder shows 'general-purpose' (matches delegate default)", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ description: "no role given", prompt: "do thing" }),
      makePlaceholderCfg(),
    );
    expect(fields!.role).toBe("general-purpose");
    expect(fields!.task).toBe("do thing");
  });

  it("new schema, known role → placeholder shows the known role (regression)", () => {
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ subagent_type: "designer", prompt: "design" }),
      makePlaceholderCfg(),
    );
    expect(fields!.role).toBe("designer");
    expect(fields!.task).toBe("design");
  });

  it("unknown-role fallback + custom 'general-purpose' config → still shows 'general-purpose'", () => {
    const cfg = makePlaceholderCfg({
      roles: {
        "general-purpose": {
          label: "Custom GP", promptFile: "", workspaceFiles: [],
          baseTools: ["read"], customTools: ["submit_result"],
          mcpAccess: "shared-readonly", maxTurns: 5, maxTokens: 10000,
        },
      },
    });
    const fields = parseDelegatePlaceholder(
      JSON.stringify({ subagent_type: "typo-role", prompt: "x" }),
      cfg,
    );
    // Effective NAME is still "general-purpose" — resolver picks the config
    // override under that name when the runner runs it. The panel label is
    // computed from the runtime RoleConfig later; here we only assert the
    // name lines up with what the runner will actually run.
    expect(fields!.role).toBe("general-purpose");
  });
});
