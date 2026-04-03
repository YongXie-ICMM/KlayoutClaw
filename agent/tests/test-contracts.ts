/**
 * Contract verification tests for v0.4 cross-boundary types.
 *
 * Verifies every interface/type from v04-contracts.ts is importable,
 * constructable, and has the correct shape.
 */

import { describe, it, expect } from "vitest";
import type {
  KLayoutConfig,
  ToolAnnotation,
  FocusState,
  ConfigPanelTab,
  SubagentConfig,
  RoleConfig,
  SubagentResult,
  SubagentRunOptions,
  SubagentTUIEntry,
  SubagentSegment,
  ThinkingSegment,
  TextSegment,
  ToolCallSegment,
  InjectedSegment,
  SearchMode,
  SearchConfig,
  EmbeddingConfig,
  Embedder,
  RerankResult,
  ConfigPanelState,
  CommandResultStateChange,
  StartedEvent,
  ThinkingEvent,
  TextEvent,
  ToolStartEvent,
  ToolEndEvent,
} from "../src/types/v04-contracts.js";
import {
  makeConfig,
  makeKLayoutConfig,
  makeSubagentConfig,
  makeSearchConfig,
  makeEmbeddingConfig,
  makeTmpDir,
  writeConfigFiles,
} from "./helpers/config-builder.js";
import { stripAnsi, pressKey } from "./helpers/ink-helpers.js";

