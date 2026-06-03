/**
 * Tool factory — creates the tool set available to a subagent based on its role config.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { RoleConfig, ToolAnnotation } from "../types/v04-contracts.js";
import type { NamespacedTool, ToolInputSchema } from "../mcp/types.js";
import { Type } from "typebox";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { execSync } from "child_process";

/**
 * Dependencies injected into the tool factory.
 */
export interface ToolFactoryDeps {
  mcpManager: {
    callTool: (name: string, params: Record<string, unknown>) => Promise<any>;
  };
  memoryManager: {
    search: (query: string) => Promise<any[]>;
  };
  annotations: ToolAnnotation[];
  /** Namespaced MCP tools from mcpManager.allTools() — provides real names + schemas */
  mcpTools?: NamespacedTool[];
  /** Tools disabled at config level — excluded from all roles */
  disabledTools?: string[];
  resultCallback: (result: {
    status: string;
    findings: string[];
    warnings: string[];
    dataPaths?: string[];
  }) => void;
}

/**
 * Convert MCP ToolInputSchema to TypeBox schema for subagent tool registration.
 */
function buildProxySchema(inputSchema: ToolInputSchema) {
  const props: Record<string, any> = {};
  for (const [key, def] of Object.entries(inputSchema.properties ?? {})) {
    let schema: any;
    switch (def.type) {
      case "string":
        schema = Type.String({ description: def.description });
        break;
      case "integer":
        schema = Type.Integer({ description: def.description });
        break;
      case "number":
        schema = Type.Number({ description: def.description });
        break;
      case "boolean":
        schema = Type.Boolean({ description: def.description });
        break;
      case "array":
        schema = Type.Array(Type.Unknown(), { description: def.description });
        break;
      case "object":
        // Dynamic-key object (e.g. evaluate_design.layer_map) — render as a
        // real object schema, not Type.Unknown() (`{}`), so the model emits a
        // structured object rather than a JSON string the server can't parse.
        schema = Type.Object(
          {},
          { description: def.description, additionalProperties: true },
        );
        break;
      default:
        schema = Type.Unknown();
    }
    const required = inputSchema.required ?? [];
    props[key] = required.includes(key) ? schema : Type.Optional(schema);
  }
  return Type.Object(props);
}

