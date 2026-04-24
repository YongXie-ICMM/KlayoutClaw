/**
 * TDD regression tests for Tier 1 bugs from the 7-reviewer audit.
 * Each test should FAIL against the current (buggy) code and PASS once fixed.
 *
 *   BUG 1 (#8):  Transform pipeline order — autoRecall after stateLoader contaminates memory search
 *   BUG 2 (#5):  Subagent MCP tool naming — annotation names vs namespaced names
 *   BUG 3 (#10): submit_result continuation — loop doesn't break after result
 *   BUG 4 (#6):  Subagent listener leaks — unsubscribe never stored, no dispose()
 *   BUG 5 (#9):  Empty MCP schemas — Type.Object({}) for all MCP proxy tools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import {
  makeSubagentConfig,
} from "./helpers/config-builder.js";
import type {
  RoleConfig,
  SubagentConfig,
  ToolAnnotation,
} from "../src/types/v04-contracts.js";
import { TOOL_ANNOTATIONS } from "../src/tools/annotations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function srcFile(relPath: string): string {
  return readFileSync(join(__dirname, "..", "src", relPath), "utf-8");
}

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qlaybot-tier1-"));
  tmpDirs.push(dir);
  // Create workspace structure needed by SubagentRunner
  mkdirSync(join(dir, "subagent"), { recursive: true });
  writeFileSync(join(dir, "subagent", "scout.md"), "# Scout\nYou are a scout.");
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ============================================================
// BUG 1 (#8): Transform pipeline order — STRUCTURAL
// ============================================================

describe("BUG 1 (#8): Transform pipeline order — autoRecall before stateLoader", () => {
  it("agent.ts must run autoRecall BEFORE stateLoader in transformContext", () => {
    const src = srcFile("agent.ts");
    const txBlock = src.match(
      /const transformContext[\s\S]*?return transformed;\s*\}/,
    );
    expect(txBlock).toBeTruthy();
    const body = txBlock![0];

    const autoRecallPos = body.indexOf("autoRecall(");
    const stateLoaderPos = body.indexOf("stateLoader(");

    expect(autoRecallPos).toBeGreaterThan(-1);
    expect(stateLoaderPos).toBeGreaterThan(-1);
    expect(autoRecallPos).toBeLessThan(stateLoaderPos);
  });
});

// ============================================================
// BUG 2 (#5): Subagent MCP tool naming — STRUCTURAL
// ============================================================

describe("BUG 2 (#5): Subagent MCP tool naming — must use namespaced names", () => {
  it("tool-factory MCP proxy must NOT pass bare ann.name through to callTool", () => {
    const src = srcFile("subagent/tool-factory.ts");
    const mcpBlock = src.match(
      /\/\/ 2\. MCP proxy tools[\s\S]*?\/\/ 3\. submit_result/,
    );
    expect(mcpBlock).toBeTruthy();
    const block = mcpBlock![0];

    // The bug pattern: `const toolName = ann.name;` then `callTool(toolName, ...)`
    // This passes bare names like "screenshot" to callTool which expects "klayout_screenshot"
    const assignsBareName = /const toolName = ann\.name/.test(block);
    const callsWithBareName = /callTool\(toolName/.test(block);
    const hasBug = assignsBareName && callsWithBareName;
    expect(hasBug).toBe(false);
  });
});

// ============================================================
// BUG 5 (#9): Empty MCP schemas — STRUCTURAL
// ============================================================

describe("BUG 5 (#9): Empty MCP schemas — must forward real inputSchema", () => {
  it("tool-factory MCP proxy must NOT use Type.Object({}) as parameters", () => {
    const src = srcFile("subagent/tool-factory.ts");
    const mcpBlock = src.match(
      /\/\/ 2\. MCP proxy tools[\s\S]*?\/\/ 3\. submit_result/,
    );
    expect(mcpBlock).toBeTruthy();
    const block = mcpBlock![0];

    const usesEmptySchema = /parameters:\s*Type\.Object\(\s*\{\s*\}\s*\)/.test(block);
    expect(usesEmptySchema).toBe(false);
  });
});

// ============================================================
// Mock Agent SDK for behavioral tests (bugs 3 & 4)
// ============================================================

let lastSessionOpts: any = null;
let lastMockSession: ReturnType<typeof createMockSession>;
let promptCallCount = 0;
let mockTokenUsage = { tokens: 0, contextWindow: 200000 };
let mockPromptError: Error | null = null;
let mockPromptDelay = 0;
let subscriberListeners: Array<(event: any) => void> = [];
/** Hook called inside prompt() — use to simulate tool calls during a turn */
let promptHook: null | (() => Promise<void> | void) = null;

