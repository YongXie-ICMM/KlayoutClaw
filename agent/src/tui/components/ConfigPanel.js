// ConfigPanel implementation (compiled from ConfigPanel.tsx)
// Uses lazy ink require() to avoid top-level await issue with yoga-layout.
// When this file is require()'d from tests, ink is loaded lazily at render time,
// which works because ink is already in the ESM module cache by that point.
import React, { useEffect, useRef } from "react";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Pre-load ink and deps via dynamic import (non-blocking, no TLA)
// These resolve before any component render because React render is async
let _ink, _configMod, _annotationsMod;
const _ready = Promise.all([
  import("ink").then(m => { _ink = m; }),
  Promise.resolve().then(() => {
    // Inline save functions — avoids importing config.ts which has deep .js->ts resolution issues
    _configMod = {
      saveModelConfig(config, configDir) {
        const cfgDir = configDir ?? join(import.meta.url.replace("file://", "").replace(/\/src\/.*/, ""), ".qlaybot", "config");
        mkdirSync(cfgDir, { recursive: true });
        const data = { defaultModel: config.agent.defaultModel, thinkingLevel: config.agent.thinkingLevel, providers: config.models.providers };
        writeFileSync(join(cfgDir, "model.json"), JSON.stringify(data, null, 2));
      },
      saveSettingsConfig(config, configDir) {
        const cfgDir = configDir ?? join(import.meta.url.replace("file://", "").replace(/\/src\/.*/, ""), ".qlaybot", "config");
        mkdirSync(cfgDir, { recursive: true });
        const data = { memory: config.memory, mcpTimeouts: config.mcpTimeouts, tui: config.tui, compaction: config.compaction, subagent: config.subagent, search: config.search, embedding: config.embedding };
        writeFileSync(join(cfgDir, "settings.json"), JSON.stringify(data, null, 2));
      },
    };
  }),
  import("../../tools/annotations.ts").then(m => { _annotationsMod = m; }).catch(() => {
    _annotationsMod = {
      getToolIcon(ann) {
        if (ann.readonly) return "\u{1F440}";
        if (ann.readwrite) return "\u{1F58A}\uFE0F";
        if (ann.backgroundable) return "\u26A1";
        return "";
      }
    };
  }),
]);
function ink() { return _ink; }
function configMod() { return _configMod; }
function annotationsMod() { return _annotationsMod; }

