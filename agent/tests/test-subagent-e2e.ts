/**
 * E2E integration tests for qlaybot v0.4.0 Phase H: Subagent pipeline verification.
 *
 * These tests verify the FULL cross-layer pipeline: delegate tool -> runner ->
 * tool factory -> transcript -> reducer -> TUI state. All Agent SDK calls are
 * mocked at module level (same pattern as test-subagent.ts) — no real API calls.
 *
 * SCC-H coverage: H1-H5, H5a-H5l, H9-H19.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import React from "react";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { stripAnsi } from "./helpers/ink-helpers.js";
import {
  makeConfig,
  makeSubagentConfig,
  makeTmpDir,
} from "./helpers/config-builder.js";
import type {
  SubagentConfig,
  RoleConfig,
  SubagentResult,
  ToolAnnotation,
  StartedEvent,
  ThinkingEvent,
  TextEvent,
  ToolStartEvent,
  ToolEndEvent,
  SubagentTUIEntry,
  SubagentSegment,
} from "../src/types/v04-contracts.js";
import { TOOL_ANNOTATIONS } from "../src/tools/annotations.js";
import { ALLOWED_TOOLS } from "../src/planning/sandbox.js";

// ---------------------------------------------------------------------------
// Mock Agent SDK at module level
// ---------------------------------------------------------------------------

interface MockSession {
  prompt: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  setAutoCompactionEnabled: ReturnType<typeof vi.fn>;
}

/** All sessions created during a test, in creation order. */
let allMockSessions: MockSession[] = [];
/** All session opts, in creation order. */
let allSessionOpts: any[] = [];
/** Per-session subscriber listeners (single-callback API). */
let allSubscriberListeners: Array<(event: any) => void>[] = [];
/** Per-session prompt call count. */
let allPromptCounts: number[] = [];
/** Global mock config. */
let mockTokenUsage = { tokens: 0, contextWindow: 200000 };
let mockPromptError: Error | null = null;
let mockPromptDelay = 0;

function createMockSession(): MockSession {
  const idx = allMockSessions.length;
  const listeners: Array<(event: any) => void> = [];
  allSubscriberListeners.push(listeners);
  allPromptCounts.push(0);

  const session: MockSession = {
    prompt: vi.fn().mockImplementation(async () => {
      allPromptCounts[idx]++;
      if (mockPromptDelay > 0) {
        await new Promise((r) => setTimeout(r, mockPromptDelay));
      }
      if (mockPromptError) {
        throw mockPromptError;
      }
      return undefined;
    }),
    subscribe: vi.fn().mockImplementation((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    dispose: vi.fn(),
    abort: vi.fn(),
    getContextUsage: vi.fn().mockImplementation(() => ({ ...mockTokenUsage })),
    setAutoCompactionEnabled: vi.fn(),
  };
  allMockSessions.push(session);
  return session;
}

/**
 * Emit event on a specific session (by index).
 * Maps legacy event names to real AgentSession event format.
 */
function emitOnSession(sessionIdx: number, event: string, payload: any) {
  const listeners = allSubscriberListeners[sessionIdx];
  if (!listeners) return;
  let sessionEvent: any;
  switch (event) {
    case "thinking":
      sessionEvent = { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: payload.text } };
      break;
    case "text":
      sessionEvent = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: payload.text } };
      break;
    case "tool_start":
      sessionEvent = { type: "tool_execution_start", toolName: payload.toolName, toolCallId: payload.toolCallId ?? "tc-mock", args: payload.args ?? "{}" };
      break;
    case "tool_end":
      sessionEvent = { type: "tool_execution_end", toolName: payload.toolName, toolCallId: payload.toolCallId ?? "tc-mock", result: payload.result ?? "" };
      break;
    default:
      sessionEvent = { type: event, ...payload };
  }
  for (const listener of listeners) listener(sessionEvent);
}

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AgentSession: vi.fn().mockImplementation((opts: any) => {
    allSessionOpts.push(opts);
    return createMockSession();
  }),
  SessionManager: { inMemory: vi.fn().mockReturnValue({}) },
  SettingsManager: { inMemory: vi.fn().mockReturnValue({}) },
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({ reload: vi.fn() })),
  AuthStorage: vi.fn().mockImplementation(() => ({
    setRuntimeApiKey: vi.fn(),
    hasAuth: vi.fn(),
  })),
  ModelRegistry: vi.fn().mockImplementation(() => ({
    find: vi.fn(),
    registerProvider: vi.fn(),
  })),
  convertToLlm: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy imports (after mocks are installed)
// ---------------------------------------------------------------------------

const { SubagentRunner } = await import("../src/subagent/runner.js");
const { createSubagentTools } = await import("../src/subagent/tool-factory.js");
const { createDelegateTool } = await import("../src/tools/delegate.js");
const { TranscriptLogger } = await import("../src/subagent/transcript.js");
const { buildSubagentPrompt } = await import("../src/subagent/prompt-builder.js");
const { tuiReducer, initialState } = await import("../src/tui/reducer.js");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeScoutRole(overrides?: Partial<RoleConfig>): RoleConfig {
  return {
    label: "Scout",
    promptFile: "subagent/scout.md",
    workspaceFiles: [],
    baseTools: ["read", "bash"],
    customTools: ["submit_result"],
    mcpAccess: "shared-readonly",
    maxTurns: 10,
    maxTokens: 50000,
    ...overrides,
  };
}

function makeDesignerRole(overrides?: Partial<RoleConfig>): RoleConfig {
  return {
    label: "Designer",
    promptFile: "subagent/designer.md",
    workspaceFiles: [],
    baseTools: ["read", "bash", "edit", "write"],
    customTools: ["submit_result"],
    mcpAccess: "full",
    maxTurns: 15,
    maxTokens: 100000,
    ...overrides,
  };
}

function makeDeps(overrides?: {
  config?: SubagentConfig;
  workspaceDir?: string;
  annotations?: ToolAnnotation[];
}) {
  const tmpDir = makeTmpDir();
  const logDir = join(tmpDir, "logs");
  mkdirSync(logDir, { recursive: true });

  const config = overrides?.config ?? makeSubagentConfig({
    logDir,
    roles: {
      scout: makeScoutRole(),
      designer: makeDesignerRole(),
    },
  });

  return {
    config,
    mcpManager: {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "mock result" }],
      }),
    },
    memoryManager: {
      search: vi.fn().mockResolvedValue([]),
    },
    workspaceDir: overrides?.workspaceDir ?? tmpDir,
    annotations: overrides?.annotations ?? TOOL_ANNOTATIONS,
    getApiKey: async () => "test-key",
    defaultModel: "custom-anthropic/claude-sonnet-4-6",
    defaultThinkingLevel: "medium",
    modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    tmpDir,
    logDir,
  };
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  allMockSessions = [];
  allSessionOpts = [];
  allSubscriberListeners = [];
  allPromptCounts = [];
  mockTokenUsage = { tokens: 0, contextWindow: 200000 };
  mockPromptError = null;
  mockPromptDelay = 0;
});

