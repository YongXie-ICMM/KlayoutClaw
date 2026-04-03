/**
 * ConfigPanel — modal settings/models/mcp configuration panel.
 * v0.4 Phase C1: Settings + Models tabs.
 * v0.4 Phase C2: MCP tab with server list + tool drilldown.
 */

import React, { useEffect, useRef } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { QlayBotConfig } from "../../config.js";
import { saveModelConfig, saveSettingsConfig } from "../../config.js";
import type { ConfigPanelState, ConfigPanelTab, ToolAnnotation } from "../../types/v04-contracts.js";
import type { TUIAction } from "../types.js";
import { getToolIcon } from "../../tools/annotations.js";

const TAB_ORDER: ConfigPanelTab[] = ["settings", "models", "mcp"];

/** SETTABLE_KEYS — must match the keys in commands/config.ts */
const SETTABLE_KEYS: {
  key: string;
  getValuePath: (config: QlayBotConfig) => string;
  file: string;
  apply: (config: QlayBotConfig, value: string) => void;
  validate: (v: string) => boolean;
}[] = [
  {
    key: "thinking",
    getValuePath: (c) => String(c.agent.thinkingLevel),
    file: "model.json",
    apply: (c, v) => { c.agent.thinkingLevel = v as QlayBotConfig["agent"]["thinkingLevel"]; },
    validate: (v) => ["off", "minimal", "low", "medium", "high", "xhigh"].includes(v),
  },
  {
    key: "model",
    getValuePath: (c) => String(c.agent.defaultModel),
    file: "model.json",
    apply: (c, v) => { c.agent.defaultModel = v; },
    validate: () => true,
  },
  {
    key: "memory.maxResults",
    getValuePath: (c) => String(c.memory.autoRecall.maxResults),
    file: "settings.json",
    apply: (c, v) => { c.memory.autoRecall.maxResults = Number(v); },
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  {
    key: "memory.maxEntries",
    getValuePath: (c) => String(c.memory.budget.maxEntriesPerCategory),
    file: "settings.json",
    apply: (c, v) => { c.memory.budget.maxEntriesPerCategory = Number(v); },
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
];

interface ModelEntry {
  provider: string;
  model: QlayBotConfig["models"]["providers"][string]["models"][number];
  ref: string;
}

function buildModelList(config: QlayBotConfig): { headers: Map<number, string>; entries: ModelEntry[] } {
  const entries: ModelEntry[] = [];
  const headers = new Map<number, string>();
  for (const [provName, provConfig] of Object.entries(config.models.providers)) {
    headers.set(entries.length, provName);
    for (const m of provConfig.models) {
      entries.push({ provider: provName, model: m, ref: `${provName}/${m.id}` });
    }
  }
  return { headers, entries };
}

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// MCP Server Data (passed from App.tsx)
// ---------------------------------------------------------------------------

export interface MCPServerData {
  key: string;
  displayName: string;
  connected: boolean;
  tools: Array<{
    name: string;
    description: string;
    disabled: boolean;
    annotation?: ToolAnnotation;
  }>;
}

export interface ConfigPanelProps {
  config: QlayBotConfig;
  configPanelState: ConfigPanelState;
  dispatch: (action: TUIAction) => void;
  configDir?: string;
  mcpServers?: MCPServerData[];
}

export function ConfigPanel({ config, configPanelState, dispatch, configDir, mcpServers }: ConfigPanelProps) {
  const { tab, editing, editValue, cursors, mcpDrilldown } = configPanelState;

  // Raw stdin listener for Escape -- useInput defers bare \x1b by ~100ms,
  // so we use useStdin for immediate escape detection.
  const stdinHook = useStdin();
  const editingRef = useRef(editing);
  const mcpDrilldownRef = useRef(mcpDrilldown);
  const tabRef = useRef(tab);
  editingRef.current = editing;
  mcpDrilldownRef.current = mcpDrilldown;
  tabRef.current = tab;

  // Refs for MCP server data and cursors (for Space handler)
  const mcpServersRef = useRef(mcpServers);
  const cursorsRef = useRef(cursors);
  const configDirRef = useRef(configDir);
  const dispatchRef = useRef(dispatch);
  mcpServersRef.current = mcpServers;
  cursorsRef.current = cursors;
  configDirRef.current = configDir;
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!stdinHook?.stdin) return;
    const handler = (data: Buffer) => {
      const str = data.toString();
      if (str === "\x1b") {
        if (editingRef.current) {
          dispatchRef.current({ type: "CONFIG_PANEL_EDIT_CANCEL" });
        } else if (tabRef.current === "mcp" && mcpDrilldownRef.current.level === "tools") {
          dispatchRef.current({ type: "CONFIG_PANEL_MCP_BACK" });
        } else {
          dispatchRef.current({ type: "CONFIG_PANEL_CLOSE" });
        }
      } else if (str === " " && tabRef.current === "mcp" && mcpDrilldownRef.current.level === "tools") {
        // Space toggles tool enabled/disabled in MCP tool drilldown
        handleMcpSpaceToggle();
      } else if (str === "r" && tabRef.current === "mcp" && mcpDrilldownRef.current.level === "servers") {
        // 'r' key dispatches reconnect for selected server
        const servers = mcpServersRef.current ?? [];
        const serverIdx = cursorsRef.current.mcp;
        if (serverIdx >= 0 && serverIdx < servers.length) {
          dispatchRef.current({ type: "CONFIG_PANEL_MCP_RECONNECT", server: servers[serverIdx].key });
        }
      }
    };
    stdinHook.stdin.on("data", handler);
    return () => { stdinHook.stdin.off("data", handler); };
  }, [stdinHook?.stdin]);

  function handleMcpSpaceToggle() {
    const servers = mcpServersRef.current ?? [];
    const selectedServer = mcpDrilldownRef.current.selectedServer;
    const server = servers.find((s) => s.key === selectedServer);
    if (!server || server.tools.length === 0) return;

    const toolIdx = cursorsRef.current.mcp;
    if (toolIdx < 0 || toolIdx >= server.tools.length) return;

    const tool = server.tools[toolIdx];

    // Dispatch toggle action
    dispatchRef.current({ type: "CONFIG_PANEL_MCP_TOGGLE_TOOL", tool: tool.name, server: server.key });

    // Persist to config file based on server type
    const cfgDir = configDirRef.current;
    if (!cfgDir) return;

    if (server.key === "klayout") {
      // KLayout tools → klayout.json
      const klayoutPath = join(cfgDir, "klayout.json");
      let klayoutData: Record<string, unknown>;

      if (existsSync(klayoutPath)) {
        try {
          klayoutData = JSON.parse(readFileSync(klayoutPath, "utf8"));
        } catch {
          klayoutData = {};
        }
      } else {
        mkdirSync(cfgDir, { recursive: true });
        klayoutData = {};
      }

      if (!Array.isArray(klayoutData.disabledTools)) {
        klayoutData.disabledTools = [];
      }

      const disabledTools = klayoutData.disabledTools as string[];
      if (tool.disabled) {
        klayoutData.disabledTools = disabledTools.filter((t: string) => t !== tool.name);
      } else {
        if (!disabledTools.includes(tool.name)) {
          disabledTools.push(tool.name);
        }
      }

      writeFileSync(klayoutPath, JSON.stringify(klayoutData, null, 2));
    } else {
      // Generic MCP server tools → mcp.json under <server>.disabledTools
      const mcpPath = join(cfgDir, "mcp.json");
      let mcpData: Record<string, unknown>;

      if (existsSync(mcpPath)) {
        try {
          mcpData = JSON.parse(readFileSync(mcpPath, "utf8"));
        } catch {
          mcpData = {};
        }
      } else {
        mkdirSync(cfgDir, { recursive: true });
        mcpData = {};
      }

      const serverData = (mcpData[server.key] ?? {}) as Record<string, unknown>;
      if (!Array.isArray(serverData.disabledTools)) {
        serverData.disabledTools = [];
      }

      const disabledTools = serverData.disabledTools as string[];
      if (tool.disabled) {
        serverData.disabledTools = disabledTools.filter((t: string) => t !== tool.name);
      } else {
        if (!disabledTools.includes(tool.name)) {
          disabledTools.push(tool.name);
        }
      }

      mcpData[server.key] = serverData;
      writeFileSync(mcpPath, JSON.stringify(mcpData, null, 2));
    }
  }

  useInput((_input, key) => {
    // Tab navigation: left/right
    if (key.leftArrow) {
      const curIdx = TAB_ORDER.indexOf(tab);
      if (curIdx > 0) {
        dispatch({ type: "CONFIG_PANEL_TAB_CHANGE", tab: TAB_ORDER[curIdx - 1] });
      }
      return;
    }
    if (key.rightArrow) {
      const curIdx = TAB_ORDER.indexOf(tab);
      if (curIdx < TAB_ORDER.length - 1) {
        dispatch({ type: "CONFIG_PANEL_TAB_CHANGE", tab: TAB_ORDER[curIdx + 1] });
      }
      return;
    }

    // Up/Down navigation
    if (key.downArrow) {
      dispatch({ type: "CONFIG_PANEL_NAVIGATE", direction: "down" });
      return;
    }
    if (key.upArrow) {
      dispatch({ type: "CONFIG_PANEL_NAVIGATE", direction: "up" });
      return;
    }

    // Escape
    if (key.escape) {
      if (editing) {
        dispatch({ type: "CONFIG_PANEL_EDIT_CANCEL" });
      } else if (tab === "mcp" && mcpDrilldown.level === "tools") {
        dispatch({ type: "CONFIG_PANEL_MCP_BACK" });
      } else {
        dispatch({ type: "CONFIG_PANEL_CLOSE" });
      }
      return;
    }

    // Enter
    if (key.return) {
      if (tab === "settings") {
        if (!editing) {
          // Start editing current key
          const settableKey = SETTABLE_KEYS[cursors.settings];
          if (settableKey) {
            const currentValue = settableKey.getValuePath(config);
            dispatch({ type: "CONFIG_PANEL_EDIT_START", currentValue });
          }
        } else {
          // Confirm edit: validate and persist
          const settableKey = SETTABLE_KEYS[cursors.settings];
          if (settableKey && settableKey.validate(editValue)) {
            // Apply to config in-memory
            settableKey.apply(config, editValue);
            // Persist to disk
            if (settableKey.file === "model.json") {
              saveModelConfig(config, configDir);
            } else {
              saveSettingsConfig(config, configDir);
            }
            dispatch({ type: "CONFIG_PANEL_EDIT_CONFIRM", newValue: editValue });
          } else {
            // Invalid value — cancel without persisting
            dispatch({ type: "CONFIG_PANEL_EDIT_CANCEL" });
          }
        }
      } else if (tab === "models") {
        // Select model at cursor
        const { entries } = buildModelList(config);
        const idx = cursors.models;
        if (idx >= 0 && idx < entries.length) {
          const entry = entries[idx];
          config.agent.defaultModel = entry.ref;
          saveModelConfig(config, configDir);
          dispatch({ type: "CONFIG_PANEL_SELECT" });
        }
      } else if (tab === "mcp") {
        // In MCP tab: Enter drills into server from server list
        if (mcpDrilldown.level === "servers") {
          const servers = mcpServers ?? [];
          const idx = cursors.mcp;
          if (idx >= 0 && idx < servers.length) {
            dispatch({ type: "CONFIG_PANEL_MCP_DRILLDOWN", server: servers[idx].key });
          }
        }
      }
      return;
    }
  }, { isActive: configPanelState.open });

  // Render tab header
  const tabHeaders = TAB_ORDER.map((t) => {
    const label = t === "mcp" ? "MCP" : t.charAt(0).toUpperCase() + t.slice(1);
    if (t === tab) {
      return `[${label}]`;
    }
    return label;
  }).join("  ");

  // Render tab content
  let content: React.ReactNode;
  if (tab === "settings") {
    content = (
      <Box flexDirection="column">
        {SETTABLE_KEYS.map((sk, idx) => {
          const isCursor = idx === cursors.settings;
          const value = sk.getValuePath(config);
          const prefix = isCursor ? "> " : "  ";
          const isEditing = isCursor && editing;
          return (
            <Text key={sk.key}>
              {prefix}{sk.key}  {isEditing ? `[${editValue}]` : value}
            </Text>
          );
        })}
      </Box>
    );
  } else if (tab === "models") {
    const { headers, entries } = buildModelList(config);
    const items: React.ReactNode[] = [];
    let entryIdx = 0;
    for (const entry of entries) {
      const headerText = headers.get(entryIdx);
      if (headerText) {
        items.push(
          <Text key={`header-${headerText}`} bold>
            {headerText}
          </Text>
        );
      }
      const isCursor = entryIdx === cursors.models;
      const isCurrent = config.agent.defaultModel === entry.ref || config.agent.defaultModel.includes(entry.model.id);
      const prefix = isCursor ? "> " : "  ";
      const star = isCurrent ? " *" : "";
      const ctxWindow = formatContextWindow(entry.model.contextWindow);
      const cost = `$${entry.model.cost.input}/$${entry.model.cost.output}`;
      items.push(
        <Text key={entry.ref}>
          {prefix}{entry.model.name}  {ctxWindow}  {cost}{star}
        </Text>
      );
      entryIdx++;
    }
    content = <Box flexDirection="column">{items}</Box>;
  } else if (tab === "mcp") {
    content = renderMcpTab();
  } else {
    content = <Text>Unknown tab</Text>;
  }

  function renderMcpTab(): React.ReactNode {
    const servers = mcpServers ?? [];

    if (mcpDrilldown.level === "tools") {
      return renderMcpToolList(servers);
    }

    // Server list view
    return (
      <Box flexDirection="column">
        {servers.map((server, idx) => {
          const isCursor = idx === cursors.mcp;
          const prefix = isCursor ? "> " : "  ";
          const statusIcon = server.connected ? "\u25CF" : "\u25CB"; // ● or ○
          const toolCount = server.tools.length;
          const toolLabel = toolCount === 1 ? "tool" : "tools";
          return (
            <Text key={server.key}>
              {prefix}{statusIcon} {server.displayName}  {toolCount} {toolLabel}
            </Text>
          );
        })}
      </Box>
    );
  }

  function renderMcpToolList(servers: MCPServerData[]): React.ReactNode {
    const server = servers.find((s) => s.key === mcpDrilldown.selectedServer);
    const serverName = server?.displayName ?? mcpDrilldown.selectedServer ?? "unknown";
    const tools = server?.tools ?? [];
    const toolCount = tools.length;
    const toolLabel = toolCount === 1 ? "tool" : "tools";

    return (
      <Box flexDirection="column">
        <Text>{"\u2190"} {serverName} ({toolCount} {toolLabel})</Text>
        {tools.length === 0 ? (
          <Text>  No tools available</Text>
        ) : (
          tools.map((tool, idx) => {
            const isCursor = idx === cursors.mcp;
            const prefix = isCursor ? "> " : "  ";
            const enableIcon = tool.disabled ? "\u2717" : "\u2713"; // ✗ or ✓
            // Icon logic: if disabled → lock, else use annotation icon
            let icon: string;
            if (tool.disabled) {
              icon = "\u{1F512}"; // 🔒
            } else if (tool.annotation) {
              icon = getToolIcon(tool.annotation);
            } else {
              icon = "";
            }
            return (
              <Text key={tool.name}>
                {prefix}{enableIcon} {tool.name} {icon}
              </Text>
            );
          })
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text>{tabHeaders}</Text>
      <Box marginTop={1} flexDirection="column">
        {content}
      </Box>
    </Box>
  );
}

export default ConfigPanel;
