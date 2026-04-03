// SubagentPanel implementation (compiled from SubagentPanel.tsx)
// Uses lazy ink require() to avoid top-level await issue with yoga-layout.
import React from "react";

let _ink;
const _ready = import("ink").then(m => { _ink = m; });
function ink() { return _ink; }

// Status icons
function statusIcon(status) {
  switch (status) {
    case "running":
      return "\u25CF"; // magenta ●
    case "completed":
      return "\u2713"; // green ✓
    case "error":
      return "\u2717"; // red ✗
    case "partial":
      return "\u25D0"; // yellow ◐
    default:
      return " ";
  }
}

// Format elapsed time as M:SS
function formatElapsed(startTime, endTime) {
  const elapsed = Math.floor(((endTime ?? Date.now()) - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return `0:${String(seconds).padStart(2, "0")}`;
}

// Truncate task to maxLen chars
function truncateTask(task, maxLen = 40) {
  if (task.length <= maxLen) return task;
  return task.slice(0, maxLen - 3) + "...";
}

// Render a single segment as text
function renderSegment(seg) {
  switch (seg.type) {
    case "thinking":
      return `\uD83E\uDD14 ${seg.text}`;
    case "text":
      return `\uD83D\uDCAC ${seg.text}`;
    case "tool_call": {
      let line = `\uD83D\uDD27 ${seg.toolName}`;
      if (seg.result) {
        line += `\n\u2192 ${seg.result}`;
      }
      return line;
    }
    case "injected":
      return `\uD83D\uDCE8 ${seg.text}`;
    default:
      return "";
  }
}

function SummaryBar({ state, dispatch }) {
  const { Box, Text } = ink();
  const entries = state.subagents;

  if (entries.length === 0) {
    return React.createElement(Box, { borderStyle: "single", flexDirection: "column", paddingX: 1 },
      React.createElement(Text, { bold: true }, "Subagents"),
      React.createElement(Text, { color: "gray" }, "No subagents"),
      React.createElement(Text, { dimColor: true }, "Esc: close"),
    );
  }

  return React.createElement(Box, { borderStyle: "single", flexDirection: "column", paddingX: 1 },
    React.createElement(Text, { bold: true }, "Subagents"),
    ...entries.map((entry, idx) => {
      const selected = idx === state.subagentSummaryIndex;
      const prefix = selected ? "> " : "  ";
      const icon = statusIcon(entry.status);
      const elapsed = formatElapsed(entry.startTime, entry.endTime);
      const tokens = entry.tokenUsage ?? "";
      const task = truncateTask(entry.task);
      const line = `${prefix}${icon} ${entry.role} ${task} ${elapsed}${tokens ? " " + tokens : ""}`;
      return React.createElement(Text, { key: entry.id, bold: selected }, line);
    }),
    React.createElement(Text, { dimColor: true }, "Up/Down: navigate | Enter: inspect | i: inject | k: kill | Esc: close"),
  );
}

function InspectWindow({ state, dispatch }) {
  const { Box, Text } = ink();
  const entry = state.subagents.find((s) => s.id === state.subagentInspectId);
  if (!entry) {
    return React.createElement(Box, { borderStyle: "single", flexDirection: "column", paddingX: 1 },
      React.createElement(Text, { bold: true }, "Inspect"),
      React.createElement(Text, { color: "gray" }, "No subagent selected"),
    );
  }

  const title = `${entry.role}: ${entry.task}`;
  const segments = entry.segments;

  const children = [
    React.createElement(Text, { key: "title", bold: true }, title),
    ...segments.map((seg, idx) =>
      React.createElement(Text, { key: `seg-${idx}` }, renderSegment(seg))
    ),
  ];

  if (state.subagentInjectMode) {
    children.push(
      React.createElement(Text, { key: "inject", color: "magenta" }, `>>> Inject message: ${state.subagentInjectValue}`)
    );
  }

  children.push(
    React.createElement(Text, { key: "footer", dimColor: true }, "Left/Right: switch | Up/Down: scroll | i: inject | Esc: back")
  );

  return React.createElement(Box, { borderStyle: "single", flexDirection: "column", paddingX: 1 }, ...children);
}

export function SubagentPanel({ state, dispatch }) {
  const { useInput } = ink();

  useInput((input, key) => {
    if (state.focusState === "subagent-summary") {
      if (key.downArrow) dispatch({ type: "SUBAGENT_NAVIGATE", direction: "down" });
      if (key.upArrow) dispatch({ type: "SUBAGENT_NAVIGATE", direction: "up" });
      if (key.return) {
        const entry = state.subagents[state.subagentSummaryIndex];
        if (entry) dispatch({ type: "SUBAGENT_INSPECT", subagentId: entry.id });
      }
      if (input === "i") {
        const entry = state.subagents[state.subagentSummaryIndex];
        if (entry && entry.status === "running") {
          dispatch({ type: "SUBAGENT_INJECT_START", subagentId: entry.id });
        }
      }
      if (input === "k") {
        const entry = state.subagents[state.subagentSummaryIndex];
        if (entry && entry.status === "running") {
          dispatch({ type: "SUBAGENT_KILL", subagentId: entry.id });
        }
      }
    } else if (state.focusState === "subagent-inspect") {
      if (key.leftArrow) dispatch({ type: "SUBAGENT_INSPECT_NAV", direction: "left" });
      if (key.rightArrow) dispatch({ type: "SUBAGENT_INSPECT_NAV", direction: "right" });
      if (key.upArrow) dispatch({ type: "SUBAGENT_INSPECT_SCROLL", direction: "up" });
      if (key.downArrow) dispatch({ type: "SUBAGENT_INSPECT_SCROLL", direction: "down" });
    }
  });

  // If inspecting (or injecting into) a specific subagent, show inspect window
  if (
    state.subagentInspectId != null &&
    (state.focusState === "subagent-inspect" || state.focusState === "subagent-inject")
  ) {
    return React.createElement(InspectWindow, { state, dispatch });
  }

  // Otherwise show summary bar
  return React.createElement(SummaryBar, { state, dispatch });
}

export default SubagentPanel;