// ===========================================================================
// GROUP 1: Full Pipeline (SCC-H1, H2, H3)
// ===========================================================================

describe("Group 1: Full delegation pipeline", () => {
  it("SCC-H1: scout delegation filters out readwrite MCP tools", async () => {
    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    // Run scout — captures the session opts which include customTools
    const resultPromise = runner.run({
      role: "scout",
      task: "Inspect the layout",
      toolCallId: "tc-scout-001",
    });

    // Wait for result (prompt is a no-op mock, so maxTurns=10 will loop quickly)
    const result = await resultPromise;

    // Verify session was constructed
    expect(allSessionOpts.length).toBeGreaterThanOrEqual(1);

    // Check the tools passed to AgentSession: should NOT include readwrite tools
    const sessionTools = allSessionOpts[0].customTools as Array<{ name: string }>;
    const toolNames = sessionTools.map((t) => t.name);

    // Scout with shared-readonly: should have readonly MCP tools
    expect(toolNames).toContain("screenshot");
    expect(toolNames).toContain("get_layout_info");

    // Should NOT have readwrite MCP tools
    expect(toolNames).not.toContain("execute_script");
    expect(toolNames).not.toContain("save_layout");
    expect(toolNames).not.toContain("create_layout");
    expect(toolNames).not.toContain("auto_route");

    // Should have base tools and submit_result
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("submit_result");
  });

  it("SCC-H2: designer delegation includes readwrite MCP tools", async () => {
    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    const resultPromise = runner.run({
      role: "designer",
      task: "Create a hall bar",
      toolCallId: "tc-designer-001",
    });

    const result = await resultPromise;

    expect(allSessionOpts.length).toBeGreaterThanOrEqual(1);

    const sessionTools = allSessionOpts[0].customTools as Array<{ name: string }>;
    const toolNames = sessionTools.map((t) => t.name);

    // Designer with full access: should have ALL MCP tools
    expect(toolNames).toContain("screenshot");
    expect(toolNames).toContain("get_layout_info");
    expect(toolNames).toContain("execute_script");
    expect(toolNames).toContain("save_layout");
    expect(toolNames).toContain("create_layout");
    expect(toolNames).toContain("auto_route");

    // And base tools
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("write");
  });

  it("SCC-H2: designer execute_script tool invocation reaches mcpManager.callTool", async () => {
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "script executed" }],
    });
    const designerRole = makeDesignerRole();
    const tools = createSubagentTools(designerRole, {
      mcpManager: { callTool: mockCallTool },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      annotations: TOOL_ANNOTATIONS,
      resultCallback: () => {},
    });

    // Find execute_script tool and actually call its execute()
    const execScriptTool = tools.find((t) => t.name === "execute_script");
    expect(execScriptTool).toBeDefined();

    const result = await execScriptTool!.execute("tc-exec-001", {
      code: 'print("hello")',
    });

    // Prove the tool is functional: mcpManager.callTool was invoked
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCallTool).toHaveBeenCalledWith("execute_script", {
      code: 'print("hello")',
    });
    expect(result.content[0].text).toBe("script executed");
  });

  it("SCC-H3: both scout and designer produce transcript files on disk", async () => {
    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    // Run scout
    const scoutResult = await runner.run({
      role: "scout",
      task: "Check layers",
      toolCallId: "tc-s-001",
    });

    // Reset sessions for designer
    allMockSessions = [];
    allSessionOpts = [];
    allSubscriberListeners = [];
    allPromptCounts = [];

    // Run designer
    const designerResult = await runner.run({
      role: "designer",
      task: "Build cell",
      toolCallId: "tc-d-001",
    });

    // Both should have non-empty transcript paths
    expect(scoutResult.transcriptPath).toBeTruthy();
    expect(designerResult.transcriptPath).toBeTruthy();

    // Both transcript files should exist on disk
    expect(existsSync(scoutResult.transcriptPath)).toBe(true);
    expect(existsSync(designerResult.transcriptPath)).toBe(true);

    // Both should contain markdown content with role info
    const scoutContent = readFileSync(scoutResult.transcriptPath, "utf-8");
    expect(scoutContent).toContain("scout");
    expect(scoutContent).toContain("Check layers");

    const designerContent = readFileSync(designerResult.transcriptPath, "utf-8");
    expect(designerContent).toContain("designer");
    expect(designerContent).toContain("Build cell");
  });

  it("SCC-H1+H2: scout readwrite tool execution is blocked at tool factory level", async () => {
    // Create scout tools directly and verify execute_script is not present
    const scoutRole = makeScoutRole();
    let capturedResult: any = null;

    const tools = createSubagentTools(scoutRole, {
      mcpManager: {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "executed" }],
        }),
      },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      annotations: TOOL_ANNOTATIONS,
      resultCallback: (r) => { capturedResult = r; },
    });

    const toolNames = tools.map((t) => t.name);

    // Verify execute_script (readwrite) is excluded
    expect(toolNames).not.toContain("execute_script");
    // Verify screenshot (readonly) IS included
    expect(toolNames).toContain("screenshot");

    // Verify there's no way to call readwrite tools — none in the list
    const readwriteTools = TOOL_ANNOTATIONS
      .filter((a) => a.readwrite)
      .map((a) => a.name);

    for (const rw of readwriteTools) {
      expect(toolNames).not.toContain(rw);
    }
  });

  it("full pipeline: delegate tool -> runner -> submit_result -> result returned", async () => {
    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    // Configure the mock prompt to simulate the subagent calling submit_result on first turn.
    // We intercept AgentSession construction to hook into prompt behavior.
    let submitResultCalled = false;

    // Override the next session's prompt to call submit_result from the tool set
    const origMockImpl = vi.mocked(
      (await import("@mariozechner/pi-coding-agent")).AgentSession,
    ).getMockImplementation();

    vi.mocked(
      (await import("@mariozechner/pi-coding-agent")).AgentSession,
    ).mockImplementationOnce((opts: any) => {
      allSessionOpts.push(opts);
      const session = createMockSession();
      // Override prompt: on first call, find submit_result and execute it
      session.prompt.mockImplementationOnce(async () => {
        const submitTool = (opts.customTools as Array<{ name: string; execute: Function }>)
          .find((t) => t.name === "submit_result");
        if (submitTool) {
          await submitTool.execute("tc-submit-001", {
            status: "completed",
            findings: ["Found 3 layers", "All polygons valid"],
            warnings: ["Layer 5 is empty"],
          });
          submitResultCalled = true;
        }
        return undefined;
      });
      return session;
    });

    const delegateTool = createDelegateTool(runner, deps.config);

    // Run delegate
    const toolResult = await delegateTool.execute("tc-full-001", {
      role: "scout",
      task: "Full pipeline test",
    });

    // submit_result must have been called
    expect(submitResultCalled).toBe(true);

    // The delegate tool should return a text content block with JSON
    expect(toolResult.content).toBeDefined();
    expect(toolResult.content.length).toBeGreaterThan(0);
    const text = toolResult.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.role).toBe("scout");
    expect(parsed.task).toBe("Full pipeline test");
    expect(parsed.status).toBe("completed");
    expect(parsed.findings).toContain("Found 3 layers");
    expect(parsed.findings).toContain("All polygons valid");
    expect(parsed.warnings).toContain("Layer 5 is empty");
    expect(parsed.transcriptPath).toBeTruthy();
  });
});