/**
 * Create the tool list for a subagent based on its role configuration.
 *
 * - Base tools (read, bash, edit, write) are included only if in roleConfig.baseTools
 * - MCP proxy tools are filtered by mcpAccess annotation
 * - submit_result is always included (first-wins semantics)
 * - memory_search is included if in customTools
 * - "delegate" is NEVER included
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSubagentTools(roleConfig: RoleConfig, deps: ToolFactoryDeps): AgentTool<any>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: AgentTool<any>[] = [];

  // 1. Base tools — only those in roleConfig.baseTools, with real implementations
  const baseToolSet = new Set(roleConfig.baseTools);

  if (baseToolSet.has("read")) {
    tools.push({
      name: "read",
      label: "read",
      description: "Read a file from the filesystem",
      parameters: Type.Object({
        file_path: Type.String({ description: "Absolute path to the file to read" }),
      }),
      async execute(_toolCallId: string, params: any): Promise<AgentToolResult<any>> {
        try {
          const filePath = resolve(params.file_path ?? params.path);
          const text = readFileSync(filePath, "utf-8");
          return {
            content: [{ type: "text" as const, text }],
            details: { filePath },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Error reading file: ${err.message}` }],
            details: { error: true },
          };
        }
      },
    } as AgentTool<any>);
  }

  if (baseToolSet.has("bash")) {
    tools.push({
      name: "bash",
      label: "bash",
      description: "Execute a bash command",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
      }),
      async execute(_toolCallId: string, params: any): Promise<AgentToolResult<any>> {
        try {
          const output = execSync(params.command, {
            encoding: "utf-8",
            shell: "/bin/bash",
            timeout: 30000,
          });
          return {
            content: [{ type: "text" as const, text: output }],
            details: { command: params.command },
          };
        } catch (err: any) {
          const stderr = err.stderr ? String(err.stderr) : "";
          const stdout = err.stdout ? String(err.stdout) : "";
          const msg = stderr || stdout || err.message;
          return {
            content: [{ type: "text" as const, text: `Error (exit code ${err.status ?? "unknown"}): ${msg}` }],
            details: { command: params.command, error: true, exitCode: err.status },
          };
        }
      },
    } as AgentTool<any>);
  }

  if (baseToolSet.has("edit")) {
    tools.push({
      name: "edit",
      label: "edit",
      description: "Edit a file by replacing old_string with new_string",
      parameters: Type.Object({
        file_path: Type.String({ description: "Absolute path to the file to edit" }),
        old_string: Type.String({ description: "Text to find and replace" }),
        new_string: Type.String({ description: "Replacement text" }),
      }),
      async execute(_toolCallId: string, params: any): Promise<AgentToolResult<any>> {
        try {
          const filePath = resolve(params.file_path);
          const original = readFileSync(filePath, "utf-8");
          const idx = original.indexOf(params.old_string);
          if (idx === -1) {
            return {
              content: [{ type: "text" as const, text: "old_string not found in file" }],
              details: { filePath, error: true },
            };
          }
          const updated =
            original.slice(0, idx) +
            params.new_string +
            original.slice(idx + params.old_string.length);
          writeFileSync(filePath, updated, "utf-8");
          return {
            content: [{ type: "text" as const, text: updated }],
            details: { filePath },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Error editing file: ${err.message}` }],
            details: { error: true },
          };
        }
      },
    } as AgentTool<any>);
  }

  if (baseToolSet.has("write")) {
    tools.push({
      name: "write",
      label: "write",
      description: "Write content to a file",
      parameters: Type.Object({
        file_path: Type.String({ description: "Absolute path to the file to write" }),
        content: Type.String({ description: "File content to write" }),
      }),
      async execute(_toolCallId: string, params: any): Promise<AgentToolResult<any>> {
        try {
          const filePath = resolve(params.file_path);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, params.content, "utf-8");
          return {
            content: [{ type: "text" as const, text: `Wrote ${filePath}` }],
            details: { filePath },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Error writing file: ${err.message}` }],
            details: { error: true },
          };
        }
      },
    } as AgentTool<any>);
  }

  // 2. MCP proxy tools based on mcpAccess
  //    Resolve namespaced names + real schemas from mcpTools (bugs #5 and #9 fix)
  const mcpToolMap = new Map<string, NamespacedTool>();
  for (const t of deps.mcpTools ?? []) {
    mcpToolMap.set(t.originalName, t);
  }

  const disabled = new Set(deps.disabledTools ?? []);
  if (roleConfig.mcpAccess !== "none") {
    for (const ann of deps.annotations) {
      // Skip tools disabled at config level
      if (disabled.has(ann.name)) {
        continue;
      }
      // For shared-readonly, only include readonly tools
      if (roleConfig.mcpAccess === "shared-readonly" && !ann.readonly) {
        continue;
      }
      // For "full", include all annotated tools

      // Look up the real MCP tool for namespaced name + inputSchema
      const mcpTool = mcpToolMap.get(ann.name);
      const namespacedName = mcpTool?.name ?? ann.name;
      const schema = mcpTool?.inputSchema
        ? buildProxySchema(mcpTool.inputSchema)
        : Type.Object({});

      tools.push({
        name: ann.name,
        label: `mcp/${ann.name}`,
        description: mcpTool?.description ?? `MCP proxy: ${ann.name}`,
        parameters: schema,
        async execute(toolCallId: string, params: any): Promise<AgentToolResult<any>> {
          try {
            const result = await deps.mcpManager.callTool(namespacedName, params);
            const text = result.content
              ?.filter((c: any) => c.type === "text" && c.text)
              .map((c: any) => c.text)
              .join("\n") ?? JSON.stringify(result);
            return {
              content: [{ type: "text" as const, text }],
              details: result,
            };
          } catch (err: any) {
            return {
              content: [{ type: "text" as const, text: `Error calling MCP tool '${ann.name}': ${err.message}` }],
              details: { error: true },
            };
          }
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as AgentTool<any>);
    }
  }

  // 3. submit_result tool (first-wins)
  let resultSubmitted = false;
  if (roleConfig.customTools.includes("submit_result")) {
    tools.push({
      name: "submit_result",
      label: "submit_result",
      description: "Submit the final result of this subagent task. Can only be called once.",
      parameters: Type.Object({
        status: Type.String({ description: "Result status: completed, partial, or error" }),
        findings: Type.Array(Type.String(), { description: "List of findings" }),
        warnings: Type.Array(Type.String(), { description: "List of warnings" }),
        dataPaths: Type.Optional(Type.Array(Type.String(), { description: "List of data file paths" })),
      }),
      async execute(toolCallId: string, params: any): Promise<AgentToolResult<any>> {
        if (resultSubmitted) {
          return {
            content: [{ type: "text" as const, text: "Error: result already submitted. Only the first submission is accepted." }],
            details: { error: true },
          };
        }
        resultSubmitted = true;
        deps.resultCallback({
          status: params.status,
          findings: params.findings ?? [],
          warnings: params.warnings ?? [],
          dataPaths: params.dataPaths ?? [],
        });
        return {
          content: [{ type: "text" as const, text: "Result submitted successfully." }],
          details: { submitted: true },
        };
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as AgentTool<any>);
  }

  // 4. memory_search tool (if in customTools)
  if (roleConfig.customTools.includes("memory_search")) {
    tools.push({
      name: "memory_search",
      label: "memory_search",
      description: "Search the parent agent's memory store.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(toolCallId: string, params: any): Promise<AgentToolResult<any>> {
        try {
          const results = await deps.memoryManager.search(params.query);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(results) }],
            details: results,
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Error searching memory: ${err.message}` }],
            details: { error: true },
          };
        }
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as AgentTool<any>);
  }

  // NEVER include "delegate" — filter it out as a safety measure
  return tools.filter((t) => t.name !== "delegate");
}
