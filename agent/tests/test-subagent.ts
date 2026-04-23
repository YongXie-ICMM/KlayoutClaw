/**
 * Test suite for qlaybot v0.4.0 Phases E+F: Subagent Core + Delegation Wiring.
 *
 * Tests ALL SCC items (E1-E18, F1-F5) plus edge cases.
 * All tests should FAIL until implementation is created.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import {
  makeConfig,
  makeSubagentConfig,
  makeTmpDir,
} from "./helpers/config-builder.js";
import type {
  SubagentConfig,
  RoleConfig,
  SubagentResult,
  SubagentRunOptions,
  StartedEvent,
  ThinkingEvent,
  TextEvent,
  ToolStartEvent,
  ToolEndEvent,
  ToolAnnotation,
} from "../src/types/v04-contracts.js";
import { TOOL_ANNOTATIONS } from "../src/tools/annotations.js";

// ---------------------------------------------------------------------------
// Mock Agent SDK at module level so the runner can be tested in isolation
// ---------------------------------------------------------------------------

/** Captured options from the most recent AgentSession constructor call. */
let lastSessionOpts: any = null;
/** The most recent mock session instance (for controlling behavior in tests). */
let lastMockSession: ReturnType<typeof createMockSession>;

/** Track how many times prompt has been called on each session. */
let promptCallCount = 0;
/** Configurable: simulate token usage reported by getContextUsage. */
let mockTokenUsage = { tokens: 0, contextWindow: 200000 };
/** Configurable: if set, prompt() will reject with this error. */
let mockPromptError: Error | null = null;
/** Configurable: if set, prompt() resolves after this delay (ms). */
let mockPromptDelay = 0;
/** Configurable: subscriber listeners captured from subscribe(). */
let subscriberListeners: Array<(event: any) => void> = [];

function createMockSession() {
  promptCallCount = 0;
  subscriberListeners = [];
  const session = {
    prompt: vi.fn().mockImplementation(async () => {
      promptCallCount++;
      if (mockPromptDelay > 0) {
        await new Promise((r) => setTimeout(r, mockPromptDelay));
      }
      if (mockPromptError) {
        throw mockPromptError;
      }
      return undefined;
    }),
    subscribe: vi.fn().mockImplementation((listener: (event: any) => void) => {
      subscriberListeners.push(listener);
      return () => {}; // unsubscribe
    }),
    dispose: vi.fn(),
    abort: vi.fn(),
    getContextUsage: vi.fn().mockImplementation(() => ({ ...mockTokenUsage })),
    setAutoCompactionEnabled: vi.fn(),
  };
  return session;
}

/**
 * Emit a mock AgentSession event through the single-callback subscriber system.
 * Maps legacy event names to the real AgentSession event format.
 */
function emitMockSessionEvent(event: string, payload: any) {
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
  for (const listener of subscriberListeners) listener(sessionEvent);
}

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  AgentSession: vi.fn().mockImplementation((opts: any) => {
    lastSessionOpts = opts;
    lastMockSession = createMockSession();
    return lastMockSession;
  }),
  SessionManager: {
    inMemory: vi.fn().mockReturnValue({}),
  },
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
// Shared fixtures
// ---------------------------------------------------------------------------

function makeScoutRole(overrides?: Partial<RoleConfig>): RoleConfig {
  return {
    label: "Scout",
    promptFile: "subagent/scout.md",
    workspaceFiles: ["TOOLS.md"],
    baseTools: ["read", "bash"],
    customTools: ["memory_search", "submit_result"],
    mcpAccess: "shared-readonly",
    maxTurns: 50,
    maxTokens: 100000,
    ...overrides,
  };
}

function makeDesignerRole(overrides?: Partial<RoleConfig>): RoleConfig {
  return {
    label: "Designer",
    promptFile: "subagent/designer.md",
    workspaceFiles: ["TOOLS.md", "RULES.md"],
    baseTools: ["read", "bash", "edit", "write"],
    customTools: ["memory_search", "submit_result"],
    mcpAccess: "full",
    maxTurns: 100,
    maxTokens: 200000,
    ...overrides,
  };
}

function makeAnalystRole(overrides?: Partial<RoleConfig>): RoleConfig {
  return {
    label: "Analyst",
    promptFile: "subagent/analyst.md",
    workspaceFiles: ["TOOLS.md"],
    baseTools: ["read"],
    customTools: ["submit_result"],
    mcpAccess: "none",
    maxTurns: 30,
    maxTokens: 50000,
    ...overrides,
  };
}

function makeSubagentConfigWithRoles(): SubagentConfig {
  return makeSubagentConfig({
    roles: {
      scout: makeScoutRole(),
      designer: makeDesignerRole(),
      analyst: makeAnalystRole(),
    },
  });
}

/** Mock MCPManager with callTool that returns predictable results. */
function makeMockMCPManager() {
  return {
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "mock result" }],
    }),
    getConnectedServers: vi.fn().mockReturnValue(["klayout"]),
    getTools: vi.fn().mockReturnValue([]),
  };
}