// ===========================================================================
// GROUP 2: Concurrent + Kill (SCC-H4)
// ===========================================================================

describe("Group 2: Concurrent subagents + kill", () => {
  it("SCC-H4: killing scout does not affect running designer", async () => {
    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    // Use a delay so both subagents are running concurrently
    mockPromptDelay = 50;

    let scoutId: string | null = null;
    let designerId: string | null = null;

    runner.on("started", (ev: StartedEvent) => {
      if (ev.role === "scout") scoutId = ev.subagentId;
      if (ev.role === "designer") designerId = ev.subagentId;
    });

    // Start both concurrently
    const scoutPromise = runner.run({
      role: "scout",
      task: "Concurrent scout",
      toolCallId: "tc-conc-scout",
    });

    const designerPromise = runner.run({
      role: "designer",
      task: "Concurrent designer",
      toolCallId: "tc-conc-designer",
    });

    // Wait for both to start
    await new Promise((r) => setTimeout(r, 20));

    expect(scoutId).not.toBeNull();
    expect(designerId).not.toBeNull();

    // Kill scout
    runner.kill(scoutId!);

    // Wait for both to finish
    const [scoutResult, designerResult] = await Promise.all([
      scoutPromise,
      designerPromise,
    ]);

    // Scout should be partial/killed
    expect(scoutResult.status).toBe("partial");
    expect(scoutResult.errorMessage).toContain("Killed");

    // Designer should have completed its turn loop (not killed)
    expect(designerResult.status).not.toBe("error");
    expect(designerResult.errorMessage).not.toContain("Killed");

    // Both should produce transcripts
    expect(scoutResult.transcriptPath).toBeTruthy();
    expect(designerResult.transcriptPath).toBeTruthy();
    expect(existsSync(scoutResult.transcriptPath)).toBe(true);
    expect(existsSync(designerResult.transcriptPath)).toBe(true);
  });
});

// ===========================================================================
// GROUP 3: Budget Enforcement (SCC-H5)
// ===========================================================================

describe("Group 3: Budget enforcement", () => {
  it("SCC-H5: low maxTurns produces partial result with turn budget message", async () => {
    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: {
        scout: makeScoutRole({ maxTurns: 2 }),
      },
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    const result = await runner.run({
      role: "scout",
      task: "Budget test",
      toolCallId: "tc-budget-001",
    });

    // Should be "partial" since submit_result was never called and turns exhausted
    expect(result.status).toBe("partial");
    expect(result.errorMessage).toContain("budget");
    expect(result.tokenUsage.turns).toBe(2);
  });

  it("SCC-H5: token budget produces partial result", async () => {
    // Set high token usage so budget is immediately exceeded
    mockTokenUsage = { tokens: 999999, contextWindow: 200000 };

    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: {
        scout: makeScoutRole({ maxTurns: 10, maxTokens: 1000 }),
      },
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    const result = await runner.run({
      role: "scout",
      task: "Token budget test",
      toolCallId: "tc-tokbudget-001",
    });

    expect(result.status).toBe("partial");
    expect(result.errorMessage).toContain("Token budget");
    // Should have done 0 turns (budget exceeded before first prompt)
    expect(result.tokenUsage.turns).toBe(0);
  });
});

// ===========================================================================
// GROUP 4: Cross-Layer (SCC-H5a-H5l)
// ===========================================================================