function createMockSession() {
  promptCallCount = 0;
  subscriberListeners = [];
  const session = {
    prompt: vi.fn().mockImplementation(async () => {
      promptCallCount++;
      if (mockPromptDelay > 0) {
        await new Promise((r) => setTimeout(r, mockPromptDelay));
      }
      if (promptHook) await promptHook();
      if (mockPromptError) throw mockPromptError;
      return undefined;
    }),
    subscribe: vi.fn().mockImplementation((listener: (event: any) => void) => {
      subscriberListeners.push(listener);
      // Return a real unsubscribe function that splices the listener out
      return () => {
        const idx = subscriberListeners.indexOf(listener);
        if (idx >= 0) subscriberListeners.splice(idx, 1);
      };
    }),
    dispose: vi.fn(),
    abort: vi.fn(),
    getContextUsage: vi.fn().mockImplementation(() => ({ ...mockTokenUsage })),
    setAutoCompactionEnabled: vi.fn(),
  };
  return session;
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

// --- Shared fixtures ---

function makeScoutRole(overrides?: Partial<RoleConfig>): RoleConfig {
  return {
    label: "Scout",
    promptFile: "subagent/scout.md",
    workspaceFiles: [],
    baseTools: ["read"],
    customTools: ["submit_result"],
    mcpAccess: "none",
    maxTurns: 10,
    maxTokens: 100000,
    ...overrides,
  };
}

function makeRunner(roleOverrides?: Partial<RoleConfig>) {
  const tmpDir = makeTmpDir();
  const config = makeSubagentConfig({
    logDir: tmpDir,
    roles: { scout: makeScoutRole(roleOverrides) },
  });

  return new SubagentRunner({
    config,
    workspaceDir: tmpDir,
    defaultModel: "custom-anthropic/claude-sonnet-4-6",
    defaultThinkingLevel: "none" as any,
    getApiKey: async () => "test-key",
    annotations: TOOL_ANNOTATIONS,
    mcpManager: {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    } as any,
    memoryManager: { search: vi.fn().mockResolvedValue([]) } as any,
    modelRegistry: { find: vi.fn().mockReturnValue({ id: "mock-model", provider: "mock-provider", api: "anthropic-messages" }) } as any,
  });
}

let SubagentRunner: typeof import("../src/subagent/runner.js").SubagentRunner;

beforeEach(async () => {
  lastSessionOpts = null;
  promptCallCount = 0;
  mockTokenUsage = { tokens: 0, contextWindow: 200000 };
  mockPromptError = null;
  mockPromptDelay = 0;
  subscriberListeners = [];
  promptHook = null;

  const mod = await import("../src/subagent/runner.js");
  SubagentRunner = mod.SubagentRunner;
});

// ============================================================
// BUG 3 (#10): submit_result continuation — BEHAVIORAL
// ============================================================

describe("BUG 3 (#10): submit_result must stop the turn loop", () => {
  it("runner stops prompting after submit_result is called", async () => {
    // On the first prompt() call, simulate the model calling submit_result
    promptHook = async () => {
      const submitTool = lastSessionOpts?.customTools?.find(
        (t: any) => t.name === "submit_result",
      );
      if (submitTool && promptCallCount === 1) {
        await submitTool.execute("tc_submit", {
          status: "completed",
          findings: ["done"],
          warnings: [],
          dataPaths: [],
        });
      }
    };

    const runner = makeRunner({ maxTurns: 10 });
    const result = await runner.run({
      role: "scout",
      task: "submit immediately",
      toolCallId: "tc_bug3",
    });

    // Critical: must stop after 1 prompt, not continue to maxTurns=10
    expect(promptCallCount).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.findings).toEqual(["done"]);
  });
});

// ============================================================
// BUG 4 (#6): Subagent listener leaks — STRUCTURAL + BEHAVIORAL
// ============================================================

describe("BUG 4 (#6): Subagent listener leaks — must cleanup on all exit paths", () => {
  // Structural: subscribe return value must be captured
  it("runner.ts must capture the subscribe() return value in a variable", () => {
    const src = srcFile("subagent/runner.ts");
    // The fix pattern: `const unsub = session.subscribe(...)` or similar
    const captured = /(?:const|let)\s+\w+\s*=\s*session\.subscribe\(/.test(src);
    expect(captured).toBe(true);
  });

  // Structural: unsubscribe or dispose must be called somewhere
  it("runner.ts must call unsubscribe() or session.dispose() on exit paths", () => {
    const src = srcFile("subagent/runner.ts");
    const hasCleanup =
      /\bunsub(?:scribe)?\s*\(\)/.test(src) ||
      /session\.dispose\(\)/.test(src);
    expect(hasCleanup).toBe(true);
  });

  // Behavioral: after normal run, subscriber list should be empty
  it("subscriber listener is removed after normal run completion", async () => {
    const runner = makeRunner({ maxTurns: 1 });
    await runner.run({
      role: "scout",
      task: "normal run",
      toolCallId: "tc_bug4_normal",
    });

    // If unsubscribe was called, our mock splices the listener out
    expect(subscriberListeners.length).toBe(0);
  });

  // Behavioral: after error, subscriber list should be empty
  it("subscriber listener is removed after error exit", async () => {
    mockPromptError = new Error("boom");
    const runner = makeRunner({ maxTurns: 5 });
    await runner.run({
      role: "scout",
      task: "error run",
      toolCallId: "tc_bug4_error",
    });

    expect(subscriberListeners.length).toBe(0);
  });
});