/** Mock MemoryManager with search returning results. */
function makeMockMemoryManager() {
  return {
    search: vi.fn().mockResolvedValue([
      { hash: "abc", category: "fact", content: "test memory", score: 0.9 },
    ]),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

// ============================================================
// Phase E: Role System (SCC-E1 through SCC-E5)
// ============================================================

describe("role-resolver", () => {
  let resolveRole: typeof import("../src/subagent/role-resolver.js").resolveRole;
  let listRoles: typeof import("../src/subagent/role-resolver.js").listRoles;
  let validateRoles: typeof import("../src/subagent/role-resolver.js").validateRoles;

  beforeEach(async () => {
    const mod = await import("../src/subagent/role-resolver.js");
    resolveRole = mod.resolveRole;
    listRoles = mod.listRoles;
    validateRoles = mod.validateRoles;
  });

  // SCC-E1
  it("resolveRole('scout') returns scout config from settings", () => {
    const config = makeSubagentConfigWithRoles();
    const role = resolveRole("scout", config);
    expect(role).not.toBeNull();
    expect(role!.label).toBe("Scout");
    expect(role!.mcpAccess).toBe("shared-readonly");
    expect(role!.maxTurns).toBe(50);
    expect(role!.maxTokens).toBe(100000);
    expect(role!.baseTools).toEqual(["read", "bash"]);
  });

  // SCC-E2
  it("resolveRole('unknown_role') returns null without throwing", () => {
    const config = makeSubagentConfigWithRoles();
    const result = resolveRole("unknown_role", config);
    expect(result).toBeNull();
  });

  it("resolveRole returns null for empty string role", () => {
    const config = makeSubagentConfigWithRoles();
    expect(resolveRole("", config)).toBeNull();
  });

  // SCC-E3
  it("listRoles() returns all configured roles with labels", () => {
    const config = makeSubagentConfigWithRoles();
    const roles = listRoles(config);
    expect(roles).toHaveLength(3);
    // Each entry should have role name and label
    const roleNames = roles.map((r) => r.name);
    expect(roleNames).toContain("scout");
    expect(roleNames).toContain("designer");
    expect(roleNames).toContain("analyst");
    const scoutEntry = roles.find((r) => r.name === "scout");
    expect(scoutEntry!.label).toBe("Scout");
  });

  it("listRoles() returns empty array when no roles configured", () => {
    const config = makeSubagentConfig({ roles: {} });
    const roles = listRoles(config);
    expect(roles).toEqual([]);
  });

  // SCC-E4
  it("validateRoles() rejects config with missing required fields", () => {
    const config = makeSubagentConfig({
      roles: {
        broken: {
          label: "Broken",
          promptFile: "",
          workspaceFiles: [],
          baseTools: [],
          customTools: [],
          // missing mcpAccess is invalid value
          mcpAccess: "invalid" as any,
          maxTurns: 0,
          maxTokens: -1,
        },
      },
    });
    const errors = validateRoles(config);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("validateRoles() passes for valid config", () => {
    const config = makeSubagentConfigWithRoles();
    const errors = validateRoles(config);
    expect(errors).toEqual([]);
  });

  it("validateRoles() rejects empty promptFile", () => {
    const config = makeSubagentConfig({
      roles: {
        bad: makeScoutRole({ promptFile: "" }),
      },
    });
    const errors = validateRoles(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("promptFile"))).toBe(true);
  });

  it("validateRoles() rejects zero maxTurns", () => {
    const config = makeSubagentConfig({
      roles: {
        bad: makeScoutRole({ maxTurns: 0 }),
      },
    });
    const errors = validateRoles(config);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("validateRoles() rejects negative maxTokens", () => {
    const config = makeSubagentConfig({
      roles: {
        bad: makeScoutRole({ maxTokens: -100 }),
      },
    });
    const errors = validateRoles(config);
    expect(errors.length).toBeGreaterThan(0);
  });

  // SCC-E5
  it("roles are config-driven: resolveRole works with custom role names", () => {
    const config = makeSubagentConfig({
      roles: {
        my_custom_role: {
          label: "My Custom Role",
          promptFile: "subagent/custom.md",
          workspaceFiles: [],
          baseTools: ["read"],
          customTools: ["submit_result"],
          mcpAccess: "none",
          maxTurns: 10,
          maxTokens: 50000,
        },
      },
    });
    const role = resolveRole("my_custom_role", config);
    expect(role).not.toBeNull();
    expect(role!.label).toBe("My Custom Role");
  });

  it("no hardcoded role names: code does not require 'scout' to exist", () => {
    const config = makeSubagentConfig({
      roles: {
        alpha: makeScoutRole({ label: "Alpha" }),
        beta: makeDesignerRole({ label: "Beta" }),
      },
    });
    const roles = listRoles(config);
    expect(roles.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(resolveRole("scout", config)).toBeNull();
  });

  // Finding 2 (code-review-issue-23): config override for "general-purpose"
  // must win over the built-in role. Option A: config precedence over
  // built-in. The built-in is a safety net for configs that don't define one.
  describe("Finding 2: 'general-purpose' name is overridable by config", () => {
    let resolveRoleWithFallback: typeof import("../src/subagent/role-resolver.js").resolveRoleWithFallback;
    beforeEach(async () => {
      const mod = await import("../src/subagent/role-resolver.js");
      resolveRoleWithFallback = mod.resolveRoleWithFallback;
    });

    it("resolveRole: config.roles['general-purpose'] overrides built-in", () => {
      const config = makeSubagentConfig({
        roles: {
          "general-purpose": makeScoutRole({
            label: "Custom GP",
            baseTools: ["read"],
            mcpAccess: "shared-readonly",
            maxTurns: 5,
            maxTokens: 1000,
          }),
        },
      });
      const role = resolveRole("general-purpose", config);
      expect(role).not.toBeNull();
      expect(role!.label).toBe("Custom GP");
      expect(role!.maxTurns).toBe(5);
      expect(role!.mcpAccess).toBe("shared-readonly");
    });

    it("resolveRole: built-in returned when no config override", () => {
      const config = makeSubagentConfig({ roles: {} });
      const role = resolveRole("general-purpose", config);
      expect(role).not.toBeNull();
      expect(role!.label).toBe("General-purpose");     // from built-in
      expect(role!.mcpAccess).toBe("full");            // built-in default
    });

    it("resolveRoleWithFallback: config override wins, no warning", () => {
      const config = makeSubagentConfig({
        roles: {
          "general-purpose": makeScoutRole({ label: "Custom GP", maxTurns: 7 }),
        },
      });
      const resolved = resolveRoleWithFallback("general-purpose", config);
      expect(resolved.effectiveName).toBe("general-purpose");
      expect(resolved.role.label).toBe("Custom GP");
      expect(resolved.role.maxTurns).toBe(7);
      expect(resolved.warning).toBeUndefined();
    });

    it("resolveRoleWithFallback: built-in when no override, no warning", () => {
      const config = makeSubagentConfig({ roles: {} });
      const resolved = resolveRoleWithFallback("general-purpose", config);
      expect(resolved.effectiveName).toBe("general-purpose");
      expect(resolved.role.label).toBe("General-purpose");
      expect(resolved.warning).toBeUndefined();
    });

    it("resolveRoleWithFallback: unknown name still falls back to built-in with warning", () => {
      const config = makeSubagentConfig({ roles: { scout: makeScoutRole() } });
      const resolved = resolveRoleWithFallback("does-not-exist", config);
      expect(resolved.effectiveName).toBe("general-purpose");
      expect(resolved.role.label).toBe("General-purpose");
      expect(resolved.warning).toBeDefined();
      expect(resolved.warning!).toContain("does-not-exist");
    });

    it("resolveRoleWithFallback: unknown name + custom general-purpose → falls back to CUSTOM", () => {
      const config = makeSubagentConfig({
        roles: {
          "general-purpose": makeScoutRole({ label: "Custom GP", maxTurns: 3 }),
        },
      });
      const resolved = resolveRoleWithFallback("nonexistent", config);
      expect(resolved.effectiveName).toBe("general-purpose");
      expect(resolved.role.label).toBe("Custom GP");   // NOT the built-in
      expect(resolved.role.maxTurns).toBe(3);
      expect(resolved.warning).toBeDefined();
    });
  });
});

// ============================================================
// Phase E: Tool Factory (SCC-E6 through SCC-E10)
// ============================================================

describe("tool-factory", () => {
  let createSubagentTools: typeof import("../src/subagent/tool-factory.js").createSubagentTools;

  beforeEach(async () => {
    const mod = await import("../src/subagent/tool-factory.js");
    createSubagentTools = mod.createSubagentTools;
  });

  // SCC-E6: Read-only MCP proxy
  it("read-only MCP proxy blocks readwrite tools, allows readonly", () => {
    const role = makeScoutRole({ mcpAccess: "shared-readonly" });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const toolNames = tools.map((t) => t.name);

    // readonly tools should be proxied
    expect(toolNames).toContain("screenshot");
    expect(toolNames).toContain("get_layout_info");

    // readwrite tools must NOT be proxied
    expect(toolNames).not.toContain("create_layout");
    expect(toolNames).not.toContain("execute_script");
    expect(toolNames).not.toContain("save_layout");
    expect(toolNames).not.toContain("auto_route");
  });

  it("full MCP access includes both readonly and readwrite tools", () => {
    const role = makeDesignerRole({ mcpAccess: "full" });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("screenshot");
    expect(toolNames).toContain("execute_script");
  });

  it("mcpAccess 'none' includes no MCP tools", () => {
    const role = makeAnalystRole({ mcpAccess: "none" });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const toolNames = tools.map((t) => t.name);
    // No MCP tools at all
    for (const ann of TOOL_ANNOTATIONS) {
      expect(toolNames).not.toContain(ann.name);
    }
  });

  // SCC-E7: submit_result tool
  it("submit_result tool is available to subagents", () => {
    const role = makeScoutRole();
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const submitTool = tools.find((t) => t.name === "submit_result");
    expect(submitTool).toBeDefined();
    expect(submitTool!.description).toBeTruthy();
  });

  // SCC-E8: submit_result first-wins
  it("submit_result first-wins: second call returns error", async () => {
    const role = makeScoutRole();
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();
    const resultCallback = vi.fn();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback,
    });

    const submitTool = tools.find((t) => t.name === "submit_result")!;

    // First call succeeds
    const result1 = await submitTool.execute("tc_1", {
      status: "completed",
      findings: ["found 3 layers"],
      warnings: [],
    });
    expect(resultCallback).toHaveBeenCalledTimes(1);
    // Result should indicate success
    const text1 = JSON.stringify(result1);
    expect(text1).not.toContain("error");

    // Second call returns error
    const result2 = await submitTool.execute("tc_2", {
      status: "completed",
      findings: ["more findings"],
      warnings: [],
    });
    expect(resultCallback).toHaveBeenCalledTimes(1); // NOT called again
    const text2 = JSON.stringify(result2);
    expect(text2.toLowerCase()).toContain("error");
  });

  // SCC-E9: delegate NOT in subagent tools
  it("delegate tool NOT in subagent tool list", () => {
    const role = makeDesignerRole();
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("delegate");
  });

  // SCC-E10: Subagent gets base tools from role config
  it("subagent gets only base tools from its role config", () => {
    const role = makeAnalystRole({ baseTools: ["read"] });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const toolNames = tools.map((t) => t.name);
    // 'read' is in baseTools
    expect(toolNames).toContain("read");
    // 'bash', 'edit', 'write' are NOT in analyst baseTools
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("write");
  });

  it("subagent with full baseTools gets all four base tools", () => {
    const role = makeDesignerRole({
      baseTools: ["read", "bash", "edit", "write"],
    });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("write");
  });

  it("memory_search tool is included when in customTools", () => {
    const role = makeScoutRole({ customTools: ["memory_search", "submit_result"] });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const memTool = tools.find((t) => t.name === "memory_search");
    expect(memTool).toBeDefined();
  });

  it("memory_search delegates to parent MemoryManager.search()", async () => {
    const role = makeScoutRole({ customTools: ["memory_search", "submit_result"] });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const memTool = tools.find((t) => t.name === "memory_search")!;
    await memTool.execute("tc_mem", { query: "test query" });
    expect(memoryManager.search).toHaveBeenCalledWith("test query");
  });
});

// ============================================================
// Phase E: Prompt Builder
// ============================================================

describe("prompt-builder", () => {
  let buildSubagentPrompt: typeof import("../src/subagent/prompt-builder.js").buildSubagentPrompt;
  let buildTaskMessage: typeof import("../src/subagent/prompt-builder.js").buildTaskMessage;

  beforeEach(async () => {
    const mod = await import("../src/subagent/prompt-builder.js");
    buildSubagentPrompt = mod.buildSubagentPrompt;
    buildTaskMessage = mod.buildTaskMessage;
  });

  it("buildSubagentPrompt returns non-empty string", () => {
    const tmpDir = makeTmpDir();
    // Create a minimal prompt file
    const promptDir = join(tmpDir, "workspace", "subagent");
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(join(promptDir, "scout.md"), "# Scout\nYou are a scout agent.");

    const role = makeScoutRole({ promptFile: "subagent/scout.md" });
    const prompt = buildSubagentPrompt(role, join(tmpDir, "workspace"));
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("scout");
  });

  it("buildSubagentPrompt includes workspace file contents", () => {
    const tmpDir = makeTmpDir();
    const wsDir = join(tmpDir, "workspace");
    mkdirSync(join(wsDir, "subagent"), { recursive: true });
    writeFileSync(join(wsDir, "subagent", "scout.md"), "# Scout Prompt");
    writeFileSync(join(wsDir, "TOOLS.md"), "# Available Tools\nread, bash, screenshot");

    const role = makeScoutRole({
      promptFile: "subagent/scout.md",
      workspaceFiles: ["TOOLS.md"],
    });
    const prompt = buildSubagentPrompt(role, wsDir);
    expect(prompt).toContain("Available Tools");
  });

  it("buildTaskMessage formats task string correctly", () => {
    const msg = buildTaskMessage("Inspect all layers in the layout");
    expect(msg).toContain("Inspect all layers");
  });

  it("buildTaskMessage includes context when provided", () => {
    const msg = buildTaskMessage(
      "Inspect layers",
      "Layout has 5 metal layers and 2 via layers",
    );
    expect(msg).toContain("Inspect layers");
    expect(msg).toContain("5 metal layers");
  });

  it("buildTaskMessage without context omits context section", () => {
    const msg = buildTaskMessage("Simple task");
    // Should not include a context header or placeholder
    expect(msg).not.toContain("Context:");
  });
});

// ============================================================
// Phase E: Transcript Logger (SCC-E18)
// ============================================================

describe("transcript-logger", () => {
  let TranscriptLogger: typeof import("../src/subagent/transcript.js").TranscriptLogger;

  beforeEach(async () => {
    const mod = await import("../src/subagent/transcript.js");
    TranscriptLogger = mod.TranscriptLogger;
  });

  // SCC-E18
  it("writes markdown file with tool calls and results", () => {
    const tmpDir = makeTmpDir();
    const logger = new TranscriptLogger(tmpDir, "scout", "inspect-layers");

    logger.logThinking("Let me analyze the layout...");
    logger.logText("I found 3 layers.");
    logger.logToolCall("screenshot", '{"viewport": "full"}');
    logger.logToolResult("screenshot", "captured at /tmp/screenshot.png");
    logger.logText("Analysis complete.");

    const path = logger.save();

    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("screenshot");
    expect(content).toContain("captured at /tmp/screenshot.png");
    expect(content).toContain("3 layers");
    // Should be markdown format
    expect(content).toContain("#");
  });

  it("transcript file has .md extension", () => {
    const tmpDir = makeTmpDir();
    const logger = new TranscriptLogger(tmpDir, "designer", "create-cell");
    logger.logText("Done.");
    const path = logger.save();
    expect(path.endsWith(".md")).toBe(true);
  });

  it("log rotation: respects maxLogFiles", () => {
    const tmpDir = makeTmpDir();
    const maxFiles = 3;

    // Create more logs than the limit
    for (let i = 0; i < 5; i++) {
      const logger = new TranscriptLogger(tmpDir, "scout", `task-${i}`, maxFiles);
      logger.logText(`Entry ${i}`);
      logger.save();
    }

    const files = readdirSync(tmpDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeLessThanOrEqual(maxFiles);
  });

  it("transcript includes role and task in header", () => {
    const tmpDir = makeTmpDir();
    const logger = new TranscriptLogger(tmpDir, "analyst", "evaluate-routing");
    logger.logText("Starting evaluation.");
    const path = logger.save();

    const content = readFileSync(path, "utf-8");
    expect(content).toContain("analyst");
    expect(content).toContain("evaluate-routing");
  });
});

// ============================================================
// Phase E: Runner (SCC-E11 through SCC-E17)
// ============================================================

describe("subagent-runner", () => {
  let SubagentRunner: typeof import("../src/subagent/runner.js").SubagentRunner;
  let tmpDir: string;

  beforeEach(async () => {
    // Reset mock state before each test
    lastSessionOpts = null;
    mockTokenUsage = { tokens: 0, contextWindow: 200000 };
    mockPromptError = null;
    mockPromptDelay = 0;
    promptCallCount = 0;

    const mod = await import("../src/subagent/runner.js");
    SubagentRunner = mod.SubagentRunner;
    tmpDir = makeTmpDir();
  });

  function makeRunner(configOverrides?: Partial<SubagentConfig>) {
    const config = makeSubagentConfigWithRoles();
    const merged = { ...config, ...configOverrides, logDir: tmpDir };
    return new SubagentRunner({
      config: merged,
      mcpManager: makeMockMCPManager() as any,
      memoryManager: makeMockMemoryManager() as any,
      workspaceDir: tmpDir,
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue({ id: "mock-model", provider: "mock-provider", api: "anthropic-messages" }) } as any,
    });
  }

  // SCC-E11
  it("emits 'started' event with subagentId and toolCallId", async () => {
    const runner = makeRunner();
    const events: StartedEvent[] = [];
    runner.on("started", (e: StartedEvent) => events.push(e));

    await runner.run({
      role: "scout",
      task: "inspect layers",
      toolCallId: "tc_001",
    });

    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0];
    expect(ev.subagentId).toBeTruthy();
    expect(ev.toolCallId).toBe("tc_001");
    expect(ev.role).toBe("scout");
    expect(ev.task).toBe("inspect layers");
  });

  // SCC-E12
  it("emits thinking, text, tool_start, tool_end events during execution", async () => {
    const runner = makeRunner();
    const thinkingEvents: ThinkingEvent[] = [];
    const textEvents: TextEvent[] = [];
    const toolStartEvents: ToolStartEvent[] = [];
    const toolEndEvents: ToolEndEvent[] = [];

    runner.on("thinking", (e: ThinkingEvent) => thinkingEvents.push(e));
    runner.on("text", (e: TextEvent) => textEvents.push(e));
    runner.on("tool_start", (e: ToolStartEvent) => toolStartEvents.push(e));
    runner.on("tool_end", (e: ToolEndEvent) => toolEndEvents.push(e));

    // Configure mock prompt to simulate the session emitting events before resolving
    const originalPrompt = lastMockSession?.prompt;
    // We need to intercept after construction, so we set up a delayed prompt
    // that fires mock events via the subscriber system
    mockPromptDelay = 50; // give time for subscribe calls to register

    const runPromise = runner.run({
      role: "scout",
      task: "inspect layers",
      toolCallId: "tc_002",
    });

    // Wait a tick for the runner to subscribe, then emit mock events
    await new Promise((r) => setTimeout(r, 10));
    emitMockSessionEvent("thinking", { text: "Analyzing layout..." });
    emitMockSessionEvent("text", { text: "Found 3 layers." });
    emitMockSessionEvent("tool_start", { toolName: "screenshot", args: "{}" });
    emitMockSessionEvent("tool_end", { toolName: "screenshot", result: "captured" });

    await runPromise;

    // Runner is an EventEmitter that supports these event types
    expect(runner).toBeInstanceOf(EventEmitter);
    // Verify the runner actually forwarded events from the session (not just listener registration)
    expect(thinkingEvents.length).toBeGreaterThan(0);
    expect(thinkingEvents[0].text).toBe("Analyzing layout...");
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents[0].text).toBe("Found 3 layers.");
    expect(toolStartEvents.length).toBeGreaterThan(0);
    expect(toolStartEvents[0].toolName).toBe("screenshot");
    expect(toolEndEvents.length).toBeGreaterThan(0);
    expect(toolEndEvents[0].toolName).toBe("screenshot");
  });

  // SCC-E13
  it("budget enforcement: exceeding maxTurns returns partial result", async () => {
    // Configure mock session to simulate multiple successful turns via prompt().
    // The runner should count each prompt() call as a turn and stop at maxTurns.
    // prompt resolves successfully each time (returning undefined = agent wants
    // another turn), so the runner's turn-counting loop actually iterates.

    const runner = makeRunner({
      roles: {
        scout: makeScoutRole({ maxTurns: 2 }),
      },
    });

    const result = await runner.run({
      role: "scout",
      task: "long task that exceeds turns",
      toolCallId: "tc_budget_turns",
    });

    expect(result.status).toBe("partial");
    expect(result.role).toBe("scout");
    // The runner must have called prompt exactly maxTurns times (2), proving
    // the turn-counting loop iterated multiple times before stopping.
    expect(promptCallCount).toBe(2);
    expect(lastMockSession.prompt.mock.calls.length).toBe(2);
    expect(result.tokenUsage.turns).toBeLessThanOrEqual(2);
  });

  // SCC-E14
  it("budget enforcement: exceeding maxTokens returns partial result", async () => {
    // Configure mock session to report high token usage, so the runner
    // detects the budget exceeded and aborts
    mockTokenUsage = { tokens: 999999, contextWindow: 200000 };

    const runner = makeRunner({
      roles: {
        scout: makeScoutRole({ maxTokens: 100 }), // very small budget
      },
    });

    const result = await runner.run({
      role: "scout",
      task: "task that exceeds token budget",
      toolCallId: "tc_budget_tokens",
    });

    expect(result.status).toBe("partial");
    expect(result.role).toBe("scout");
  });

  // SCC-E15
  it("pause(id) halts subagent, resume(id) continues", async () => {
    // Use very fast prompt resolution so calls accumulate quickly.
    // This makes the pause/resume assertions meaningful: during a 200ms
    // pause window, many calls WOULD happen if pause does nothing.
    mockPromptDelay = 5;

    const runner = makeRunner();

    const startedPromise = new Promise<StartedEvent>((resolve) => {
      runner.on("started", resolve);
    });

    const runPromise = runner.run({
      role: "scout",
      task: "pauseable task",
      toolCallId: "tc_pause",
    });

    // Wait for the started event
    const started = await startedPromise;
    const subagentId = started.subagentId;
    expect(subagentId).toBeTruthy();

    // Let the runner accumulate some prompt calls first
    await new Promise((r) => setTimeout(r, 100));
    const callsBefore = lastMockSession.prompt.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0); // confirm it is actively running

    // Pause the subagent
    expect(() => runner.pause(subagentId)).not.toThrow();

    // Wait 200ms during pause — with 5ms prompt delay, ~40 calls would
    // accumulate if pause() does nothing. Zero new calls proves it works.
    await new Promise((r) => setTimeout(r, 200));
    const callsWhilePaused = lastMockSession.prompt.mock.calls.length;
    expect(callsWhilePaused).toBe(callsBefore); // no new calls during pause

    // Resume should allow execution to continue
    expect(() => runner.resume(subagentId)).not.toThrow();

    // After resuming, new prompt calls should appear
    await new Promise((r) => setTimeout(r, 200));
    const callsAfterResume = lastMockSession.prompt.mock.calls.length;
    expect(callsAfterResume).toBeGreaterThan(callsWhilePaused); // calls resumed

    // Let the run complete
    await runPromise;
  });

  // SCC-E16
  it("inject(id, message) inserts user message into subagent conversation", async () => {
    mockPromptDelay = 50;

    const runner = makeRunner();
    expect(typeof runner.inject).toBe("function");

    const startedPromise = new Promise<StartedEvent>((resolve) => {
      runner.on("started", resolve);
    });

    const runPromise = runner.run({
      role: "scout",
      task: "injectable task",
      toolCallId: "tc_inject",
    });

    const started = await startedPromise;

    const injectedText = "Additional instruction from user";

    // Record prompt call count before inject
    const callsBefore = lastMockSession.prompt.mock.calls.length;

    // inject should not throw and should queue the message for the session
    expect(() =>
      runner.inject(started.subagentId, injectedText),
    ).not.toThrow();

    // Wait for the inject to trigger a new prompt call
    await new Promise((r) => setTimeout(r, 200));

    // Verify a NEW prompt call was made after inject (beyond what existed before)
    const callsAfter = lastMockSession.prompt.mock.calls.length;
    expect(callsAfter).toBeGreaterThan(callsBefore);

    // Verify the newest prompt call(s) after inject contain the injected text.
    // Check all calls made after the inject point for the injected message.
    const newCalls = lastMockSession.prompt.mock.calls.slice(callsBefore);
    const hasInjectedMessage = newCalls.some((call: any[]) =>
      JSON.stringify(call).includes(injectedText),
    );
    expect(hasInjectedMessage).toBe(true);

    // Let the run complete
    await runPromise;
  });

  // SCC-E17
  it("kill(id) aborts session, returns SubagentResult with status partial", async () => {
    // Use a long delay so we can kill before it completes
    mockPromptDelay = 5000;

    const runner = makeRunner();

    const startedPromise = new Promise<StartedEvent>((resolve) => {
      runner.on("started", resolve);
    });

    const runPromise = runner.run({
      role: "scout",
      task: "killable task",
      toolCallId: "tc_kill",
    });

    const started = await startedPromise;

    // Kill the subagent
    runner.kill(started.subagentId);

    // The runner should abort the session and return a partial result
    const result = await runPromise;
    expect(result.status).toBe("partial");
    expect(result.errorMessage).toBe("Killed by user");
    expect(result.role).toBe("scout");

    // Verify the mock session's abort was called
    expect(lastMockSession.abort).toHaveBeenCalled();
  });

  it("run() with unknown role returns error result", async () => {
    const runner = makeRunner();

    const result = await runner.run({
      role: "nonexistent",
      task: "should fail",
      toolCallId: "tc_bad_role",
    });

    expect(result.status).toBe("error");
    expect(result.errorMessage).toBeTruthy();
    expect(result.role).toBe("nonexistent");
  });

  it("run() returns SubagentResult with all required fields", async () => {
    const runner = makeRunner();

    const result = await runner.run({
      role: "scout",
      task: "quick task",
      toolCallId: "tc_fields",
    });

    expect(result.role).toBe("scout");
    expect(result.task).toBe("quick task");
    expect(["completed", "partial", "error"]).toContain(result.status);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.dataPaths)).toBe(true);
    expect(result.tokenUsage).toBeDefined();
    expect(typeof result.tokenUsage.inputTokens).toBe("number");
    expect(typeof result.tokenUsage.outputTokens).toBe("number");
    expect(typeof result.tokenUsage.totalTokens).toBe("number");
    expect(typeof result.tokenUsage.turns).toBe("number");
    expect(typeof result.transcriptPath).toBe("string");
  });

  it("run() creates transcript file", async () => {
    const runner = makeRunner();

    const result = await runner.run({
      role: "scout",
      task: "transcript task",
      toolCallId: "tc_transcript",
    });

    expect(result.transcriptPath).toBeTruthy();
    expect(existsSync(result.transcriptPath)).toBe(true);
  });
});