describe("v04-contracts: type existence and shape", () => {
  it("KLayoutConfig has all required fields", () => {
    const cfg: KLayoutConfig = {
      url: "http://127.0.0.1:8765/mcp",
      required: true,
      autoLaunch: true,
      disabledTools: ["tool1"],
    };
    expect(cfg.url).toBe("http://127.0.0.1:8765/mcp");
    expect(cfg.required).toBe(true);
    expect(cfg.autoLaunch).toBe(true);
    expect(cfg.disabledTools).toEqual(["tool1"]);
  });

  it("ToolAnnotation has name and optional flags", () => {
    const ann: ToolAnnotation = { name: "screenshot", readonly: true };
    expect(ann.name).toBe("screenshot");
    expect(ann.readonly).toBe(true);
    expect(ann.readwrite).toBeUndefined();
    expect(ann.backgroundable).toBeUndefined();

    const ann2: ToolAnnotation = {
      name: "auto_route",
      readwrite: true,
      backgroundable: true,
    };
    expect(ann2.backgroundable).toBe(true);
  });

  it("FocusState has exactly 9 values", () => {
    const allStates: FocusState[] = [
      "input",
      "completion",
      "bar-select",
      "config-panel",
      "workspace-bar",
      "background-bar",
      "subagent-summary",
      "subagent-inspect",
      "subagent-inject",
    ];
    expect(allStates).toHaveLength(9);
    // Each value is assignable
    for (const s of allStates) {
      const _check: FocusState = s;
      expect(typeof _check).toBe("string");
    }
  });

  it("ConfigPanelTab has exactly 3 values", () => {
    const allTabs: ConfigPanelTab[] = ["settings", "models", "mcp"];
    expect(allTabs).toHaveLength(3);
  });

  it("SubagentConfig has all required fields", () => {
    const cfg: SubagentConfig = {
      enabled: true,
      logDir: "/tmp/logs",
      maxLogFiles: 100,
      roles: {},
    };
    expect(cfg.enabled).toBe(true);
    expect(cfg.logDir).toBe("/tmp/logs");
    expect(cfg.maxLogFiles).toBe(100);
    expect(cfg.roles).toEqual({});
  });

  it("RoleConfig has all required fields and optional model/thinkingLevel", () => {
    const role: RoleConfig = {
      label: "Scout",
      promptFile: "subagent/scout.md",
      workspaceFiles: ["TOOLS.md"],
      baseTools: ["read"],
      customTools: ["memory_search", "submit_result"],
      mcpAccess: "shared-readonly",
      maxTurns: 100,
      maxTokens: 200000,
    };
    expect(role.label).toBe("Scout");
    expect(role.mcpAccess).toBe("shared-readonly");
    expect(role.model).toBeUndefined();
    expect(role.thinkingLevel).toBeUndefined();

    const roleWithOverrides: RoleConfig = {
      ...role,
      model: "custom-anthropic/claude-haiku-4-5-20251001",
      thinkingLevel: "low",
    };
    expect(roleWithOverrides.model).toBe(
      "custom-anthropic/claude-haiku-4-5-20251001",
    );
  });

  it("SubagentResult has all required fields and optional errorMessage", () => {
    const result: SubagentResult = {
      role: "scout",
      task: "inspect layers",
      status: "completed",
      findings: ["found 3 layers"],
      warnings: [],
      dataPaths: ["/tmp/out.gds"],
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        turns: 5,
      },
      transcriptPath: "/tmp/transcript.md",
    };
    expect(result.status).toBe("completed");
    expect(result.errorMessage).toBeUndefined();

    const errResult: SubagentResult = {
      ...result,
      status: "error",
      errorMessage: "Budget exceeded",
    };
    expect(errResult.errorMessage).toBe("Budget exceeded");
  });

  it("SubagentRunOptions has role, task, and optional context", () => {
    const opts: SubagentRunOptions = {
      role: "scout",
      task: "find markers",
    };
    expect(opts.role).toBe("scout");
    expect(opts.context).toBeUndefined();

    const optsCtx: SubagentRunOptions = {
      ...opts,
      context: "Layer 5/0 contains alignment markers",
    };
    expect(optsCtx.context).toBe("Layer 5/0 contains alignment markers");
  });

  it("SubagentTUIEntry has all required fields", () => {
    const entry: SubagentTUIEntry = {
      id: "scout-1711648200000",
      toolCallId: "tc_123",
      role: "scout",
      task: "inspect layout",
      status: "running",
      startTime: Date.now(),
      segments: [],
    };
    expect(entry.id).toBe("scout-1711648200000");
    expect(entry.status).toBe("running");
    expect(entry.endTime).toBeUndefined();
    expect(entry.tokenUsage).toBeUndefined();
    expect(entry.currentTool).toBeUndefined();
    expect(entry.findings).toBeUndefined();
    expect(entry.warnings).toBeUndefined();
    expect(entry.errorMessage).toBeUndefined();
  });

  it("SubagentSegment is a 4-member union", () => {
    const thinking: ThinkingSegment = { type: "thinking", text: "hmm" };
    const text: TextSegment = { type: "text", text: "hello" };
    const tool: ToolCallSegment = {
      type: "tool_call",
      toolName: "screenshot",
      args: "{}",
      status: "running",
    };
    const injected: InjectedSegment = { type: "injected", text: "user msg" };

    const segments: SubagentSegment[] = [thinking, text, tool, injected];
    expect(segments).toHaveLength(4);
    expect(segments[0].type).toBe("thinking");
    expect(segments[1].type).toBe("text");
    expect(segments[2].type).toBe("tool_call");
    expect(segments[3].type).toBe("injected");
  });

  it("SearchMode has exactly 4 values", () => {
    const allModes: SearchMode[] = [
      "fts5",
      "fts5+rerank",
      "fts5+vector+rerank",
      "vector+rerank",
    ];
    expect(allModes).toHaveLength(4);
  });

  it("SearchConfig has all required fields with correct types", () => {
    const cfg: SearchConfig = {
      mode: "fts5",
      minRerank: 4,
      rerankMinScore: 0.3,
      rerankMaxTokens: 256,
    };
    expect(cfg.mode).toBe("fts5");
    expect(typeof cfg.minRerank).toBe("number");
    expect(typeof cfg.rerankMinScore).toBe("number");
    expect(typeof cfg.rerankMaxTokens).toBe("number");
  });

  it("EmbeddingConfig has all required fields", () => {
    const cfg: EmbeddingConfig = {
      api: "openai-embeddings",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 1536,
      similarityThreshold: 0.3,
    };
    expect(cfg.api).toBe("openai-embeddings");
    expect(cfg.dimensions).toBe(1536);
  });

  it("Embedder interface shape is correct", () => {
    // Verify the interface can be implemented
    const embedder: Embedder = {
      embed: async (_text: string) => new Float32Array(1536),
      embedBatch: async (texts: string[]) =>
        texts.map(() => new Float32Array(1536)),
      dimensions: 1536,
    };
    expect(embedder.dimensions).toBe(1536);
    expect(typeof embedder.embed).toBe("function");
    expect(typeof embedder.embedBatch).toBe("function");
  });

  it("RerankResult has entryHash and score", () => {
    const r: RerankResult = { entryHash: "abc123", score: 0.85 };
    expect(r.entryHash).toBe("abc123");
    expect(r.score).toBe(0.85);
  });

  it("ConfigPanelState has all required fields", () => {
    const state: ConfigPanelState = {
      open: false,
      tab: "settings",
      editing: false,
      editValue: "",
      cursors: { settings: 0, models: 0, mcp: 0 },
      mcpDrilldown: {
        level: "servers",
        selectedServer: null,
        toolIndex: 0,
      },
    };
    expect(state.open).toBe(false);
    expect(state.cursors.settings).toBe(0);
    expect(state.mcpDrilldown.level).toBe("servers");
  });

  it("CommandResultStateChange extends with configPanel", () => {
    const change: CommandResultStateChange = {
      planMode: true,
      showThinking: false,
      configPanel: { open: true, tab: "models" },
    };
    expect(change.configPanel?.open).toBe(true);
    expect(change.configPanel?.tab).toBe("models");

    // All fields are optional
    const empty: CommandResultStateChange = {};
    expect(empty.planMode).toBeUndefined();
  });

  it("RunnerEventPayloads have correct shapes", () => {
    const started: StartedEvent = {
      subagentId: "scout-123",
      toolCallId: "tc_456",
      role: "scout",
      task: "inspect",
    };
    expect(started.subagentId).toBe("scout-123");

    const thinking: ThinkingEvent = {
      subagentId: "scout-123",
      text: "I need to check...",
    };
    expect(thinking.text).toBe("I need to check...");

    const text: TextEvent = {
      subagentId: "scout-123",
      text: "Found 3 layers",
    };
    expect(text.text).toBe("Found 3 layers");

    const toolStart: ToolStartEvent = {
      subagentId: "scout-123",
      toolName: "screenshot",
      args: "{}",
    };
    expect(toolStart.toolName).toBe("screenshot");

    const toolEnd: ToolEndEvent = {
      subagentId: "scout-123",
      toolName: "screenshot",
      result: "captured.png",
    };
    expect(toolEnd.result).toBe("captured.png");
  });
});

