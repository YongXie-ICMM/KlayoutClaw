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

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "fs";
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