// ============================================================
// Phase F: Delegate Tool (SCC-F1 through SCC-F2)
// ============================================================

describe("delegate-tool", () => {
  let createDelegateTool: typeof import("../src/tools/delegate.js").createDelegateTool;

  beforeEach(async () => {
    const mod = await import("../src/tools/delegate.js");
    createDelegateTool = mod.createDelegateTool;
  });

  // SCC-F1
  it("createDelegateTool returns tool with role, task, context parameters", () => {
    const mockRunner = new EventEmitter() as any;
    mockRunner.run = vi.fn().mockResolvedValue({
      role: "scout",
      task: "test",
      status: "completed",
      findings: [],
      warnings: [],
      dataPaths: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
      transcriptPath: "/tmp/t.md",
    });

    const config = makeSubagentConfigWithRoles();
    const tool = createDelegateTool(mockRunner, config);

    expect(tool.name).toBe("delegate");
    expect(tool.description).toBeTruthy();

    // Parameters schema should be a TypeBox schema object with properties
    const schema = tool.parameters;
    expect(schema).toBeDefined();

    // Parse the schema to verify it has the correct property structure.
    // TypeBox schemas have a `properties` object with typed sub-schemas.
    const props = schema.properties;
    expect(props).toBeDefined();

    // New API (issue #23): description/prompt/subagent_type/model are the
    // primary params. Legacy role/task are accepted for backward compat.
    expect(props.description).toBeDefined();
    expect(props.description.type).toBe("string");
    expect(props.prompt).toBeDefined();
    expect(props.prompt.type).toBe("string");
    expect(props.subagent_type).toBeDefined();
    expect(props.model).toBeDefined();

    // Legacy params still present (optional) for deprecation window
    expect(props.role).toBeDefined();
    expect(props.task).toBeDefined();
    expect(props.context).toBeDefined();
  });

  // SCC-F2 — updated for issue #23: unknown subagent_type falls back to
  // general-purpose with a warning (not a hard error), matching Claude Code's
  // Agent-tool pattern.
  it("calling delegate with unknown subagent_type falls back to general-purpose with warning", async () => {
    const mockRunner = new EventEmitter() as any;
    mockRunner.run = vi.fn(async (opts: any) => ({
      role: opts.role,
      task: opts.task,
      status: "completed",
      findings: [],
      warnings: [],
      dataPaths: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
      transcriptPath: "",
    }));

    const config = makeSubagentConfigWithRoles();
    const tool = createDelegateTool(mockRunner, config);

    const result = await tool.execute("tc_bad", {
      role: "nonexistent_role",
      task: "should fall back",
    });

    expect(mockRunner.run).toHaveBeenCalledTimes(1);
    const callArgs = mockRunner.run.mock.calls[0][0];
    expect(callArgs.role).toBe("general-purpose");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.warnings.some((w: string) => w.includes("nonexistent_role"))).toBe(true);
    expect(parsed.warnings.some((w: string) => w.includes("general-purpose"))).toBe(true);
  });

  it("delegate tool calls runner.run with correct parameters", async () => {
    const mockRunner = new EventEmitter() as any;
    mockRunner.run = vi.fn().mockResolvedValue({
      role: "scout",
      task: "test task",
      status: "completed",
      findings: ["found something"],
      warnings: [],
      dataPaths: [],
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, turns: 3 },
      transcriptPath: "/tmp/t.md",
    });

    const config = makeSubagentConfigWithRoles();
    const tool = createDelegateTool(mockRunner, config);

    await tool.execute("tc_good", {
      role: "scout",
      task: "inspect the layout",
      context: "Layout has 3 metal layers",
    });

    expect(mockRunner.run).toHaveBeenCalledTimes(1);
    const callArgs = mockRunner.run.mock.calls[0][0];
    expect(callArgs.role).toBe("scout");
    expect(callArgs.task).toBe("inspect the layout");
    expect(callArgs.toolCallId).toBe("tc_good");
  });

  it("delegate tool returns SubagentResult content on success", async () => {
    const mockRunner = new EventEmitter() as any;
    mockRunner.run = vi.fn().mockResolvedValue({
      role: "scout",
      task: "test",
      status: "completed",
      findings: ["Layer 1 has 42 shapes"],
      warnings: ["Some overlapping geometry"],
      dataPaths: ["/tmp/out.gds"],
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, turns: 3 },
      transcriptPath: "/tmp/t.md",
    });

    const config = makeSubagentConfigWithRoles();
    const tool = createDelegateTool(mockRunner, config);

    const result = await tool.execute("tc_success", {
      role: "scout",
      task: "test",
    });

    const resultStr = JSON.stringify(result);
    expect(resultStr).toContain("completed");
    expect(resultStr).toContain("42 shapes");
  });
});