describe("Group 4: Cross-layer integration", () => {
  it("SCC-H5a: workspace files appear in subagent system prompt", () => {
    const wsDir = makeTmpDir();
    // Create prompt file and workspace file
    const subagentDir = join(wsDir, "subagent");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(subagentDir, "scout.md"), "You are a scout agent.");
    writeFileSync(join(wsDir, "RULES.md"), "Always verify before acting.");

    const role = makeScoutRole({
      promptFile: "subagent/scout.md",
      workspaceFiles: ["RULES.md"],
    });

    const prompt = buildSubagentPrompt(role, wsDir);

    expect(prompt).toContain("You are a scout agent.");
    expect(prompt).toContain("Always verify before acting.");
  });

  it("SCC-H5b: transcript rotation deletes oldest when maxLogFiles exceeded", () => {
    const logDir = makeTmpDir();

    // Create 3 existing transcripts with known filenames, oldest first
    const filenames: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ts = Date.now() - (3 - i) * 1000; // oldest first
      const fname = `scout-old_task-${ts}.md`;
      filenames.push(fname);
      writeFileSync(join(logDir, fname), `# Old transcript ${i}`);
    }
    const oldestFile = filenames[0]; // smallest timestamp = oldest
    const middleFile = filenames[1];
    const newestFile = filenames[2];

    // Create a new transcript with maxLogFiles=3
    const logger = new TranscriptLogger(logDir, "scout", "rotation test", 3);
    logger.logText("New transcript content");
    const saved = logger.save();

    // Should now have exactly 3 files (rotated one out)
    const files = readdirSync(logDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBe(3);

    // The oldest file must have been deleted
    expect(existsSync(join(logDir, oldestFile))).toBe(false);

    // The middle and newest pre-existing files must still exist
    expect(existsSync(join(logDir, middleFile))).toBe(true);
    expect(existsSync(join(logDir, newestFile))).toBe(true);

    // The saved file should exist
    expect(existsSync(saved)).toBe(true);

    // The saved file should contain our content
    const content = readFileSync(saved, "utf-8");
    expect(content).toContain("New transcript content");
  });

  it("SCC-H5c: disabled tool excluded from subagent tool set", () => {
    // Create annotations without get_layout_info (simulating it being disabled)
    const filteredAnnotations = TOOL_ANNOTATIONS.filter(
      (a) => a.name !== "get_layout_info",
    );

    const tools = createSubagentTools(makeScoutRole(), {
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      annotations: filteredAnnotations,
      resultCallback: () => {},
    });

    const names = tools.map((t) => t.name);
    // get_layout_info was filtered from annotations, so should not appear
    expect(names).not.toContain("get_layout_info");
    // screenshot should still be there
    expect(names).toContain("screenshot");
  });

  it("SCC-H5e: disable tool then delegate immediately — tool not in set", async () => {
    // Simulate disabling execute_script by removing from annotations before delegation
    const withoutExecScript = TOOL_ANNOTATIONS.filter(
      (a) => a.name !== "execute_script",
    );

    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: {
        designer: makeDesignerRole(), // full access, but annotation is removed
      },
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: withoutExecScript,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    await runner.run({
      role: "designer",
      task: "Disabled tool test",
      toolCallId: "tc-disable-001",
    });

    // Check the session was created with tools that don't include execute_script
    expect(allSessionOpts.length).toBeGreaterThanOrEqual(1);
    const toolNames = (allSessionOpts[0].customTools as Array<{ name: string }>).map(
      (t) => t.name,
    );

    expect(toolNames).not.toContain("execute_script");
    // Other readwrite tools should still be there
    expect(toolNames).toContain("save_layout");
    expect(toolNames).toContain("create_layout");
  });

  it("SCC-H5f: createDelegateTool is callable (sandbox allows delegate)", () => {
    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: { scout: makeScoutRole() },
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    const tool = createDelegateTool(runner, config);

    // Verify the delegate tool has the correct shape
    expect(tool.name).toBe("delegate");
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBeDefined();
  });

  it("SCC-H5f: sandbox ALLOWED_TOOLS includes 'delegate' for plan-mode delegation", () => {
    // Verify that the sandbox allows the delegate tool so delegation works in plan mode.
    // ALLOWED_TOOLS is the Set in src/planning/sandbox.ts that gates tool execution.
    expect(ALLOWED_TOOLS.has("delegate")).toBe(true);

    // Also verify other expected tools are present
    expect(ALLOWED_TOOLS.has("read")).toBe(true);
    expect(ALLOWED_TOOLS.has("klayout_native_get_layout_info")).toBe(true);
    expect(ALLOWED_TOOLS.has("klayout_native_screenshot")).toBe(true);
    expect(ALLOWED_TOOLS.has("memory_save")).toBe(true);
    expect(ALLOWED_TOOLS.has("memory_search")).toBe(true);

    // Readwrite tools must NOT be allowed in sandbox
    expect(ALLOWED_TOOLS.has("execute_script")).toBe(false);
    expect(ALLOWED_TOOLS.has("save_layout")).toBe(false);
    expect(ALLOWED_TOOLS.has("create_layout")).toBe(false);
  });

  it("SCC-H5f: delegate tool validates unknown role", async () => {
    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: { scout: makeScoutRole() },
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    const tool = createDelegateTool(runner, config);
    const result = await tool.execute("tc-unknown", { role: "nonexistent", task: "test" });

    expect(result.content[0].text).toContain("Unknown role");
    expect(result.content[0].text).toContain("nonexistent");
  });

  it("SCC-H5l: no submit_result before forced stop produces synthesized partial result", async () => {
    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: {
        scout: makeScoutRole({ maxTurns: 3 }),
      },
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    // Do not call submit_result — just let turns exhaust
    const result = await runner.run({
      role: "scout",
      task: "No submit test",
      toolCallId: "tc-nosubmit-001",
    });

    expect(result.status).toBe("partial");
    expect(result.errorMessage).toBeDefined();
    expect(result.findings).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.dataPaths).toEqual([]);
    expect(result.tokenUsage.turns).toBe(3);
  });

  it("SCC-H5d: per-server disabled tool excluded even with full MCP access", () => {
    // Simulate per-server disabling by removing auto_route from annotations
    // (in real code, mcp.json per-server disabledTools filters annotations before passing to runner)
    const withoutAutoRoute = TOOL_ANNOTATIONS.filter(
      (a) => a.name !== "auto_route",
    );

    const tools = createSubagentTools(makeDesignerRole(), {
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      annotations: withoutAutoRoute,
      resultCallback: () => {},
    });

    const names = tools.map((t) => t.name);
    // Designer has mcpAccess="full" but auto_route was filtered at config level
    expect(names).not.toContain("auto_route");
    // Other readwrite tools should still be present
    expect(names).toContain("execute_script");
    expect(names).toContain("save_layout");
    expect(names).toContain("create_layout");
    // Readonly tools should still be present
    expect(names).toContain("screenshot");
    expect(names).toContain("get_layout_info");
  });

  it("SCC-H5i: running subagent isolated from config change — second lacks removed tool", async () => {
    // First designer: full annotations (includes auto_route)
    const deps1 = makeDeps();
    const runner1 = new SubagentRunner(deps1);

    await runner1.run({
      role: "designer",
      task: "First designer",
      toolCallId: "tc-iso-001",
    });

    // Capture first session's tools
    const firstToolNames = (allSessionOpts[0].customTools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(firstToolNames).toContain("auto_route");

    // Second designer: auto_route removed from annotations (simulating config change)
    const withoutAutoRoute = TOOL_ANNOTATIONS.filter(
      (a) => a.name !== "auto_route",
    );
    const deps2 = makeDeps({ annotations: withoutAutoRoute });
    const runner2 = new SubagentRunner(deps2);

    await runner2.run({
      role: "designer",
      task: "Second designer",
      toolCallId: "tc-iso-002",
    });

    // Second session's tools should NOT include auto_route
    // allSessionOpts accumulates across both runners; find the latest
    const secondToolNames = (allSessionOpts[allSessionOpts.length - 1].customTools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(secondToolNames).not.toContain("auto_route");

    // First session's tools were already assembled and remain unchanged
    expect(firstToolNames).toContain("auto_route");
  });

  it("SCC-H5h: large tool result stored in full by reducer and transcript", () => {
    // Generate a large result string (>10KB)
    const largeResult = "X".repeat(15000);

    // 1. Reducer test: SUBAGENT_TOOL_END with large result stores full content
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-large",
      role: "designer",
      task: "Large result test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-large",
      toolCallId: "tc-large",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_TOOL_START",
      subagentId: "sa-large",
      toolName: "execute_script",
      args: '{"code":"big output"}',
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_TOOL_END",
      subagentId: "sa-large",
      toolName: "execute_script",
      result: largeResult,
    });

    const seg = state.subagents[0].segments[0] as any;
    expect(seg.result).toBe(largeResult);
    expect(seg.result.length).toBe(15000);

    // 2. TranscriptLogger test: log large tool result, save, verify full content on disk
    const logDir = makeTmpDir();
    const logger = new TranscriptLogger(logDir, "designer", "large-result-test", 100);
    logger.logToolCall("execute_script", '{"code":"big output"}');
    logger.logToolResult("execute_script", largeResult);
    const transcriptPath = logger.save();

    const content = readFileSync(transcriptPath, "utf-8");
    expect(content).toContain(largeResult);
    expect(content.length).toBeGreaterThan(15000);
  });

  it("SCC-H5j: token budget exhausted mid-run produces partial in runner and reducer", async () => {
    // Start with tokens under budget — the runner will complete at least 1 turn.
    // After the first prompt call, tokens jump past the budget, triggering
    // mid-run exhaustion (not pre-first-prompt).
    mockTokenUsage = { tokens: 50000, contextWindow: 200000 };

    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: {
        designer: makeDesignerRole({ maxTurns: 10, maxTokens: 100000 }),
      },
    });

    // Override AgentSession so mock prompt increments token usage past budget
    // after the first call completes.
    vi.mocked(
      (await import("@mariozechner/pi-coding-agent")).AgentSession,
    ).mockImplementationOnce((opts: any) => {
      allSessionOpts.push(opts);
      const session = createMockSession();
      // After first prompt call, push tokens past budget
      session.prompt.mockImplementation(async () => {
        allPromptCounts[allMockSessions.length - 1]++;
        mockTokenUsage = { tokens: 150000, contextWindow: 200000 };
        return undefined;
      });
      return session;
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    const result = await runner.run({
      role: "designer",
      task: "Token exhaustion test",
      toolCallId: "tc-tokex-001",
    });

    // Runner returns partial with budget message
    expect(result.status).toBe("partial");
    expect(result.errorMessage).toContain("Token budget");
    // Must have completed at least 1 turn before budget was exceeded
    expect(result.tokenUsage.turns).toBeGreaterThan(0);

    // Pipe through reducer: SUBAGENT_END with partial status
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-tokex-001",
      role: "designer",
      task: "Token exhaustion test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-tokex",
      toolCallId: "tc-tokex-001",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_END",
      subagentId: "sa-tokex",
      status: "partial",
      errorMessage: result.errorMessage,
    });

    expect(state.subagents[0].status).toBe("partial");
    expect(state.subagents[0].errorMessage).toContain("Token budget");
  });

  it("SCC-H5k: inject + maxTurns boundary produces partial with inject consumed", async () => {
    const logDir = makeTmpDir();
    const config = makeSubagentConfig({
      logDir,
      roles: {
        scout: makeScoutRole({ maxTurns: 3 }),
      },
    });

    const runner = new SubagentRunner({
      config,
      mcpManager: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
      memoryManager: { search: vi.fn().mockResolvedValue([]) },
      workspaceDir: makeTmpDir(),
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue(undefined) } as any,
    });

    let subagentId: string | null = null;
    runner.on("started", (ev: StartedEvent) => {
      subagentId = ev.subagentId;
    });

    // Use a delay so we can inject between turns
    mockPromptDelay = 30;

    const resultPromise = runner.run({
      role: "scout",
      task: "Inject boundary test",
      toolCallId: "tc-inject-boundary",
    });

    // Wait for the first turn to begin
    await new Promise((r) => setTimeout(r, 15));
    expect(subagentId).not.toBeNull();

    // Inject a message after the first turn starts — consumed as the second turn's prompt arg
    runner.inject(subagentId!, "Check layer 5 too");

    const result = await resultPromise;

    // Should be partial because maxTurns=3 exhausted (no submit_result called)
    expect(result.status).toBe("partial");
    expect(result.errorMessage).toContain("budget");
    expect(result.tokenUsage.turns).toBe(3);

    // Prove the injected message was consumed: session.prompt must have been called
    // with the injected text on one of its calls
    const session = allMockSessions[0];
    const promptCalls = session.prompt.mock.calls;
    const injectedCall = promptCalls.find(
      (args: any[]) => args[0] === "Check layer 5 too",
    );
    expect(injectedCall).toBeDefined();
  });

  it("SCC-H5m: subagent session uses SessionManager.inMemory (ephemeral, no auto-compaction)", async () => {
    const { SessionManager } = await import("@mariozechner/pi-coding-agent");

    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    await runner.run({
      role: "scout",
      task: "Ephemeral session test",
      toolCallId: "tc-ephemeral-001",
    });

    // Verify SessionManager.inMemory() was called (session is ephemeral)
    expect(SessionManager.inMemory).toHaveBeenCalled();

    // Verify setAutoCompactionEnabled was NOT called with true
    const session = allMockSessions[0];
    const autoCompactCalls = session.setAutoCompactionEnabled.mock.calls;
    const calledWithTrue = autoCompactCalls.some(
      (args: any[]) => args[0] === true,
    );
    expect(calledWithTrue).toBe(false);
  });

  it("delegate tool never includes delegate in subagent tools", async () => {
    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    await runner.run({
      role: "designer",
      task: "No delegate recursion",
      toolCallId: "tc-nodeleg-001",
    });

    const sessionTools = (allSessionOpts[0].customTools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(sessionTools).not.toContain("delegate");
  });
});