const TAB_ORDER = ["settings", "models", "mcp"];
const SETTABLE_KEYS = [
  {
    key: "thinking",
    getValuePath: (c) => String(c.agent.thinkingLevel),
    file: "model.json",
    apply: (c, v) => { c.agent.thinkingLevel = v; },
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

function buildModelList(config) {
  const entries = [];
  const headers = new Map();
  for (const [provName, provConfig] of Object.entries(config.models.providers)) {
    headers.set(entries.length, provName);
    for (const m of provConfig.models) {
      entries.push({ provider: provName, model: m, ref: `${provName}/${m.id}` });
    }
  }
  return { headers, entries };
}

function formatContextWindow(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function ConfigPanel({ config, configPanelState, dispatch, configDir, mcpServers }) {
  const { Box, Text, useInput, useStdin } = ink();
  const { saveModelConfig, saveSettingsConfig } = configMod();
  const { getToolIcon } = annotationsMod();

  const { tab, editing, editValue, cursors, mcpDrilldown } = configPanelState;

  const stdinHook = useStdin();
  const editingRef = useRef(editing);
  const mcpDrilldownRef = useRef(mcpDrilldown);
  const tabRef = useRef(tab);
  editingRef.current = editing;
  mcpDrilldownRef.current = mcpDrilldown;
  tabRef.current = tab;

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
    const handler = (data) => {
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
        handleMcpSpaceToggle();
      } else if (str === "r" && tabRef.current === "mcp" && mcpDrilldownRef.current.level === "servers") {
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
    dispatchRef.current({ type: "CONFIG_PANEL_MCP_TOGGLE_TOOL", tool: tool.name, server: server.key });
    const cfgDir = configDirRef.current;
    if (!cfgDir) return;
    mkdirSync(cfgDir, { recursive: true });
    if (selectedServer === "klayout") {
      // KLayout server: persist to klayout.json
      const klayoutPath = join(cfgDir, "klayout.json");
      let klayoutData;
      if (existsSync(klayoutPath)) {
        try { klayoutData = JSON.parse(readFileSync(klayoutPath, "utf8")); } catch { klayoutData = {}; }
      } else {
        klayoutData = {};
      }
      if (!Array.isArray(klayoutData.disabledTools)) klayoutData.disabledTools = [];
      const disabledTools = klayoutData.disabledTools;
      if (tool.disabled) {
        klayoutData.disabledTools = disabledTools.filter((t) => t !== tool.name);
      } else {
        if (!disabledTools.includes(tool.name)) disabledTools.push(tool.name);
      }
      writeFileSync(klayoutPath, JSON.stringify(klayoutData, null, 2));
    } else {
      // Generic MCP server: persist to mcp.json under <server>.disabledTools
      const mcpPath = join(cfgDir, "mcp.json");
      let mcpData;
      if (existsSync(mcpPath)) {
        try { mcpData = JSON.parse(readFileSync(mcpPath, "utf8")); } catch { mcpData = {}; }
      } else {
        mcpData = {};
      }
      if (!mcpData[selectedServer]) mcpData[selectedServer] = {};
      if (!Array.isArray(mcpData[selectedServer].disabledTools)) mcpData[selectedServer].disabledTools = [];
      const disabledTools = mcpData[selectedServer].disabledTools;
      if (tool.disabled) {
        mcpData[selectedServer].disabledTools = disabledTools.filter((t) => t !== tool.name);
      } else {
        if (!disabledTools.includes(tool.name)) disabledTools.push(tool.name);
      }
      writeFileSync(mcpPath, JSON.stringify(mcpData, null, 2));
    }
  }

  useInput((_input, key) => {
    if (key.leftArrow) {
      const curIdx = TAB_ORDER.indexOf(tab);
      if (curIdx > 0) dispatch({ type: "CONFIG_PANEL_TAB_CHANGE", tab: TAB_ORDER[curIdx - 1] });
      return;
    }
    if (key.rightArrow) {
      const curIdx = TAB_ORDER.indexOf(tab);
      if (curIdx < TAB_ORDER.length - 1) dispatch({ type: "CONFIG_PANEL_TAB_CHANGE", tab: TAB_ORDER[curIdx + 1] });
      return;
    }
    if (key.downArrow) { dispatch({ type: "CONFIG_PANEL_NAVIGATE", direction: "down" }); return; }
    if (key.upArrow) { dispatch({ type: "CONFIG_PANEL_NAVIGATE", direction: "up" }); return; }
    if (key.escape) {
      if (editing) dispatch({ type: "CONFIG_PANEL_EDIT_CANCEL" });
      else if (tab === "mcp" && mcpDrilldown.level === "tools") dispatch({ type: "CONFIG_PANEL_MCP_BACK" });
      else dispatch({ type: "CONFIG_PANEL_CLOSE" });
      return;
    }
    if (key.return) {
      if (tab === "settings") {
        if (!editing) {
          const settableKey = SETTABLE_KEYS[cursors.settings];
          if (settableKey) dispatch({ type: "CONFIG_PANEL_EDIT_START", currentValue: settableKey.getValuePath(config) });
        } else {
          const settableKey = SETTABLE_KEYS[cursors.settings];
          if (settableKey && settableKey.validate(editValue)) {
            settableKey.apply(config, editValue);
            if (settableKey.file === "model.json") saveModelConfig(config, configDir);
            else saveSettingsConfig(config, configDir);
            dispatch({ type: "CONFIG_PANEL_EDIT_CONFIRM", newValue: editValue });
          } else {
            dispatch({ type: "CONFIG_PANEL_EDIT_CANCEL" });
          }
        }
      } else if (tab === "models") {
        const { entries } = buildModelList(config);
        const idx = cursors.models;
        if (idx >= 0 && idx < entries.length) {
          const entry = entries[idx];
          config.agent.defaultModel = entry.ref;
          saveModelConfig(config, configDir);
          dispatch({ type: "CONFIG_PANEL_SELECT" });
        }
      } else if (tab === "mcp") {
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
  });

  const tabHeaders = TAB_ORDER.map((t) => {
    const label = t === "mcp" ? "MCP" : t.charAt(0).toUpperCase() + t.slice(1);
    return t === tab ? `[${label}]` : label;
  }).join("  ");

  let content;
  if (tab === "settings") {
    content = React.createElement(Box, { flexDirection: "column" },
      SETTABLE_KEYS.map((sk, idx) => {
        const isCursor = idx === cursors.settings;
        const value = sk.getValuePath(config);
        const prefix = isCursor ? "> " : "  ";
        const isEditing = isCursor && editing;
        return React.createElement(Text, { key: sk.key },
          `${prefix}${sk.key}  ${isEditing ? `[${editValue}]` : value}`);
      })
    );
  } else if (tab === "models") {
    const { headers, entries } = buildModelList(config);
    const items = [];
    let entryIdx = 0;
    for (const entry of entries) {
      const headerText = headers.get(entryIdx);
      if (headerText) items.push(React.createElement(Text, { key: `header-${headerText}`, bold: true }, headerText));
      const isCursor = entryIdx === cursors.models;
      const isCurrent = config.agent.defaultModel === entry.ref || config.agent.defaultModel.includes(entry.model.id);
      const prefix = isCursor ? "> " : "  ";
      const star = isCurrent ? " *" : "";
      const ctxWindow = formatContextWindow(entry.model.contextWindow);
      const cost = `$${entry.model.cost.input}/$${entry.model.cost.output}`;
      items.push(React.createElement(Text, { key: entry.ref },
        `${prefix}${entry.model.name}  ${ctxWindow}  ${cost}${star}`));
      entryIdx++;
    }
    content = React.createElement(Box, { flexDirection: "column" }, ...items);
  } else if (tab === "mcp") {
    const servers = mcpServers ?? [];
    if (mcpDrilldown.level === "tools") {
      const server = servers.find((s) => s.key === mcpDrilldown.selectedServer);
      const serverName = server?.displayName ?? mcpDrilldown.selectedServer ?? "unknown";
      const tools = server?.tools ?? [];
      const toolCount = tools.length;
      const toolLabel = toolCount === 1 ? "tool" : "tools";
      const toolItems = tools.length === 0
        ? [React.createElement(Text, { key: "empty" }, "  No tools available")]
        : tools.map((tool, idx) => {
            const isCursor = idx === cursors.mcp;
            const prefix = isCursor ? "> " : "  ";
            const enableIcon = tool.disabled ? "\u2717" : "\u2713";
            let icon;
            if (tool.disabled) icon = "\u{1F512}";
            else if (tool.annotation) icon = getToolIcon(tool.annotation);
            else icon = "";
            return React.createElement(Text, { key: tool.name },
              `${prefix}${enableIcon} ${tool.name} ${icon}`);
          });
      content = React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, null, `\u2190 ${serverName} (${toolCount} ${toolLabel})`),
        ...toolItems);
    } else {
      content = React.createElement(Box, { flexDirection: "column" },
        ...servers.map((server, idx) => {
          const isCursor = idx === cursors.mcp;
          const prefix = isCursor ? "> " : "  ";
          const statusIcon = server.connected ? "\u25CF" : "\u25CB";
          const toolCount = server.tools.length;
          const toolLabel = toolCount === 1 ? "tool" : "tools";
          return React.createElement(Text, { key: server.key },
            `${prefix}${statusIcon} ${server.displayName}  ${toolCount} ${toolLabel}`);
        })
      );
    }
  }

  return React.createElement(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 },
    React.createElement(Text, null, tabHeaders),
    React.createElement(Box, { marginTop: 1, flexDirection: "column" }, content)
  );
}

export default ConfigPanel;