describe("config-builder helpers", () => {
  it("makeConfig returns full config with v0.4 fields", () => {
    const cfg = makeConfig();
    expect(cfg.agent.defaultModel).toBe("custom-anthropic/claude-sonnet-4-6");
    expect(cfg.klayout.url).toBe("http://127.0.0.1:8765/mcp");
    expect(cfg.subagent.enabled).toBe(true);
    expect(cfg.search.mode).toBe("fts5");
    expect(cfg.embedding.api).toBe("openai-embeddings");
  });

  it("makeConfig accepts overrides", () => {
    const cfg = makeConfig({
      klayout: { autoLaunch: false },
      search: { mode: "fts5+rerank" },
    });
    expect(cfg.klayout.autoLaunch).toBe(false);
    expect(cfg.search.mode).toBe("fts5+rerank");
  });

  it("makeKLayoutConfig returns correct defaults", () => {
    const cfg = makeKLayoutConfig();
    expect(cfg.url).toBe("http://127.0.0.1:8765/mcp");
    expect(cfg.required).toBe(true);
    expect(cfg.autoLaunch).toBe(true);
    expect(cfg.disabledTools).toEqual([]);
  });

  it("makeSubagentConfig returns correct defaults", () => {
    const cfg = makeSubagentConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxLogFiles).toBe(100);
    expect(cfg.roles).toEqual({});
  });

  it("makeSearchConfig returns correct defaults", () => {
    const cfg = makeSearchConfig();
    expect(cfg.mode).toBe("fts5");
    expect(cfg.minRerank).toBe(4);
    expect(cfg.rerankMinScore).toBe(0.3);
    expect(cfg.rerankMaxTokens).toBe(256);
  });

  it("makeTmpDir creates and auto-cleans directory", () => {
    const dir = makeTmpDir();
    expect(typeof dir).toBe("string");
    expect(dir.includes("qlaybot-test-")).toBe(true);
    // Cleanup happens in afterEach
  });

  it("writeConfigFiles writes all 4 config files", async () => {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const dir = makeTmpDir();
    const cfg = makeConfig();
    writeConfigFiles(dir, cfg);

    expect(existsSync(join(dir, "config", "model.json"))).toBe(true);
    expect(existsSync(join(dir, "config", "klayout.json"))).toBe(true);
    expect(existsSync(join(dir, "config", "mcp.json"))).toBe(true);
    expect(existsSync(join(dir, "config", "settings.json"))).toBe(true);
  });
});

describe("ink-helpers", () => {
  it("stripAnsi removes ANSI escape codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("no codes")).toBe("no codes");
    expect(stripAnsi("\x1b[1m\x1b[32mbold green\x1b[0m")).toBe("bold green");
  });

  it("pressKey maps named keys to sequences", () => {
    const written: string[] = [];
    const stdin = { write: (d: string) => written.push(d) };

    pressKey(stdin, "ctrl-s");
    pressKey(stdin, "tab");
    pressKey(stdin, "up");
    pressKey(stdin, "escape");
    pressKey(stdin, "enter");

    expect(written).toEqual(["\x13", "\t", "\x1b[A", "\x1b", "\r"]);
  });

  it("pressKey throws on unknown key", () => {
    const stdin = { write: () => {} };
    expect(() => pressKey(stdin, "unknown-key")).toThrow("Unknown key");
  });
});
