/**
 * Consolidated compaction tests.
 * Covers: CompactionConfig, tool result pruning, state extraction,
 * state loading, prompt loading, config integration, and /compact command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Helper to build a minimal AgentMessage sequence for pruner tests.
function makeToolCallSequence(
  toolName: string,
  resultText: string,
  toolUseId: string = `tu_${toolName}`,
): AgentMessage[] {
  return [
    { role: "user", content: "do something", timestamp: Date.now() } as AgentMessage,
    {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
    {
      role: "tool",
      tool_use_id: toolUseId,
      content: [{ type: "text", text: resultText }],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
    {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      timestamp: Date.now(),
    } as unknown as AgentMessage,
  ];
}

// ============================================================
// 1. CompactionConfig
// ============================================================

describe("CompactionConfig", () => {
  it("DEFAULT_COMPACTION_CONFIG has correct defaults", async () => {
    const { DEFAULT_COMPACTION_CONFIG } = await import("../src/compaction/index.js");
    expect(DEFAULT_COMPACTION_CONFIG.enabled).toBe(true);
    expect(DEFAULT_COMPACTION_CONFIG.autoThreshold).toBe(90);
    expect(DEFAULT_COMPACTION_CONFIG.warningThreshold).toBe(70);
    expect(DEFAULT_COMPACTION_CONFIG.toolResultPruning.keepRecentResults).toBe(3);
  });

  it("resolveCompactionConfig merges partial overrides", async () => {
    const { resolveCompactionConfig } = await import("../src/compaction/index.js");
    const resolved = resolveCompactionConfig({ autoThreshold: 80, toolResultPruning: { keepRecentResults: 5 } });
    expect(resolved.enabled).toBe(true);
    expect(resolved.autoThreshold).toBe(80);
    expect(resolved.toolResultPruning.keepRecentResults).toBe(5);
    expect(resolved.toolResultPruning.enabled).toBe(true);
  });
});

// ============================================================
// 2. Tool Result Pruner
// ============================================================

describe("createToolResultPruner", () => {
  it("disabled config returns identity", async () => {
    const { createToolResultPruner } = await import("../src/compaction/tool-result-pruner.js");
    const pruner = createToolResultPruner({ enabled: false, keepRecentResults: 3, minResultSizeBytes: 500, neverPruneTools: [] });
    const msgs = makeToolCallSequence("execute_script", "A".repeat(1000));
    expect(pruner(msgs)).toBe(msgs);
  });

  it("keeps last N results intact, prunes older ones", async () => {
    const { createToolResultPruner } = await import("../src/compaction/tool-result-pruner.js");
    const pruner = createToolResultPruner({ enabled: true, keepRecentResults: 3, minResultSizeBytes: 10, neverPruneTools: [] });
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 5; i++) msgs.push(...makeToolCallSequence(`tool_${i}`, "X".repeat(600), `tu_${i}`));
    const result = pruner(msgs);
    let prunedCount = 0;
    let keptToolResults = 0;
    for (const msg of result) {
      const m = msg as unknown as Record<string, unknown>;
      if (m.role === "tool") {
        const content = m.content as Array<{ type: string; text?: string }>;
        if (content?.[0]?.text?.startsWith("[Pruned:")) prunedCount++;
        else keptToolResults++;
      }
    }
    expect(prunedCount).toBe(2);
    expect(keptToolResults).toBe(3);
  });

  it("never prunes tools in neverPruneTools list", async () => {
    const { createToolResultPruner } = await import("../src/compaction/tool-result-pruner.js");
    const pruner = createToolResultPruner({ enabled: true, keepRecentResults: 0, minResultSizeBytes: 10, neverPruneTools: ["screenshot"] });
    const msgs = makeToolCallSequence("screenshot", "B".repeat(1000));
    const result = pruner(msgs);
    const content = (result[2] as unknown as Record<string, unknown>).content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("B".repeat(1000));
  });

  it("only prunes results > minResultSizeBytes", async () => {
    const { createToolResultPruner } = await import("../src/compaction/tool-result-pruner.js");
    const pruner = createToolResultPruner({ enabled: true, keepRecentResults: 0, minResultSizeBytes: 500, neverPruneTools: [] });
    const msgs = makeToolCallSequence("execute_script", "tiny");
    const content = (pruner(msgs)[2] as unknown as Record<string, unknown>).content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe("tiny");
  });
});

// ============================================================
// 3. State Extractor
// ============================================================

const EXTRACTOR_TEST_DIR = "/tmp/qlaybot_test_state_extractor";

describe("extractTag", () => {
  it("extracts content from valid tags and returns null for missing", async () => {
    const { extractTag } = await import("../src/compaction/state-extractor.js");
    expect(extractTag("<layout-state>Cell: TOP</layout-state>", "layout-state")).toBe("Cell: TOP");
    expect(extractTag("<layout-state>stuff</layout-state>", "design-rules")).toBeNull();
  });
});

describe("extractStateFiles", () => {
  beforeEach(() => { if (existsSync(EXTRACTOR_TEST_DIR)) rmSync(EXTRACTOR_TEST_DIR, { recursive: true }); mkdirSync(EXTRACTOR_TEST_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(EXTRACTOR_TEST_DIR)) rmSync(EXTRACTOR_TEST_DIR, { recursive: true }); });

  it("writes correct files from summary tags", async () => {
    const { extractStateFiles } = await import("../src/compaction/state-extractor.js");
    const summary = `<layout-state>Active cell: TOP\nLayers: 1/0</layout-state>\n<design-rules>Min spacing: 5um</design-rules>`;
    extractStateFiles(summary, EXTRACTOR_TEST_DIR);
    const compDir = join(EXTRACTOR_TEST_DIR, "compaction");
    expect(existsSync(compDir)).toBe(true);
    expect(readFileSync(join(compDir, "layout-state.md"), "utf-8")).toContain("Active cell: TOP");
    expect(readFileSync(join(compDir, "design-rules.md"), "utf-8")).toContain("Min spacing: 5um");
  });
});

// ============================================================
// 4. State Loader
// ============================================================

const LOADER_TEST_DIR = "/tmp/qlaybot_test_state_loader";

describe("loadStateBlock", () => {
  beforeEach(() => { if (existsSync(LOADER_TEST_DIR)) rmSync(LOADER_TEST_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(LOADER_TEST_DIR)) rmSync(LOADER_TEST_DIR, { recursive: true }); });

  it("returns null when no compaction directory exists", async () => {
    const { loadStateBlock } = await import("../src/compaction/state-loader.js");
    mkdirSync(LOADER_TEST_DIR, { recursive: true });
    expect(loadStateBlock(LOADER_TEST_DIR)).toBeNull();
  });

  it("builds correct block from existing state files", async () => {
    const { loadStateBlock } = await import("../src/compaction/state-loader.js");
    const compDir = join(LOADER_TEST_DIR, "compaction");
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, "layout-state.md"), "Cell: TOP\nLayers: 1/0, 2/0");
    const result = loadStateBlock(LOADER_TEST_DIR);
    expect(result).toContain("<compaction-state>");
    expect(result).toContain("Cell: TOP");
  });

  it("skips empty files", async () => {
    const { loadStateBlock } = await import("../src/compaction/state-loader.js");
    const compDir = join(LOADER_TEST_DIR, "compaction");
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, "layout-state.md"), "Real content");
    writeFileSync(join(compDir, "design-rules.md"), "");
    const result = loadStateBlock(LOADER_TEST_DIR);
    expect(result).toContain("Layout State");
    expect(result).not.toContain("Design Rules");
  });
});

// ============================================================
// 5. Prompt Loader
// ============================================================

const PROMPT_TEST_DIR = "/tmp/qlaybot_test_prompt_loader";

describe("loadCompactPrompt", () => {
  beforeEach(() => { if (existsSync(PROMPT_TEST_DIR)) rmSync(PROMPT_TEST_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(PROMPT_TEST_DIR)) rmSync(PROMPT_TEST_DIR, { recursive: true }); });

  it("reads COMPACT.md when it exists", async () => {
    const { loadCompactPrompt } = await import("../src/compaction/prompt-loader.js");
    const compDir = join(PROMPT_TEST_DIR, "compaction");
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, "COMPACT.md"), "Custom instructions.");
    expect(loadCompactPrompt(PROMPT_TEST_DIR)).toBe("Custom instructions.");
  });

  it("fallback contains KLayout-domain keywords", async () => {
    const { loadCompactPrompt } = await import("../src/compaction/prompt-loader.js");
    mkdirSync(PROMPT_TEST_DIR, { recursive: true });
    const result = loadCompactPrompt(PROMPT_TEST_DIR).toLowerCase();
    const terms = ["layout", "cell", "layer", "geometry", "gds", "design", "plan"];
    expect(terms.filter((t) => result.includes(t)).length).toBeGreaterThanOrEqual(3);
  });
});

describe("buildCompactInstructions", () => {
  beforeEach(() => { if (existsSync(PROMPT_TEST_DIR)) rmSync(PROMPT_TEST_DIR, { recursive: true }); mkdirSync(PROMPT_TEST_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(PROMPT_TEST_DIR)) rmSync(PROMPT_TEST_DIR, { recursive: true }); });

  it("composes base prompt + user instructions", async () => {
    const { buildCompactInstructions, DEFAULT_COMPACTION_CONFIG } = await import("../src/compaction/index.js");
    const result = buildCompactInstructions(PROMPT_TEST_DIR, DEFAULT_COMPACTION_CONFIG, "Focus on routing");
    expect(result).toContain("Focus on routing");
    expect(result.length).toBeGreaterThan("Focus on routing".length);
  });
});

// ============================================================
// 6. Re-exports
// ============================================================

describe("compaction index re-exports", () => {
  it("exports all expected symbols", async () => {
    const mod = await import("../src/compaction/index.js");
    expect(mod.DEFAULT_COMPACTION_CONFIG).toBeDefined();
    expect(typeof mod.resolveCompactionConfig).toBe("function");
    expect(typeof mod.createToolResultPruner).toBe("function");
    expect(typeof mod.extractTag).toBe("function");
    expect(typeof mod.extractStateFiles).toBe("function");
    expect(typeof mod.loadStateBlock).toBe("function");
    expect(typeof mod.createStateLoaderTransform).toBe("function");
    expect(typeof mod.loadCompactPrompt).toBe("function");
    expect(typeof mod.buildCompactInstructions).toBe("function");
  });
});
