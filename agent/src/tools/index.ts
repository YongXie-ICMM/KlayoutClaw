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
import { Type } from "@sinclair/typebox";
import { SubagentRunner } from "../subagent/runner.js";
import { createDelegateTool } from "./delegate.js";
import { TOOL_ANNOTATIONS as DEFAULT_ANNOTATIONS } from "./annotations.js";

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
        const text = result.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");
        return {
          content: [
            { type: "text" as const, text: text || JSON.stringify(result) },
          ],
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

    // Filter out disabled tools (base tools are never filtered)
    if (opts.disabledTools && opts.disabledTools.length > 0) {
      const baseNames = new Set(['read', 'bash', 'edit', 'write']);
      for (const name of Object.keys(toolMap)) {
        if (!baseNames.has(name) && opts.disabledTools.includes(name)) {
          delete toolMap[name];
        }
      }
    }

    // Add delegate tool if subagent is enabled with roles
    const subagentConfig: SubagentConfig = opts.config.subagent;
    if (subagentConfig?.enabled && Object.keys(subagentConfig.roles).length > 0) {
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
      const delegateTool = createDelegateTool(runner, subagentConfig);
      toolMap[delegateTool.name] = delegateTool;
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
