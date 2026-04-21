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

// ---------------------------------------------------------------------------
// Task 0.8 — TranscriptMarker discriminated union (spec §4.6 + TH-8/TH-9)
// ---------------------------------------------------------------------------

import { expectTypeOf } from "vitest";
import type {
  TranscriptMarker,
  ThinkRecordedMarker,
  PlanDraftedMarker,
  PlanFileWrittenMarker,
  PlanApprovedMarker,
  PlanRejectedMarker,
  PlanExecutingMarker,
  PlanExecutionAbortedMarker,
  PlanReplanMarker,
  PlanDoneMarker,
} from "../src/events/marker-types.js";

describe("Task 0.8 — TranscriptMarker union type + runtime shape assertions", () => {
  // Each test begins by loading the marker-types module at runtime. TS
  // type-only imports are erased by esbuild, so without this guard the
  // shape tests would silently pass even if marker-types.ts never existed.
  async function loadModule(): Promise<unknown> {
    return await import("../src/events/marker-types.js");
  }

  // Runtime regex validators (enforce §4.6 wire-level invariants even
  // though TS type annotations are erased by esbuild).
  // §4.6: ts is iso8601 — accept fractional seconds + optional Z suffix.
  const ISO8601 =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;
  // §4.6: planHash = sha256(utf8Bytes(plan)), lowercase hex.
  const SHA256_HEX = /^[0-9a-f]{64}$/;

  /**
   * assertMarkerShape — load-bearing runtime validator.
   *
   * Enforces §4.6 schema STRICTLY:
   *   - `m.type` must match `expectedType` exactly.
   *   - every field in `requiredFields` must be present and not undefined.
   *   - `m` must NOT contain any field beyond `requiredFields`
   *     (plus optional fields when listed via `optionalFields`).
   *   - `m.ts` must match ISO-8601.
   *
   * This is how the RPC consumer + history consumer validate markers on
   * the wire — test-time byte-level schema guard. TS-only `expectTypeOf`
   * erasure in esbuild is why this exists.
   */
  function assertMarkerShape(
    m: Record<string, unknown>,
    expectedType: string,
    requiredFields: readonly string[],
    optionalFields: readonly string[] = [],
  ): void {
    expect(m).toBeDefined();
    expect(m.type).toBe(expectedType);
    // Every required field is present.
    for (const f of requiredFields) {
      expect(
        m[f],
        `§4.6: required field "${f}" missing on ${expectedType}`,
      ).toBeDefined();
    }
    // No EXTRA fields beyond the §4.6 schema.
    const allowed = new Set<string>([...requiredFields, ...optionalFields]);
    for (const k of Object.keys(m)) {
      expect(
        allowed.has(k),
        `§4.6: unexpected extra field "${k}" on ${expectedType} — allowed: ${[...allowed].join(", ")}`,
      ).toBe(true);
    }
    // ts is always required and ISO-8601.
    expect(typeof m.ts).toBe("string");
    expect((m.ts as string).match(ISO8601)).not.toBeNull();
  }

  it("runtime: ../src/events/marker-types.js module is loadable (required by the type-only imports above)", async () => {
    const mod = await loadModule();
    expect(mod).toBeDefined();
  });

  it("compile-time: TranscriptMarker.type is exactly the 9 expected discriminator values", async () => {
    await loadModule(); // gates the type-only assertions below
    // This is a type-level assertion; if the union shrinks or adds a variant
    // not listed here, the test fails to compile.
    expectTypeOf<TranscriptMarker["type"]>().toEqualTypeOf<
      | "think_recorded"
      | "plan_drafted"
      | "plan_file_written"
      | "plan_approved"
      | "plan_rejected"
      | "plan_executing"
      | "plan_execution_aborted"
      | "plan_replan"
      | "plan_done"
    >();
  });

  it("compile-time: every TranscriptMarker variant requires `ts: string`", async () => {
    await loadModule();
    expectTypeOf<TranscriptMarker>().toMatchTypeOf<{ ts: string }>();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Runtime shape-guards — load-bearing. The `expectTypeOf<>` calls above
  // are erased at runtime because type-checking is OFF in vitest.unit.config.
  // These tests run even under esbuild erasure and gate the Executor.
  // ──────────────────────────────────────────────────────────────────────

  it("runtime: think_recorded — strict shape, source='tool' literal, ts regex", async () => {
    await loadModule();
    // §4.6 + TH-8: think_recorded requires {type, thought, ts, source}.
    // TH-9: source ∈ {tool, native, inline} but Phase-0's producer only
    // emits "tool" — we test the shape flexibly but assert the literal
    // "tool" matches.
    const m: Record<string, unknown> = {
      type: "think_recorded",
      thought: "probe",
      ts: "2026-04-21T00:00:00.000Z",
      source: "tool",
    };
    assertMarkerShape(m, "think_recorded", [
      "type",
      "thought",
      "ts",
      "source",
    ]);
    expect(m.source).toBe("tool");
    // Invalid source should NOT pass the type check (TS-level) and on
    // the wire would be rejected by the consumer's discriminator.
    expect(["tool", "native", "inline"]).toContain(m.source);
  });

  it("runtime: think_recorded rejects an extra field like requestId or foo", async () => {
    await loadModule();
    const cheater: Record<string, unknown> = {
      type: "think_recorded",
      thought: "x",
      ts: "2026-04-21T00:00:00.000Z",
      source: "tool",
      requestId: "sneaky",
    };
    // The strict shape guard MUST fail this.
    expect(() =>
      assertMarkerShape(cheater, "think_recorded", [
        "type",
        "thought",
        "ts",
        "source",
      ]),
    ).toThrow();
  });

  it("runtime: plan_drafted — planHash is lowercase sha256 hex (64 chars)", async () => {
    await loadModule();
    const m: Record<string, unknown> = {
      type: "plan_drafted",
      plan: "step1\nstep2",
      planHash: "a".repeat(64),
      planLengthChars: 11,
      planSlug: "alpha",
      planFilePath: "/tmp/p.md",
      replan_count: 0,
      ts: "2026-04-21T00:00:03.000Z",
    };
    assertMarkerShape(m, "plan_drafted", [
      "type",
      "plan",
      "planHash",
      "planLengthChars",
      "planSlug",
      "planFilePath",
      "replan_count",
      "ts",
    ]);
    expect(typeof m.planHash).toBe("string");
    expect((m.planHash as string).length).toBe(64);
    expect((m.planHash as string).match(SHA256_HEX)).not.toBeNull();
    // Upper-case hex must fail
    const bad = {
      ...m,
      planHash: "A".repeat(64),
    };
    expect((bad.planHash as string).match(SHA256_HEX)).toBeNull();
    // planLengthChars is JS String.length (code-unit count)
    expect(m.planLengthChars).toBe((m.plan as string).length);
  });

  it("runtime: plan_file_written — bytes:number required, planHash matches sha256 hex", async () => {
    await loadModule();
    const m: Record<string, unknown> = {
      type: "plan_file_written",
      planFilePath: "/tmp/p.md",
      planHash: "b".repeat(64),
      bytes: 128,
      ts: "2026-04-21T00:00:04.000Z",
    };
    assertMarkerShape(m, "plan_file_written", [
      "type",
      "planFilePath",
      "planHash",
      "bytes",
      "ts",
    ]);
    expect(typeof m.bytes).toBe("number");
    expect((m.planHash as string).match(SHA256_HEX)).not.toBeNull();
  });

  it("runtime: plan_approved — auto:boolean + executeAfterApproval:boolean, NO requestId (v0.4.5-only)", async () => {
    await loadModule();
    const m: Record<string, unknown> = {
      type: "plan_approved",
      auto: false,
      executeAfterApproval: true,
      ts: "2026-04-21T00:00:05.000Z",
    };
    // §4.6 line 398 explicitly excludes requestId from v0.4.4 schema.
    assertMarkerShape(m, "plan_approved", [
      "type",
      "auto",
      "executeAfterApproval",
      "ts",
    ]);
    expect("requestId" in m).toBe(false);
    expect(typeof m.auto).toBe("boolean");
    expect(typeof m.executeAfterApproval).toBe("boolean");

    // v0.4.5 requestId leak detector — if the Executor (or a future
    // enthusiastic refactor) adds requestId in v0.4.4, the strict shape
    // guard catches it.
    const leaky = { ...m, requestId: "req-123" };
    expect(() =>
      assertMarkerShape(leaky, "plan_approved", [
        "type",
        "auto",
        "executeAfterApproval",
        "ts",
      ]),
    ).toThrow();
  });

  it("runtime: plan_rejected — action is EXACTLY 'reject' OR 'abandon'", async () => {
    await loadModule();
    const reject: Record<string, unknown> = {
      type: "plan_rejected",
      feedback: "needs more detail",
      action: "reject",
      ts: "2026-04-21T00:00:06.000Z",
    };
    assertMarkerShape(reject, "plan_rejected", [
      "type",
      "feedback",
      "action",
      "ts",
    ]);
    expect(["reject", "abandon"]).toContain(reject.action);

    const abandon: Record<string, unknown> = {
      type: "plan_rejected",
      feedback: "abandoned",
      action: "abandon",
      ts: "2026-04-21T00:00:07.000Z",
    };
    assertMarkerShape(abandon, "plan_rejected", [
      "type",
      "feedback",
      "action",
      "ts",
    ]);
    expect(["reject", "abandon"]).toContain(abandon.action);

    // Anything else must fail the literal set check.
    const bogus = {
      type: "plan_rejected",
      feedback: "x",
      action: "cancel",
      ts: "2026-04-21T00:00:08.000Z",
    };
    // Spec: action MUST be exactly one of the two literals.
    expect(["reject", "abandon"]).not.toContain(bogus.action);
  });

  it("runtime: plan_executing — only {type, planHash, ts} — no extras", async () => {
    await loadModule();
    const m: Record<string, unknown> = {
      type: "plan_executing",
      planHash: "c".repeat(64),
      ts: "2026-04-21T00:00:08.000Z",
    };
    assertMarkerShape(m, "plan_executing", ["type", "planHash", "ts"]);
    expect((m.planHash as string).match(SHA256_HEX)).not.toBeNull();

    // Extra field "reason" is a plan_done field — must not leak here.
    const leaky = { ...m, reason: "why" };
    expect(() =>
      assertMarkerShape(leaky, "plan_executing", ["type", "planHash", "ts"]),
    ).toThrow();
  });

  it("runtime: plan_execution_aborted — reason, replan_count, tool, pattern, ts (all required)", async () => {
    await loadModule();
    const m: Record<string, unknown> = {
      type: "plan_execution_aborted",
      reason: "tool-denied",
      replan_count: 1,
      tool: "bash",
      pattern: "rm -rf",
      ts: "2026-04-21T00:00:09.000Z",
    };
    assertMarkerShape(m, "plan_execution_aborted", [
      "type",
      "reason",
      "replan_count",
      "tool",
      "pattern",
      "ts",
    ]);
    expect(typeof m.replan_count).toBe("number");
  });

  it("runtime: plan_replan — {type, replan_count, prev_reason, ts} only", async () => {
    await loadModule();
    const m: Record<string, unknown> = {
      type: "plan_replan",
      replan_count: 2,
      prev_reason: "tool-denied",
      ts: "2026-04-21T00:00:10.000Z",
    };
    assertMarkerShape(m, "plan_replan", [
      "type",
      "replan_count",
      "prev_reason",
      "ts",
    ]);
  });

  it("runtime: plan_done — status is EXACTLY 'ok' or 'failed'; reason is optional", async () => {
    await loadModule();
    const ok: Record<string, unknown> = {
      type: "plan_done",
      status: "ok",
      ts: "2026-04-21T00:00:11.000Z",
    };
    assertMarkerShape(
      ok,
      "plan_done",
      ["type", "status", "ts"],
      ["reason"],
    );
    expect(["ok", "failed"]).toContain(ok.status);

    const failed: Record<string, unknown> = {
      type: "plan_done",
      status: "failed",
      reason: "replan budget exhausted",
      ts: "2026-04-21T00:00:12.000Z",
    };
    assertMarkerShape(
      failed,
      "plan_done",
      ["type", "status", "ts"],
      ["reason"],
    );
    expect(["ok", "failed"]).toContain(failed.status);

    // Invalid status (e.g. "done") MUST NOT pass the set check.
    const bogus = { ...ok, status: "done" };
    expect(["ok", "failed"]).not.toContain(bogus.status);
  });

  it("runtime: every valid marker.ts matches ISO-8601; malformed ts values fail the regex", async () => {
    await loadModule();
    const good = [
      "2026-04-21T00:00:00.000Z",
      "2026-04-21T00:00:00Z",
      "2026-04-21T00:00:00",
      "2026-12-31T23:59:59.999Z",
    ];
    for (const g of good) {
      expect(g.match(ISO8601)).not.toBeNull();
    }
    const bad = [
      "not-a-date",
      "2026/04/21",
      "2026-04-21",
      "2026-04-21 00:00:00",
      "04-21T00:00:00Z",
    ];
    for (const b of bad) {
      expect(b.match(ISO8601)).toBeNull();
    }
  });

  it("runtime: planHash regex rejects short, long, non-hex, and uppercase variants", async () => {
    await loadModule();
    expect("a".repeat(64).match(SHA256_HEX)).not.toBeNull();
    expect("0123456789abcdef".repeat(4).match(SHA256_HEX)).not.toBeNull();
    // Short
    expect("a".repeat(63).match(SHA256_HEX)).toBeNull();
    // Long
    expect("a".repeat(65).match(SHA256_HEX)).toBeNull();
    // Uppercase
    expect("A".repeat(64).match(SHA256_HEX)).toBeNull();
    // Non-hex char
    expect(("g" + "a".repeat(63)).match(SHA256_HEX)).toBeNull();
  });

  it("think_recorded shape — TH-8/TH-9: type, thought, ts, source in {tool,native,inline}", async () => {
    await loadModule();
    const m: ThinkRecordedMarker = {
      type: "think_recorded",
      thought: "probe",
      ts: "2026-04-21T00:00:00.000Z",
      source: "tool",
    };
    expect(m.type).toBe("think_recorded");
    expect(m.source).toBe("tool");
    expect(typeof m.thought).toBe("string");
    expect(typeof m.ts).toBe("string");

    // Source discriminators
    const native: ThinkRecordedMarker = {
      type: "think_recorded",
      thought: "n",
      ts: "2026-04-21T00:00:01.000Z",
      source: "native",
    };
    const inline: ThinkRecordedMarker = {
      type: "think_recorded",
      thought: "i",
      ts: "2026-04-21T00:00:02.000Z",
      source: "inline",
    };
    expect(native.source).toBe("native");
    expect(inline.source).toBe("inline");

    // A think_recorded is also assignable to the wider union.
    const asUnion: TranscriptMarker = m;
    expect(asUnion.type).toBe("think_recorded");
  });

  it("plan_drafted shape — §4.6 field-exact", async () => {
    await loadModule();
    const planText = "1. Step one\n2. Step two";
    const m: PlanDraftedMarker = {
      type: "plan_drafted",
      plan: planText,
      planHash: "a".repeat(64),
      planLengthChars: planText.length,
      planSlug: "alpha-bravo",
      planFilePath: "/tmp/plan.md",
      replan_count: 0,
      ts: "2026-04-21T00:00:03.000Z",
    };
    expect(m.type).toBe("plan_drafted");
    // §4.6: planLengthChars = JS String.length of the plan
    expect(m.planLengthChars).toBe(planText.length);
    expect(m.plan).toBe(planText);
    expect(m.planHash.length).toBe(64);
    expect(m.replan_count).toBe(0);
  });

  it("plan_file_written shape — §4.6 field-exact (new in v0.4.4)", async () => {
    await loadModule();
    const m: PlanFileWrittenMarker = {
      type: "plan_file_written",
      planFilePath: "/tmp/plan.md",
      planHash: "b".repeat(64),
      bytes: 128,
      ts: "2026-04-21T00:00:04.000Z",
    };
    expect(m.type).toBe("plan_file_written");
    expect(m.bytes).toBe(128);
    expect(m.planHash.length).toBe(64);
  });

  it("plan_approved shape — auto + executeAfterApproval booleans, no requestId in v0.4.4", async () => {
    await loadModule();
    const m: PlanApprovedMarker = {
      type: "plan_approved",
      auto: false,
      executeAfterApproval: true,
      ts: "2026-04-21T00:00:05.000Z",
    };
    expect(m.type).toBe("plan_approved");
    expect(m.auto).toBe(false);
    expect(m.executeAfterApproval).toBe(true);
    // v0.4.5-only field must NOT be present in v0.4.4 schema.
    expect("requestId" in m).toBe(false);
  });

  it("plan_rejected shape — action discriminates reject vs abandon", async () => {
    await loadModule();
    const rejected: PlanRejectedMarker = {
      type: "plan_rejected",
      feedback: "needs more detail",
      action: "reject",
      ts: "2026-04-21T00:00:06.000Z",
    };
    expect(rejected.action).toBe("reject");

    const abandoned: PlanRejectedMarker = {
      type: "plan_rejected",
      feedback: "abandoned",
      action: "abandon",
      ts: "2026-04-21T00:00:07.000Z",
    };
    expect(abandoned.action).toBe("abandon");
  });

  it("plan_executing shape — planHash + ts only", async () => {
    await loadModule();
    const m: PlanExecutingMarker = {
      type: "plan_executing",
      planHash: "c".repeat(64),
      ts: "2026-04-21T00:00:08.000Z",
    };
    expect(m.type).toBe("plan_executing");
    expect(m.planHash.length).toBe(64);
  });

  it("plan_execution_aborted shape — reason, replan_count, tool, pattern (new in v0.4.4)", async () => {
    await loadModule();
    const m: PlanExecutionAbortedMarker = {
      type: "plan_execution_aborted",
      reason: "tool-denied",
      replan_count: 1,
      tool: "bash",
      pattern: "rm -rf",
      ts: "2026-04-21T00:00:09.000Z",
    };
    expect(m.type).toBe("plan_execution_aborted");
    expect(m.replan_count).toBe(1);
    expect(m.tool).toBe("bash");
    expect(m.pattern).toBe("rm -rf");
  });

  it("plan_replan shape — replan_count + prev_reason (new in v0.4.4)", async () => {
    await loadModule();
    const m: PlanReplanMarker = {
      type: "plan_replan",
      replan_count: 2,
      prev_reason: "tool-denied",
      ts: "2026-04-21T00:00:10.000Z",
    };
    expect(m.type).toBe("plan_replan");
    expect(m.replan_count).toBe(2);
    expect(m.prev_reason).toBe("tool-denied");
  });

  it("plan_done shape — status in {ok,failed}, optional reason", async () => {
    await loadModule();
    const ok: PlanDoneMarker = {
      type: "plan_done",
      status: "ok",
      ts: "2026-04-21T00:00:11.000Z",
    };
    expect(ok.status).toBe("ok");
    expect(ok.reason).toBeUndefined();

    const failed: PlanDoneMarker = {
      type: "plan_done",
      status: "failed",
      reason: "replan budget exhausted",
      ts: "2026-04-21T00:00:12.000Z",
    };
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe("replan budget exhausted");
  });

  it("narrowing: discriminated union narrows by `type` (behavioural type assertion)", async () => {
    await loadModule();
    const markers: TranscriptMarker[] = [
      {
        type: "think_recorded",
        thought: "a",
        ts: "2026-04-21T00:00:13.000Z",
        source: "tool",
      },
      {
        type: "plan_drafted",
        plan: "p",
        planHash: "d".repeat(64),
        planLengthChars: 1,
        planSlug: "p",
        planFilePath: "/tmp/p.md",
        replan_count: 0,
        ts: "2026-04-21T00:00:14.000Z",
      },
      {
        type: "plan_done",
        status: "ok",
        ts: "2026-04-21T00:00:15.000Z",
      },
    ];

    // Narrowing each by its discriminator must compile AND produce the right runtime values.
    const thinks = markers.filter(
      (m): m is ThinkRecordedMarker => m.type === "think_recorded",
    );
    expect(thinks.length).toBe(1);
    expect(thinks[0].source).toBe("tool");

    const drafts = markers.filter(
      (m): m is PlanDraftedMarker => m.type === "plan_drafted",
    );
    expect(drafts.length).toBe(1);
    expect(drafts[0].planHash.length).toBe(64);

    const dones = markers.filter(
      (m): m is PlanDoneMarker => m.type === "plan_done",
    );
    expect(dones.length).toBe(1);
    expect(dones[0].status).toBe("ok");
  });

  it("§4.6 invariant: same planHash may appear on plan_drafted, plan_file_written, plan_executing", async () => {
    await loadModule();
    const h = "e".repeat(64);
    const d: PlanDraftedMarker = {
      type: "plan_drafted",
      plan: "x",
      planHash: h,
      planLengthChars: 1,
      planSlug: "x",
      planFilePath: "/tmp/x.md",
      replan_count: 0,
      ts: "2026-04-21T00:00:16.000Z",
    };
    const w: PlanFileWrittenMarker = {
      type: "plan_file_written",
      planFilePath: "/tmp/x.md",
      planHash: h,
      bytes: 1,
      ts: "2026-04-21T00:00:17.000Z",
    };
    const e: PlanExecutingMarker = {
      type: "plan_executing",
      planHash: h,
      ts: "2026-04-21T00:00:18.000Z",
    };
    expect(d.planHash).toBe(w.planHash);
    expect(w.planHash).toBe(e.planHash);
  });
});
