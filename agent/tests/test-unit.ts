/**
 * Consolidated unit tests for qlaybot agent.
 * Covers: config, prompts, base tools, commands, domain tools, memory, planning,
 * background tasks, MCP routing, TUI reducer, input hooks, auto-compact,
 * command history, markdown rendering, workspace, and app shortcuts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolve } from "path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// Mock getHistoryPath before importing history module
const TEST_HISTORY_DIR = join(tmpdir(), `qlaybot-test-history-${process.pid}`);
const TEST_HISTORY_PATH = join(TEST_HISTORY_DIR, "history.json");

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getHistoryPath: () => TEST_HISTORY_PATH,
  };
});

// ============================================================
// 1. Config
// ============================================================

import { loadConfig, parseModelRef, getQlayBotDir } from "../src/config.js";

describe("config", () => {
  it("returns default config with thinkingLevel=high", () => {
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.agent.thinkingLevel).toBe("medium");
  });

  it("parses model references correctly", () => {
    expect(parseModelRef("custom-anthropic/claude-sonnet-4-5")).toEqual({
      provider: "custom-anthropic",
      modelId: "claude-sonnet-4-5",
    });
    expect(parseModelRef("claude-sonnet-4-5")).toEqual({
      provider: "custom-anthropic",
      modelId: "claude-sonnet-4-5",
    });
  });

  it("uses ANTHROPIC_API_KEY env var", () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-123";
    const config = loadConfig(`/tmp/qlaybot-test-cfg-${Date.now()}`);
    const provider = Object.values(config.models.providers)[0];
    expect(provider.apiKey).toBe("test-key-123");
    if (originalKey) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("includes compaction config with correct defaults", () => {
    const config = loadConfig();
    expect(config.compaction.enabled).toBe(true);
    expect(config.compaction.autoThreshold).toBe(90);
    expect(config.compaction.warningThreshold).toBe(70);
    expect(config.compaction.toolResultPruning.enabled).toBe(true);
    expect(config.compaction.toolResultPruning.keepRecentResults).toBe(3);
  });
});

// ============================================================
// 2. Prompt building
// ============================================================

import { buildSystemPrompt, PromptMode } from "../src/prompts/index.js";

describe("prompt building", () => {
  it("builds system prompt with tool names", () => {
    const prompt = buildSystemPrompt({
      mode: PromptMode.Full,
      workspaceDir: `${process.cwd()}/workspace`,
      toolNames: ["read", "bash", "klayout_native_execute_script"],
      connectedServers: ["klayout"],
    });
    expect(prompt).toContain("klayout_native_execute_script");
    expect(prompt).toContain("Memory System");
  });

  it("skips memory section in Sub mode", () => {
    const prompt = buildSystemPrompt({
      mode: PromptMode.Sub,
      workspaceDir: `${process.cwd()}/workspace`,
      toolNames: ["read"],
      connectedServers: [],
    });
    expect(prompt).not.toContain("Memory System");
  });
});

// ============================================================
// 3. Base tools
// ============================================================

import { createBaseToolsOverride } from "../src/tools/index.js";

describe("base tools", () => {
  it("creates all 4 base tools", () => {
    const tools = createBaseToolsOverride(process.cwd());
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["read", "bash", "edit", "write"]),
    );
    for (const tool of Object.values(tools)) {
      expect(tool.name).toBeDefined();
      expect(tool.execute).toBeInstanceOf(Function);
    }
  });
});

// ============================================================
// 4. Commands
// ============================================================

import {
  CommandRegistry,
  parseCommand,
  createCommandRegistry,
  COMMAND_NAMES,
  type CommandContext,
  type CommandResult,
} from "../src/commands/index.js";

describe("parseCommand", () => {
  it("parses /model set sonnet", () => {
    expect(parseCommand("/model set sonnet")).toEqual({ name: "model", args: ["set", "sonnet"] });
  });

  it("returns null for non-slash input", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  it("returns null for empty slash", () => {
    expect(parseCommand("/")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(parseCommand("  /config show  ")).toEqual({ name: "config", args: ["show"] });
  });
});

describe("CommandRegistry", () => {
  it("registers and executes a command", async () => {
    const registry = new CommandRegistry();
    registry.register({
      name: "test",
      description: "test command",
      usage: "/test",
      execute: async () => ({ output: "ok", exitCode: 0 }),
    });
    expect(registry.has("test")).toBe(true);
    expect(registry.has("unknown")).toBe(false);
    const result = await registry.execute("test", [], {} as CommandContext);
    expect(result.output).toBe("ok");
  });

  it("returns error for unknown command", async () => {
    const registry = new CommandRegistry();
    const result = await registry.execute("unknown", [], {} as CommandContext);
    expect(result.output).toContain("Unknown command");
    expect(result.exitCode).toBe(1);
  });

  it("has all 9 commands registered (v0.4.3: /plan removed, handled by App.tsx slash intercept)", () => {
    // v0.4.3 Group 3 step 10 deleted `src/commands/plan.ts` and its
    // registration — the `/plan` slash is now intercepted by App.tsx
    // before the CommandRegistry (spec §1.8.1). COMMAND_NAMES therefore
    // does NOT contain "plan", and the registry does not register a
    // plan command.
    const registry = createCommandRegistry();
    expect(COMMAND_NAMES.length).toBe(9);
    expect(COMMAND_NAMES).not.toContain("plan");
    expect(registry.has("plan")).toBe(false);
    for (const name of COMMAND_NAMES) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("compact command has complete metadata", () => {
    const registry = createCommandRegistry();
    const handler = registry.get("compact");
    expect(handler).toBeDefined();
    expect(handler!.name).toBe("compact");
    expect(handler!.description.length).toBeGreaterThan(0);
    expect(handler!.usage).toMatch(/^\/compact/);
    expect(typeof handler!.execute).toBe("function");
  });
});

describe("CommandResult with sections (v0.3)", () => {
  it("accepts sections field", () => {
    const result: CommandResult = {
      output: "Context info",
      sections: [
        { title: "MCP Status", summary: "Connected" },
        { title: "Memory", summary: "42 entries", details: "Breakdown..." },
      ],
    };
    expect(result.sections!.length).toBe(2);
    expect(result.sections![0].title).toBe("MCP Status");
  });
});

// ============================================================
// 5. Domain tools
// ============================================================

import { registerAllDomainTools } from "../src/tools/klayout/index.js";
import { registerGeometryTools } from "../src/tools/klayout/geometry.js";
import { registerDisplayTools } from "../src/tools/klayout/display.js";
import { registerImageTools } from "../src/tools/klayout/image.js";
import { registerVisualTools } from "../src/tools/klayout/visual.js";
import { registerNanodeviceTools } from "../src/tools/klayout/nanodevice.js";

describe("domain tool schemas", () => {
  it("all tools have valid inputSchema and underscore names", () => {
    const tools = registerAllDomainTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^klayout_\w+_\w+$/);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.generateCode).toBeInstanceOf(Function);
      expect(tool.name).not.toContain(".");
    }
  });
});

describe("geometry tools", () => {
  it("registers 5 geometry tools", () => {
    const tools = registerGeometryTools();
    expect(tools.length).toBe(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("klayout_geometry_add_rect");
    expect(names).toContain("klayout_geometry_add_polygon");
    expect(names).toContain("klayout_geometry_add_path");
    expect(names).toContain("klayout_geometry_create_cell");
    expect(names).toContain("klayout_geometry_add_instance");
  });

  it("add_rect generates valid pya code", () => {
    const tools = registerGeometryTools();
    const addRect = tools.find((t) => t.name === "klayout_geometry_add_rect")!;
    const code = addRect.generateCode({
      cell: "TOP", layer: 1, datatype: 0, x1: 0, y1: 0, x2: 100, y2: 25,
    });
    expect(code).toContain('_layout.cell("TOP")');
    expect(code).toContain("pya.Box");
    expect(code).toContain("100/dbu");
  });

  it("add_polygon generates valid pya code", () => {
    const tools = registerGeometryTools();
    const addPoly = tools.find((t) => t.name === "klayout_geometry_add_polygon")!;
    const code = addPoly.generateCode({
      cell: "TOP", layer: 1, datatype: 0, points: [[0, 0], [100, 0], [50, 50]],
    });
    expect(code).toContain("pya.Polygon");
    expect(code).toContain("pya.Point");
  });

  it("create_cell generates valid pya code", () => {
    const tools = registerGeometryTools();
    const createCell = tools.find((t) => t.name === "klayout_geometry_create_cell")!;
    const code = createCell.generateCode({ name: "DEVICE" });
    expect(code).toContain('_layout.create_cell("DEVICE")');
  });
});

describe("display tools", () => {
  it("registers 2 display tools with valid code gen", () => {
    const tools = registerDisplayTools();
    expect(tools.length).toBe(2);
    const toggle = tools.find((t) => t.name === "klayout_display_toggle_layer")!;
    const code = toggle.generateCode({ layer: 1, datatype: 0, mode: "on" });
    expect(code).toContain("lp.visible");
  });
});

describe("image tools", () => {
  it("registers 3 image tools", () => {
    const tools = registerImageTools();
    expect(tools.length).toBe(3);
    expect(tools.map((t) => t.name)).toContain("klayout_image_add_image");
  });
});

describe("visual tools", () => {
  it("registers 1 visual tool", () => {
    const tools = registerVisualTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("klayout_visual_capture");
  });

  it("klayout_visual_capture returns an instruction-only workflow_plan", () => {
    const tools = registerVisualTools();
    const t = tools[0] as typeof tools[0] & { generateCode: (args: Record<string, unknown>) => string };
    const code = t.generateCode({
      filepath: "/tmp/test.png",
      dpi: 150,
      gds_path: "/tmp/test.gds",
    });
    // No JS literal leak (Q1 pyLiteral invariant)
    expect(code).not.toMatch(/\btrue\b|\bfalse\b|\bnull\b/);
    // Workflow_plan wrapper (T1 + T4 instruction-only convention)
    expect(code).toContain('"type": "workflow_plan"');
    // Two explicit steps: save layout + render PNG
    expect(code).toContain('"1_save_layout"');
    expect(code).toContain('"2_render_png"');
    // Filepath + dpi + gds_path interpolated through pyLiteral
    expect(code).toContain("/tmp/test.png");
    expect(code).toContain("/tmp/test.gds");
    expect(code).toContain("150");
    // Explicit distinction from klayout_native_screenshot
    expect(code).toContain("klayout_native_screenshot");
  });
});

describe("nanodevice tools", () => {
  it("registers all nanodevice tools (flakedetect + gdsalign + routing)", () => {
    const tools = registerNanodeviceTools();
    const names = tools.map((t) => t.name);
    // Flakedetect pipeline: 5 substeps
    expect(names).toContain("klayout_nanodevice_flakedetect_align");
    expect(names).toContain("klayout_nanodevice_flakedetect_detect");
    expect(names).toContain("klayout_nanodevice_flakedetect_combine");
    expect(names).toContain("klayout_nanodevice_flakedetect_commit");
    expect(names).toContain("klayout_nanodevice_flakedetect_review");
    // GDS alignment
    expect(names).toContain("klayout_nanodevice_gdsalign_align_to_gds");
    // Routing
    expect(names).toContain("klayout_nanodevice_routing_place_pads");
    expect(names).toContain("klayout_nanodevice_routing_route_leads");
    expect(names).toContain("klayout_nanodevice_routing_clear_routes");
    expect(tools.length).toBe(9);
  });

  it("gdsalign commit_gds command includes --warp, --traces, and --gds args", () => {
    const tools = registerNanodeviceTools();
    const gdsalignTool = tools.find((t) => t.name === "klayout_nanodevice_gdsalign_align_to_gds");
    expect(gdsalignTool).toBeDefined();
    const code = gdsalignTool!.generateCode({});
    // Parse the JSON from the instruction result
    const jsonStr = code.replace(/^result = /, "");
    const result = JSON.parse(jsonStr);
    const commitCmd = result.scripts["4_commit_gds"].command as string;
    // All 6 required args must be present in the command template
    expect(commitCmd).toContain("--warp");
    expect(commitCmd).toContain("--traces");
    expect(commitCmd).toContain("--gds");
    expect(commitCmd).toContain("--image");
    expect(commitCmd).toContain("--pixel-size");
    expect(commitCmd).toContain("--output-dir");
  });

  it("each tool returns instruction JSON with skill_doc reference", () => {
    const tools = registerNanodeviceTools();
    for (const tool of tools) {
      const code = tool.generateCode({});
      expect(code).toContain("result =");
      // All tools except clear_routes should reference a skill_doc
      if (tool.originalName !== "clear_routes") {
        expect(code).toContain("skill_doc");
        expect(code).toContain("SKILL.md");
      }
    }
  });
});

// ============================================================
// 6. Memory
// ============================================================

import { MemoryManager } from "../src/memory/index.js";
import { parseMemoryFile, formatEntry } from "../src/memory/parser.js";

const TEST_MEMORY_DIR = "/tmp/qlaybot_test_memory";

describe("memory entry parser", () => {
  it("parses timestamped entries with tags", () => {
    const content = `## 2026-03-26T14:30:00 | hallbar, routing
Dense fan-out needed path_safe_distance=8.

## 2026-03-26T15:00:00 | qubit, transmon
Transmon frequency at 5.2 GHz.
`;
    const entries = parseMemoryFile(content, "knowledge");
    expect(entries.length).toBe(2);
    expect(entries[0].tags).toEqual(["hallbar", "routing"]);
    expect(entries[0].content).toContain("path_safe_distance=8");
  });

  it("formats new entries correctly", () => {
    const entry = formatEntry("Test content", ["tag1", "tag2"]);
    expect(entry).toMatch(/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} \| tag1, tag2\nTest content\n$/);
  });
});

describe("MemoryManager", () => {
  beforeEach(() => {
    if (existsSync(TEST_MEMORY_DIR)) rmSync(TEST_MEMORY_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_MEMORY_DIR)) rmSync(TEST_MEMORY_DIR, { recursive: true });
  });

  it("saves and searches entries", () => {
    const mm = new MemoryManager(TEST_MEMORY_DIR);
    mm.save("knowledge", "Transmon frequency is 5.2 GHz", ["qubit", "transmon"]);
    mm.save("knowledge", "Graphene sheet resistance is 200 ohms", ["graphene"]);
    const results = mm.search("transmon frequency");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("5.2 GHz");
  });

  it("searches across categories", () => {
    const mm = new MemoryManager(TEST_MEMORY_DIR);
    mm.save("knowledge", "Layer 1/0 is mesa", ["layer"]);
    mm.save("procedures", "Always save after routing", ["workflow"]);
    const results = mm.search("layer mesa");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].category).toBe("knowledge");
  });

  it("returns empty results for no match", () => {
    const mm = new MemoryManager(TEST_MEMORY_DIR);
    mm.save("knowledge", "Some content", []);
    expect(mm.search("xyznonexistent")).toEqual([]);
  });

  it("respects limit parameter", () => {
    const mm = new MemoryManager(TEST_MEMORY_DIR);
    for (let i = 0; i < 10; i++) {
      mm.save("knowledge", `Entry ${i} about quantum devices`, ["quantum"]);
    }
    expect(mm.search("quantum", 3).length).toBeLessThanOrEqual(3);
  });

  it("clear removes all entries and returns count", () => {
    const mm = new MemoryManager(TEST_MEMORY_DIR);
    mm.save("knowledge", "Entry 1", ["tag1"]);
    mm.save("knowledge", "Entry 2", ["tag2"]);
    mm.save("knowledge", "Entry 3", ["tag3"]);
    expect(mm.clear("knowledge")).toBe(3);
    expect(mm.getCategory("knowledge").length).toBe(0);
  });
});

// ============================================================
// 7. Planning + Sandbox (legacy block — DELETED in v0.4.3 Group 3 step 11)
// ============================================================
//
// The 0.4.2 PlanManager shim API and the legacy sandbox allowlist
// helpers were removed from src/planning/ per spec §9 step 11; the
// tests that validated those shims were deleted alongside them. The
// qdevbot-parity replacement surface is now covered by:
//   • tests/test-plan-mode-v043.ts (PlanManager new API + symlink-safe
//     sandbox + annotation plan-mode gate + tool factories)
//   • tests/test-plan-mode-v043-group3.ts (TUI reducer + App.tsx slash
//     handler + exit menu + shim-removal regressions)

// ============================================================
// 8. Background tasks
// ============================================================

import { BackgroundTaskManager } from "../src/background/index.js";

describe("BackgroundTaskManager", () => {
  it("runs a task and completes", async () => {
    const btm = new BackgroundTaskManager();
    const id = btm.run("test-task", async () => "done");
    expect(id).toBe("1");
    expect(btm.status(id)!.status).toBe("running");
    await new Promise((r) => setTimeout(r, 50));
    const completed = btm.status(id)!;
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("done");
  });

  it("handles failed tasks", async () => {
    const btm = new BackgroundTaskManager();
    const id = btm.run("fail-task", async () => { throw new Error("test error"); });
    await new Promise((r) => setTimeout(r, 50));
    expect(btm.status(id)!.status).toBe("failed");
    expect(btm.status(id)!.error).toBe("test error");
  });

  it("lists all tasks", () => {
    const btm = new BackgroundTaskManager();
    btm.run("task-1", async () => "a");
    btm.run("task-2", async () => "b");
    expect(btm.list().length).toBe(2);
  });

  it("isBackgroundable checks allowlist", () => {
    const btm = new BackgroundTaskManager();
    expect(btm.isBackgroundable("klayout_native_auto_route")).toBe(true);
    expect(btm.isBackgroundable("bash")).toBe(false);
  });

  it("subscribe notifies on state changes and unsubscribe works", async () => {
    const btm = new BackgroundTaskManager();
    const events: Array<{ id: string; status: string }> = [];
    const unsub = btm.subscribe((task) => {
      events.push({ id: task.id, status: task.status });
    });
    const taskId = btm.run("test-task", () => Promise.resolve("done"));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].status).toBe("running");
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.status === "completed")).toBe(true);
    unsub();
    const countBefore = events.length;
    btm.run("ignored", () => Promise.resolve("ignored"));
    expect(events.length).toBe(countBefore);
  });

  it("cancel changes status to cancelled and notifies", async () => {
    const btm = new BackgroundTaskManager();
    const statuses: string[] = [];
    btm.subscribe((task) => statuses.push(task.status));
    const taskId = btm.run("long-task", () => new Promise(() => {}));
    btm.cancel(taskId);
    expect(statuses).toContain("cancelled");
    expect(btm.status(taskId)?.status).toBe("cancelled");
  });
});

// ============================================================
// 9. MCP routing
// ============================================================

import { MCPManager } from "../src/mcp/manager.js";

describe("MCP routing", () => {
  it("rejects unknown namespace", async () => {
    const manager = new MCPManager({ servers: {} });
    await expect(manager.callTool("unknown_tool", {})).rejects.toThrow();
  });

  it("rejects when KLayout not connected", async () => {
    const manager = new MCPManager({ servers: {} });
    await expect(
      manager.callTool("klayout_native_execute_script", { code: "1+1" }),
    ).rejects.toThrow("KLayout MCP not connected");
  });

  it("strips _mcp suffix from server keys", () => {
    const manager = new MCPManager({
      servers: { klayout_mcp: { url: "http://localhost:8765/mcp", required: true } },
    });
    expect(manager.isConnected("klayout")).toBe(false);
  });
});

// ============================================================
// 10. TUI Reducer
// ============================================================

import { tuiReducer, initialState } from "../src/tui/reducer.js";
import type {
  TUIState,
  TUIAction,
  ToolExecution,
  BackgroundTaskSummaryTUI,
  ContextSection,
  SystemMessageData,
} from "../src/tui/types.js";

describe("initialState v0.3 fields", () => {
  it("has correct initial values", () => {
    expect(initialState.isCompacting).toBe(false);
    expect(initialState.inPlanMode).toBe(false);
    expect(initialState.toolDetailExpanded).toBe(false);
    expect(initialState.thinkingExpanded).toBe(false);
    expect(initialState.backgroundTasks).toEqual([]);
    expect(initialState).toHaveProperty("backgroundTaskCount");
  });
});

describe("BG_TASK reducer actions", () => {
  it("BG_TASK_CREATED adds tasks", () => {
    const task: BackgroundTaskSummaryTUI = { id: "bg-1", name: "task", status: "running", startedAt: 1000 };
    const state = tuiReducer(initialState, { type: "BG_TASK_CREATED", task });
    expect(state.backgroundTasks.length).toBe(1);
    expect(state.backgroundTasks[0]).toEqual(task);
  });

  it("BG_TASK_COMPLETED updates status", () => {
    const task: BackgroundTaskSummaryTUI = { id: "bg-1", name: "task", status: "running", startedAt: 1000 };
    let state = tuiReducer(initialState, { type: "BG_TASK_CREATED", task });
    state = tuiReducer(state, { type: "BG_TASK_COMPLETED", taskId: "bg-1", completedAt: 5000 });
    expect(state.backgroundTasks[0].status).toBe("completed");
    expect(state.backgroundTasks[0].completedAt).toBe(5000);
  });

  it("BG_TASK_FAILED sets error", () => {
    const task: BackgroundTaskSummaryTUI = { id: "bg-1", name: "task", status: "running", startedAt: 1000 };
    let state = tuiReducer(initialState, { type: "BG_TASK_CREATED", task });
    state = tuiReducer(state, { type: "BG_TASK_FAILED", taskId: "bg-1", error: "out of memory" });
    expect(state.backgroundTasks[0].status).toBe("failed");
    expect(state.backgroundTasks[0].error).toBe("out of memory");
  });

  it("BG_TASK_CANCELLED updates status", () => {
    const task: BackgroundTaskSummaryTUI = { id: "bg-1", name: "task", status: "running", startedAt: 1000 };
    let state = tuiReducer(initialState, { type: "BG_TASK_CREATED", task });
    state = tuiReducer(state, { type: "BG_TASK_CANCELLED", taskId: "bg-1" });
    expect(state.backgroundTasks[0].status).toBe("cancelled");
  });

  it("nonexistent taskId returns state unchanged", () => {
    const task: BackgroundTaskSummaryTUI = { id: "bg-1", name: "task", status: "running", startedAt: 1000 };
    const state = tuiReducer(initialState, { type: "BG_TASK_CREATED", task });
    const result = tuiReducer(state, { type: "BG_TASK_COMPLETED", taskId: "bg-nonexistent", completedAt: 9999 });
    expect(result.backgroundTasks[0].status).toBe("running");
  });
});

describe("COMPACTION_START / COMPACTION_END", () => {
  it("toggles isCompacting", () => {
    let state = tuiReducer(initialState, { type: "COMPACTION_START" });
    expect(state.isCompacting).toBe(true);
    state = tuiReducer(state, { type: "COMPACTION_END" });
    expect(state.isCompacting).toBe(false);
  });

  it("does not affect phase", () => {
    const ready: TUIState = { ...initialState, phase: "ready" };
    const state = tuiReducer(ready, { type: "COMPACTION_START" });
    expect(state.phase).toBe("ready");
  });
});

describe("PLAN_MODE_ENTERED / PLAN_MODE_EXITED", () => {
  it("toggles inPlanMode", () => {
    let state = tuiReducer(initialState, { type: "PLAN_MODE_ENTERED" });
    expect(state.inPlanMode).toBe(true);
    state = tuiReducer(state, { type: "PLAN_MODE_EXITED" });
    expect(state.inPlanMode).toBe(false);
  });
});

describe("TOGGLE_DETAIL_VIEW", () => {
  it("flips both toolDetailExpanded and thinkingExpanded simultaneously", () => {
    const s1 = tuiReducer(initialState, { type: "TOGGLE_DETAIL_VIEW" });
    expect(s1.toolDetailExpanded).toBe(true);
    expect(s1.thinkingExpanded).toBe(true);
    const s2 = tuiReducer(s1, { type: "TOGGLE_DETAIL_VIEW" });
    expect(s2.toolDetailExpanded).toBe(false);
    expect(s2.thinkingExpanded).toBe(false);
  });

  it("does not affect isCompacting, inPlanMode, or backgroundTasks", () => {
    const task: BackgroundTaskSummaryTUI = { id: "bg-x", name: "test", status: "running", startedAt: 1000 };
    let state = tuiReducer(initialState, { type: "BG_TASK_CREATED", task });
    state = { ...state, isCompacting: true, inPlanMode: true };
    state = tuiReducer(state, { type: "TOGGLE_DETAIL_VIEW" });
    expect(state.isCompacting).toBe(true);
    expect(state.inPlanMode).toBe(true);
    expect(state.backgroundTasks.length).toBe(1);
  });
});

describe("SYSTEM_MESSAGE with sections", () => {
  it("stores sections on the system message", () => {
    const sections: ContextSection[] = [
      { title: "Overview", summary: "A brief overview" },
      { title: "Details", summary: "More info", details: "Full details here" },
    ];
    const state = tuiReducer(initialState, { type: "SYSTEM_MESSAGE", text: "System info", sections });
    const lastMsg = state.messages[state.messages.length - 1] as SystemMessageData;
    expect(lastMsg.sections).toEqual(sections);
  });
});

describe("COMMAND_RESULT with sections", () => {
  it("stores sections and handles planMode stateChange", () => {
    const sections: ContextSection[] = [{ title: "Config", summary: "Current configuration" }];
    const state = tuiReducer(initialState, { type: "COMMAND_RESULT", output: "Config displayed", sections });
    const lastMsg = state.messages[state.messages.length - 1] as SystemMessageData;
    expect(lastMsg.sections).toEqual(sections);

    const state2 = tuiReducer(initialState, {
      type: "COMMAND_RESULT", output: "Plan mode entered", stateChange: { planMode: true },
    });
    expect(state2.inPlanMode).toBe(true);
  });
});

describe("backward compatibility", () => {
  it("BACKGROUND_UPDATE still works", () => {
    const state = tuiReducer(initialState, { type: "BACKGROUND_UPDATE", taskCount: 3 });
    expect(state.backgroundTaskCount).toBe(3);
  });

  it("TOGGLE_THINKING_VIEW still flips showThinking", () => {
    const state = tuiReducer(initialState, { type: "TOGGLE_THINKING_VIEW" });
    expect(state.showThinking).toBe(true);
  });

  it("SESSION_READY preserves new state fields", () => {
    const state = tuiReducer(initialState, {
      type: "SESSION_READY", modelName: "claude-sonnet-4-6", thinkingLevel: "high",
    });
    expect(state.phase).toBe("ready");
    expect(state.isCompacting).toBe(false);
    expect(state.backgroundTasks).toEqual([]);
  });
});

describe("ToolExecution backgrounded status", () => {
  it("accepts backgrounded status (type-level validation)", () => {
    const tool: ToolExecution = {
      id: "tool-1", toolName: "auto_route", args: {}, status: "backgrounded",
      startTime: Date.now(), backgroundTaskId: "bg-42",
    };
    expect(tool.status).toBe("backgrounded");
    expect(tool.backgroundTaskId).toBe("bg-42");
  });
});

// ============================================================
// 11. Markdown rendering
// ============================================================

import { renderMarkdown } from "../src/tui/markdown.js";

describe("renderMarkdown", () => {
  it("returns empty string for empty/whitespace input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   ")).toBe("");
  });

  it("renders heading without raw ### markers", () => {
    const output = renderMarkdown("### My Heading\n\n#### Fourth Level");
    expect(output).not.toMatch(/#{3,}/);
    expect(output).toContain("My Heading");
    expect(output).toContain("Fourth Level");
  });

  it("replaces - bullets with bullet characters", () => {
    const output = renderMarkdown("- item one\n- item two");
    expect(output).toContain("\u2022");
  });

  it("renders code block with ANSI escape sequences", () => {
    const output = renderMarkdown("```python\ndef hello():\n    return 42\n```");
    expect(output).toMatch(/\x1b\[/);
    expect(output).toContain("def");
  });

  it("collapses 3+ consecutive newlines to 2", () => {
    const output = renderMarkdown("paragraph 1\n\n\n\nparagraph 2");
    expect(output).not.toMatch(/\n{3,}/);
  });
});

// ============================================================
// 12. Input buffer reducer
// ============================================================

import { bufferReducer, initialBufferState } from "../src/tui/hooks/useInputBuffer.js";

describe("bufferReducer", () => {
  it("INSERT adds character and advances cursor", () => {
    const s1 = bufferReducer(initialBufferState, { type: "INSERT", char: "a" });
    expect(s1.value).toBe("a");
    expect(s1.cursor).toBe(1);
  });

  it("INSERT in middle inserts at cursor position", () => {
    const result = bufferReducer({ value: "ac", cursor: 1 }, { type: "INSERT", char: "b" });
    expect(result.value).toBe("abc");
  });

  it("DELETE_BACK removes char before cursor", () => {
    const result = bufferReducer({ value: "abc", cursor: 3 }, { type: "DELETE_BACK" });
    expect(result.value).toBe("ab");
  });

  it("DELETE_BACK at position 0 is a no-op", () => {
    const result = bufferReducer({ value: "abc", cursor: 0 }, { type: "DELETE_BACK" });
    expect(result.value).toBe("abc");
  });

  it("DELETE_FORWARD removes char at cursor", () => {
    const result = bufferReducer({ value: "abc", cursor: 1 }, { type: "DELETE_FORWARD" });
    expect(result.value).toBe("ac");
  });

  it("MOVE_LEFT/RIGHT with clamping", () => {
    expect(bufferReducer({ value: "abc", cursor: 0 }, { type: "MOVE_LEFT" }).cursor).toBe(0);
    expect(bufferReducer({ value: "abc", cursor: 3 }, { type: "MOVE_RIGHT" }).cursor).toBe(3);
    expect(bufferReducer({ value: "abc", cursor: 2 }, { type: "MOVE_LEFT" }).cursor).toBe(1);
    expect(bufferReducer({ value: "abc", cursor: 1 }, { type: "MOVE_RIGHT" }).cursor).toBe(2);
  });

  it("MOVE_HOME/END set cursor correctly", () => {
    expect(bufferReducer({ value: "hello", cursor: 3 }, { type: "MOVE_HOME" }).cursor).toBe(0);
    expect(bufferReducer({ value: "hello", cursor: 1 }, { type: "MOVE_END" }).cursor).toBe(5);
  });

  it("CLEAR resets to empty state", () => {
    const result = bufferReducer({ value: "some text", cursor: 4 }, { type: "CLEAR" });
    expect(result.value).toBe("");
    expect(result.cursor).toBe(0);
  });

  it("SET_VALUE sets value and cursor to end", () => {
    const result = bufferReducer(initialBufferState, { type: "SET_VALUE", value: "new text" });
    expect(result.value).toBe("new text");
    expect(result.cursor).toBe(8);
  });

  it("complex sequence: type hello with correction", () => {
    let state = initialBufferState;
    for (const ch of "helo") state = bufferReducer(state, { type: "INSERT", char: ch });
    state = bufferReducer(state, { type: "MOVE_LEFT" });
    state = bufferReducer(state, { type: "INSERT", char: "l" });
    expect(state.value).toBe("hello");
  });
});

// ============================================================
// 13. Command history manager
// ============================================================

import { createCommandHistoryManager } from "../src/tui/hooks/useCommandHistory.js";

describe("createCommandHistoryManager", () => {
  it("push deduplicates consecutive identical commands", () => {
    const mgr = createCommandHistoryManager([]);
    mgr.push("ls");
    mgr.push("ls");
    mgr.push("ls");
    expect(mgr.navigateUp("")).toBe("ls");
    expect(mgr.navigateUp("")).toBeUndefined();
  });

  it("navigateUp/Down with draft preservation", () => {
    const mgr = createCommandHistoryManager(["a", "b", "c"]);
    expect(mgr.navigateUp("my draft")).toBe("c");
    expect(mgr.navigateUp("")).toBe("b");
    expect(mgr.navigateUp("")).toBe("a");
    expect(mgr.navigateUp("")).toBeUndefined();
    expect(mgr.navigateDown()).toBe("b");
    expect(mgr.navigateDown()).toBe("c");
    expect(mgr.navigateDown()).toBe("my draft");
    expect(mgr.navigateDown()).toBeUndefined();
  });

  it("push trims whitespace and ignores blank", () => {
    const mgr = createCommandHistoryManager([]);
    mgr.push("   ");
    mgr.push("\t");
    expect(mgr.navigateUp("")).toBeUndefined();
    mgr.push("  ls  ");
    mgr.push("ls");
    expect(mgr.navigateUp("")).toBe("ls");
    expect(mgr.navigateUp("")).toBeUndefined();
  });

  it("onSave callback receives cumulative entries", () => {
    const saved: string[][] = [];
    const mgr = createCommandHistoryManager([], (entries) => saved.push([...entries]));
    mgr.push("alpha");
    mgr.push("beta");
    expect(saved.length).toBe(2);
    expect(saved[1]).toEqual(["alpha", "beta"]);
  });

  it("reset clears navigation state", () => {
    const mgr = createCommandHistoryManager(["cmd1"]);
    mgr.navigateUp("draft");
    mgr.reset();
    expect(mgr.navigateDown()).toBeUndefined();
  });
});

// ============================================================
// 14. History persistence
// ============================================================

import { loadHistory, saveHistory } from "../src/tui/history.js";

describe("history persistence", () => {
  beforeEach(() => {
    if (!existsSync(TEST_HISTORY_DIR)) mkdirSync(TEST_HISTORY_DIR, { recursive: true });
    if (existsSync(TEST_HISTORY_PATH)) rmSync(TEST_HISTORY_PATH);
  });
  afterEach(() => {
    if (existsSync(TEST_HISTORY_PATH)) rmSync(TEST_HISTORY_PATH);
  });

  it("returns empty array when file does not exist", () => {
    expect(loadHistory()).toEqual([]);
  });

  it("round-trips entries", () => {
    saveHistory(["a", "b", "c"]);
    expect(loadHistory()).toEqual(["a", "b", "c"]);
  });

  it("truncates to MAX 500 entries", () => {
    const bigList = Array.from({ length: 600 }, (_, i) => `cmd-${i}`);
    saveHistory(bigList);
    const loaded = loadHistory();
    expect(loaded.length).toBeLessThanOrEqual(500);
    expect(loaded[loaded.length - 1]).toBe("cmd-599");
  });
});

// ============================================================
// 15. TUI SLASH_COMMANDS + matchCommands
// ============================================================

import { SLASH_COMMANDS, matchCommands, matchCommandsWithInfo, formatHelpText } from "../src/tui/commands.js";

describe("TUI SLASH_COMMANDS", () => {
  it("has 10 entries including compact", () => {
    expect(SLASH_COMMANDS.length).toBe(10);
    const names = SLASH_COMMANDS.map((c: { name: string }) => c.name);
    for (const cmd of ["model", "mcp", "config", "context", "memory", "plan", "tasks", "compact", "help", "exit"]) {
      expect(names).toContain(cmd);
    }
  });
});

describe("matchCommands", () => {
  it("returns matches starting with prefix", () => {
    const matches = matchCommands("/m");
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) expect(m.startsWith("/m")).toBe(true);
  });

  it("returns all commands for '/' prefix", () => {
    expect(matchCommands("/").length).toBe(10);
  });

  it("returns empty for no matches", () => {
    expect(matchCommands("/zzz_nonexistent")).toEqual([]);
  });
});

describe("matchCommandsWithInfo", () => {
  it("returns objects with name and description", () => {
    const matches = matchCommandsWithInfo("/co");
    const names = matches.map((m: { name: string }) => m.name);
    expect(names).toContain("/compact");
    expect(names).toContain("/config");
    expect(names).toContain("/context");
    expect(names).not.toContain("/exit");
  });
});

describe("formatHelpText", () => {
  it("includes all commands and keybinding info", () => {
    const help = formatHelpText();
    for (const cmd of ["model", "mcp", "config", "context", "memory", "plan", "tasks", "compact", "help", "exit"]) {
      expect(help).toContain(cmd);
    }
    expect(help).toMatch(/ctrl|enter|escape|tab|shift/i);
    expect(help).toMatch(/ctrl\+w|workspace/i);
    expect(help).toMatch(/ctrl\+g|background/i);
  });
});

// ============================================================
// 16. Workspace
// ============================================================

import { extractDescription, listWorkspaceFiles, checkWorkspaceIntegrity } from "../src/tui/workspace.js";

describe("workspace", () => {
  it("extractDescription extracts heading", () => {
    expect(extractDescription("# My Title\nBody")).toContain("My Title");
    expect(extractDescription("Just a line")).toContain("Just a line");
    expect(extractDescription("")).toBe("");
  });

  it("listWorkspaceFiles returns array of WorkspaceFile objects", () => {
    const files = listWorkspaceFiles();
    expect(Array.isArray(files)).toBe(true);
    for (const f of files) expect(typeof f.path).toBe("string");
  });

  it("checkWorkspaceIntegrity returns correct shape", () => {
    const result = checkWorkspaceIntegrity();
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.fileCount).toBe("number");
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ============================================================
// 17. Theme
// ============================================================

import { theme } from "../src/tui/theme.js";

describe("theme", () => {
  it("exports callable functions for all expected keys", () => {
    const keys = ["primary", "error", "muted", "toolRunning", "toolSuccess", "toolError"];
    for (const key of keys) {
      expect(typeof (theme as Record<string, unknown>)[key]).toBe("function");
    }
  });

  it("theme.primary returns string containing input", () => {
    const result = theme.primary("hello");
    expect(typeof result).toBe("string");
    expect(result).toContain("hello");
  });
});

// ============================================================
// 18. shouldAutoCompact
// ============================================================

import { shouldAutoCompact } from "../src/tui/auto-compact.js";

describe("shouldAutoCompact", () => {
  const enabled = { enabled: true, autoThreshold: 90 };
  const disabled = { enabled: false, autoThreshold: 90 };

  it("returns true when all conditions met", () => {
    expect(shouldAutoCompact(enabled, 95, false, false, "ready")).toBe(true);
    expect(shouldAutoCompact(enabled, 90, false, false, "ready")).toBe(true);
  });

  it("returns false when any condition fails", () => {
    expect(shouldAutoCompact(enabled, 89, false, false, "ready")).toBe(false);
    expect(shouldAutoCompact(disabled, 95, false, false, "ready")).toBe(false);
    expect(shouldAutoCompact(enabled, 95, true, false, "ready")).toBe(false);
    expect(shouldAutoCompact(enabled, 95, false, true, "ready")).toBe(false);
    expect(shouldAutoCompact(enabled, 95, false, false, "streaming")).toBe(false);
  });

  it("works with custom threshold values", () => {
    const low = { enabled: true, autoThreshold: 50 };
    expect(shouldAutoCompact(low, 50, false, false, "ready")).toBe(true);
    expect(shouldAutoCompact(low, 49, false, false, "ready")).toBe(false);
  });
});

// ============================================================
// 19. /compact command
// ============================================================

describe("/compact command", () => {
  it("handler exists and is executable", async () => {
    const { compactCommand } = await import("../src/commands/compact.js");
    expect(compactCommand).toBeDefined();
    expect(compactCommand.name).toBe("compact");
    expect(typeof compactCommand.execute).toBe("function");
  });

  it("execute calls session.compact and returns result", async () => {
    const { compactCommand } = await import("../src/commands/compact.js");
    const compactFn = vi.fn().mockResolvedValue("summary");
    const mockContext = {
      session: {
        compact: compactFn,
        session: { compact: vi.fn() },
        config: { compaction: { enabled: true, autoThreshold: 90 } },
      },
      mode: "tui" as const,
    };
    const result = await compactCommand.execute([], mockContext as any);
    expect(result.output).toContain("compaction");
    expect(compactFn).toHaveBeenCalledTimes(1);
  });

  it("passes user args to compact", async () => {
    const { compactCommand } = await import("../src/commands/compact.js");
    const compactFn = vi.fn().mockResolvedValue("summary");
    const mockContext = {
      session: {
        compact: compactFn,
        session: { compact: vi.fn() },
        config: { compaction: { enabled: true, autoThreshold: 90 } },
      },
      mode: "tui" as const,
    };
    await compactCommand.execute(["keep", "memory", "entries"], mockContext as any);
    expect(compactFn).toHaveBeenCalledWith("keep memory entries");
  });
});

// ============================================================
// 20. Package version
// ============================================================

describe("package.json version", () => {
  it("version is 0.4.3", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
    expect(pkg.version).toBe("0.4.3");
  });
});

// ============================================================
// 21. Task 0.3 — HistoryEntry transcript_marker envelope
// ============================================================

import { InteractionHistory, type HistoryEntry } from "../src/history.js";

describe("history — transcript_marker envelope", () => {
  const histTmpDir = join(tmpdir(), `qlaybot-history-marker-${process.pid}`);

  beforeEach(() => {
    if (existsSync(histTmpDir)) rmSync(histTmpDir, { recursive: true, force: true });
    mkdirSync(histTmpDir, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(histTmpDir)) rmSync(histTmpDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Task 0.3 — extend HistoryEntry union with "transcript_marker".
  //
  // Reviewer note (v2): we dropped the earlier source-grep test that a
  // comment containing "transcript_marker" could satisfy. Instead:
  //
  //   1. `appendTranscript` accepts a properly-typed HistoryEntry whose
  //      `type` literal is "transcript_marker" — NO `as any` cast. If the
  //      Executor hasn't widened the union, `cd agent && npm run build`
  //      fails at this file (the plan's Step 5 mandates a build gate).
  //   2. Runtime round-trip: write then re-read the JSONL, assert deep-
  //      equality — the load() step in Task 0.3 Step 1.
  //
  // Why both: esbuild erases type annotations under vitest test-run, so
  // the runtime test alone cannot distinguish a widened union from a
  // narrowed one. The `npm run build` gate catches the type gap.
  // ─────────────────────────────────────────────────────────────────────

  it("appendTranscript accepts a properly-typed transcript_marker entry (no `as any` casts)", () => {
    const sessionId = `marker-session-${Date.now()}`;
    const history = new InteractionHistory(sessionId);
    const ts = "2026-04-21T00:10:00.000Z";
    // Build the entry with the EXACT HistoryEntry type — this line must
    // compile under `npm run build`. If the Executor has not widened
    // HistoryEntry["type"] to include "transcript_marker", the typecheck
    // fails RED. NO `as any` — that would silently defeat the build gate.
    const entry: HistoryEntry = {
      timestamp: ts,
      type: "transcript_marker",
      data: {
        type: "think_recorded",
        source: "tool",
        thought: "history-envelope probe",
        ts,
      },
    };
    history.appendTranscript(entry);

    const transcriptPath = join(history.getSessionDir(), "transcript.jsonl");
    expect(existsSync(transcriptPath)).toBe(true);

    const raw = readFileSync(transcriptPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("transcript_marker");
    expect(parsed.timestamp).toBe(ts);
    expect(parsed.data).toBeDefined();
  });

  it("canonical timestamp: the outer entry.timestamp equals data.ts (marker.ts wins)", () => {
    const sessionId = `marker-ts-session-${Date.now()}`;
    const history = new InteractionHistory(sessionId);
    const ts = "2026-04-21T00:11:00.000Z";
    const entry: HistoryEntry = {
      timestamp: ts,
      type: "transcript_marker",
      data: {
        type: "think_recorded",
        source: "tool",
        thought: "canonical-ts probe",
        ts,
      },
    };
    history.appendTranscript(entry);

    const transcriptPath = join(history.getSessionDir(), "transcript.jsonl");
    const line = readFileSync(transcriptPath, "utf8").trim();
    const parsed = JSON.parse(line);
    // marker.ts is authoritative — outer timestamp must copy it verbatim
    expect(parsed.timestamp).toBe(parsed.data.ts);
    expect(parsed.timestamp).toBe(ts);
  });

  it("round-trips through JSONL: writing then re-reading preserves the marker payload exactly (Task 0.3 Step 1 load)", () => {
    const sessionId = `marker-roundtrip-${Date.now()}`;
    const history = new InteractionHistory(sessionId);
    const ts = "2026-04-21T00:12:00.000Z";
    const entry: HistoryEntry = {
      timestamp: ts,
      type: "transcript_marker",
      data: {
        type: "think_recorded",
        source: "tool",
        thought: "roundtrip probe",
        ts,
      },
    };
    history.appendTranscript(entry);

    const transcriptPath = join(history.getSessionDir(), "transcript.jsonl");
    const line = readFileSync(transcriptPath, "utf8").trim();
    const parsed = JSON.parse(line);
    // Deep equality — every field of the entry round-trips byte-for-byte
    // (modulo JSON normalisation, which is a no-op for our flat shape).
    expect(parsed).toEqual(entry);
    // Structural invariants that any downstream loader assumes.
    expect(parsed.type).toBe("transcript_marker");
    expect(parsed.timestamp).toBe(ts);
    expect(parsed.data.type).toBe("think_recorded");
    expect(parsed.data.source).toBe("tool");
    expect(parsed.data.thought).toBe("roundtrip probe");
    expect(parsed.data.ts).toBe(ts);
  });

  it("existing history variants still round-trip alongside transcript_marker (no regression)", () => {
    const sessionId = `marker-mixed-${Date.now()}`;
    const history = new InteractionHistory(sessionId);
    history.recordPrompt("hello");
    const ts = "2026-04-21T00:13:00.000Z";
    const entry: HistoryEntry = {
      timestamp: ts,
      type: "transcript_marker",
      data: { type: "think_recorded", source: "tool", thought: "mixed", ts },
    };
    history.appendTranscript(entry);
    history.recordResponse("world");

    const transcriptPath = join(history.getSessionDir(), "transcript.jsonl");
    const lines = readFileSync(transcriptPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    expect(lines.length).toBe(3);
    expect(lines[0].type).toBe("user_prompt");
    expect(lines[1].type).toBe("transcript_marker");
    expect(lines[2].type).toBe("agent_response");
  });

  // ─────────────────────────────────────────────────────────────────────
  // Type-level build gate for Task 0.3.
  //
  // Reviewer v2 concern: esbuild erases TS type annotations under
  // vitest, so at runtime `const e: HistoryEntry = {type: "transcript_marker", ...}`
  // passes even against a HistoryEntry union that does NOT include
  // "transcript_marker". The typed-entry tests above are
  // necessary-but-not-sufficient. This test uses the TypeScript compiler
  // programmatically to SYNTHESISE the type check on a minimal snippet
  // that MUST compile only if HistoryEntry["type"] was widened.
  //
  // Depends on: the `typescript` package (already a devDependency).
  // ─────────────────────────────────────────────────────────────────────
  it("Task 0.3 type gate: HistoryEntry accepts { type: 'transcript_marker' } under strict TS (programmatic tsc probe)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ts = require("typescript") as typeof import("typescript");
    const probeFilename = "history-transcript-marker-probe.ts";
    const historyTsPath = resolve(__dirname, "..", "src", "history.ts");
    const historySrc = readFileSync(historyTsPath, "utf-8");

    // Minimal probe that imports HistoryEntry and constructs one with
    // type: "transcript_marker". If the union hasn't been widened, the
    // TypeScript compiler reports a Type '"transcript_marker"' is not
    // assignable to type ... error on the `type:` property — which this
    // test catches as a diagnostic.
    const probeSource = `
      import type { HistoryEntry } from "./history.js";
      const entry: HistoryEntry = {
        timestamp: "2026-04-21T00:14:00.000Z",
        type: "transcript_marker",
        data: { type: "think_recorded", source: "tool", thought: "type-gate", ts: "2026-04-21T00:14:00.000Z" },
      };
      // force the type to be seen (avoid "declared but never read")
      void entry;
    `;

    // Synthesise an in-memory TS program with two source files: the real
    // src/history.ts (so HistoryEntry resolves) and the probe.
    const files = new Map<string, string>([
      [resolve(__dirname, "..", "src", "history.ts"), historySrc],
      [resolve(__dirname, "..", "src", probeFilename), probeSource],
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
      [resolve(__dirname, "..", "src", probeFilename)],
      compilerOptions,
      host,
    );
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => {
        // Only care about diagnostics that originate in the probe file
        // itself. skipLibCheck handles lib types; downstream module
        // import errors from e.g. missing truncation.ts imports are
        // noise for this specific gate.
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
        `Task 0.3 type gate FAILED — HistoryEntry["type"] does not include "transcript_marker" (or the probe is otherwise ill-typed). Diagnostics:\n${messages}`,
      );
    }
  });
});

// ============================================================
// Task 1.1 / 1.6 — createThinkingTool factory (TH-1/2/3/14, T29)
// ============================================================
//
// Source of truth:
//  - docs/superpowers/specs/2026-04-19-qlaybot-0.4.4-design.md §3.2 (TH-1,
//    TH-2, TH-3, TH-8, TH-11, TH-14), §3.3 interface.
//  - docs/superpowers/plans/2026-04-21-qlaybot-0.4.4.md Task 1.1 Step 1,
//    Task 1.6 T29(a–e).
//
// All RED until the Executor lands `agent/src/tools/thinking.ts`.

describe("thinking tool factory (Task 1.1 / TH-1/2/3/14)", () => {
  it("exposes a tool whose name is exactly 'thinking' (lowercase, no prefix — TH-1)", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const tool = createThinkingTool(emitter);
    expect(tool.name).toBe("thinking");
  });

  it("description is a non-empty string containing the §3.3 anchors 'side-effect-free' and 'scratchpad'", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const tool = createThinkingTool(emitter);
    expect(typeof tool.description).toBe("string");
    const desc = tool.description as string;
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).toContain("side-effect-free");
    expect(desc).toContain("scratchpad");
  });

  it("schema is a TypeBox object with exactly one required string property `thought` (minLength 1), additionalProperties:false (TH-2, TH-14)", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const tool = createThinkingTool(emitter);
    const schema: any = tool.parameters;
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Array.isArray(schema.required)).toBe(true);
    expect(schema.required).toEqual(["thought"]);

    // Properties: exactly {thought} — nothing else.
    const props = schema.properties;
    expect(props).toBeDefined();
    expect(Object.keys(props).sort()).toEqual(["thought"]);

    expect(props.thought.type).toBe("string");
    expect(props.thought.minLength).toBe(1);
  });

  it("execute synchronously emits exactly ONE think_recorded marker with the required shape (TH-8)", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const received: unknown[] = [];
    emitter.on("marker", (m) => received.push(m));
    const tool = createThinkingTool(emitter);

    await tool.execute("tcid-1", { thought: "hello" });

    expect(received.length).toBe(1);
    const m = received[0] as any;
    expect(m.type).toBe("think_recorded");
    expect(m.source).toBe("tool");
    expect(m.thought).toBe("hello");
    expect(typeof m.ts).toBe("string");
    expect(m.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("execute returns the §3.3 echo contract: content[{type:'text', text:JSON.stringify({ok:true,thought})}] (TH-3)", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const tool = createThinkingTool(emitter);
    const result = await tool.execute("tcid-2", { thought: "hello" });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    const first = result.content[0] as { type: string; text: string };
    expect(first.type).toBe("text");
    const parsed = JSON.parse(first.text) as {
      ok: boolean;
      thought: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.thought).toBe("hello");
    // details is present (AgentToolResult shape); we don't enforce its
    // exact shape beyond "non-throwing access".
    expect(result.details).toBeDefined();
  });

  it("TH-11 byte-equality: a `thought` containing literal `<think>…</think>` is echoed verbatim", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const tool = createThinkingTool(emitter);
    const thought = "<think>reasoning</think>";
    const result = await tool.execute("tcid-3", { thought });
    const first = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(first.text) as { thought: string };
    expect(parsed.thought).toBe(thought);
  });
});

// ---------------------------------------------------------------------------
// TH-3 side-effect-free coverage (review item #5 + #7)
//
// TH-3 says the tool MUST NOT write files, call MCP tools, spawn subagents,
// mutate session state, or produce any UI beyond the transcript marker.
// These tests cover that explicitly — not by peeking at locked emitter
// internals (G1 surface) but by observing side-effect surfaces directly.
// ---------------------------------------------------------------------------

describe("thinking tool side-effect-free contract (TH-3 — review item #5)", () => {
  it("TH-3 / fs: tool.execute does not write files (static source probe + runtime sandbox dir snapshot)", async () => {
    // ESM limitation: `vi.spyOn(fs, "writeFileSync")` fails with
    // "Cannot spy on export …; Module namespace is not configurable in ESM."
    // The ESM module namespace bindings are read-only, so we cannot spy
    // on them at runtime.
    //
    // Round-4 fix (Option A): two independent checks that don't need
    // module-namespace spies.
    //   (a) Static: read src/tools/thinking.ts and assert it does not
    //       import any fs module. A tool that statically has no fs
    //       binding cannot call one.
    //   (b) Runtime: snapshot a sandbox tmpdir before/after execute()
    //       (with process.cwd() redirected into it so any relative-path
    //       fs write would land there). Nothing new must appear.
    const { mkdtempSync, readdirSync } = await import("fs");
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    // (a) Static source probe — the impl must not import fs at all.
    const thinkingSrcPath = resolve(
      __dirname,
      "..",
      "src",
      "tools",
      "thinking.ts",
    );
    const src = readFileSync(thinkingSrcPath, "utf-8");
    expect(
      src,
      "TH-3 / fs static: src/tools/thinking.ts must not import 'fs'",
    ).not.toMatch(/from\s+["']fs["']/);
    expect(
      src,
      "TH-3 / fs static: src/tools/thinking.ts must not import 'fs/promises'",
    ).not.toMatch(/from\s+["']fs\/promises["']/);
    expect(
      src,
      "TH-3 / fs static: src/tools/thinking.ts must not `require('fs')`",
    ).not.toMatch(/require\s*\(\s*["']fs["']\s*\)/);
    expect(
      src,
      "TH-3 / fs static: src/tools/thinking.ts must not `require('fs/promises')`",
    ).not.toMatch(/require\s*\(\s*["']fs\/promises["']\s*\)/);

    // (b) Runtime sandbox — redirect cwd into an empty tmpdir, run
    // execute(), and verify the tmpdir is still empty afterwards.
    const sandbox = mkdtempSync(join(tmpdir(), "qlaybot-th3-fs-"));
    const before = readdirSync(sandbox);
    const origCwd = process.cwd();
    try {
      const emitter = new TranscriptMarkerEmitter();
      const tool = createThinkingTool(emitter);
      process.chdir(sandbox);
      try {
        await tool.execute("tcid-fs-1", { thought: "side-effect probe" });
      } finally {
        process.chdir(origCwd);
      }
      const after = readdirSync(sandbox);
      expect(
        after,
        "TH-3 / fs runtime: tool.execute must not create files in cwd",
      ).toEqual(before);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("TH-3 / structural: createThinkingTool factory signature takes ONLY an emitter — no MCP manager, no subagent runner reachable", async () => {
    // Structural proof: the factory parameter is a single TranscriptMarkerEmitter.
    // Function arity MUST be 1 — any additional params would indicate the
    // tool can reach an MCPManager or SubagentRunner.
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    // Reflect the declared arity. `Function.length` excludes rest params
    // and params with default values, but asserting <= 1 catches the
    // "oops, a 2nd required param snuck in" regression.
    expect(createThinkingTool.length).toBeLessThanOrEqual(1);
  });

  it("TH-3 / no hidden listener subscription: execute does not accumulate subscribers on the emitter (review item #7 rewrite)", async () => {
    // Rewritten from the old internals-peeking test. We register ONE
    // listener, execute the tool N times, and assert our listener saw
    // exactly N deliveries — no more, no fewer. If the tool internally
    // subscribed a phantom listener that swallowed markers, our count
    // would drop. If the tool subscribed a phantom emitting listener,
    // our count could stay right but duplicates would appear — we check
    // each marker payload's thought to catch that too.
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const captured: any[] = [];
    emitter.on("marker", (m) => captured.push(m));

    const tool = createThinkingTool(emitter);
    await tool.execute("tcid-a", { thought: "first" });
    expect(captured.length).toBe(1);
    expect(captured[0].thought).toBe("first");

    await tool.execute("tcid-b", { thought: "second" });
    expect(captured.length).toBe(2);
    expect(captured[1].thought).toBe("second");

    await tool.execute("tcid-c", { thought: "third" });
    // No duplicates — if execute secretly subscribed another listener that
    // re-emits, captured would be > 3.
    expect(captured.length).toBe(3);
    // And the payloads are the ones we sent, in order, each exactly once.
    expect(captured.map((m) => m.thought)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 1.6 — T29 schema probe (TH-1/2/4/14)
// ---------------------------------------------------------------------------

describe("thinking tool schema probe (Task 1.6 / T29 TH-1/2/4/14)", () => {
  it("T29(a): additionalProperties === false", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const tool = createThinkingTool(new TranscriptMarkerEmitter());
    const schema: any = tool.parameters;
    expect(schema.additionalProperties).toBe(false);
  });

  it("T29(b): exactly one property key: ['thought']", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const tool = createThinkingTool(new TranscriptMarkerEmitter());
    const schema: any = tool.parameters;
    expect(Object.keys(schema.properties).sort()).toEqual(["thought"]);
  });

  it("T29(c): Value.Check rejects empty string and accepts non-empty", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const { Value } = await import("@sinclair/typebox/value");
    const tool = createThinkingTool(new TranscriptMarkerEmitter());
    const schema: any = tool.parameters;
    expect(Value.Check(schema, { thought: "" })).toBe(false);
    expect(Value.Check(schema, { thought: "x" })).toBe(true);
    // And missing `thought` must fail too — TH-2 says required.
    expect(Value.Check(schema, {})).toBe(false);
    // Extra fields must fail — TH-14 (no effort dial).
    expect(Value.Check(schema, { thought: "x", effort: "high" })).toBe(false);
  });

  it("T29(c) runtime: invalid input MUST report a validation error (throw | details.error | ok:false) AND emit zero markers — never a silent {ok:true, thought:''} echo (review item #8, round-4 Concern A)", async () => {
    // Plan / spec §3.7 edge cases: "`thought` is the empty string | Schema
    // validation fails (TH-2 `minLength: 1`); tool returns a **validation
    // error** and no `think_recorded` marker is emitted."
    //
    // Round-4 tightening (Concern A): the previous revision only rejected
    // the literal `{ok:true, thought:""}` echo shape. Codex flagged this
    // as still too loose — a malformed result (e.g. `{content:[], details:{}}`
    // with thought missing entirely) would pass. Round-4 requires the
    // impl to REPORT an error one of three documented ways:
    //
    //   (a) `execute()` throws, OR
    //   (b) returned `AgentToolResult.details.error` is defined, OR
    //   (c) returned `content[0].text` is JSON with `ok: false` (or an
    //       `error` field).
    //
    // AND simultaneously the impl MUST NOT:
    //   (x) return `{ok:true, thought:""}` (silent success echo), OR
    //   (y) emit ANY marker for the invalid input.
    //
    // A malformed return (e.g. thought missing without an error signal)
    // fails the "reportedError" clause below.
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const { Value } = await import("@sinclair/typebox/value");

    const emitter = new TranscriptMarkerEmitter();
    const received: any[] = [];
    emitter.on("marker", (m) => received.push(m));
    const tool = createThinkingTool(emitter);
    const schema: any = tool.parameters;

    // (i) Schema-surface check — independent of runtime execute path.
    expect(Value.Check(schema, { thought: "" })).toBe(false);
    expect(Value.Check(schema, {})).toBe(false);
    expect(Value.Check(schema, { thought: "x", extra: 1 })).toBe(false);

    // (ii) Direct-execute binding — the tool implementation MUST report
    //      an error one of three ways. We probe each invalid input and
    //      check both the reported-error clause AND the anti-cheat
    //      clause (no silent success echo).
    async function assertInvalidReportsError(
      label: string,
      tcid: string,
      input: any,
    ): Promise<void> {
      let threw = false;
      let result: any = undefined;
      try {
        result = await tool.execute(tcid, input);
      } catch {
        threw = true;
      }

      // Parse the returned result's first content block as JSON (if any).
      // Used by both the reported-error clause and the anti-cheat clause.
      let parsed: any = undefined;
      if (result) {
        const first = result.content?.[0];
        if (first?.type === "text" && typeof first.text === "string") {
          try {
            parsed = JSON.parse(first.text);
          } catch {
            parsed = undefined;
          }
        }
      }

      // --- REPORTED-ERROR CLAUSE ---------------------------------------
      // One of these three MUST be true:
      //   (a) execute threw
      //   (b) result.details.error is defined
      //   (c) parsed.ok === false OR parsed.error is truthy
      const reportedError =
        threw ||
        result?.details?.error !== undefined ||
        (parsed !== undefined &&
          (parsed.ok === false || parsed.error !== undefined));
      expect(
        reportedError,
        `T29(c) runtime / ${label}: impl MUST report a validation error — execute() must throw, set details.error, or return ok:false/error. threw=${threw} result=${JSON.stringify(result)?.slice(0, 200)}`,
      ).toBe(true);

      // --- ANTI-CHEAT CLAUSE -------------------------------------------
      // The SPECIFIC failure mode spec §3.7 names is "silent success
      // echo". Forbid it directly.
      if (result && parsed !== undefined) {
        // (x) Never the literal {ok:true, thought:""} (or missing thought)
        //     for the empty/missing-input cases.
        if (label === "empty") {
          expect(parsed).not.toEqual({ ok: true, thought: "" });
        }
        if (label === "missing") {
          // For missing field, thought is undefined — forbid
          //   {ok:true} with no thought AND {ok:true, thought: anything}
          //   for the missing-input case.
          expect(parsed.ok === true && parsed.thought !== undefined).toBe(
            false,
          );
          // Also forbid ok:true with thought === "" (degenerate case).
          expect(parsed).not.toEqual({ ok: true, thought: "" });
        }
        if (label === "extra") {
          // For additionalProperties, forbid ok:true echo that ignores
          // the extra field (silent acceptance of schema-violating input).
          if (parsed.ok === true) {
            expect(
              reportedError,
              `T29(c) runtime / extra: impl returned ok:true for input with extra fields — must reject via one of the three error channels`,
            ).toBe(true);
          }
        }
      }
    }

    await assertInvalidReportsError("empty", "tcid-empty", { thought: "" });
    await assertInvalidReportsError("missing", "tcid-missing", {} as any);
    await assertInvalidReportsError("extra", "tcid-extra", {
      thought: "x",
      extra: 1,
    } as any);

    // CRITICAL: zero markers across ALL invalid invocations (clause y).
    expect(
      received.length,
      "T29(c) runtime: no think_recorded marker should fire for any invalid input (empty, missing, extra)",
    ).toBe(0);

    // Positive path: valid input DOES produce exactly one marker,
    // demonstrating the gate's pass/reject symmetry on the SAME tool
    // instance and SAME emitter that were probed above. This also
    // catches a degenerate impl that disables emission entirely.
    await tool.execute("tcid-ok", { thought: "runtime valid" });
    expect(received.length).toBe(1);
    expect(received[0].thought).toBe("runtime valid");
  });

  it("T29(d): no effort / budget / level / mode / depth / thinking fields present in the schema", async () => {
    const { createThinkingTool } = await import("../src/tools/thinking.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const tool = createThinkingTool(new TranscriptMarkerEmitter());
    const schema: any = tool.parameters;
    const keys = Object.keys(schema.properties);
    for (const banned of ["effort", "budget", "level", "mode", "depth", "thinking"]) {
      expect(keys).not.toContain(banned);
    }
    expect(keys).toEqual(["thought"]);
  });

  it("T29(e): assembleTools extended signature returns toolMap with a `thinking` entry (identity-stable across calls)", async () => {
    const { assembleTools } = await import("../src/tools/index.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();

    const mockMcpManager = {
      allTools: () => [],
      getServerKeys: () => [],
      isConnected: () => false,
      callTool: async () => ({ content: [{ type: "text" as const, text: "" }] }),
    } as any;
    const mockMemoryManager = {
      save: async () => {},
      search: async () => [],
      close: () => {},
    } as any;
    const cwd = join(tmpdir(), `qlaybot-t29e-${process.pid}-${Date.now()}`);

    const callAssemble = () =>
      assembleTools({
        config: { subagent: { enabled: false, roles: {} } } as any,
        mcpManager: mockMcpManager,
        memoryManager: mockMemoryManager,
        cwd,
        workspaceDir: cwd,
        annotations: [],
        getApiKey: async () => undefined,
        defaultModel: "test-model",
        defaultThinkingLevel: "medium",
        modelRegistry: {} as any,
        transcriptMarkerEmitter: emitter,
      });

    const r1 = callAssemble();
    const r2 = callAssemble();
    expect(r1.toolMap["thinking"]).toBeDefined();
    expect(r1.toolMap["thinking"].name).toBe("thinking");
    // Idempotent: both calls produce a `thinking` entry with the same name.
    expect(r2.toolMap["thinking"]).toBeDefined();
    expect(r2.toolMap["thinking"].name).toBe("thinking");
  });
});

// ---------------------------------------------------------------------------
// Task 1.2 — assembleTools wires thinking + allowlist (TH-4)
//
// Narrowed per review item #7: only test the surface that's NEW in Task 1.2.
// Emitter param threading was already locked by G1 (test-runtime-wiring.ts),
// so we DO NOT re-test that here. We test:
//   (i)  toolMap["thinking"] exists with name === "thinking" (new surface).
//   (ii) assembleTools does NOT throw the "escaped the plan-mode sandbox"
//        error when a PlanManager is present — this exercises the new
//        NON_MCP + ALLOWED_BASE additions required for `thinking` to pass
//        the deny-by-default allowlist at tools/index.ts:286-319.
// ---------------------------------------------------------------------------

describe("assembleTools thinking registration (Task 1.2 / TH-4 — narrowed per review #7)", () => {
  it("(i) toolMap['thinking'] exists with name 'thinking' — new surface", async () => {
    const { assembleTools } = await import("../src/tools/index.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const emitter = new TranscriptMarkerEmitter();
    const mockMcpManager = {
      allTools: () => [],
      getServerKeys: () => [],
      isConnected: () => false,
      callTool: async () => ({ content: [] }),
    } as any;
    const mockMemoryManager = {
      save: async () => {},
      search: async () => [],
      close: () => {},
    } as any;
    const cwd = join(tmpdir(), `qlaybot-t12-a-${process.pid}-${Date.now()}`);
    const { toolMap } = assembleTools({
      config: { subagent: { enabled: false, roles: {} } } as any,
      mcpManager: mockMcpManager,
      memoryManager: mockMemoryManager,
      cwd,
      workspaceDir: cwd,
      annotations: [],
      getApiKey: async () => undefined,
      defaultModel: "test-model",
      defaultThinkingLevel: "medium",
      modelRegistry: {} as any,
      transcriptMarkerEmitter: emitter,
    });
    expect(toolMap["thinking"]).toBeDefined();
    expect(toolMap["thinking"].name).toBe("thinking");
  });

  it("(ii) allowlist: assembleTools with a PlanManager (non-subagent) does NOT throw 'escaped the plan-mode sandbox'", async () => {
    // This exercises the tools/index.ts:286-319 deny-by-default allowlist —
    // if the Executor forgets to add "thinking" to NON_MCP + ALLOWED_BASE,
    // the throw below will fire. We assert NO throw.
    const { assembleTools } = await import("../src/tools/index.js");
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const { PlanManager } = await import("../src/planning/index.js");

    const emitter = new TranscriptMarkerEmitter();
    const mockMcpManager = {
      allTools: () => [],
      getServerKeys: () => [],
      isConnected: () => false,
      callTool: async () => ({ content: [] }),
    } as any;
    const mockMemoryManager = {
      save: async () => {},
      search: async () => [],
      close: () => {},
    } as any;
    const workspaceDir = join(
      tmpdir(),
      `qlaybot-t12-c-${process.pid}-${Date.now()}`,
    );
    mkdirSync(workspaceDir, { recursive: true });
    const pm = new PlanManager(workspaceDir);

    const call = () =>
      assembleTools({
        config: { subagent: { enabled: false, roles: {} } } as any,
        mcpManager: mockMcpManager,
        memoryManager: mockMemoryManager,
        cwd: workspaceDir,
        workspaceDir,
        annotations: [],
        getApiKey: async () => undefined,
        defaultModel: "test-model",
        defaultThinkingLevel: "medium",
        modelRegistry: {} as any,
        planManager: pm,
        isSubagent: false,
        transcriptMarkerEmitter: emitter,
      });

    // If Executor forgot to add "thinking" to ALLOWED_BASE + NON_MCP, this
    // call would throw "…escaped the plan-mode sandbox…".
    expect(() => call()).not.toThrow();

    // And `thinking` must still be in the resulting toolMap under its bare
    // name — confirming it wasn't wrapped/renamed by the MCP wrapper.
    const { toolMap } = call();
    expect(toolMap["thinking"]).toBeDefined();
    expect(toolMap["thinking"].name).toBe("thinking");
  });
});

// ---------------------------------------------------------------------------
// Task 1.3 — annotations TH-7 (thinking readonly + plan-mode allowed)
// ---------------------------------------------------------------------------

describe("annotations thinking (Task 1.3 / TH-7)", () => {
  it("TOOL_ANNOTATIONS contains a 'thinking' entry with readonly:true", async () => {
    const { TOOL_ANNOTATIONS } = await import("../src/tools/annotations.js");
    const entry = TOOL_ANNOTATIONS.find((a) => a.name === "thinking");
    expect(entry, "annotations.ts must list 'thinking'").toBeDefined();
    expect(entry!.readonly).toBe(true);
    // And NOT classified as readwrite (would block it in plan mode).
    expect((entry as any).readwrite).not.toBe(true);
  });

  it("getReadOnlyForPlanMode('thinking') returns {allowed:true, reasons:[]}", async () => {
    const { getReadOnlyForPlanMode } = await import(
      "../src/tools/annotations.js"
    );
    const result = getReadOnlyForPlanMode("thinking");
    expect(result.allowed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("canonicalToolName('thinking') is 'thinking' (no prefix stripping)", async () => {
    const { canonicalToolName } = await import("../src/tools/annotations.js");
    expect(canonicalToolName("thinking")).toBe("thinking");
  });
});