// ============================================================
// Phase F: Agent Wiring (SCC-F3, SCC-F4, SCC-F5)
// ============================================================

describe("agent-wiring", () => {
  // SCC-F3: delegate tool wired into agent.ts tool list
  it("delegate tool is in the assembled tool list when subagent enabled", async () => {
    // We test by importing the assembleTools or createDesignSession and checking
    // for the delegate tool in the returned tools
    const { assembleTools } = await import("../src/tools/index.js");
    const config = makeConfig({
      subagent: { enabled: true, roles: { scout: makeScoutRole() } },
    });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const { toolMap } = assembleTools({
      config,
      mcpManager: mcpManager as any,
      memoryManager: memoryManager as any,
      cwd: "/tmp",
      workspaceDir: "/tmp",
      annotations: TOOL_ANNOTATIONS,
    });

    const toolNames = Object.keys(toolMap);
    expect(toolNames).toContain("delegate");
  });

  it("delegate tool is NOT assembled when subagent disabled", async () => {
    const { assembleTools } = await import("../src/tools/index.js");
    const config = makeConfig({
      subagent: { enabled: false },
    });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const { toolMap } = assembleTools({
      config,
      mcpManager: mcpManager as any,
      memoryManager: memoryManager as any,
      cwd: "/tmp",
      workspaceDir: "/tmp",
      annotations: TOOL_ANNOTATIONS,
    });

    const toolNames = Object.keys(toolMap);
    expect(toolNames).not.toContain("delegate");
  });

  // DELETED (qlaybot v0.4.3 Group 3 step 11): the SCC-F4 "delegate in
  // plan-mode allowlist" test was removed because the legacy allowlist
  // Set was deleted from src/planning/sandbox.ts per spec §9 step 11.
  // Delegate is now unconditionally BLOCKED in plan mode (§1.11) — the
  // opposite of the old allowlist behavior — and that new contract is
  // covered by tests/test-plan-mode-v043-group2.ts.

  // SCC-F5: system prompt includes delegation section
  it("system prompt includes dynamic delegation section with role descriptions", async () => {
    const { buildDelegationSection } = await import(
      "../src/prompts/sections/delegation.js"
    );
    const config = makeSubagentConfigWithRoles();

    const section = buildDelegationSection(config);

    // Should contain role descriptions
    expect(section).toBeTruthy();
    expect(section).toContain("Scout");
    expect(section).toContain("Designer");
    expect(section).toContain("Analyst");
    expect(section!.toLowerCase()).toContain("delegate");
  });

  it("delegation section updates dynamically when roles change", async () => {
    const { buildDelegationSection } = await import(
      "../src/prompts/sections/delegation.js"
    );

    // Start with standard roles
    const config1 = makeSubagentConfigWithRoles();
    const section1 = buildDelegationSection(config1);
    expect(section1).toBeTruthy();
    expect(section1).toContain("Scout");
    expect(section1).not.toContain("Fabricator");

    // Add a custom role and rebuild
    const config2 = makeSubagentConfig({
      roles: {
        ...config1.roles,
        fabricator: {
          label: "Fabricator",
          promptFile: "subagent/fabricator.md",
          workspaceFiles: [],
          baseTools: ["read", "bash"],
          customTools: ["submit_result"],
          mcpAccess: "full" as const,
          maxTurns: 50,
          maxTokens: 100000,
        },
      },
    });
    const section2 = buildDelegationSection(config2);
    expect(section2).toBeTruthy();
    // The new role must appear
    expect(section2).toContain("Fabricator");
    // Original roles must still appear
    expect(section2).toContain("Scout");
    // Section content should have changed
    expect(section2).not.toBe(section1);
  });

  it("system prompt delegation section is absent when no roles configured", async () => {
    // Import the delegation section builder directly -- this module must exist
    const { buildDelegationSection } = await import(
      "../src/prompts/sections/delegation.js"
    );
    const config = makeSubagentConfig({ roles: {} });

    const section = buildDelegationSection(config);
    // With no roles, section should be empty/null
    expect(!section || section.length === 0).toBe(true);
  });
});

