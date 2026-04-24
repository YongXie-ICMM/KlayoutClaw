/**
 * Tool assembly — combines base tools, KLayout MCP tools, and custom tools.
 */

/** Base tools that must NEVER be disabled. */
const BASE_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);

/**
 * Filter out disabled tools from the full tool list.
 * Base tools (read, bash, edit, write) are NEVER filtered.
 */
export function filterDisabledTools(
  allToolNames: string[],
  disabledTools: string[],
): string[] {
  const disabled = new Set(disabledTools);
  return allToolNames.filter(
    (name) => BASE_TOOL_NAMES.has(name) || !disabled.has(name),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { MCPManager } from "../mcp/manager.js";
import type { MemoryManager } from "../memory/index.js";
import type { NamespacedTool } from "../mcp/types.js";
import type { ToolAnnotation, SubagentConfig } from "../types/v04-contracts.js";
import { createReadTool } from "./read.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createWriteTool } from "./write.js";
import { createMemorySaveTool, createMemorySearchTool } from "./memory.js";
import { createThinkingTool } from "./thinking.js";
import { Type } from "@sinclair/typebox";
import { SubagentRunner } from "../subagent/runner.js";
import { createDelegateTool } from "./delegate.js";
import { TOOL_ANNOTATIONS as DEFAULT_ANNOTATIONS } from "./annotations.js";
import type { PlanManager } from "../planning/index.js";
import {
  wrapWriteForPlanMode,
  wrapEditForPlanMode,
  wrapBashForPlanMode,
  wrapMCPToolForPlanMode,
  wrapToolForPlanDraftedFreeze,
} from "../planning/sandbox.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "./plan.js";

/**
 * Create base tools override (read, bash, edit, write).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBaseToolsOverride(cwd: string): Record<string, AgentTool<any>> {
  return {
    read: createReadTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
  };
}

/**
 * Build a TypeBox schema from a ToolInputSchema.
 * Converts JSON-Schema-subset property definitions to TypeBox types so
 * the Anthropic API receives the real parameter schemas (not a generic Record).
 */
function buildToolSchema(inputSchema: NamespacedTool["inputSchema"]) {
  const props: Record<string, any> = {};
  for (const [key, def] of Object.entries(inputSchema.properties ?? {})) {
    switch (def.type) {
      case "string":
        props[key] = Type.String({ description: def.description });
        break;
      case "integer":
        props[key] = Type.Integer({ description: def.description });
        break;
      case "number":
        props[key] = Type.Number({ description: def.description });
        break;
      case "boolean":
        props[key] = Type.Boolean({ description: def.description });
        break;
      case "array":
        props[key] = Type.Array(Type.Unknown(), { description: def.description });
        break;
      default:
        props[key] = Type.Unknown();
    }
  }

  const required = inputSchema.required ?? [];
  // TypeBox Type.Object marks all properties as required by default.
  // Split into required vs optional and use Type.Optional for optional ones.
  const finalProps: Record<string, ReturnType<typeof Type.Unknown>> = {};
  for (const [key, schema] of Object.entries(props)) {
    finalProps[key] = required.includes(key) ? schema : Type.Optional(schema);
  }

  return Type.Object(finalProps);
}

/**
 * Create MCP-backed tool wrappers.
 * Each NamespacedTool becomes an AgentTool that routes through the MCPManager.
 */
export function createMCPTools(
  mcpManager: MCPManager,
  namespacedTools: NamespacedTool[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any>[] {
  return namespacedTools.map((nt) => {
    // Build schema from the tool's real inputSchema so Claude sees correct parameters
    const schema = buildToolSchema(nt.inputSchema);

    return {
      name: nt.name,
      label: `${nt.group}/${nt.originalName}`,
      description: nt.description,
      parameters: schema,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> {
        const result = await mcpManager.callTool(nt.name, params);
        // Preserve both text and image blocks through the pi-agent tool
        // wrapper (spec §2.3). Previously this wrapper collapsed every
        // block into a single JSON.stringify(result) text payload, which
        // silently dropped image blocks. The new passthrough keeps the
        // Anthropic-shaped content array intact so downstream consumers
        // (TUI ToolPanel, the model itself) can render images inline.
        //
        // Note: pi-agent-core's AgentToolResult.content type is
        // `(TextContent | ImageContent)[]` where ImageContent uses the
        // legacy flat `{data, mimeType}` shape. We intentionally preserve
        // the nested Anthropic `{source:{type:"base64",media_type,data}}`
        // shape here — it's what downstream consumers (TUI ToolPanel) and
        // Claude's API expect — so the return is cast to satisfy the
        // looser runtime contract.
        const passthrough = result.content.filter(
          (c) =>
            (c.type === "text" && typeof c.text === "string") ||
            c.type === "image",
        );
        const content =
          passthrough.length > 0
            ? passthrough
            : [{ type: "text" as const, text: JSON.stringify(result) }];
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          content: content as any,
          details: result,
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as AgentTool<any>;
  });
}

/**
 * Create custom tools (memory_save, memory_search).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createCustomTools(memoryManager: MemoryManager): AgentTool<any>[] {
  return [
    createMemorySaveTool(memoryManager),
    createMemorySearchTool(memoryManager),
  ];
}

/**
 * Extended assembleTools signature that includes subagent/delegation support.
 * Returns tool map + SubagentRunner (if subagent enabled).
 */
export function assembleTools(opts: {
  config: { subagent: SubagentConfig; [key: string]: any };
  mcpManager: any;
  memoryManager: any;
  cwd: string;
  workspaceDir: string;
  annotations: ToolAnnotation[];
  disabledTools?: string[];
  getApiKey: (provider: string) => Promise<string | undefined>;
  defaultModel: string;
  defaultThinkingLevel: string;
  modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry;
  planManager?: PlanManager;
  isSubagent?: boolean;
  /**
   * v0.4.4 §4.7 — the per-session TranscriptMarkerEmitter. Constructed
   * once in createDesignSession and threaded through to tool factories
   * that need to emit markers (notably the `thinking` tool, landed by
   * G2 in Phase 1). Phase 0 only accepts the param and threads it; the
   * first producer wiring is G2's concern.
   */
  transcriptMarkerEmitter?: import("../events/marker-emitter.js").TranscriptMarkerEmitter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): { toolMap: Record<string, AgentTool<any>>; runner: SubagentRunner | null };

/**
 * Legacy assembleTools signature for backward compatibility.
 */
export function assembleTools(opts: {
  cwd: string;
  mcpManager: MCPManager;
  memoryManager: MemoryManager;
  disabledTools?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): { baseToolsOverride: Record<string, AgentTool<any>>; customTools: AgentTool<any>[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assembleTools(opts: any): any {
  // Extended signature — has config property
  if (opts.config) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolMap: Record<string, AgentTool<any>> = {};
    let runner: SubagentRunner | null = null;

    // Add base tools (may not be available when SDK is mocked in tests)
    try {
      const baseTools = createBaseToolsOverride(opts.cwd);
      for (const [name, tool] of Object.entries(baseTools)) {
        toolMap[name] = tool;
      }
    } catch (err: unknown) {
      // Log but don't crash — base tools may be unavailable in mocked test environments
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`assembleTools: base tool creation failed: ${msg}`);
    }

    // Add MCP tools
    try {
      const mcpTools = createMCPTools(opts.mcpManager, opts.mcpManager.allTools());
      for (const tool of mcpTools) {
        toolMap[tool.name] = tool;
      }
    } catch {
      // MCP tools unavailable (no connection or mocked environment)
    }

    // Add memory tools
    try {
      const memoryTools = createCustomTools(opts.memoryManager);
      for (const tool of memoryTools) {
        toolMap[tool.name] = tool;
      }
    } catch {
      // Memory tools unavailable in mocked environment
    }

    // v0.4.4 §3 / TH-4 — register the `thinking` tool whenever a
    // TranscriptMarkerEmitter is threaded through. createDesignSession
    // always passes one so `thinking` shows up in every real session's
    // `tools/list` (TH-4). Tests that skip the emitter (legacy callers
    // of the extended signature) simply won't get the tool registered.
    if (opts.transcriptMarkerEmitter) {
      const thinkingTool = createThinkingTool(opts.transcriptMarkerEmitter);
      toolMap[thinkingTool.name] = thinkingTool;
    }

    // Filter out disabled tools (base tools are never filtered)
    if (opts.disabledTools && opts.disabledTools.length > 0) {
      const baseNames = new Set(['read', 'bash', 'edit', 'write', 'thinking']);
      for (const name of Object.keys(toolMap)) {
        if (!baseNames.has(name) && opts.disabledTools.includes(name)) {
          delete toolMap[name];
        }
      }
    }

    // Register delegate tool whenever subagent is enabled. The pre-redesign
    // gate also required `Object.keys(roles).length > 0`, but after the
    // issue-#23 redesign the built-in `general-purpose` role is always a
    // reachable target. Keeping the length gate made fresh installs
    // (roles: {}) silently drop delegate, defeating the fallback (R3 #1).
    const subagentConfig: SubagentConfig = opts.config.subagent;
    const planManager: PlanManager | undefined = opts.planManager;
    if (subagentConfig?.enabled === true) {
      runner = new SubagentRunner({
        config: subagentConfig,
        mcpManager: opts.mcpManager,
        memoryManager: opts.memoryManager,
        workspaceDir: opts.workspaceDir,
        annotations: opts.annotations,
        getApiKey: opts.getApiKey,
        defaultModel: opts.defaultModel,
        defaultThinkingLevel: opts.defaultThinkingLevel,
        modelRegistry: opts.modelRegistry,
      });
      const delegateTool = createDelegateTool(runner, subagentConfig, planManager);
      toolMap[delegateTool.name] = delegateTool;
    }

    // Plan-mode wiring (spec §9 step 5). When a PlanManager is provided and
    // we are NOT running as a subagent, wrap base tools + MCP tools, register
    // plan tools, and run the deny-by-default allowlist assertion.
    const isSubagent: boolean = opts.isSubagent === true;
    if (planManager && !isSubagent) {
      // Wrap base tools (sandbox: write/edit only write inside plansDir,
      // bash fully blocked in plan mode).
      if (toolMap.write) toolMap.write = wrapWriteForPlanMode(toolMap.write, planManager, opts.cwd);
      if (toolMap.edit) toolMap.edit = wrapEditForPlanMode(toolMap.edit, planManager, opts.cwd);
      if (toolMap.bash) toolMap.bash = wrapBashForPlanMode(toolMap.bash, planManager);
      if (toolMap.read) toolMap.read = wrapToolForPlanDraftedFreeze(toolMap.read, planManager);

      // Register plan tools.
      const enterTool = createEnterPlanModeTool(planManager);
      const exitTool = createExitPlanModeTool(planManager);
      toolMap[enterTool.name] = enterTool;
      toolMap[exitTool.name] = exitTool;
      if (toolMap.memory_save) toolMap.memory_save = wrapToolForPlanDraftedFreeze(toolMap.memory_save, planManager);
      if (toolMap.memory_search) toolMap.memory_search = wrapToolForPlanDraftedFreeze(toolMap.memory_search, planManager);
      // R5 finding #1: do NOT wrap delegate with the plan_drafted freeze.
      // Its own execute() already handles plan-mode (returns
      // plan_mode_restricted + emits `cancelled` so the TUI clears the
      // SUBAGENT_PLACEHOLDER). The freeze wrapper short-circuits before
      // execute runs, so the cancelled event never fires and the placeholder
      // leaks. Delegate owns its own plan-mode contract.
      if (toolMap.thinking) toolMap.thinking = wrapToolForPlanDraftedFreeze(toolMap.thinking, planManager);
      toolMap[enterTool.name] = wrapToolForPlanDraftedFreeze(toolMap[enterTool.name], planManager);
      toolMap[exitTool.name] = wrapToolForPlanDraftedFreeze(toolMap[exitTool.name], planManager);

      // Wrap every MCP-backed tool (exclude base/memory/plan/delegate/thinking).
      const NON_MCP = new Set([
        "read",
        "write",
        "edit",
        "bash",
        "memory_save",
        "memory_search",
        "enter_plan_mode",
        "exit_plan_mode",
        "delegate",
        // v0.4.4 §3 / TH-4 — `thinking` is a qlaybot-native tool, not
        // MCP-backed. Exclude from MCP-wrap loop so it keeps its bare
        // factory handler (which the annotations allow under TH-7).
        "thinking",
      ]);
      const wrappedMCPTools = new Set<string>();
      for (const [name, tool] of Object.entries(toolMap)) {
        if (!NON_MCP.has(name)) {
          toolMap[name] = wrapMCPToolForPlanMode(tool, planManager);
          wrappedMCPTools.add(name);
        }
      }

      // Deny-by-default allowlist (spec §1.5 step 4 + §9 step 5e): every tool
      // in toolMap must be either an allowlisted base/memory/plan/delegate
      // name OR wrapped via wrapMCPToolForPlanMode above. Unknown tools
      // surface as a loud startup failure.
      const ALLOWED_BASE = new Set([
        "read",
        "write",
        "edit",
        "bash",
        "memory_save",
        "memory_search",
        "enter_plan_mode",
        "exit_plan_mode",
        "delegate",
        // v0.4.4 §3 / TH-4 — `thinking` is allowlisted in plan mode
        // (TH-7 / annotations.ts classifies it readonly).
        "thinking",
      ]);
      for (const name of Object.keys(toolMap)) {
        if (!ALLOWED_BASE.has(name) && !wrappedMCPTools.has(name)) {
          throw new Error(
            `assembleTools: tool "${name}" escaped the plan-mode sandbox — ` +
              `it is neither an allowlist base/memory/plan/delegate tool nor ` +
              `wrapped via wrapMCPToolForPlanMode. This is a deny-by-default ` +
              `allowlist violation.`,
          );
        }
      }
    }

    return { toolMap, runner };
  }

  // Legacy signature
  const baseToolsOverride = createBaseToolsOverride(opts.cwd);

  let mcpTools: AgentTool<any>[] = [];
  try {
    mcpTools = createMCPTools(opts.mcpManager, opts.mcpManager.allTools());
  } catch {
    // mcpManager may not have allTools in test scenarios
  }

  const memoryTools = createCustomTools(opts.memoryManager);
  let customTools = [...mcpTools, ...memoryTools];

  // Filter out disabled tools (base tools are never filtered)
  if (opts.disabledTools && opts.disabledTools.length > 0) {
    const allNames = customTools.map((t: any) => t.name);
    const allowedNames = new Set(filterDisabledTools(allNames, opts.disabledTools));
    customTools = customTools.filter((t: any) => allowedNames.has(t.name));
  }

  return {
    baseToolsOverride,
    customTools,
  };
}
