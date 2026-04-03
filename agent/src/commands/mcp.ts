/**
 * /mcp command — MCP server status, tools, reconnect, enable/disable.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

/** Base tools that cannot be disabled */
const BASE_TOOLS = ["read", "bash", "edit", "write", "memory_save", "memory_search"];

export const mcpCommand: CommandHandler = {
  name: "mcp",
  description: "MCP server management",
  usage: "/mcp [status|tools [server]|reconnect [server]|enable <tool>|disable <tool>]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const sub = args[0];
    const mcpManager = context.session.mcpManager;

    // Bare /mcp in TUI mode opens the ConfigPanel MCP tab
    if (!sub) {
      if (context.mode === "tui") {
        return {
          output: "",
          exitCode: 0,
          stateChange: { configPanel: { open: true, tab: "mcp" } },
        };
      }
      // Non-TUI: fall through to status
      return executeStatus(mcpManager);
    }

    switch (sub) {
      case "status":
        return executeStatus(mcpManager);

      case "tools": {
        const serverKey = args[1];
        const tools = mcpManager.allTools();
        if (serverKey) {
          const filtered = tools.filter((t: { name: string; description: string; group?: string }) => t.group === serverKey || t.name.startsWith(serverKey));
          if (filtered.length === 0) {
            return { output: `No tools found for server: ${serverKey}`, exitCode: 1 };
          }
          const lines = filtered.map((t: { name: string; description: string }) => `  ${t.name} — ${t.description.slice(0, 60)}`);
          return { output: `Tools for ${serverKey}:\n${lines.join("\n")}`, exitCode: 0 };
        }
        if (tools.length === 0) {
          return { output: "No MCP tools available.", exitCode: 0 };
        }
        const lines = tools.map((t: { name: string; description: string }) => `  ${t.name} — ${t.description.slice(0, 60)}`);
        return { output: `MCP Tools (${tools.length}):\n${lines.join("\n")}`, exitCode: 0 };
      }

      case "reconnect": {
        const serverKey = args[1];
        try {
          if (serverKey) {
            await mcpManager.reconnect(serverKey);
            return { output: `Reconnected to ${serverKey}`, exitCode: 0 };
          }
          await mcpManager.reconnectAll();
          return { output: "Reconnected all MCP servers", exitCode: 0 };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `Reconnect failed: ${msg}`, exitCode: 1 };
        }
      }

      case "disable": {
        const toolName = args[1];
        if (!toolName) {
          return { output: "Usage: /mcp disable <tool>", exitCode: 1 };
        }
        if (BASE_TOOLS.includes(toolName)) {
          return { output: `Cannot disable base tool "${toolName}".`, exitCode: 1 };
        }
        return toggleTool(context, toolName, true);
      }

      case "enable": {
        const toolName = args[1];
        if (!toolName) {
          return { output: "Usage: /mcp enable <tool>", exitCode: 1 };
        }
        return toggleTool(context, toolName, false);
      }

      default:
        return {
          output: `Unknown subcommand: ${sub}. Usage: ${mcpCommand.usage}`,
          exitCode: 1,
        };
    }
  },
};

function executeStatus(mcpManager: CommandContext["session"]["mcpManager"]): CommandResult {
  const servers = mcpManager.getServerKeys();
  if (servers.length === 0) {
    return { output: "MCP Servers: (none configured)", exitCode: 0 };
  }
  const lines: string[] = ["MCP Servers:"];
  for (const key of servers) {
    const connected = mcpManager.isConnected(key);
    const status = connected ? "* connected" : "o disconnected";
    const toolCount = connected ? mcpManager.getToolCount(key) : 0;
    const toolInfo = connected ? `${toolCount} tools` : "not discovered";
    lines.push(`  ${key.padEnd(25)} ${status.padEnd(16)} ${toolInfo}`);
  }
  return { output: lines.join("\n"), exitCode: 0 };
}

/**
 * Toggle a tool's disabled state.
 * Routes to klayout.json for klayout tools, mcp.json for other servers.
 * disable=true adds to disabledTools, disable=false removes.
 */
function toggleTool(context: CommandContext, toolName: string, disable: boolean): CommandResult {
  const configDir = (context.session as unknown as { configDir?: string }).configDir;
  if (!configDir) {
    return { output: "No config directory available", exitCode: 1 };
  }

  // Determine which server owns this tool
  const mcpManager = context.session.mcpManager;
  const allTools = mcpManager.allTools();
  const toolEntry = allTools.find((t: { name: string; group?: string }) => t.name === toolName);
  const serverGroup = toolEntry?.group ?? "klayout";

  if (serverGroup === "klayout") {
    return toggleToolKLayout(configDir, toolName, disable);
  } else {
    return toggleToolGeneric(configDir, serverGroup, toolName, disable);
  }
}

/** Toggle tool in klayout.json (existing behavior) */
function toggleToolKLayout(configDir: string, toolName: string, disable: boolean): CommandResult {
  const klayoutPath = join(configDir, "klayout.json");
  let klayoutData: Record<string, unknown>;

  if (existsSync(klayoutPath)) {
    try {
      klayoutData = JSON.parse(readFileSync(klayoutPath, "utf8"));
    } catch {
      klayoutData = {};
    }
  } else {
    // Create the file if it doesn't exist (SCC-C37)
    mkdirSync(configDir, { recursive: true });
    klayoutData = {};
  }

  // Ensure disabledTools array exists
  if (!Array.isArray(klayoutData.disabledTools)) {
    klayoutData.disabledTools = [];
  }

  const disabledTools = klayoutData.disabledTools as string[];

  if (disable) {
    if (!disabledTools.includes(toolName)) {
      disabledTools.push(toolName);
    }
  } else {
    klayoutData.disabledTools = disabledTools.filter((t: string) => t !== toolName);
  }

  writeFileSync(klayoutPath, JSON.stringify(klayoutData, null, 2));

  const action = disable ? "Disabled" : "Enabled";
  return { output: `${action} tool: ${toolName}`, exitCode: 0 };
}

/** Toggle tool in mcp.json under <serverKey>.disabledTools */
function toggleToolGeneric(configDir: string, serverKey: string, toolName: string, disable: boolean): CommandResult {
  const mcpPath = join(configDir, "mcp.json");
  let mcpData: Record<string, Record<string, unknown>>;

  if (existsSync(mcpPath)) {
    try {
      mcpData = JSON.parse(readFileSync(mcpPath, "utf8"));
    } catch {
      mcpData = {};
    }
  } else {
    mkdirSync(configDir, { recursive: true });
    mcpData = {};
  }

  // Ensure server entry and disabledTools array exist
  if (!mcpData[serverKey] || typeof mcpData[serverKey] !== "object") {
    mcpData[serverKey] = {};
  }
  if (!Array.isArray(mcpData[serverKey].disabledTools)) {
    mcpData[serverKey].disabledTools = [];
  }

  const disabledTools = mcpData[serverKey].disabledTools as string[];

  if (disable) {
    if (!disabledTools.includes(toolName)) {
      disabledTools.push(toolName);
    }
  } else {
    mcpData[serverKey].disabledTools = disabledTools.filter((t: string) => t !== toolName);
  }

  writeFileSync(mcpPath, JSON.stringify(mcpData, null, 2));

  const action = disable ? "Disabled" : "Enabled";
  return { output: `${action} tool: ${toolName}`, exitCode: 0 };
}