// ============================================================
// Phase F: Workspace prompt templates
// ============================================================

describe("workspace-templates", () => {
  // Compute workspace path relative to this test file, not hardcoded
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const wsDir = join(__dirname, "..", "workspace", "subagent");

  it("scout.md template exists in workspace/subagent/", () => {
    expect(existsSync(join(wsDir, "scout.md"))).toBe(true);
  });

  it("designer.md template exists in workspace/subagent/", () => {
    expect(existsSync(join(wsDir, "designer.md"))).toBe(true);
  });

  it("analyst.md template exists in workspace/subagent/", () => {
    expect(existsSync(join(wsDir, "analyst.md"))).toBe(true);
  });

  it("planner.md template exists in workspace/subagent/", () => {
    expect(existsSync(join(wsDir, "planner.md"))).toBe(true);
  });
});

// ============================================================
// Edge cases and integration
// ============================================================

describe("edge-cases", () => {
  it("tool-factory: MCP proxy tool calls pass through to mcpManager.callTool", async () => {
    const { createSubagentTools } = await import("../src/subagent/tool-factory.js");
    const role = makeScoutRole({ mcpAccess: "shared-readonly" });
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback: vi.fn(),
    });

    const screenshotTool = tools.find((t) => t.name === "screenshot");
    expect(screenshotTool).toBeDefined();

    await screenshotTool!.execute("tc_proxy", { viewport: "full" });
    expect(mcpManager.callTool).toHaveBeenCalledWith("screenshot", { viewport: "full" });
  });

  it("runner: concurrent runs get distinct subagent IDs", async () => {
    const { SubagentRunner } = await import("../src/subagent/runner.js");
    const dir = makeTmpDir();
    const config = makeSubagentConfigWithRoles();
    config.logDir = dir;

    const runner = new SubagentRunner({
      config,
      mcpManager: makeMockMCPManager() as any,
      memoryManager: makeMockMemoryManager() as any,
      workspaceDir: dir,
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue({ id: "mock-model", provider: "mock-provider", api: "anthropic-messages" }) } as any,
    });

    const ids: string[] = [];
    runner.on("started", (e: StartedEvent) => ids.push(e.subagentId));

    // Start two concurrent runs (mocked SDK, both should succeed)
    const [r1, r2] = await Promise.all([
      runner.run({ role: "scout", task: "task A", toolCallId: "tc_a" }),
      runner.run({ role: "designer", task: "task B", toolCallId: "tc_b" }),
    ]);

    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("tool-factory: submit_result callback receives findings and warnings", async () => {
    const { createSubagentTools } = await import("../src/subagent/tool-factory.js");
    const role = makeScoutRole();
    const mcpManager = makeMockMCPManager();
    const memoryManager = makeMockMemoryManager();
    const resultCallback = vi.fn();

    const tools = createSubagentTools(role, {
      mcpManager,
      memoryManager,
      annotations: TOOL_ANNOTATIONS,
      resultCallback,
    });

    const submitTool = tools.find((t) => t.name === "submit_result")!;
    await submitTool.execute("tc_cb", {
      status: "completed",
      findings: ["Layer 1: 42 shapes", "Layer 2: 10 shapes"],
      warnings: ["Overlap detected at (100, 200)"],
      dataPaths: ["/tmp/report.json"],
    });

    expect(resultCallback).toHaveBeenCalledTimes(1);
    const callArg = resultCallback.mock.calls[0][0];
    expect(callArg.findings).toHaveLength(2);
    expect(callArg.warnings).toHaveLength(1);
    expect(callArg.dataPaths).toHaveLength(1);
  });

  it("validateRoles rejects invalid mcpAccess value", async () => {
    const { validateRoles } = await import("../src/subagent/role-resolver.js");
    const config = makeSubagentConfig({
      roles: {
        bad: makeScoutRole({ mcpAccess: "write-only" as any }),
      },
    });
    const errors = validateRoles(config);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("mcpAccess"))).toBe(true);
  });
});

