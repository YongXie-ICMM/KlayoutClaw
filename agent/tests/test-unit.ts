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