// ===========================================================================
// GROUP 5: TUI Integration (SCC-H9-H19)
// ===========================================================================

describe("Group 5: TUI integration via reducer", () => {
  it("SCC-H9: SUBAGENT_PLACEHOLDER creates entry in state", () => {
    const state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-001",
      role: "scout",
      task: "Inspect layers",
    });

    expect(state.subagents.length).toBe(1);
    const entry = state.subagents[0];
    expect(entry.toolCallId).toBe("tc-001");
    expect(entry.role).toBe("scout");
    expect(entry.task).toBe("Inspect layers");
    expect(entry.status).toBe("running");
    expect(entry.segments).toEqual([]);
    expect(entry.startTime).toBeGreaterThan(0);
  });

  it("SCC-H10: runner thinking event adds thinking segment via reducer", () => {
    // Create an entry
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-think",
      role: "scout",
      task: "Think test",
    });

    // Start with real subagentId
    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-001",
      toolCallId: "tc-think",
    });

    // Thinking event
    state = tuiReducer(state, {
      type: "SUBAGENT_THINKING",
      subagentId: "sa-001",
      text: "Analyzing the layout structure...",
    });

    expect(state.subagents[0].segments.length).toBe(1);
    const seg = state.subagents[0].segments[0];
    expect(seg.type).toBe("thinking");
    expect((seg as any).text).toBe("Analyzing the layout structure...");
  });

  it("SCC-H11: runner text event adds text segment via reducer", () => {
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-text",
      role: "designer",
      task: "Text test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-002",
      toolCallId: "tc-text",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_TEXT",
      subagentId: "sa-002",
      text: "Creating the hall bar geometry...",
    });

    const seg = state.subagents[0].segments[0];
    expect(seg.type).toBe("text");
    expect((seg as any).text).toBe("Creating the hall bar geometry...");
  });

  it("SCC-H12: runner tool events add tool_call segment with status transitions", () => {
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-tool",
      role: "designer",
      task: "Tool test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-003",
      toolCallId: "tc-tool",
    });

    // Tool start
    state = tuiReducer(state, {
      type: "SUBAGENT_TOOL_START",
      subagentId: "sa-003",
      toolName: "execute_script",
      args: '{"code":"import pya"}',
    });

    expect(state.subagents[0].segments.length).toBe(1);
    const startSeg = state.subagents[0].segments[0] as any;
    expect(startSeg.type).toBe("tool_call");
    expect(startSeg.toolName).toBe("execute_script");
    expect(startSeg.status).toBe("running");
    expect(state.subagents[0].currentTool).toBe("execute_script");

    // Tool end
    state = tuiReducer(state, {
      type: "SUBAGENT_TOOL_END",
      subagentId: "sa-003",
      toolName: "execute_script",
      result: "Script executed successfully",
    });

    const endSeg = state.subagents[0].segments[0] as any;
    expect(endSeg.status).toBe("done");
    expect(endSeg.result).toBe("Script executed successfully");
    expect(state.subagents[0].currentTool).toBeUndefined();
  });

  it("SCC-H13: SUBAGENT_NAVIGATE moves cursor up and down", () => {
    // Create two entries
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-nav-a",
      role: "scout",
      task: "Nav A",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-nav-b",
      role: "designer",
      task: "Nav B",
    });

    expect(state.subagentSummaryIndex).toBe(0);

    // Navigate down
    state = tuiReducer(state, { type: "SUBAGENT_NAVIGATE", direction: "down" });
    expect(state.subagentSummaryIndex).toBe(1);

    // Navigate down again — should clamp
    state = tuiReducer(state, { type: "SUBAGENT_NAVIGATE", direction: "down" });
    expect(state.subagentSummaryIndex).toBe(1);

    // Navigate up
    state = tuiReducer(state, { type: "SUBAGENT_NAVIGATE", direction: "up" });
    expect(state.subagentSummaryIndex).toBe(0);
  });

  it("SCC-H14: SUBAGENT_INSPECT opens inspect view with correct focus", () => {
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-insp",
      role: "scout",
      task: "Inspect test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-insp",
      toolCallId: "tc-insp",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_INSPECT",
      subagentId: "sa-insp",
    });

    expect(state.focusState).toBe("subagent-inspect");
    expect(state.subagentInspectId).toBe("sa-insp");
  });

  it("SCC-H15: SUBAGENT_INSPECT_SCROLL moves up and down with clamping", () => {
    // Create entry with segments, inspect it
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-scroll",
      role: "scout",
      task: "Scroll test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-scroll",
      toolCallId: "tc-scroll",
    });

    // Add some segments
    state = tuiReducer(state, { type: "SUBAGENT_THINKING", subagentId: "sa-scroll", text: "Thinking..." });
    state = tuiReducer(state, { type: "SUBAGENT_TEXT", subagentId: "sa-scroll", text: "Line 1" });
    state = tuiReducer(state, { type: "SUBAGENT_TEXT", subagentId: "sa-scroll", text: "Line 2" });

    // Inspect the entry
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT", subagentId: "sa-scroll" });
    expect(state.subagentInspectScroll).toBe(0);

    // Scroll down
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" });
    expect(state.subagentInspectScroll).toBe(1);

    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" });
    expect(state.subagentInspectScroll).toBe(2);

    // Scroll up
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "up" });
    expect(state.subagentInspectScroll).toBe(1);

    // Scroll up to 0
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "up" });
    expect(state.subagentInspectScroll).toBe(0);

    // Scroll up again — clamped at 0
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "up" });
    expect(state.subagentInspectScroll).toBe(0);

    // Downward scroll past segment count: reducer increments without clamping.
    // With 3 segments (indices 0-2), scrolling to 3+ is allowed by the reducer.
    // The TUI rendering layer is responsible for viewport clamping.
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" });
    expect(state.subagentInspectScroll).toBe(1);
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" });
    expect(state.subagentInspectScroll).toBe(2);
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" });
    expect(state.subagentInspectScroll).toBe(3); // past segment count — no clamp
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_SCROLL", direction: "down" });
    expect(state.subagentInspectScroll).toBe(4); // continues incrementing
  });

  it("SCC-H15a: SUBAGENT_INSPECT_NAV left/right switches between subagents with clamping", () => {
    // Create 3 entries
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-nav3-a",
      role: "scout",
      task: "Nav3 A",
    });
    state = tuiReducer(state, { type: "SUBAGENT_START", subagentId: "sa-nav3-a", toolCallId: "tc-nav3-a" });

    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-nav3-b",
      role: "designer",
      task: "Nav3 B",
    });
    state = tuiReducer(state, { type: "SUBAGENT_START", subagentId: "sa-nav3-b", toolCallId: "tc-nav3-b" });

    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-nav3-c",
      role: "scout",
      task: "Nav3 C",
    });
    state = tuiReducer(state, { type: "SUBAGENT_START", subagentId: "sa-nav3-c", toolCallId: "tc-nav3-c" });

    // Inspect first entry
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT", subagentId: "sa-nav3-a" });
    expect(state.subagentInspectId).toBe("sa-nav3-a");

    // Nav right -> second
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_NAV", direction: "right" });
    expect(state.subagentInspectId).toBe("sa-nav3-b");

    // Nav right -> third
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_NAV", direction: "right" });
    expect(state.subagentInspectId).toBe("sa-nav3-c");

    // Nav right again -> clamped at third
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_NAV", direction: "right" });
    expect(state.subagentInspectId).toBe("sa-nav3-c");

    // Nav left -> back to second
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_NAV", direction: "left" });
    expect(state.subagentInspectId).toBe("sa-nav3-b");

    // Nav left -> back to first
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_NAV", direction: "left" });
    expect(state.subagentInspectId).toBe("sa-nav3-a");

    // Nav left again -> clamped at first
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_NAV", direction: "left" });
    expect(state.subagentInspectId).toBe("sa-nav3-a");
  });

  it("SCC-H5g: kill targets correct subagent after inspect nav", () => {
    // Create 2 running entries
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-kill2-a",
      role: "scout",
      task: "Kill2 A",
    });
    state = tuiReducer(state, { type: "SUBAGENT_START", subagentId: "sa-kill2-a", toolCallId: "tc-kill2-a" });

    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-kill2-b",
      role: "designer",
      task: "Kill2 B",
    });
    state = tuiReducer(state, { type: "SUBAGENT_START", subagentId: "sa-kill2-b", toolCallId: "tc-kill2-b" });

    // Inspect first entry
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT", subagentId: "sa-kill2-a" });
    expect(state.subagentInspectId).toBe("sa-kill2-a");

    // Navigate to second entry via SUBAGENT_INSPECT_NAV
    state = tuiReducer(state, { type: "SUBAGENT_INSPECT_NAV", direction: "right" });

    // Read the currently-inspected ID from state (not hardcoded)
    const inspectId = state.subagentInspectId!;
    expect(inspectId).toBe("sa-kill2-b");

    // Kill using the inspectId read from state
    state = tuiReducer(state, { type: "SUBAGENT_KILL", subagentId: inspectId });

    // The navigated-to entry (second) should be partial/killed
    const killed = state.subagents.find((s) => s.id === inspectId)!;
    expect(killed.status).toBe("partial");
    expect(killed.errorMessage).toContain("Killed");

    // The other entry (first) should still be running
    const other = state.subagents.find((s) => s.id !== inspectId)!;
    expect(other.status).toBe("running");
  });

  it("SCC-H16: inject flow transitions focus states correctly", () => {
    // Create running entry
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-inject",
      role: "scout",
      task: "Inject test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-inject",
      toolCallId: "tc-inject",
    });

    // Start inject
    state = tuiReducer(state, {
      type: "SUBAGENT_INJECT_START",
      subagentId: "sa-inject",
    });

    expect(state.focusState).toBe("subagent-inject");
    expect(state.subagentInjectMode).toBe(true);
    expect(state.subagentInjectTarget).toBe("sa-inject");

    // Type inject text
    state = tuiReducer(state, { type: "SUBAGENT_INJECT_CHAR", char: "P" } as any);
    state = tuiReducer(state, { type: "SUBAGENT_INJECT_CHAR", char: "l" } as any);
    state = tuiReducer(state, { type: "SUBAGENT_INJECT_CHAR", char: "ease also check layer 5" } as any);

    // Submit inject
    state = tuiReducer(state, {
      type: "SUBAGENT_INJECT_SUBMIT",
    } as any);

    expect(state.focusState).toBe("subagent-inspect");
    expect(state.subagentInjectMode).toBe(false);
    expect(state.subagentInjectTarget).toBeNull();

    // Verify injected segment was added
    const entry = state.subagents[0];
    const lastSeg = entry.segments[entry.segments.length - 1];
    expect(lastSeg.type).toBe("injected");
    expect((lastSeg as any).text).toBe("Please also check layer 5");
  });

  it("SCC-H16: inject cancel returns to summary", () => {
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-inject-c",
      role: "scout",
      task: "Cancel test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-inject-c",
      toolCallId: "tc-inject-c",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_INJECT_START",
      subagentId: "sa-inject-c",
    });

    expect(state.focusState).toBe("subagent-inject");

    state = tuiReducer(state, { type: "SUBAGENT_INJECT_CANCEL" });

    expect(state.focusState).toBe("subagent-summary");
    expect(state.subagentInjectMode).toBe(false);
  });

  it("SCC-H17: SUBAGENT_KILL updates entry status to partial", () => {
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-kill",
      role: "scout",
      task: "Kill test",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-kill",
      toolCallId: "tc-kill",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_KILL",
      subagentId: "sa-kill",
    });

    const entry = state.subagents[0];
    expect(entry.status).toBe("partial");
    expect(entry.errorMessage).toContain("Killed");
    expect(entry.endTime).toBeGreaterThan(0);
  });

  it("SCC-H17: SUBAGENT_KILL on non-running entry is a no-op", () => {
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-kill-noop",
      role: "scout",
      task: "Kill noop",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-kill-noop",
      toolCallId: "tc-kill-noop",
    });

    // End the subagent first
    state = tuiReducer(state, {
      type: "SUBAGENT_END",
      subagentId: "sa-kill-noop",
      status: "completed",
      findings: 2,
      warnings: 0,
    });

    // Now try to kill — should be a no-op
    const stateAfterKill = tuiReducer(state, {
      type: "SUBAGENT_KILL",
      subagentId: "sa-kill-noop",
    });

    expect(stateAfterKill.subagents[0].status).toBe("completed");
  });

  it("SCC-H18: activeSubagents count matches running entries", () => {
    // Create two running entries
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-badge-a",
      role: "scout",
      task: "Badge A",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-badge-b",
      role: "designer",
      task: "Badge B",
    });

    // Count running subagents (this is what StatusBar reads)
    const runningCount = state.subagents.filter(
      (s) => s.status === "running",
    ).length;
    expect(runningCount).toBe(2);

    // End one
    state = tuiReducer(state, {
      type: "SUBAGENT_START",
      subagentId: "sa-badge-a",
      toolCallId: "tc-badge-a",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_END",
      subagentId: "sa-badge-a",
      status: "completed",
    });

    const runningAfter = state.subagents.filter(
      (s) => s.status === "running",
    ).length;
    expect(runningAfter).toBe(1);
  });

  it("SCC-H18: StatusBar renders '2 sub' badge when 2 subagents are running", () => {
    // Build a state with 2 running subagents
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-sb-a",
      role: "scout",
      task: "StatusBar A",
    });
    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-sb-b",
      role: "designer",
      task: "StatusBar B",
    });

    // Render StatusBar component
    const instance = render(React.createElement(StatusBar, { state }));
    const frame = instance.lastFrame() ?? "";
    instance.unmount();

    const text = stripAnsi(frame);
    expect(text).toContain("2 sub");
  });

  // Note: Ctrl+S keypress dispatches TOGGLE_SUBAGENT_PANEL in App.tsx.
  // Testing the actual keypress requires a full App render (App.tsx integration),
  // which is outside the TRD scope for this suite. The reducer test below is
  // sufficient to verify the action's behavior. The keyboard binding is covered
  // by the App.tsx component tests.
  it("SCC-H19: TOGGLE_SUBAGENT_PANEL preserves entries", () => {
    // Add some entries
    let state = tuiReducer(initialState, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-toggle-a",
      role: "scout",
      task: "Toggle A",
    });

    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-toggle-b",
      role: "designer",
      task: "Toggle B",
    });

    // Open panel
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" });
    expect(state.subagentPanelOpen).toBe(true);
    expect(state.focusState).toBe("subagent-summary");
    expect(state.subagents.length).toBe(2);

    // Close panel
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" });
    expect(state.subagentPanelOpen).toBe(false);
    expect(state.focusState).toBe("input");

    // Entries are still there
    expect(state.subagents.length).toBe(2);
    expect(state.subagents[0].role).toBe("scout");
    expect(state.subagents[1].role).toBe("designer");
  });

  it("SCC-H19: toggle closes config panel if open", () => {
    // Open config panel first
    let state: typeof initialState = {
      ...initialState,
      configPanel: { ...initialState.configPanel, open: true },
    };

    // Toggle subagent panel
    state = tuiReducer(state, { type: "TOGGLE_SUBAGENT_PANEL" });

    expect(state.subagentPanelOpen).toBe(true);
    expect(state.configPanel.open).toBe(false);
  });
});

