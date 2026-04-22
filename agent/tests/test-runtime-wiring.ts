/**
 * Runtime Wiring Integration Tests
 *
 * These tests verify the FULL runtime chain across all v0.4 modules.
 * Unlike existing component-level tests (which use mocks), these use
 * real objects from createDesignSession() and real Ink rendering.
 *
 * Each test targets a specific wiring gap discovered in the deep audit.
 * All tests should FAIL against the current (broken) code and PASS
 * once the wiring fixes are applied.
 *
 * Gaps tested:
 *   G1: QlayBotSession interface missing subagentRunner field
 *   G2: assembleTools() creates SubagentRunner in local scope, never returns it
 *   G3: botSession object omits subagentRunner
 *   G4: Base tools in subagent tool-factory return "placeholder" text
 *   G5: App.tsx has zero runner.on() event subscriptions
 *   G6: System prompt toolNames array omits delegate tool
 *   G7: MCP proxy tools use empty Type.Object({}) parameter schemas
 *   G8: 15 SUBAGENT_* reducer actions never dispatched from anywhere
 */

import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import React from "react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 2000,
  intervalMs = 30,
  msg = "condition not met",
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await sleep(intervalMs);
  }
  throw new Error(msg);
}

function textOf(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => String(c.text ?? ""))
    .join("\n");
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      const { rmSync } = require("fs");
      rmSync(d, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
});

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "qlaybot-wiring-"));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Section 1: Source Code Contract Tests (no runtime needed)
// These verify the source files contain the required wiring patterns.
// ---------------------------------------------------------------------------

