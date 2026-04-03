/**
 * SubagentPanel — two-level panel: summary bar + inspect window.
 * v0.4 Phase G
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { Chalk } from "chalk";
import type { TUIState, TUIAction } from "../types.js";
import type { SubagentTUIEntry, SubagentSegment } from "../../types/v04-contracts.js";

const chalk = new Chalk({ level: 3 });

interface SubagentPanelProps {
  state: TUIState;
  dispatch: (action: TUIAction) => void;
}

// Status icons
function statusIcon(status: SubagentTUIEntry["status"]): string {
  switch (status) {
    case "running":
      return chalk.magenta("\u25CF"); // ●
    case "completed":
      return chalk.green("\u2713"); // ✓
    case "error":
      return chalk.red("\u2717"); // ✗
    case "partial":
      return chalk.yellow("\u25D0"); // ◐
    default:
      return " ";
  }
}

// Format elapsed time as M:SS
function formatElapsed(startTime: number, endTime?: number): string {
  const elapsed = Math.floor(((endTime ?? Date.now()) - startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return `0:${String(seconds).padStart(2, "0")}`;
}

// Truncate task to maxLen chars
function truncateTask(task: string, maxLen = 40): string {
  if (task.length <= maxLen) return task;
  return task.slice(0, maxLen - 3) + "...";
}

// Render a single segment
function renderSegment(seg: SubagentSegment): string {
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

function SummaryBar({ state, dispatch }: SubagentPanelProps) {
  const entries = state.subagents;

  if (entries.length === 0) {
    return (
      <Box borderStyle="single" flexDirection="column" paddingX={1}>
        <Text bold>Subagents</Text>
        <Text color="gray">No subagents</Text>
        <Text dimColor>Esc: close</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>Subagents</Text>
      {entries.map((entry, idx) => {
        const selected = idx === state.subagentSummaryIndex;
        const prefix = selected ? "> " : "  ";
        const icon = statusIcon(entry.status);
        const elapsed = formatElapsed(entry.startTime, entry.endTime);
        const tokens = entry.tokenUsage ?? "";
        const task = truncateTask(entry.task);
        const line = `${prefix}${icon} ${entry.role} ${task} ${elapsed}${tokens ? " " + tokens : ""}`;
        return (
          <Text key={entry.id} bold={selected}>
            {line}
          </Text>
        );
      })}
      <Text dimColor>Up/Down: navigate | Enter: inspect | i: inject | k: kill | Esc: close</Text>
    </Box>
  );
}

function InspectWindow({ state, dispatch }: SubagentPanelProps) {
  const entry = state.subagents.find((s) => s.id === state.subagentInspectId);
  if (!entry) {
    return (
      <Box borderStyle="single" flexDirection="column" paddingX={1}>
        <Text bold>Inspect</Text>
        <Text color="gray">No subagent selected</Text>
      </Box>
    );
  }

  const title = `${entry.role}: ${entry.task}`;
  const visibleSegments = entry.segments.slice(state.subagentInspectScroll);

  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>{title}</Text>
      {visibleSegments.map((seg, idx) => (
        <Text key={state.subagentInspectScroll + idx}>{renderSegment(seg)}</Text>
      ))}
      {state.subagentInjectMode && (
        <Text color="magenta">{`>>> Inject message: ${state.subagentInjectValue}`}</Text>
      )}
      <Text dimColor>Left/Right: switch | Up/Down: scroll | i: inject | Esc: back</Text>
    </Box>
  );
}

export function SubagentPanel({ state, dispatch }: SubagentPanelProps) {
  const isActive = state.focusState === "subagent-summary" ||
    state.focusState === "subagent-inspect" ||
    state.focusState === "subagent-inject";

  useInput((input, key) => {
    if (state.focusState === "subagent-summary") {
      if (key.downArrow) dispatch({ type: "SUBAGENT_NAVIGATE", direction: "down" } as TUIAction);
      if (key.upArrow) dispatch({ type: "SUBAGENT_NAVIGATE", direction: "up" } as TUIAction);
      if (key.return) {
        const entry = state.subagents[state.subagentSummaryIndex];
        if (entry) dispatch({ type: "SUBAGENT_INSPECT", subagentId: entry.id } as TUIAction);
      }
      if (input === "i") {
        const entry = state.subagents[state.subagentSummaryIndex];
        if (entry && entry.status === "running") {
          dispatch({ type: "SUBAGENT_INJECT_START", subagentId: entry.id } as TUIAction);
        }
      }
      if (input === "k") {
        const entry = state.subagents[state.subagentSummaryIndex];
        if (entry && entry.status === "running") {
          dispatch({ type: "SUBAGENT_KILL", subagentId: entry.id } as TUIAction);
        }
      }
      if (input === "p") {
        const entry = state.subagents[state.subagentSummaryIndex];
        if (entry && entry.status === "running") {
          dispatch({ type: "SUBAGENT_PAUSE", subagentId: entry.id } as TUIAction);
        }
      }
    } else if (state.focusState === "subagent-inspect") {
      if (key.leftArrow) dispatch({ type: "SUBAGENT_INSPECT_NAV", direction: "left" } as TUIAction);
      if (key.rightArrow) dispatch({ type: "SUBAGENT_INSPECT_NAV", direction: "right" } as TUIAction);
      if (key.upArrow) dispatch({ type: "SUBAGENT_INSPECT_SCROLL", direction: "up" } as TUIAction);
      if (key.downArrow) dispatch({ type: "SUBAGENT_INSPECT_SCROLL", direction: "down" } as TUIAction);
    } else if (state.focusState === "subagent-inject") {
      if (key.return) {
        dispatch({ type: "SUBAGENT_INJECT_SUBMIT" } as TUIAction);
      } else if (key.backspace || key.delete) {
        dispatch({ type: "SUBAGENT_INJECT_BACKSPACE" } as TUIAction);
      } else if (input && !key.ctrl && !key.meta) {
        dispatch({ type: "SUBAGENT_INJECT_CHAR", char: input } as TUIAction);
      }
    }
  }, { isActive });

  // If inspecting (or injecting into) a specific subagent, show inspect window
  if (
    state.subagentInspectId != null &&
    (state.focusState === "subagent-inspect" || state.focusState === "subagent-inject")
  ) {
    return <InspectWindow state={state} dispatch={dispatch} />;
  }

  // Otherwise show summary bar
  return <SummaryBar state={state} dispatch={dispatch} />;
}