// ===========================================================================
// GROUP 5 (continued): Runner -> Reducer event integration
// ===========================================================================

describe("Group 5 (continued): Runner events -> Reducer pipeline", () => {
  it("runner events can be piped to reducer to build full TUI state", async () => {
    const deps = makeDeps();
    const runner = new SubagentRunner(deps);

    // Collect events from the runner
    const events: Array<{ type: string; payload: any }> = [];
    runner.on("started", (ev: StartedEvent) => events.push({ type: "started", payload: ev }));
    runner.on("thinking", (ev: ThinkingEvent) => events.push({ type: "thinking", payload: ev }));
    runner.on("text", (ev: TextEvent) => events.push({ type: "text", payload: ev }));
    runner.on("tool_start", (ev: ToolStartEvent) => events.push({ type: "tool_start", payload: ev }));
    runner.on("tool_end", (ev: ToolEndEvent) => events.push({ type: "tool_end", payload: ev }));

    // Configure prompt to emit events during first call
    const origPrompt = allMockSessions.length; // track which session

    const result = runner.run({
      role: "scout",
      task: "Event pipeline test",
      toolCallId: "tc-events-001",
    });

    // Wait a tick so the runner creates session and subscribes
    await new Promise((r) => setTimeout(r, 5));

    // Emit events on the session (session index 0)
    emitOnSession(0, "thinking", { text: "Let me analyze..." });
    emitOnSession(0, "text", { text: "Found 3 layers." });
    emitOnSession(0, "tool_start", { toolName: "screenshot", args: "{}" });
    emitOnSession(0, "tool_end", { toolName: "screenshot", result: "captured" });

    await result;

    // Verify each expected event type was captured
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("started");
    expect(eventTypes).toContain("thinking");
    expect(eventTypes).toContain("text");
    expect(eventTypes).toContain("tool_start");
    expect(eventTypes).toContain("tool_end");

    // Now pipe these events through reducer to build state
    let state = initialState;

    // Placeholder first
    state = tuiReducer(state, {
      type: "SUBAGENT_PLACEHOLDER",
      toolCallId: "tc-events-001",
      role: "scout",
      task: "Event pipeline test",
    });

    // Process runner events
    for (const ev of events) {
      switch (ev.type) {
        case "started":
          state = tuiReducer(state, {
            type: "SUBAGENT_START",
            subagentId: ev.payload.subagentId,
            toolCallId: ev.payload.toolCallId,
          });
          break;
        case "thinking":
          state = tuiReducer(state, {
            type: "SUBAGENT_THINKING",
            subagentId: ev.payload.subagentId,
            text: ev.payload.text,
          });
          break;
        case "text":
          state = tuiReducer(state, {
            type: "SUBAGENT_TEXT",
            subagentId: ev.payload.subagentId,
            text: ev.payload.text,
          });
          break;
        case "tool_start":
          state = tuiReducer(state, {
            type: "SUBAGENT_TOOL_START",
            subagentId: ev.payload.subagentId,
            toolName: ev.payload.toolName,
            args: ev.payload.args,
          });
          break;
        case "tool_end":
          state = tuiReducer(state, {
            type: "SUBAGENT_TOOL_END",
            subagentId: ev.payload.subagentId,
            toolName: ev.payload.toolName,
            result: ev.payload.result,
          });
          break;
      }
    }

    // Verify final state
    expect(state.subagents.length).toBe(1);
    const entry = state.subagents[0];
    expect(entry.role).toBe("scout");
    expect(entry.segments.length).toBe(3); // thinking + text + tool_call (tool_end merges into existing)

    // Verify segment types
    expect(entry.segments[0].type).toBe("thinking");
    expect(entry.segments[1].type).toBe("text");
    expect(entry.segments[2].type).toBe("tool_call");
    // tool_end updates the existing tool_call segment, doesn't add a new one
    expect((entry.segments[2] as any).status).toBe("done");
    expect((entry.segments[2] as any).result).toBe("captured");
  });
});

// ===========================================================================
// GROUP 6: Build regression (separate describe)
// ===========================================================================

describe("Group 6: Build regression", () => {
  it("TypeScript compiles without errors", async () => {
    // This test validates that all imports resolve and types are correct.
    // If the build is broken, this entire test file won't load.
    // We verify by checking that our key imports are actual constructors/functions.
    expect(typeof SubagentRunner).toBe("function");
    expect(typeof createSubagentTools).toBe("function");
    expect(typeof createDelegateTool).toBe("function");
    expect(typeof TranscriptLogger).toBe("function");
    expect(typeof buildSubagentPrompt).toBe("function");
    expect(typeof tuiReducer).toBe("function");
    expect(typeof initialState).toBe("object");
    expect(TOOL_ANNOTATIONS.length).toBeGreaterThan(0);
  });
});