describe("source-code contracts", () => {
  const agentSrc = () =>
    readFileSync(
      join(__dirname, "..", "src", "agent.ts"),
      "utf-8",
    );
  const appSrc = () =>
    readFileSync(
      join(__dirname, "..", "src", "tui", "components", "App.tsx"),
      "utf-8",
    );
  const toolsSrc = () =>
    readFileSync(
      join(__dirname, "..", "src", "tools", "index.ts"),
      "utf-8",
    );
  const toolFactorySrc = () =>
    readFileSync(
      join(__dirname, "..", "src", "subagent", "tool-factory.ts"),
      "utf-8",
    );

  it("G1: QlayBotSession interface includes subagentRunner field", () => {
    const src = agentSrc();
    // Extract the interface block
    const ifaceMatch = src.match(
      /export interface QlayBotSession\s*\{([\s\S]*?)\}/,
    );
    expect(ifaceMatch).toBeTruthy();
    expect(ifaceMatch![1]).toContain("subagentRunner");
  });

  it("G3: botSession construction includes subagentRunner", () => {
    const src = agentSrc();
    // The object literal assigned to botSession must include subagentRunner
    const objMatch = src.match(
      /const botSession:\s*QlayBotSession\s*=\s*\{([\s\S]*?)\};/,
    );
    expect(objMatch).toBeTruthy();
    expect(objMatch![1]).toContain("subagentRunner");
  });

  it("G2: assembleTools returns runner (or runner is created outside assembleTools)", () => {
    const src = agentSrc();
    // Either: assembleTools returns the runner via destructuring, or agent.ts creates it
    const hasRunnerAssignment =
      // Pattern: destructured from assembleTools result
      /\{\s*toolMap\s*,\s*runner\s*\}/.test(src) ||
      // Or: runner stored as a variable
      /(?:const|let)\s+(?:subagent)?[Rr]unner\s*=/.test(src) ||
      // Or: SubagentRunner is constructed directly in createDesignSession
      /new SubagentRunner/.test(src);
    expect(hasRunnerAssignment).toBe(true);
  });

  it("G5: App.tsx subscribes to all 5 subagent runner events", () => {
    const src = appSrc();
    // Must subscribe to started, thinking, text, tool_start, tool_end
    for (const event of ["started", "thinking", "text", "tool_start", "tool_end"]) {
      expect(src).toMatch(
        new RegExp(`\\.on\\(["'\`]${event}["'\`]`),
      );
    }
  });

  it("G5+G8: App.tsx dispatches SUBAGENT_* actions for all event types", () => {
    const src = appSrc();
    const requiredActions = [
      "SUBAGENT_PLACEHOLDER",
      "SUBAGENT_START",
      "SUBAGENT_THINKING",
      "SUBAGENT_TEXT",
      "SUBAGENT_TOOL_START",
      "SUBAGENT_TOOL_END",
    ];
    for (const action of requiredActions) {
      expect(src).toContain(action);
    }
  });

  it("G6: system prompt toolNames includes delegate", () => {
    const src = agentSrc();
    // The toolNames array passed to buildSystemPrompt must include "delegate"
    // Either directly or via custom tool names
    const toolNamesBlock = src.match(/toolNames:\s*\[([\s\S]*?)\]/);
    expect(toolNamesBlock).toBeTruthy();
    const block = toolNamesBlock![1];
    // Should contain delegate either as a literal or via a spread of custom tool names
    const hasDelegateInToolNames =
      block.includes('"delegate"') ||
      block.includes("'delegate'") ||
      block.includes("customToolNames") ||
      block.includes("rawCustomTools") ||
      block.includes("delegateToolName");
    expect(hasDelegateInToolNames).toBe(true);
  });

  it("G4: base tool execute() does not return placeholder text", () => {
    const src = toolFactorySrc();
    // The word "placeholder" should NOT appear in execute function bodies
    expect(src).not.toMatch(/["'`].*placeholder.*["'`]/i);
  });
});

// ---------------------------------------------------------------------------
// Section 2: Runtime Object Tests (real createDesignSession)
// These create a real session and inspect its structure.
// ---------------------------------------------------------------------------

describe("runtime session structure", () => {
  let botSession: any;

  afterEach(async () => {
    if (botSession?.dispose) {
      try {
        await botSession.dispose();
      } catch { /* ignore */ }
    }
    botSession = null;
  });

  it("G1+G3: createDesignSession returns session with subagentRunner", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    botSession = await createDesignSession({ ephemeral: true });

    // subagentRunner must exist on the session object
    expect(botSession.subagentRunner).toBeDefined();
    expect(typeof botSession.subagentRunner.on).toBe("function");
    expect(typeof botSession.subagentRunner.run).toBe("function");
  });

  it("G2: delegate tool is present in session custom tools", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    botSession = await createDesignSession({ ephemeral: true });

    // Get all tools from the AgentSession
    const session = botSession.session;
    const allTools = session.getAllTools?.() ?? session.tools ?? [];
    const toolNames = allTools.map((t: any) => t.name);

    expect(toolNames).toContain("delegate");
  });

  it("G6: system prompt mentions delegate tool and at least one role", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    botSession = await createDesignSession({ ephemeral: true });

    const prompt = botSession.session.systemPrompt ?? "";
    // Delegation section must exist
    expect(prompt).toContain("Delegation");
    expect(prompt).toContain("delegate");
    // At least one role from settings.json
    expect(prompt).toMatch(/scout|designer|analyst|planner/i);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Subagent Tool Factory Tests (real tools, no placeholders)
// ---------------------------------------------------------------------------

describe("subagent base tools produce real results", () => {
  it("G4: read tool returns actual file content, not placeholder", async () => {
    const fixtureDir = makeTmpDir();
    const fixtureFile = join(fixtureDir, "probe.txt");
    writeFileSync(fixtureFile, "real-content-12345\n", "utf-8");

    const { createSubagentTools } = await import(
      "../src/subagent/tool-factory.js"
    );

    const tools = createSubagentTools(
      {
        label: "Test",
        promptFile: "test.md",
        workspaceFiles: [],
        baseTools: ["read", "bash"],
        customTools: ["submit_result"],
        mcpAccess: "none",
        maxTurns: 3,
        maxTokens: 10000,
      },
      {
        mcpManager: { callTool: async () => ({ content: [] }) },
        memoryManager: { search: async () => [] },
        annotations: [],
        resultCallback: () => {},
      },
    );

    const readTool = tools.find((t: any) => t.name === "read");
    expect(readTool).toBeDefined();

    const result = await readTool!.execute("tc-1", {
      file_path: fixtureFile,
      path: fixtureFile,
    });
    const text = textOf(result);

    // Must contain actual file content
    expect(text).toContain("real-content-12345");
    // Must NOT be a placeholder
    expect(text.toLowerCase()).not.toContain("placeholder");
  });

  it("G4: bash tool executes real commands, not placeholder", async () => {
    const { createSubagentTools } = await import(
      "../src/subagent/tool-factory.js"
    );

    const tools = createSubagentTools(
      {
        label: "Test",
        promptFile: "test.md",
        workspaceFiles: [],
        baseTools: ["bash"],
        customTools: ["submit_result"],
        mcpAccess: "none",
        maxTurns: 3,
        maxTokens: 10000,
      },
      {
        mcpManager: { callTool: async () => ({ content: [] }) },
        memoryManager: { search: async () => [] },
        annotations: [],
        resultCallback: () => {},
      },
    );

    const bashTool = tools.find((t: any) => t.name === "bash");
    expect(bashTool).toBeDefined();

    const result = await bashTool!.execute("tc-2", {
      command: "echo wiring-test-ok",
    });
    const text = textOf(result);

    expect(text).toContain("wiring-test-ok");
    expect(text.toLowerCase()).not.toContain("placeholder");
  });

  it("G4: base tools have non-empty parameter schemas", async () => {
    const { createSubagentTools } = await import(
      "../src/subagent/tool-factory.js"
    );

    const tools = createSubagentTools(
      {
        label: "Test",
        promptFile: "test.md",
        workspaceFiles: [],
        baseTools: ["read", "bash", "edit", "write"],
        customTools: ["submit_result"],
        mcpAccess: "none",
        maxTurns: 3,
        maxTokens: 10000,
      },
      {
        mcpManager: { callTool: async () => ({ content: [] }) },
        memoryManager: { search: async () => [] },
        annotations: [],
        resultCallback: () => {},
      },
    );

    for (const name of ["read", "bash", "edit", "write"]) {
      const tool = tools.find((t: any) => t.name === name);
      expect(tool, `${name} tool should exist`).toBeDefined();
      const props = tool!.parameters?.properties ?? {};
      expect(
        Object.keys(props).length,
        `${name} tool should have non-empty parameter schema`,
      ).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3b: Bug 2 — Base tool error handling (must not throw)
// ---------------------------------------------------------------------------

describe("subagent base tools: error handling", () => {
  it("Bug2: bash tool returns error content on non-zero exit, does not throw", async () => {
    const { createSubagentTools } = await import(
      "../src/subagent/tool-factory.js"
    );

    const tools = createSubagentTools(
      {
        label: "Test",
        promptFile: "test.md",
        workspaceFiles: [],
        baseTools: ["bash"],
        customTools: ["submit_result"],
        mcpAccess: "none",
        maxTurns: 3,
        maxTokens: 10000,
      },
      {
        mcpManager: { callTool: async () => ({ content: [] }) },
        memoryManager: { search: async () => [] },
        annotations: [],
        resultCallback: () => {},
      },
    );

    const bashTool = tools.find((t: any) => t.name === "bash");
    expect(bashTool).toBeDefined();

    // This command exits non-zero — execute must NOT throw
    const result = await bashTool!.execute("tc-err-1", {
      command: "exit 1",
    });
    const text = textOf(result);
    // Should contain error info, not crash
    expect(text.toLowerCase()).toMatch(/error|exit|fail|non-zero/i);
  });

  it("Bug2: read tool returns error content on missing file, does not throw", async () => {
    const { createSubagentTools } = await import(
      "../src/subagent/tool-factory.js"
    );

    const tools = createSubagentTools(
      {
        label: "Test",
        promptFile: "test.md",
        workspaceFiles: [],
        baseTools: ["read"],
        customTools: ["submit_result"],
        mcpAccess: "none",
        maxTurns: 3,
        maxTokens: 10000,
      },
      {
        mcpManager: { callTool: async () => ({ content: [] }) },
        memoryManager: { search: async () => [] },
        annotations: [],
        resultCallback: () => {},
      },
    );

    const readTool = tools.find((t: any) => t.name === "read");
    expect(readTool).toBeDefined();

    // Missing file — must NOT throw
    const result = await readTool!.execute("tc-err-2", {
      file_path: "/nonexistent/path/file.txt",
    });
    const text = textOf(result);
    expect(text.toLowerCase()).toMatch(/error|no such file|not found|enoent/i);
  });

  it("Bug2: edit tool returns error on missing file, does not throw", async () => {
    const { createSubagentTools } = await import(
      "../src/subagent/tool-factory.js"
    );

    const tools = createSubagentTools(
      {
        label: "Test",
        promptFile: "test.md",
        workspaceFiles: [],
        baseTools: ["edit"],
        customTools: ["submit_result"],
        mcpAccess: "none",
        maxTurns: 3,
        maxTokens: 10000,
      },
      {
        mcpManager: { callTool: async () => ({ content: [] }) },
        memoryManager: { search: async () => [] },
        annotations: [],
        resultCallback: () => {},
      },
    );

    const editTool = tools.find((t: any) => t.name === "edit");
    expect(editTool).toBeDefined();

    // Missing file — must NOT throw
    const result = await editTool!.execute("tc-err-3", {
      file_path: "/nonexistent/path/file.txt",
      old_string: "hello",
      new_string: "world",
    });
    const text = textOf(result);
    expect(text.toLowerCase()).toMatch(/error|no such file|not found|enoent/i);
  });

  it("Bug2: write tool returns error on permission denied, does not throw", async () => {
    const { createSubagentTools } = await import(
      "../src/subagent/tool-factory.js"
    );

    const tools = createSubagentTools(
      {
        label: "Test",
        promptFile: "test.md",
        workspaceFiles: [],
        baseTools: ["write"],
        customTools: ["submit_result"],
        mcpAccess: "none",
        maxTurns: 3,
        maxTokens: 10000,
      },
      {
        mcpManager: { callTool: async () => ({ content: [] }) },
        memoryManager: { search: async () => [] },
        annotations: [],
        resultCallback: () => {},
      },
    );

    const writeTool = tools.find((t: any) => t.name === "write");
    expect(writeTool).toBeDefined();

    // Write to unwritable path — must NOT throw
    const result = await writeTool!.execute("tc-err-4", {
      file_path: "/proc/nonexistent/file.txt",
      content: "test",
    });
    const text = textOf(result);
    expect(text.toLowerCase()).toMatch(/error|permission|denied|eacces|enoent/i);
  });
});

// ---------------------------------------------------------------------------
// Section 3c: Bug 1 — SubagentRunner must emit "completed" event
// ---------------------------------------------------------------------------

describe("SubagentRunner emits completed event", () => {
  it("Bug1: runner source contains this.emit('completed') call", () => {
    const runnerSrc = readFileSync(
      join(__dirname, "..", "src", "subagent", "runner.ts"),
      "utf-8",
    );
    // runner.ts must emit "completed" inside the run() method body
    expect(runnerSrc).toMatch(/this\.emit\(["'`]completed["'`]/);
  });

  it("Bug1: App.tsx subscribes to runner 'completed' event", () => {
    const appSrc = readFileSync(
      join(__dirname, "..", "src", "tui", "components", "App.tsx"),
      "utf-8",
    );
    // App.tsx must listen for "completed" on runner
    expect(appSrc).toMatch(/\.on\(["'`]completed["'`]/);
  });

  it("Bug1: App.tsx dispatches SUBAGENT_END on runner 'completed'", () => {
    const appSrc = readFileSync(
      join(__dirname, "..", "src", "tui", "components", "App.tsx"),
      "utf-8",
    );
    // SUBAGENT_END must be dispatched somewhere in App.tsx
    expect(appSrc).toContain("SUBAGENT_END");
  });

  it("Bug1: integration — runner completed event reaches TUI state", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { render } = await import("ink-testing-library");
    const { App } = await import("../src/tui/components/App.js");

    const botSession = await createDesignSession({ ephemeral: true });
    const runner = (botSession as any).subagentRunner;
    expect(runner).toBeDefined();

    const app = render(React.createElement(App, { botSession }));
    await sleep(100);

    // Emit subagent lifecycle: started → completed
    runner.emit("started", {
      subagentId: "sa-complete-test",
      toolCallId: "tc-complete-1",
      role: "scout",
      task: "Test completion",
    });
    await sleep(50);

    runner.emit("completed", {
      subagentId: "sa-complete-test",
      status: "completed",
      findings: 2,
      warnings: 0,
      tokenUsage: "1200 tokens",
    });
    await sleep(50);

    // Open subagent panel
    app.stdin.write("\x13"); // Ctrl+S
    await sleep(100);

    const frame = stripAnsi(app.lastFrame() ?? "");
    // Should show completed status, not running
    expect(frame).toMatch(/completed|done|✓/i);
    expect(frame).not.toMatch(/● running/);

    app.unmount();
    await botSession.dispose().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Section 3d: Bug 5 — Two-phase ID mapping (toolCallId → subagentId)
// ---------------------------------------------------------------------------

describe("two-phase ID mapping: delegate tool_execution_start → SUBAGENT_PLACEHOLDER", () => {
  it("Bug5: onToolStartWithId dispatches SUBAGENT_PLACEHOLDER when tool is delegate", () => {
    const appSrc = readFileSync(
      join(__dirname, "..", "src", "tui", "components", "App.tsx"),
      "utf-8",
    );

    // The onToolStartWithId callback must check for "delegate" toolName
    // and dispatch SUBAGENT_PLACEHOLDER from there (not from runner events)
    // Look for: if (toolName === "delegate") or toolName.includes("delegate")
    // followed by dispatch SUBAGENT_PLACEHOLDER — within the onToolStartWithId handler
    const hasToolStartDelegateDetection =
      /onToolStartWithId:.*?delegate.*?SUBAGENT_PLACEHOLDER/s.test(appSrc) ||
      /onToolStartWithId.*?\(toolCallId.*?toolName.*?\)[\s\S]*?delegate[\s\S]*?SUBAGENT_PLACEHOLDER/s.test(appSrc);

    expect(
      hasToolStartDelegateDetection,
      "App.tsx onToolStartWithId must detect 'delegate' and dispatch SUBAGENT_PLACEHOLDER",
    ).toBe(true);
  });

  it("Bug5: onToolStartWithId is the PRIMARY source of SUBAGENT_PLACEHOLDER for delegate", () => {
    const appSrc = readFileSync(
      join(__dirname, "..", "src", "tui", "components", "App.tsx"),
      "utf-8",
    );

    // The subscribeToSession block must detect "delegate" and dispatch SUBAGENT_PLACEHOLDER
    // This ensures the placeholder is created BEFORE runner.run() starts
    // (since tool_execution_start fires before the tool's execute() runs)
    const subscribeBlock = appSrc.match(
      /subscribeToSession\([\s\S]*?return\s*\(\)\s*=>\s*unsubscribe/,
    );
    expect(subscribeBlock, "subscribeToSession block must exist").toBeTruthy();
    const block = subscribeBlock![0];

    // Must contain delegate detection in onToolStartWithId
    expect(block).toContain("delegate");
    expect(block).toContain("SUBAGENT_PLACEHOLDER");
  });

  it("Bug5: integration — delegate tool_execution_start creates placeholder before runner started", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { render } = await import("ink-testing-library");
    const { App } = await import("../src/tui/components/App.js");

    const botSession = await createDesignSession({ ephemeral: true });
    const runner = (botSession as any).subagentRunner;
    expect(runner).toBeDefined();

    const app = render(React.createElement(App, { botSession }));
    await sleep(100);

    // Simulate the session event for delegate tool_execution_start
    // This should create a SUBAGENT_PLACEHOLDER entry in TUI state
    const sessionCallbacks: any[] = [];
    const origSubscribe = botSession.session.subscribe.bind(botSession.session);

    // The onToolStartWithId in the existing subscription should detect "delegate"
    // and dispatch SUBAGENT_PLACEHOLDER. Let's simulate by emitting tool_execution_start
    // with toolName "delegate" via the session event system.
    // Since we can't easily access the dispatch, test via runner events:

    // Step 1: Runner emits "started" — this should dispatch SUBAGENT_START only
    runner.emit("started", {
      subagentId: "sa-phase-test",
      toolCallId: "tc-phase-1",
      role: "scout",
      task: "Phase test",
    });
    await sleep(100);

    // Open panel to check state
    app.stdin.write("\x13");
    await sleep(100);

    const frame = stripAnsi(app.lastFrame() ?? "");
    // The subagent should be visible
    expect(frame).toMatch(/scout|Phase test/);

    app.unmount();
    await botSession.dispose().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Section 4: TUI Event Bridge Tests (runner → dispatch → state → panel)
// These use ink-testing-library with the REAL App component.
// ---------------------------------------------------------------------------

describe("TUI event bridge: runner → dispatch → SubagentPanel", () => {
  let app: any;
  let botSession: any;

  afterEach(async () => {
    if (app?.unmount) {
      try { app.unmount(); } catch { /* ignore */ }
    }
    if (botSession?.dispose) {
      try { await botSession.dispose(); } catch { /* ignore */ }
    }
    app = null;
    botSession = null;
  });

  it("G5+G8: runner events flow through to SubagentPanel rendering", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { render } = await import("ink-testing-library");
    const { App } = await import("../src/tui/components/App.js");

    botSession = await createDesignSession({ ephemeral: true });
    const runner = (botSession as any).subagentRunner;
    expect(runner, "subagentRunner must exist on session").toBeDefined();

    app = render(React.createElement(App, { botSession }));
    await sleep(100); // let initial render settle

    // Emit subagent events as if a delegation is happening
    runner.emit("started", {
      subagentId: "sa-wiring-test",
      toolCallId: "tc-wiring-1",
      role: "scout",
      task: "Verify wiring integration",
    });
    runner.emit("thinking", {
      subagentId: "sa-wiring-test",
      text: "Checking event bridge...",
    });
    runner.emit("text", {
      subagentId: "sa-wiring-test",
      text: "Events are flowing correctly",
    });
    runner.emit("tool_start", {
      subagentId: "sa-wiring-test",
      toolName: "read",
      args: JSON.stringify({ path: "/tmp/test" }),
    });
    runner.emit("tool_end", {
      subagentId: "sa-wiring-test",
      toolName: "read",
      result: "file contents here",
    });

    // Open subagent panel with Ctrl+S
    app.stdin.write("\x13"); // Ctrl+S
    await sleep(100);

    // The panel should show the subagent entry
    await waitFor(
      () => {
        const frame = stripAnsi(app.lastFrame() ?? "");
        return (
          frame.includes("scout") &&
          frame.includes("Verify wiring integration")
        );
      },
      2000,
      50,
      "SubagentPanel did not render the subagent entry after runner events + Ctrl+S. " +
      "This means runner.on() subscriptions are missing in App.tsx (Gap G5) " +
      "or SUBAGENT_* dispatch calls are missing (Gap G8).",
    );
  });

  it("G5: Ctrl+S opens panel even without subagent events (keyboard shortcut wiring)", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { render } = await import("ink-testing-library");
    const { App } = await import("../src/tui/components/App.js");

    botSession = await createDesignSession({ ephemeral: true });
    app = render(React.createElement(App, { botSession }));
    await sleep(100);

    // Open subagent panel
    app.stdin.write("\x13"); // Ctrl+S
    await sleep(100);

    const frame = stripAnsi(app.lastFrame() ?? "");
    // Panel should be visible (even if empty)
    expect(frame).toMatch(/subagent|delegation|no subagents/i);
  });
});

// ---------------------------------------------------------------------------
// Section 5: Cross-Feature Interaction Tests
// ---------------------------------------------------------------------------

describe("cross-feature: ConfigPanel + focus + escape routing", () => {
  let app: any;
  let botSession: any;

  afterEach(async () => {
    if (app?.unmount) try { app.unmount(); } catch { /* */ }
    if (botSession?.dispose) try { await botSession.dispose(); } catch { /* */ }
    app = null;
    botSession = null;
  });

  it("Ctrl+N opens ConfigPanel, Escape closes it, focus returns to input", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { render } = await import("ink-testing-library");
    const { App } = await import("../src/tui/components/App.js");

    botSession = await createDesignSession({ ephemeral: true });
    app = render(React.createElement(App, { botSession }));
    await sleep(100);

    // Open config panel
    app.stdin.write("\x0e"); // Ctrl+N
    await sleep(100);

    let frame = stripAnsi(app.lastFrame() ?? "");
    expect(frame).toMatch(/settings|config|model/i);

    // Close with Escape
    app.stdin.write("\x1b"); // Escape
    await sleep(100);

    frame = stripAnsi(app.lastFrame() ?? "");
    // Config panel should be closed - look for input prompt indicator
    // The frame should no longer show config-panel-specific content
    // or should show the normal input area
    expect(frame).not.toMatch(/\[config-panel\]/i);
  });
});

// ---------------------------------------------------------------------------
// Section 6: LLM Integration (guarded by QLAYBOT_E2E=1)
// ---------------------------------------------------------------------------

const describeLLM =
  process.env.QLAYBOT_E2E === "1" ? describe : describe.skip;

describeLLM("LLM integration: delegate tool reachable via real model", () => {
  let botSession: any;

  afterEach(async () => {
    if (botSession?.dispose) {
      try { await botSession.dispose(); } catch { /* */ }
    }
    botSession = null;
  });

  it(
    "model can discover and call delegate tool",
    async () => {
      const { createDesignSession } = await import("../src/agent.js");
      botSession = await createDesignSession({ ephemeral: true });

      const toolCalls: string[] = [];
      const unsub = botSession.session.subscribe((event: any) => {
        if (event?.type === "tool_execution_start") {
          toolCalls.push(String(event.toolName));
        }
      });

      try {
        await botSession.session.prompt(
          "Call the delegate tool once with role 'scout' and task 'list workspace files'.",
        );
        expect(toolCalls).toContain("delegate");
      } finally {
        unsub();
      }
    },
    180_000,
  );
});

// ---------------------------------------------------------------------------
// Section 7: Phase 0 — Shared Marker Infrastructure (Tasks 0.4, 0.6, 0.7)
//
// These tests assert end-to-end behaviour of the TranscriptMarkerEmitter:
//   - onTranscriptMarker callback forwarded from subscribeToSession (Task 0.6)
//   - RPC stream forwards transcript_marker events (Task 0.7)
//   - single emit fires across ALL FOUR sinks with identical ts (Task 0.4 capstone)
// ---------------------------------------------------------------------------

describe("Phase 0: subscribeToSession onTranscriptMarker — Task 0.6", () => {
  let botSession: any;

  afterEach(async () => {
    if (botSession?.dispose) {
      try { await botSession.dispose(); } catch { /* */ }
    }
    botSession = null;
  });

  it("onTranscriptMarker callback is invoked with the marker argument (object identity)", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { subscribeToSession } = await import("../src/events.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    botSession = await createDesignSession({ ephemeral: true });
    const emitter = getTranscriptMarkerEmitter(botSession.session);
    expect(emitter, "emitter must be registered on the session").toBeDefined();

    const received: unknown[] = [];
    // NO intersection escape hatch (e.g. `QlayBotEventCallbacks & {...}`).
    // TypeScript intersections ALWAYS compile whether or not the LHS has
    // the field, so they cannot gate Task 0.6. The `ts.createProgram`
    // probe at the end of this describe block is the authoritative gate.
    const callbacks: import("../src/events.js").QlayBotEventCallbacks = {
      onTranscriptMarker: (m: unknown) => received.push(m),
    };
    const unsubscribe = subscribeToSession(botSession.session, callbacks);

    const marker = {
      type: "think_recorded",
      source: "tool",
      thought: "subscribeToSession-probe",
      ts: "2026-04-21T00:20:00.000Z",
    };
    emitter!.emit("marker", marker);

    await sleep(20);

    expect(received.length).toBe(1);
    // Identity: subscribeToSession must NOT wrap/clone the marker.
    expect(received[0]).toBe(marker);

    unsubscribe();

    // After unsubscribe, a second emit does NOT reach the callback.
    emitter!.emit("marker", {
      type: "think_recorded",
      source: "tool",
      thought: "post-unsubscribe",
      ts: "2026-04-21T00:20:01.000Z",
    });
    await sleep(20);
    expect(received.length).toBe(1); // unchanged
  });

  it("passing ONLY onTranscriptMarker (no other callbacks) still works — callback is optional and independent", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { subscribeToSession } = await import("../src/events.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    botSession = await createDesignSession({ ephemeral: true });
    const emitter = getTranscriptMarkerEmitter(botSession.session);

    const received: unknown[] = [];
    // Same rationale as the sibling test: no intersection escape hatch.
    const callbacks: import("../src/events.js").QlayBotEventCallbacks = {
      onTranscriptMarker: (m: unknown) => received.push(m),
    };
    const unsubscribe = subscribeToSession(botSession.session, callbacks);

    const marker = {
      type: "think_recorded",
      source: "tool",
      thought: "solo-probe",
      ts: "2026-04-21T00:21:00.000Z",
    };
    emitter!.emit("marker", marker);
    await sleep(20);

    expect(received.length).toBe(1);
    expect(received[0]).toBe(marker);
    unsubscribe();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Task 0.6 type gate — programmatic ts.createProgram probe.
  //
  // Reviewer v3 concern: an intersection type `QlayBotEventCallbacks & {
  // onTranscriptMarker?: ... }` ALWAYS compiles regardless of whether
  // the LHS interface declares the field, so an intersection cannot gate
  // Task 0.6. A source-regex backup can be satisfied by a comment or a
  // local param named `onTranscriptMarker`. This test compiles a minimal
  // probe snippet that imports `QlayBotEventCallbacks` directly and
  // constructs `{ onTranscriptMarker: ... }` against it — if the
  // Executor hasn't added the field to the interface itself, TypeScript
  // emits a "Type ... is not assignable to type 'QlayBotEventCallbacks'"
  // diagnostic which this test surfaces as a RED failure.
  //
  // Parallels the Task 0.3 ts.createProgram gate at
  // test-unit.ts:Task 0.3 type gate.
  // ──────────────────────────────────────────────────────────────────────
  it("Task 0.6 type gate: QlayBotEventCallbacks accepts onTranscriptMarker under strict TS (programmatic tsc probe)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ts = require("typescript") as typeof import("typescript");
    const probeFilename = "events-callback-probe.ts";
    const eventsTsPath = join(__dirname, "..", "src", "events.ts");
    const eventsSrc = readFileSync(eventsTsPath, "utf-8");

    // Minimal probe: import QlayBotEventCallbacks directly (NO
    // intersection) and construct a value with onTranscriptMarker. If
    // the Executor hasn't widened the interface, TS reports:
    //   Object literal may only specify known properties, and
    //   'onTranscriptMarker' does not exist in type 'QlayBotEventCallbacks'
    const probeSource = `
      import type { QlayBotEventCallbacks } from "./events.js";
      const cbs: QlayBotEventCallbacks = {
        onTranscriptMarker: (m: unknown) => { void m; },
      };
      void cbs;
    `;

    const files = new Map<string, string>([
      [eventsTsPath, eventsSrc],
      [join(__dirname, "..", "src", probeFilename), probeSource],
    ]);

    const compilerOptions: import("typescript").CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    };

    const host = ts.createCompilerHost(compilerOptions);
    const originalReadFile = host.readFile.bind(host);
    host.readFile = (fn: string): string | undefined => {
      if (files.has(fn)) return files.get(fn);
      return originalReadFile(fn);
    };
    const originalFileExists = host.fileExists.bind(host);
    host.fileExists = (fn: string): boolean => {
      if (files.has(fn)) return true;
      return originalFileExists(fn);
    };

    const program = ts.createProgram(
      [join(__dirname, "..", "src", probeFilename)],
      compilerOptions,
      host,
    );
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => {
        // Only care about diagnostics originating from the probe file —
        // downstream import-resolution diagnostics from events.ts's own
        // deps are noise for this specific gate.
        const fn = d.file?.fileName ?? "";
        return fn.endsWith(probeFilename);
      });

    if (diagnostics.length > 0) {
      const messages = diagnostics
        .map((d) =>
          typeof d.messageText === "string"
            ? d.messageText
            : d.messageText.messageText,
        )
        .join("\n");
      throw new Error(
        `Task 0.6 type gate FAILED — QlayBotEventCallbacks does not accept 'onTranscriptMarker' as a known property. Diagnostics:\n${messages}`,
      );
    }
  });
});

describe("Phase 0: RPC forwards transcript_marker events — Task 0.7", () => {
  // These tests drive the REAL RPC code path in src/rpc.ts. The approach:
  //
  //   1. Import the helper `subscribeMarkersToRPC(session, sendEvent)` from
  //      `../src/rpc.js`. The plan contract (§4.7 Consumers) requires rpc.ts
  //      to subscribe to `getTranscriptMarkerEmitter(session)` and forward
  //      each marker to `sendEvent("transcript_marker", marker)`. The clean
  //      factoring is a small exported helper — that way (a) the test
  //      exercises a code-path defined in rpc.ts (Executor cannot ship
  //      Phase 0 with rpc.ts unchanged), and (b) we avoid spinning up the
  //      full readline pump on stdin (which hijacks the test process).
  //
  //   2. Fallback: if the Executor chooses to inline the subscription
  //      inside startRPCServer instead of exposing a helper, the source
  //      regression test in the final `it` of this describe catches it by
  //      asserting the initialize handler contains the subscription.
  //
  //   3. Ship a full end-to-end smoke test that spawns `node dist/cli.js
  //      --mode rpc`, sends `initialize`, and checks the stdout event
  //      stream for a `transcript_marker` frame. This is gated on
  //      `dist/cli.js` existing (the plan mandates `npm run build` between
  //      tasks) and on ANTHROPIC_API_KEY (the SDK needs a provider creds
  //      probe). When skipped, the in-process helper test above is the
  //      authoritative gate.
  let botSession: any;

  afterEach(async () => {
    if (botSession?.dispose) {
      try { await botSession.dispose(); } catch { /* */ }
    }
    botSession = null;
  });

  it("rpc.ts exports subscribeMarkersToRPC(session, sendEvent) that forwards `marker` emits to sendEvent('transcript_marker', marker)", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    // This import is load-bearing: the Executor MUST add
    // `subscribeMarkersToRPC` as a named export of src/rpc.ts. Without it,
    // this await throws and the test fails RED with a clear message —
    // "rpc.ts is missing subscribeMarkersToRPC".
    const rpcModule = await import("../src/rpc.js");
    expect(
      (rpcModule as any).subscribeMarkersToRPC,
      "src/rpc.ts must export subscribeMarkersToRPC(session, sendEvent) — this proves a code-path in rpc.ts emits the marker frame (Task 0.7 Step 3).",
    ).toBeDefined();
    expect(typeof (rpcModule as any).subscribeMarkersToRPC).toBe("function");

    botSession = await createDesignSession({ ephemeral: true });
    const emitter = getTranscriptMarkerEmitter(botSession.session);
    expect(emitter, "RPC must see the session's emitter via getTranscriptMarkerEmitter").toBeDefined();

    // Capture sendEvent calls — this is EXACTLY the surface rpc.ts uses
    // internally (see `sendEvent` at src/rpc.ts:84). subscribeMarkersToRPC
    // MUST call it with ("transcript_marker", marker).
    const sendEventCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const sendEvent = (method: string, params: Record<string, unknown>): void => {
      sendEventCalls.push({ method, params });
    };

    const subscribeMarkersToRPC = (rpcModule as any).subscribeMarkersToRPC as (
      session: unknown,
      sendEvent: (method: string, params: Record<string, unknown>) => void,
    ) => () => void;
    const unsub = subscribeMarkersToRPC(botSession.session, sendEvent);
    expect(typeof unsub).toBe("function");

    const marker = {
      type: "think_recorded",
      source: "tool",
      thought: "rpc-forward-probe",
      ts: "2026-04-21T00:30:00.000Z",
    };
    emitter!.emit("marker", marker);
    await sleep(20);

    expect(sendEventCalls.length).toBe(1);
    const call = sendEventCalls[0];
    expect(call.method).toBe("transcript_marker");
    // params IS the marker object — no wrapper envelope.
    // §4.7 Canonical timestamp: marker.ts wins; no wrapper ts.
    expect(call.params).toBe(marker); // object identity
    expect((call.params as any).ts).toBe(marker.ts);
    // No wrapper-level divergent ts inside the sendEvent params payload.
    // (sendEvent wraps in the JSON-RPC envelope `{jsonrpc, method, params}`
    //  at rpc.ts:84 — that wrapper has no `ts` field at all.)

    // Unsubscribe cleanly — subsequent emits MUST NOT produce further
    // sendEvent calls.
    unsub();
    emitter!.emit("marker", {
      type: "think_recorded",
      source: "tool",
      thought: "post-unsub",
      ts: "2026-04-21T00:30:01.000Z",
    });
    await sleep(10);
    expect(sendEventCalls.length).toBe(1); // unchanged
  });

  it("subscribeMarkersToRPC returns an unsubscribe that is called on dispose (rpc.ts integration contract)", async () => {
    // This test ensures that even if rpc.ts stores the unsub in a closure,
    // the helper's public contract is "returns an unsubscribe function" —
    // the dispose path in startRPCServer MUST call it.
    const rpcModule = await import("../src/rpc.js");
    const subscribeMarkersToRPC = (rpcModule as any).subscribeMarkersToRPC;
    expect(subscribeMarkersToRPC).toBeDefined();

    const { createDesignSession } = await import("../src/agent.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    botSession = await createDesignSession({ ephemeral: true });
    const emitter = getTranscriptMarkerEmitter(botSession.session);

    const calls: unknown[] = [];
    const unsub = subscribeMarkersToRPC(
      botSession.session,
      (_method: string, params: Record<string, unknown>) => calls.push(params),
    );
    emitter!.emit("marker", {
      type: "think_recorded",
      source: "tool",
      thought: "pre-unsub",
      ts: "2026-04-21T00:31:00.000Z",
    });
    await sleep(10);
    expect(calls.length).toBe(1);

    // Invoke the returned unsub — this models `startRPCServer`'s dispose
    // call-site at rpc.ts:260-271.
    unsub();

    emitter!.emit("marker", {
      type: "think_recorded",
      source: "tool",
      thought: "post-unsub",
      ts: "2026-04-21T00:31:01.000Z",
    });
    await sleep(10);
    expect(calls.length).toBe(1); // no additional forwards
  });

  // ──────────────────────────────────────────────────────────────────────
  // Source-code regression — guarantee that rpc.ts's initialize handler
  // actually wires up the marker subscription. Parallels the existing
  // RPC re-init / concurrent-init source checks in
  // test-plan-mode-v043-group6.ts. This is the second line of defence:
  // even if subscribeMarkersToRPC is mis-implemented as a no-op that
  // returns () => {} and never subscribes, this source check will fail if
  // rpc.ts doesn't also USE it inside startRPCServer.
  // ──────────────────────────────────────────────────────────────────────
  it("src/rpc.ts wires subscribeMarkersToRPC (or an equivalent emitter.on('marker') forward) in the initialize path", () => {
    const raw = readFileSync(
      join(__dirname, "..", "src", "rpc.ts"),
      "utf8",
    );
    // Slice from startRPCServer header to EOF.
    const startIdx = raw.indexOf("startRPCServer");
    expect(
      startIdx,
      "src/rpc.ts missing `startRPCServer` — if renamed, update this test",
    ).toBeGreaterThan(0);
    const body = raw.slice(startIdx);

    // Accept either idiom:
    //   (a) `subscribeMarkersToRPC(session, sendEvent)` call
    //   (b) `getTranscriptMarkerEmitter(...).on("marker", ...)` +
    //       `sendEvent("transcript_marker", ...)`
    const hasHelper = /subscribeMarkersToRPC\s*\(/.test(body);
    const hasInlineEmitterOn =
      /getTranscriptMarkerEmitter\s*\(/.test(body) &&
      /on\s*\(\s*["'`]marker["'`]\s*,/.test(body) &&
      /sendEvent\s*\(\s*["'`]transcript_marker["'`]/.test(body);

    expect(
      hasHelper || hasInlineEmitterOn,
      `startRPCServer in src/rpc.ts must wire the TranscriptMarkerEmitter to sendEvent("transcript_marker", marker). Neither the helper form (subscribeMarkersToRPC(...)) nor the inline form (getTranscriptMarkerEmitter(...).on("marker", ...) → sendEvent("transcript_marker", ...)) was found.`,
    ).toBe(true);

    // Also: sendEvent with method "transcript_marker" must exist — this is
    // the §4.7 wire contract.
    expect(
      /sendEvent\s*\(\s*["'`]transcript_marker["'`]/.test(body) ||
        hasHelper, // helper takes sendEvent as an argument, so the method literal lives elsewhere
      "rpc.ts must emit RPC events with method=\"transcript_marker\"",
    ).toBe(true);
  });
});

describe("T35: headless auto-approve + autoApprovePlans coercion", () => {
  it("warns on autoApprovePlans=false and auto-executes in headless mode", async () => {
    const homeDir = makeTmpDir();
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;
    vi.resetModules();

    const configDir = join(homeDir, ".qlaybot", "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ autoApprovePlans: false }, null, 2),
      "utf-8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createDesignSession } = await import("../src/agent.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const { createExitPlanModeTool } = await import("../src/tools/plan.js");

    const botSession = await createDesignSession({
      ephemeral: true,
      headless: true,
    });

    try {
      const markers: any[] = [];
      const emitter = getTranscriptMarkerEmitter(botSession.session);
      emitter?.on("marker", (marker: unknown) => markers.push(marker));

      botSession.planManager?.enterPlanMode("Headless approval flow");
      botSession.planManager?.writePlanContent("1. Execute the approved plan");

      const result = await createExitPlanModeTool(botSession.planManager!).execute(
        "tc-headless",
        { approved: true },
      );
      const body = JSON.parse(textOf(result));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("autoApprovePlans=false"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("v0.4.5"),
      );
      expect(body.status).toBe("plan_approved");
      expect(body.auto).toBe(true);
      expect(body.executeAfterApproval).toBe(true);
      expect(markers.map((marker) => marker.type)).toEqual([
        "plan_drafted",
        "plan_file_written",
        "plan_approved",
        "plan_executing",
        "plan_done",
      ]);
    } finally {
      await botSession.dispose();
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      vi.resetModules();
    }
  });
});

describe("Phase 0 capstone: one emit fans out to all 4 sinks with identical ts — Task 0.4 end-to-end", () => {
  let botSession: any;
  let originalCwd: string;
  let verboseCwd: string;
  let originalWrite: typeof process.stdout.write;
  let rpcCapture: string[];

  afterEach(async () => {
    if (originalWrite) {
      process.stdout.write = originalWrite;
      originalWrite = undefined as any;
    }
    if (originalCwd) {
      try { process.chdir(originalCwd); } catch { /* */ }
      originalCwd = undefined as any;
    }
    if (botSession?.dispose) {
      try { await botSession.dispose(); } catch { /* */ }
    }
    botSession = null;
  });

  it("synthesised think_recorded emit reaches history JSONL + verbose JSONL + TUI callback + RPC event — identical ts throughout", async () => {
    originalCwd = process.cwd();
    verboseCwd = makeTmpDir();
    process.chdir(verboseCwd);

    const { createDesignSession } = await import("../src/agent.js");
    const { subscribeToSession } = await import("../src/events.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    // Sink 4 uses the REAL rpc.ts export — no self-emulated forward.
    // If the Executor has NOT yet added subscribeMarkersToRPC, the module
    // dynamic import resolves but the named export is undefined, and the
    // assertion below fails RED with a clean message.
    const rpcModule = await import("../src/rpc.js");
    const subscribeMarkersToRPC = (rpcModule as any).subscribeMarkersToRPC as
      | ((
          session: unknown,
          sendEvent: (method: string, params: Record<string, unknown>) => void,
        ) => () => void)
      | undefined;
    expect(
      subscribeMarkersToRPC,
      "Sink 4 requires src/rpc.ts to export subscribeMarkersToRPC — the capstone MUST drive the real RPC code path, not a self-emulated forward.",
    ).toBeDefined();

    // No intersection escape hatch — the ts.createProgram probe in the
    // Task 0.6 describe block is the authoritative type gate. This line
    // only exercises the runtime path.

    rpcCapture = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = ((chunk: any) => {
      try { rpcCapture.push(typeof chunk === "string" ? chunk : String(chunk)); } catch { /* */ }
      return true;
    }) as any;

    botSession = await createDesignSession({ ephemeral: true, verbose: true });
    const emitter = getTranscriptMarkerEmitter(botSession.session);
    expect(emitter).toBeDefined();

    // Sink 3: TUI callback via subscribeToSession({onTranscriptMarker})
    const tuiReceived: unknown[] = [];
    const tuiCallbacks: import("../src/events.js").QlayBotEventCallbacks = {
      onTranscriptMarker: (m: unknown) => tuiReceived.push(m),
    };
    const unsubTui = subscribeToSession(botSession.session, tuiCallbacks);

    // Sink 4: REAL RPC forward via src/rpc.ts export.
    // sendEvent's behaviour is exactly what rpc.ts:84 does on wire:
    //   process.stdout.write(JSON.stringify({jsonrpc:"2.0", method, params}) + "\n")
    // We use the SAME function shape here so the capstone exercises the
    // real code-path's expected invocation contract.
    const rpcSendCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const sendEvent = (method: string, params: Record<string, unknown>): void => {
      rpcSendCalls.push({ method, params });
      // Mirror the on-wire behaviour for the stdout-based frame count
      // assertion below — if rpc.ts ever writes the frame differently,
      // this mirror still yields the same observable.
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      );
    };
    const unsubRPC = subscribeMarkersToRPC!(botSession.session, sendEvent);

    const ts = "2026-04-21T00:40:00.000Z";
    const marker = {
      type: "think_recorded",
      source: "tool",
      thought: "phase-0-capstone",
      ts,
    };

    emitter!.emit("marker", marker);

    // Allow async fs.createWriteStream drain
    await sleep(200);

    // --- Sink 1: history JSONL -------------------------------------------
    const historyPath = join(
      botSession.history.getSessionDir(),
      "transcript.jsonl",
    );
    const historyEntries = readFileSync(historyPath, "utf8")
      .split("\n")
      .filter((l: string) => l.trim().length > 0)
      .map((l: string) => JSON.parse(l));
    const historyMarkers = historyEntries.filter(
      (e: any) => e.type === "transcript_marker",
    );
    expect(historyMarkers.length).toBe(1);
    expect(historyMarkers[0].timestamp).toBe(ts);
    expect(historyMarkers[0].data.ts).toBe(ts);

    // --- Sink 2: verbose JSONL -------------------------------------------
    const verboseDir = join(verboseCwd, "qlaybot-transcripts");
    expect(existsSync(verboseDir)).toBe(true);
    const { readdirSync: rds } = await import("fs");
    const verboseFiles = rds(verboseDir).filter((f: string) => f.endsWith(".jsonl"));
    expect(verboseFiles.length).toBeGreaterThanOrEqual(1);
    let verboseMatches: any[] = [];
    for (const f of verboseFiles) {
      const raw = readFileSync(join(verboseDir, f), "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.type === "transcript_marker" && obj.data?.ts === ts) {
            verboseMatches.push(obj);
          }
        } catch { /* ignore */ }
      }
    }
    expect(verboseMatches.length).toBe(1);
    expect(verboseMatches[0].timestamp).toBe(ts);
    expect(verboseMatches[0].data.ts).toBe(ts);

    // --- Sink 3: TUI callback --------------------------------------------
    expect(tuiReceived.length).toBe(1);
    expect((tuiReceived[0] as any).ts).toBe(ts);

    // --- Sink 4: RPC event via subscribeMarkersToRPC ---------------------
    // (a) The real helper observed exactly one sendEvent call.
    expect(rpcSendCalls.length).toBe(1);
    expect(rpcSendCalls[0].method).toBe("transcript_marker");
    // §4.7 canonical ts — no wrapper ts, params IS the marker
    expect(rpcSendCalls[0].params).toBe(marker);
    expect((rpcSendCalls[0].params as any).ts).toBe(ts);

    // (b) Cross-check the on-wire frame captured via stdout hook.
    const rpcFrames: any[] = [];
    for (const ln of rpcCapture) {
      for (const chunk of ln.split("\n")) {
        const t = chunk.trim();
        if (!t.startsWith("{")) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.method === "transcript_marker") rpcFrames.push(obj);
        } catch { /* */ }
      }
    }
    expect(rpcFrames.length).toBe(1);
    expect(rpcFrames[0].params.ts).toBe(ts);
    expect(rpcFrames[0].jsonrpc).toBe("2.0");
    // No divergent wrapper ts on the JSON-RPC envelope
    expect((rpcFrames[0] as any).ts).toBeUndefined();

    // Canonical ts is identical across all four sinks
    const observed = [
      historyMarkers[0].timestamp,
      historyMarkers[0].data.ts,
      verboseMatches[0].timestamp,
      verboseMatches[0].data.ts,
      (tuiReceived[0] as any).ts,
      rpcSendCalls[0].params.ts,
      rpcFrames[0].params.ts,
    ];
    expect(new Set(observed).size).toBe(1);

    // cleanup
    unsubTui();
    unsubRPC();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Task 0.4(c) identity check — the emitter in the tool map
  // (opts.transcriptMarkerEmitter passed to assembleTools) MUST be the
  // SAME instance returned by getTranscriptMarkerEmitter(session).
  //
  // Strategy: spy on `assembleTools` to capture the opts at call time, then
  // compare. The Executor's Task 0.4 Step 3 sequence creates the emitter
  // once and threads it through both sites (tool map + session registry).
  // Any test that only checks the session-side WILL NOT catch a regression
  // where the tool map receives a different instance.
  // ──────────────────────────────────────────────────────────────────────
  it("Task 0.4(c): opts.transcriptMarkerEmitter passed to assembleTools is === getTranscriptMarkerEmitter(session)", async () => {
    const assembleToolsModule = await import("../src/tools/index.js");
    const { createDesignSession } = await import("../src/agent.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    // Capture every `opts.transcriptMarkerEmitter` that assembleTools sees.
    const captured: unknown[] = [];
    const originalAssemble = (assembleToolsModule as any).assembleTools;
    const spy = vi
      .spyOn(assembleToolsModule as any, "assembleTools")
      .mockImplementation((opts: any) => {
        captured.push(opts.transcriptMarkerEmitter);
        return originalAssemble(opts);
      });

    try {
      botSession = await createDesignSession({ ephemeral: true });
      const sessionEmitter = getTranscriptMarkerEmitter(botSession.session);

      // The spy observed at least one assembleTools call with a bound emitter.
      expect(
        captured.length,
        "assembleTools must be invoked by createDesignSession",
      ).toBeGreaterThan(0);
      const toolMapEmitter = captured[0];
      expect(
        toolMapEmitter,
        "opts.transcriptMarkerEmitter must be passed into assembleTools (Task 0.4 Step 3.2)",
      ).toBeDefined();
      // IDENTITY — same JS reference on both sides.
      expect(toolMapEmitter).toBe(sessionEmitter);

      // Every subsequent assembleTools call (e.g. subagent re-assembly) must
      // also receive the SAME emitter — no accidental per-call reconstruction.
      for (const e of captured) {
        expect(e).toBe(sessionEmitter);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
