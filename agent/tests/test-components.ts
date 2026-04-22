/**
 * Consolidated component tests for qlaybot TUI.
 * Covers: MarkdownText, ThinkingIndicator, StreamingBar, ErrorBanner, UserMessage,
 * CompletionList, ToolPanel, SystemMessage, AssistantMessage, MessageList,
 * InputBox, StatusBar, BackgroundBar, WorkspaceBar.
 *
 * Uses ink-testing-library for React/Ink component rendering.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import React from "react";
import { render, cleanup } from "ink-testing-library";
import stripAnsi from "strip-ansi";

// Component imports
import { MarkdownText } from "../src/tui/components/MarkdownText.js";
import { ThinkingIndicator } from "../src/tui/components/ThinkingIndicator.js";
import { PlanApprovalMenu } from "../src/tui/components/PlanApprovalMenu.js";
import { StreamingBar, formatTokens } from "../src/tui/components/StreamingBar.js";
import { ErrorBanner } from "../src/tui/components/ErrorBanner.js";
import { UserMessage } from "../src/tui/components/UserMessage.js";
import { CompletionList } from "../src/tui/components/CompletionList.js";
import { ToolPanel } from "../src/tui/components/ToolPanel.js";
import { SystemMessage } from "../src/tui/components/SystemMessage.js";
import { MessageList } from "../src/tui/components/MessageList.js";
import { InputBox } from "../src/tui/components/InputBox.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { BackgroundBar } from "../src/tui/components/BackgroundBar.js";

// Types
import type {
  ToolExecution,
  ContextSection,
  SessionPhase,
  AssistantMessageData,
  UserMessageData,
  SystemMessageData,
  MessageData,
  TUIState,
  BackgroundTaskSummaryTUI,
} from "../src/tui/types.js";
import type { CommandMatch } from "../src/tui/commands.js";
import { pressKey } from "./helpers/ink-helpers.js";

// Helpers
afterEach(() => { cleanup(); });

function renderText(element: React.ReactElement): string {
  const instance = render(element);
  const frame = instance.lastFrame() ?? "";
  instance.unmount();
  return stripAnsi(frame);
}

function renderRaw(element: React.ReactElement): string {
  const instance = render(element);
  const frame = instance.lastFrame() ?? "";
  instance.unmount();
  return frame;
}

// Factory helpers
function makeAssistantMessage(overrides: Partial<AssistantMessageData> = {}): AssistantMessageData {
  return {
    id: "ast-1", role: "assistant", segments: [], textChunks: [], thinkingChunks: [],
    tools: [], isStreaming: false, startedAt: 1000, completedAt: 5000, ...overrides,
  };
}

function makeUserMessage(overrides: Partial<UserMessageData> = {}): UserMessageData {
  return { id: "usr-1", role: "user", text: "Hello qlaybot", ...overrides };
}

function makeSystemMessage(overrides: Partial<SystemMessageData> = {}): SystemMessageData {
  return { id: "sys-1", role: "system", text: "System initialized", ...overrides };
}

function makeTool(overrides: Partial<ToolExecution> = {}): ToolExecution {
  return {
    id: "tool-1", toolName: "Bash", args: { command: "ls -la" }, status: "completed",
    result: "file1.txt\nfile2.txt", startTime: 1000, endTime: 2500, ...overrides,
  };
}

function makeDefaultTUIState(overrides: Partial<TUIState> = {}): TUIState {
  return {
    phase: "ready", modelName: "claude-opus-4", thinkingLevel: "medium", messages: [],
    currentAssistant: null, error: null, planMode: false, showThinking: false,
    backgroundTaskCount: 0, tokenUsage: null, contextUsage: null, isCompacting: false,
    inPlanMode: false, toolDetailExpanded: false, thinkingExpanded: false, backgroundTasks: [],
    ...overrides,
  };
}

function makeBgTask(overrides: Partial<BackgroundTaskSummaryTUI> = {}): BackgroundTaskSummaryTUI {
  return { id: "bg-1", name: "align", status: "running", startedAt: Date.now() - 5000, ...overrides };
}

// ============================================================
// MarkdownText
// ============================================================

describe("MarkdownText", () => {
  it("renders markdown content as text", () => {
    const text = renderText(React.createElement(MarkdownText, null, "Hello **world**"));
    expect(text).toContain("world");
  });

  it("renders heading without raw ### markers", () => {
    const text = renderText(React.createElement(MarkdownText, null, "### My Heading"));
    expect(text).toContain("My Heading");
    expect(text).not.toContain("###");
  });

  it("returns empty frame for empty/whitespace content", () => {
    expect(renderText(React.createElement(MarkdownText, null, "")).trim()).toBe("");
    expect(renderText(React.createElement(MarkdownText, null, "   ")).trim()).toBe("");
  });

  it("renders bullet lists with bullet characters", () => {
    const text = renderRaw(React.createElement(MarkdownText, null, "- item one\n- item two"));
    expect(text).toContain("\u2022");
  });
});

// ============================================================
// ThinkingIndicator
// ============================================================

describe("ThinkingIndicator", () => {
  it("returns empty frame for empty chunks", () => {
    const text = renderText(React.createElement(ThinkingIndicator, { chunks: [], isActive: true }));
    expect(text.trim()).toBe("");
  });

  it("shows thinking text when chunks provided and active", () => {
    const text = renderText(React.createElement(ThinkingIndicator, {
      chunks: ["Analyzing the problem..."], isActive: true,
    }));
    expect(text).toContain("Analyzing the problem");
  });

  it("truncates early lines when chunks exceed 10 lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => i < 10 ? `Early_${i + 1}` : `Late_${i + 1}`);
    const text = renderText(React.createElement(ThinkingIndicator, { chunks: [lines.join("\n")], isActive: false }));
    expect(text).toMatch(/\d+ lines? hidden/i);
    expect(text).toContain("Late_20");
    expect(text).not.toContain("Early_1");
  });
});

// ============================================================
// Task 1.5 / T38 — ThinkingIndicator `source` prop
// ============================================================
//
// Source of truth:
//  - docs/superpowers/specs/2026-04-19-qlaybot-0.4.4-design.md §3.2 TH-6,
//    TH-9 (source field distinguishable).
//  - docs/superpowers/plans/2026-04-21-qlaybot-0.4.4.md Task 1.5 Step 1 (T38).
//
// Backwards-compat (v0.4.3): when `source` is omitted it MUST default to
// "native" so existing call sites (and the "ThinkingIndicator" block above)
// keep producing the same output.

describe("ThinkingIndicator source prop (T38)", () => {
  it("empty chunks + any source → null (no output)", () => {
    const text = renderText(
      React.createElement(ThinkingIndicator, {
        chunks: [],
        isActive: true,
        source: "tool",
      } as any),
    );
    expect(text.trim()).toBe("");
  });

  it("renders the same text content for source='tool' as for source='native'", () => {
    // The content text is identical; only the theme color should change.
    const tool = renderText(
      React.createElement(ThinkingIndicator, {
        chunks: ["Deciding between A and B"],
        isActive: false,
        source: "tool",
      } as any),
    );
    const native = renderText(
      React.createElement(ThinkingIndicator, {
        chunks: ["Deciding between A and B"],
        isActive: false,
        source: "native",
      } as any),
    );
    expect(tool).toContain("Deciding between A and B");
    expect(native).toContain("Deciding between A and B");
  });

  it("source='tool' and source='native' produce DIFFERENT raw frames (theme-color swap, TH-6/TH-9)", () => {
    // The ANSI-stripped text is equal; the raw (unstripped) frames differ
    // because only the chalk theme color changes. This is a non-byte-equal
    // assertion on the raw frame to avoid locking the test to a specific
    // hex — any color swap satisfies it.
    const tool = renderRaw(
      React.createElement(ThinkingIndicator, {
        chunks: ["source swap probe"],
        isActive: false,
        source: "tool",
      } as any),
    );
    const native = renderRaw(
      React.createElement(ThinkingIndicator, {
        chunks: ["source swap probe"],
        isActive: false,
        source: "native",
      } as any),
    );
    // Both render the same text content (sanity).
    expect(tool.length).toBeGreaterThan(0);
    expect(native.length).toBeGreaterThan(0);
    // Raw bytes must differ — the only diff is the chalk color wrapper.
    expect(tool).not.toBe(native);
  });

  it(">10 lines with source='tool' still shows `... N lines hidden ...` with correct N", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      i < 15 ? `Early_${i + 1}` : `Late_${i + 1}`,
    );
    const text = renderText(
      React.createElement(ThinkingIndicator, {
        chunks: [lines.join("\n")],
        isActive: false,
        source: "tool",
      } as any),
    );
    expect(text).toMatch(/15 lines? hidden/i);
    expect(text).toContain("Late_25");
    expect(text).not.toContain("Early_1\n");
  });

  it("isActive=true with source='tool' renders a spinner AND the thinking label", () => {
    const text = renderText(
      React.createElement(ThinkingIndicator, {
        chunks: ["active probe"],
        isActive: true,
        source: "tool",
      } as any),
    );
    // The existing component's label is " thinking" (leading space from the
    // current implementation) — we match the canonical substring "thinking".
    expect(text).toContain("thinking");
    expect(text).toContain("active probe");
  });

  it("isActive=false with source='tool' renders the content but the raw frame is smaller (no spinner characters)", () => {
    const activeRaw = renderRaw(
      React.createElement(ThinkingIndicator, {
        chunks: ["spinner-gate probe"],
        isActive: true,
        source: "tool",
      } as any),
    );
    const idleRaw = renderRaw(
      React.createElement(ThinkingIndicator, {
        chunks: ["spinner-gate probe"],
        isActive: false,
        source: "tool",
      } as any),
    );
    // Both contain the content.
    expect(stripAnsi(activeRaw)).toContain("spinner-gate probe");
    expect(stripAnsi(idleRaw)).toContain("spinner-gate probe");
    // Active frame is not byte-identical to idle — the Spinner adds at
    // least one rendered glyph. We do NOT assert on the specific spinner
    // character because @inkjs/ui may pick different ones; we only assert
    // the two frames differ.
    expect(activeRaw).not.toBe(idleRaw);
  });

  it("source prop defaults to 'native' when omitted (v0.4.3 backwards compat)", () => {
    // Render with and without source — omitted must render identical to
    // source:"native".
    const omittedRaw = renderRaw(
      React.createElement(ThinkingIndicator, {
        chunks: ["backcompat probe"],
        isActive: false,
      } as any),
    );
    const nativeRaw = renderRaw(
      React.createElement(ThinkingIndicator, {
        chunks: ["backcompat probe"],
        isActive: false,
        source: "native",
      } as any),
    );
    expect(omittedRaw).toBe(nativeRaw);
  });

  it("source='inline' renders cleanly without crashing (TH-9 reserves all three sources — review item #9)", () => {
    // TH-9 reserves `source: "tool" | "native" | "inline"`. v0.4.4 does not
    // ship a producer for "inline" but the prop must be accepted without
    // throwing and render the content. We allow the theme color to match
    // either "native" or "tool" — the Executor picks — we just assert
    // no-crash + non-null frame + content visible.
    const raw = renderRaw(
      React.createElement(ThinkingIndicator, {
        chunks: ["inline-source probe"],
        isActive: false,
        source: "inline",
      } as any),
    );
    expect(raw).toBeDefined();
    expect(raw.length).toBeGreaterThan(0);
    const text = stripAnsi(raw);
    expect(text).toContain("inline-source probe");
  });
});

describe("PlanApprovalMenu (T31)", () => {
  it("maps 1 to approve_execute", () => {
    const onAction = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PlanApprovalMenu, {
        planFilePath: "/tmp/test-plan.md",
        onAction,
      }),
    );

    stdin.write("1");
    expect(onAction).toHaveBeenCalledWith({ action: "approve_execute" });
    unmount();
  });

  it("maps 2 to approve_only", () => {
    const onAction = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PlanApprovalMenu, {
        planFilePath: "/tmp/test-plan.md",
        onAction,
      }),
    );

    stdin.write("2");
    expect(onAction).toHaveBeenCalledWith({ action: "approve_only" });
    unmount();
  });

  it("maps 3 then feedback submit to reject with feedback", () => {
    const onAction = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PlanApprovalMenu, {
        planFilePath: "/tmp/test-plan.md",
        onAction,
      }),
    );

    stdin.write("3");
    stdin.write("not quite, missing pad spacing");
    pressKey(stdin, "enter");
    expect(onAction).toHaveBeenCalledWith({
      action: "reject",
      feedback: "not quite, missing pad spacing",
    });
    unmount();
  });

  it("maps 4 to abandon", () => {
    const onAction = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PlanApprovalMenu, {
        planFilePath: "/tmp/test-plan.md",
        onAction,
      }),
    );

    stdin.write("4");
    expect(onAction).toHaveBeenCalledWith({ action: "abandon" });
    unmount();
  });

  it("treats non-affirmative free text at the root as reject feedback", () => {
    const onAction = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PlanApprovalMenu, {
        planFilePath: "/tmp/test-plan.md",
        onAction,
      }),
    );

    stdin.write("needs wider spacing");
    pressKey(stdin, "enter");
    expect(onAction).toHaveBeenCalledWith({
      action: "reject",
      feedback: "needs wider spacing",
    });
    unmount();
  });

  it("treats affirmative tokens and bare Enter as approve_execute", () => {
    const affirmative = [
      "yes",
      "y",
      "go",
      "/go",
      "ok",
      "okay",
      "approved",
      "approve",
    ];

    for (const token of affirmative) {
      const onAction = vi.fn();
      const { stdin, unmount } = render(
        React.createElement(PlanApprovalMenu, {
          planFilePath: "/tmp/test-plan.md",
          onAction,
        }),
      );

      stdin.write(token.toUpperCase());
      pressKey(stdin, "enter");
      expect(onAction).toHaveBeenCalledWith({ action: "approve_execute" });
      unmount();
    }

    const bareEnter = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(PlanApprovalMenu, {
        planFilePath: "/tmp/test-plan.md",
        onAction: bareEnter,
      }),
    );
    pressKey(stdin, "enter");
    expect(bareEnter).toHaveBeenCalledWith({ action: "approve_execute" });
    unmount();
  });
});

// ============================================================
// StreamingBar
// ============================================================

describe("StreamingBar", () => {
  describe("formatTokens", () => {
    it("formats token counts correctly", () => {
      expect(formatTokens(500)).toBe("500");
      expect(formatTokens(0)).toBe("0");
      expect(formatTokens(5000)).toBe("5.0k");
      expect(formatTokens(15000)).toBe("15k");
    });
  });

  it("returns empty when phase is ready/initializing", () => {
    expect(renderText(React.createElement(StreamingBar, { phase: "ready" as SessionPhase, tokenUsage: null, isThinking: false })).trim()).toBe("");
    expect(renderText(React.createElement(StreamingBar, { phase: "initializing" as SessionPhase, tokenUsage: null, isThinking: false })).trim()).toBe("");
  });

  it("renders token count during streaming", () => {
    const text = renderText(React.createElement(StreamingBar, {
      phase: "streaming" as SessionPhase, isThinking: false,
      tokenUsage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
    }));
    expect(text).toContain("1.5k");
  });

  it("shows thinking badge when isThinking", () => {
    const text = renderText(React.createElement(StreamingBar, {
      phase: "streaming" as SessionPhase, tokenUsage: null, isThinking: true,
    }));
    expect(text.toLowerCase()).toContain("thinking");
  });
});

// ============================================================
// ErrorBanner
// ============================================================

describe("ErrorBanner", () => {
  it("shows Error prefix and message text", () => {
    const text = renderText(React.createElement(ErrorBanner, { error: "Connection refused" }));
    expect(text).toContain("Error");
    expect(text).toContain("Connection refused");
  });
});

// ============================================================
// UserMessage
// ============================================================

describe("UserMessage", () => {
  it("shows > prefix and user text with styling", () => {
    const text = renderText(React.createElement(UserMessage, { text: "Build a hall bar" }));
    expect(text).toContain(">");
    expect(text).toContain("Build a hall bar");
    expect(renderRaw(React.createElement(UserMessage, { text: "test" }))).toMatch(/\x1b\[/);
  });
});

// ============================================================
// CompletionList
// ============================================================

describe("CompletionList", () => {
  const matches: CommandMatch[] = [
    { name: "/model", description: "Show or change model" },
    { name: "/mcp", description: "MCP server status" },
    { name: "/memory", description: "Memory management" },
  ];

  it("renders all matches with descriptions", () => {
    const text = renderText(React.createElement(CompletionList, { matches, selectedIndex: 0 }));
    expect(text).toContain("/model");
    expect(text).toContain("/mcp");
    expect(text).toContain("MCP server status");
  });

  it("highlights selected match with > marker", () => {
    const text = renderText(React.createElement(CompletionList, { matches, selectedIndex: 1 }));
    const mcpLine = text.split("\n").find((l) => l.includes("/mcp"));
    expect(mcpLine).toContain(">");
  });

  it("renders with border characters", () => {
    const text = renderText(React.createElement(CompletionList, { matches, selectedIndex: 0 }));
    expect(text).toMatch(/[│─┌┐└┘╭╮╰╯]/);
  });
});

// ============================================================
// ToolPanel
// ============================================================

describe("ToolPanel", () => {
  const baseTool: ToolExecution = {
    id: "tool-1", toolName: "Bash", args: { command: "ls -la" }, status: "completed",
    result: "file1.txt\nfile2.txt", startTime: 1000, endTime: 2500,
  };

  it("shows tool name and command arg", () => {
    const text = renderText(React.createElement(ToolPanel, { tool: baseTool }));
    expect(text.toLowerCase()).toContain("bash");
    expect(text).toContain("ls -la");
  });

  it("extracts file_path for read/edit/write tools", () => {
    const readTool = { ...baseTool, toolName: "Read", args: { file_path: "/src/main.ts" } };
    expect(renderText(React.createElement(ToolPanel, { tool: readTool }))).toContain("/src/main.ts");
  });

  it("shows duration for completed tools", () => {
    const text = renderText(React.createElement(ToolPanel, { tool: baseTool }));
    expect(text).toMatch(/1\.5|1500/);
  });

  it("shows checkmark for completed, cross for error", () => {
    expect(renderText(React.createElement(ToolPanel, { tool: baseTool }))).toMatch(/[✓✔\u2713\u2714]/);
    const errorTool = { ...baseTool, status: "error" as const, result: "Failed" };
    expect(renderText(React.createElement(ToolPanel, { tool: errorTool }))).toMatch(/[✕✗✘×\u2715\u2717\u2718]/);
  });

  it("shows full args JSON when expanded", () => {
    const text = renderText(React.createElement(ToolPanel, { tool: baseTool, expanded: true }));
    expect(text).toContain("command");
    expect(text).toContain("ls -la");
  });
});

// ============================================================
// SystemMessage
// ============================================================

describe("SystemMessage", () => {
  it("renders text content", () => {
    const text = renderText(React.createElement(SystemMessage, { text: "System initialized" }));
    expect(text).toContain("System initialized");
  });

  it("shows section titles and summaries", () => {
    const sections: ContextSection[] = [
      { title: "Configuration", summary: "All settings loaded", details: "Model: claude-opus-4" },
    ];
    const text = renderText(React.createElement(SystemMessage, { text: "Context", sections }));
    expect(text).toContain("Configuration");
    expect(text).toContain("All settings loaded");
  });

  it("shows details when expanded, hides when collapsed", () => {
    const sections: ContextSection[] = [
      { title: "Config", summary: "Loaded", details: "Model: claude-opus-4, MCP: connected" },
    ];
    const expanded = renderText(React.createElement(SystemMessage, { text: "Context", sections, expanded: true }));
    const collapsed = renderText(React.createElement(SystemMessage, { text: "Context", sections, expanded: false }));
    expect(expanded).toContain("Model: claude-opus-4");
    expect(collapsed).not.toContain("Model: claude-opus-4");
  });

  it("shows ctrl+t hint when sections provided", () => {
    const sections: ContextSection[] = [{ title: "Info", summary: "Summary" }];
    const text = renderText(React.createElement(SystemMessage, { text: "Sys", sections }));
    expect(text.toLowerCase()).toMatch(/ctrl\+t|ctrl-t/);
  });
});

// ============================================================
// AssistantMessage
// ============================================================

describe("AssistantMessage", () => {
  let AssistantMessage: any;

  beforeEach(async () => {
    try {
      const mod = await import("../src/tui/components/AssistantMessage.js");
      AssistantMessage = mod.AssistantMessage;
    } catch { AssistantMessage = undefined; }
  });

  it("exports component", () => {
    expect(AssistantMessage).toBeDefined();
  });

  it("renders text segments", () => {
    const msg = makeAssistantMessage({
      segments: [{ type: "text", chunks: ["Hello from the assistant"] }],
      textChunks: ["Hello from the assistant"],
    });
    expect(renderText(React.createElement(AssistantMessage, { message: msg }))).toContain("Hello from the assistant");
  });

  it("renders thinking before text (ordered)", () => {
    const msg = makeAssistantMessage({
      segments: [
        { type: "thinking", chunks: ["Let me analyze..."] },
        { type: "text", chunks: ["The answer is 42"] },
      ],
      thinkingChunks: ["Let me analyze..."],
      textChunks: ["The answer is 42"],
    });
    const text = renderText(React.createElement(AssistantMessage, { message: msg, thinkingExpanded: true }));
    expect(text.indexOf("analyze")).toBeLessThan(text.indexOf("42"));
  });

  it("shows footer with elapsed time after completion", () => {
    const msg = makeAssistantMessage({
      segments: [{ type: "text", chunks: ["Done."] }],
      textChunks: ["Done."],
      startedAt: 1000, completedAt: 5000,
    });
    expect(renderText(React.createElement(AssistantMessage, { message: msg }))).toMatch(/4\.?0?s/);
  });

  it("respects thinkingExpanded prop", () => {
    const msg = makeAssistantMessage({
      segments: [
        { type: "thinking", chunks: ["Deep reasoning"] },
        { type: "text", chunks: ["Final answer"] },
      ],
      thinkingChunks: ["Deep reasoning"],
      textChunks: ["Final answer"],
    });
    const collapsed = renderText(React.createElement(AssistantMessage, { message: msg, thinkingExpanded: false }));
    const expanded = renderText(React.createElement(AssistantMessage, { message: msg, thinkingExpanded: true }));
    expect(collapsed).not.toContain("Deep reasoning");
    expect(expanded).toContain("Deep reasoning");
  });
});

// ============================================================
// MessageList
// ============================================================

describe("MessageList", () => {
  it("renders user messages with > prefix (not You:)", () => {
    const messages: MessageData[] = [makeUserMessage({ text: "Build a hall bar" })];
    const text = renderText(React.createElement(MessageList, {
      messages, currentStreaming: null, toolDetailExpanded: false, thinkingExpanded: false,
    }));
    expect(text).toContain(">");
    expect(text).not.toContain("You:");
    expect(text).toContain("Build a hall bar");
  });

  it("renders multiple message types in correct order", () => {
    const messages: MessageData[] = [
      makeSystemMessage({ id: "sys-1", text: "Welcome" }),
      makeUserMessage({ id: "usr-1", text: "Hello" }),
      makeAssistantMessage({
        id: "ast-1",
        segments: [{ type: "text", chunks: ["Hi there"] }],
        textChunks: ["Hi there"], startedAt: 1000, completedAt: 2000,
      }),
    ];
    const text = renderText(React.createElement(MessageList, {
      messages, currentStreaming: null, toolDetailExpanded: false, thinkingExpanded: false,
    }));
    expect(text.indexOf("Welcome")).toBeLessThan(text.indexOf("Hello"));
    expect(text.indexOf("Hello")).toBeLessThan(text.indexOf("Hi there"));
  });

  it("renders currentStreaming after completed messages", () => {
    const streaming = makeAssistantMessage({
      id: "s1", segments: [{ type: "text", chunks: ["Working on it..."] }], isStreaming: true,
    });
    const text = renderText(React.createElement(MessageList, {
      messages: [makeUserMessage({ text: "Do something" })],
      currentStreaming: streaming, toolDetailExpanded: false, thinkingExpanded: false,
    }));
    expect(text.indexOf("Do something")).toBeLessThan(text.indexOf("Working on it"));
  });
});

// ============================================================
// InputBox
// ============================================================

describe("InputBox", () => {
  it("renders cursor with chalk.inverse", () => {
    const raw = renderRaw(React.createElement(InputBox, { phase: "ready", onSubmit: () => {}, disabled: false }));
    expect(raw).toMatch(/\x1b\[7m/);
  });

  it("shows disabled state with '...' when disabled or streaming", () => {
    expect(renderText(React.createElement(InputBox, { phase: "ready", onSubmit: () => {}, disabled: true }))).toContain("...");
    expect(renderText(React.createElement(InputBox, { phase: "streaming", onSubmit: () => {}, disabled: false }))).toContain("...");
  });

  it("accepts typed characters", async () => {
    const inst = render(React.createElement(InputBox, { phase: "ready", onSubmit: () => {}, disabled: false }));
    inst.stdin.write("hello");
    await new Promise((r) => setTimeout(r, 50));
    expect(stripAnsi(inst.lastFrame() ?? "")).toContain("hello");
    inst.unmount();
  });

  it("handles backspace", async () => {
    const inst = render(React.createElement(InputBox, { phase: "ready", onSubmit: () => {}, disabled: false }));
    inst.stdin.write("abc");
    await new Promise((r) => setTimeout(r, 30));
    inst.stdin.write("\x7f");
    await new Promise((r) => setTimeout(r, 30));
    const text = stripAnsi(inst.lastFrame() ?? "");
    expect(text).toContain("ab");
    expect(text).not.toMatch(/abc/);
    inst.unmount();
  });

  it("submits on Enter and clears buffer", async () => {
    const submitted: string[] = [];
    const inst = render(React.createElement(InputBox, {
      phase: "ready", onSubmit: (t: string) => submitted.push(t), disabled: false,
    }));
    inst.stdin.write("hello world");
    await new Promise((r) => setTimeout(r, 30));
    inst.stdin.write("\r");
    await new Promise((r) => setTimeout(r, 30));
    expect(submitted).toContain("hello world");
    inst.unmount();
  });

  it("tab completion shows matches for /m", async () => {
    const inst = render(React.createElement(InputBox, { phase: "ready", onSubmit: () => {}, disabled: false }));
    inst.stdin.write("/m");
    await new Promise((r) => setTimeout(r, 30));
    inst.stdin.write("\t");
    await new Promise((r) => setTimeout(r, 50));
    const text = stripAnsi(inst.lastFrame() ?? "");
    expect(text).toContain("/model");
    expect(text).toContain("/mcp");
    inst.unmount();
  });
});

// ============================================================
// StatusBar
// ============================================================

describe("StatusBar", () => {
  it("shows MCP dot indicator", () => {
    const state = makeDefaultTUIState({ phase: "ready" });
    const text = renderText(React.createElement(StatusBar, { state }));
    expect(text).toMatch(/[●○•◉⬤]/);
    expect(text.toLowerCase()).toContain("ready");
  });

  it("shows plan badge when inPlanMode", () => {
    const state = makeDefaultTUIState({ phase: "ready", inPlanMode: true });
    expect(renderText(React.createElement(StatusBar, { state })).toUpperCase()).toContain("PLAN");
  });

  it("hides plan badge when not in plan mode", () => {
    const state = makeDefaultTUIState({ phase: "ready", inPlanMode: false, planMode: false });
    expect(renderText(React.createElement(StatusBar, { state })).toUpperCase()).not.toMatch(/\bPLAN\b/);
  });

  it("shows context usage with color coding", () => {
    // Green at 12%
    const low = makeDefaultTUIState({ contextUsage: { tokens: 25000, contextWindow: 200000, percent: 12.5 } });
    const lowRaw = renderRaw(React.createElement(StatusBar, { state: low }));
    expect(stripAnsi(lowRaw)).toMatch(/12/);
    expect(lowRaw).toMatch(/\x1b\[32m|\x1b\[3[2-9]m/);

    // Yellow at 75%
    const mid = makeDefaultTUIState({ contextUsage: { tokens: 150000, contextWindow: 200000, percent: 75 } });
    const midRaw = renderRaw(React.createElement(StatusBar, { state: mid }));
    expect(midRaw).toMatch(/\x1b\[33m|\x1b\[9[0-7]m/);

    // Red at 90%
    const high = makeDefaultTUIState({ contextUsage: { tokens: 180000, contextWindow: 200000, percent: 90 } });
    const highRaw = renderRaw(React.createElement(StatusBar, { state: high }));
    expect(highRaw).toMatch(/\x1b\[31m|\x1b\[9[0-7]m/);
  });

  it("shows compaction spinner when isCompacting", () => {
    const state = makeDefaultTUIState({ isCompacting: true });
    expect(renderText(React.createElement(StatusBar, { state })).toLowerCase()).toMatch(/compact|⟳|↻/);
  });
});

// ============================================================
// BackgroundBar
// ============================================================

describe("BackgroundBar", () => {
  it("renders nothing when no tasks", () => {
    expect(renderText(React.createElement(BackgroundBar, { tasks: [], expanded: false })).trim()).toBe("");
  });

  it("shows collapsed summary with running count", () => {
    const tasks = [
      makeBgTask({ id: "1", name: "align", status: "running" }),
      makeBgTask({ id: "2", name: "save_layout", status: "completed" }),
    ];
    const text = renderText(React.createElement(BackgroundBar, { tasks, expanded: false }));
    expect(text).toMatch(/running|1.*running|1\/2/i);
  });

  it("shows expanded list with task names", () => {
    const tasks = [
      makeBgTask({ id: "1", name: "align", status: "running" }),
      makeBgTask({ id: "2", name: "save_layout", status: "completed", completedAt: Date.now() }),
      makeBgTask({ id: "3", name: "auto_route", status: "failed", error: "timeout" }),
    ];
    const text = renderText(React.createElement(BackgroundBar, { tasks, expanded: true }));
    expect(text).toContain("align");
    expect(text).toContain("save_layout");
    expect(text).toContain("auto_route");
  });

  it("expanded has more content than collapsed", () => {
    const tasks = [
      makeBgTask({ id: "1", status: "running" }),
      makeBgTask({ id: "2", status: "completed" }),
    ];
    const collapsed = renderText(React.createElement(BackgroundBar, { tasks, expanded: false }));
    const expanded = renderText(React.createElement(BackgroundBar, { tasks, expanded: true }));
    expect(expanded.length).toBeGreaterThan(collapsed.length);
  });
});

// ============================================================
// WorkspaceBar
// ============================================================

describe("WorkspaceBar", () => {
  let WorkspaceBar: any;

  beforeEach(async () => {
    try {
      const mod = await import("../src/tui/components/WorkspaceBar.js");
      WorkspaceBar = mod.WorkspaceBar;
    } catch { WorkspaceBar = undefined; }
  });

  it("exports WorkspaceBar component", () => {
    expect(WorkspaceBar).toBeDefined();
  });

  it("shows collapsed view with integrity dot", () => {
    const text = renderText(React.createElement(WorkspaceBar, {
      expanded: false,
      files: [{ name: "SOUL.md", path: "/ws/SOUL.md", description: "Agent soul" }],
      integrity: { ok: true, fileCount: 4, issues: [] },
    }));
    expect(text).toMatch(/[●○•◉⬤✓✔]/);
  });

  it("shows expanded file list", () => {
    const files = [
      { name: "SOUL.md", path: "/ws/SOUL.md", description: "Agent soul" },
      { name: "RULES.md", path: "/ws/RULES.md", description: "Design rules" },
    ];
    const text = renderText(React.createElement(WorkspaceBar, {
      expanded: true, files, integrity: { ok: true, fileCount: 2, issues: [] },
    }));
    expect(text).toContain("SOUL.md");
    expect(text).toContain("RULES.md");
  });
});