// ============================================================
// Cross-review gap tests: live integration paths
// ============================================================

describe("cross-review-gaps", () => {
  // GAP 1 (F3): createDesignSession must use the extended assembleTools
  // signature when subagent.enabled=true, so that a delegate tool is
  // included in the session's customTools.
  //
  // Current state: agent.ts line 192 calls assembleTools with the legacy
  // signature ({cwd, mcpManager, memoryManager, disabledTools}) which
  // never creates a delegate tool. This test proves the gap.
  it("createDesignSession includes delegate tool when subagent.enabled=true", async () => {
    // agent.ts calls assembleTools internally. We verify that the
    // resulting session's customTools contain one named "delegate".
    // We use the mock SDK (already mocked at module level) and inspect
    // lastSessionOpts.customTools after createDesignSession runs.
    const { assembleTools } = await import("../src/tools/index.js");

    // Simulate what agent.ts SHOULD do: call assembleTools with the
    // extended signature when config.subagent.enabled=true.
    // The test verifies agent.ts actually does this by checking the
    // code path. Since we cannot easily call createDesignSession (it
    // has filesystem + SDK side effects), we instead verify that
    // agent.ts passes config to assembleTools.
    //
    // Approach: read agent.ts source and confirm it uses the extended
    // signature when subagent is enabled. This is a structural test.
    const agentSource = (await import("fs")).readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "agent.ts"),
      "utf-8",
    );

    // The extended assembleTools call must include config parameter
    // so that the delegate tool gets created. The legacy call on line
    // 192 does NOT include config — this test should fail.
    const assembleCallMatch = agentSource.match(
      /assembleTools\(\{[^}]*config[^}]*\}/s,
    );
    expect(assembleCallMatch).not.toBeNull();

    // Additionally verify the call references subagent-related params
    // (workspaceDir, annotations) that the extended signature requires
    if (assembleCallMatch) {
      expect(assembleCallMatch[0]).toContain("workspaceDir");
      expect(assembleCallMatch[0]).toContain("annotations");
    }
  });

  // GAP 2 (F5): buildSystemPrompt must call buildDelegationSection
  // when subagent roles exist, so the model knows about the delegate tool.
  //
  // Current state: buildSystemPrompt in src/prompts/index.ts assembles
  // sections from tooling, mcp, memory, and context — but never imports
  // or calls buildDelegationSection. This test proves the gap.
  it("buildSystemPrompt output includes delegation section when subagent roles provided", async () => {
    const { buildSystemPrompt, PromptMode } = await import(
      "../src/prompts/index.js"
    );

    // buildSystemPrompt must accept subagent config (or roles) in its
    // PromptBuildContext so it can include the delegation section.
    const prompt = buildSystemPrompt({
      mode: PromptMode.Full,
      workspaceDir: join(dirname(fileURLToPath(import.meta.url)), "..", "workspace"),
      toolNames: ["read", "bash", "delegate"],
      connectedServers: ["klayout"],
      // The extended context should accept subagent config
      subagentConfig: makeSubagentConfigWithRoles(),
    } as any);

    // The assembled prompt must contain delegation-related content
    expect(prompt).toContain("Delegation");
    expect(prompt).toContain("delegate");
    // It must list the role names
    expect(prompt).toContain("Scout");
    expect(prompt).toContain("Designer");
    expect(prompt).toContain("Analyst");
  });

  it("buildSystemPrompt omits delegation section when no subagent roles", async () => {
    const { buildSystemPrompt, PromptMode } = await import(
      "../src/prompts/index.js"
    );

    const prompt = buildSystemPrompt({
      mode: PromptMode.Full,
      workspaceDir: join(dirname(fileURLToPath(import.meta.url)), "..", "workspace"),
      toolNames: ["read", "bash"],
      connectedServers: [],
      subagentConfig: makeSubagentConfig({ roles: {} }),
    } as any);

    // With no roles, the delegation heading must NOT appear
    expect(prompt).not.toContain("## Delegation");
  });

  // GAP 3: delegate tool must forward context to runner.run(),
  // and runner must pass it through to buildTaskMessage.
  //
  // Current state: createDelegateTool accepts context in params but
  // calls runner.run({role, task, toolCallId}) — context is dropped.
  // runner.run() calls buildTaskMessage(task) without context arg.
  it("delegate tool forwards context to runner.run()", async () => {
    const { createDelegateTool } = await import("../src/tools/delegate.js");

    const mockRunner = new EventEmitter() as any;
    mockRunner.run = vi.fn().mockResolvedValue({
      role: "scout",
      task: "check layers",
      status: "completed",
      findings: [],
      warnings: [],
      dataPaths: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 1 },
      transcriptPath: "/tmp/t.md",
    });

    const config = makeSubagentConfigWithRoles();
    const tool = createDelegateTool(mockRunner, config);

    await tool.execute("tc_ctx", {
      role: "scout",
      task: "check layers",
      context: "The layout has 5 metal layers and 2 via layers",
    });

    expect(mockRunner.run).toHaveBeenCalledTimes(1);
    const callArgs = mockRunner.run.mock.calls[0][0];
    // context must be forwarded to runner.run()
    expect(callArgs).toHaveProperty("context");
    expect(callArgs.context).toBe(
      "The layout has 5 metal layers and 2 via layers",
    );
  });

  it("runner.run() includes context in the task message sent to subagent", async () => {
    const { SubagentRunner } = await import("../src/subagent/runner.js");
    const { buildTaskMessage } = await import("../src/subagent/prompt-builder.js");
    const dir = makeTmpDir();

    // First verify buildTaskMessage supports context (it does)
    const msg = buildTaskMessage("do something", "extra context here");
    expect(msg).toContain("extra context here");
    expect(msg).toContain("Context");

    // Now verify runner.run() actually passes context through.
    // runner calls session.prompt(taskMessage) on the first turn.
    // If context is provided, taskMessage must include it.
    const config = makeSubagentConfigWithRoles();
    config.logDir = dir;

    const runner = new SubagentRunner({
      config,
      mcpManager: makeMockMCPManager() as any,
      memoryManager: makeMockMemoryManager() as any,
      workspaceDir: dir,
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: { find: vi.fn().mockReturnValue({ id: "mock-model", provider: "mock-provider", api: "anthropic-messages" }) } as any,
    });

    // Run with context — the SubagentRunOptions type must accept context
    const result = await runner.run({
      role: "scout",
      task: "inspect metal layers",
      toolCallId: "tc_ctx_runner",
      context: "Layout contains 3 metal layers",
    } as any);

    // The first prompt call should have included the context
    // in the task message. We check lastMockSession.prompt was
    // called with a string containing the context.
    expect(lastMockSession.prompt).toHaveBeenCalled();
    const firstPromptArg = lastMockSession.prompt.mock.calls[0][0];
    expect(typeof firstPromptArg).toBe("string");
    expect(firstPromptArg).toContain("Layout contains 3 metal layers");
    expect(firstPromptArg).toContain("Context");
  });
});