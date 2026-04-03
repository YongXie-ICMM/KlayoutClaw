/**
 * Displays a tool execution with Claude Code-style informative summaries.
 * Compact mode (default): header line + result summary + optional diff preview.
 * Expanded mode: full args + truncated result (8 head + 8 tail).
 */

import React, { useMemo } from "react";
import { Text, Box } from "ink";
import { Spinner } from "@inkjs/ui";
import figures from "figures";
import cliTruncate from "cli-truncate";
import { theme } from "../theme.js";
import type { ToolExecution } from "../types.js";

interface ToolPanelProps {
  tool: ToolExecution;
  expanded?: boolean;
}

const MAX_RESULT_LINES = 8;
const MAX_DIFF_LINES = 3;

// ── Utility helpers ──

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function getPath(args: unknown): string {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return "";
  const obj = args as Record<string, unknown>;
  const p = obj.file_path ?? obj.path;
  return typeof p === "string" ? p : "";
}

/**
 * Extract the text content from a tool result.
 * Pi-Agent results are AgentToolResult: { content: [{type: "text", text: "..."}], details: {} }
 * Falls back to JSON.stringify for other shapes.
 */
function resultAsString(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      const textParts = (obj.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (textParts.length > 0) return textParts.join("\n");
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function truncate(s: string, maxLen: number): string {
  if (maxLen <= 0) return s;
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

// ── Compact header (tool name + key arg) ──

function compactHeader(tool: ToolExecution, maxWidth: number): string {
  const args = tool.args as Record<string, unknown> | null;
  const name = tool.toolName;
  const nameLower = name.toLowerCase();

  if (nameLower === "bash") {
    const cmd = (args?.command as string) || "";
    const available = maxWidth - name.length - 2; // "Bash(" + ")"
    return `${name}(${truncate(cmd, available)})`;
  }

  if (nameLower === "read") {
    const p = getPath(args);
    if (!p) return `${name}(?)`;
    const offset = args?.offset as number | undefined;
    const limit = args?.limit as number | undefined;
    if (offset != null && limit != null) {
      return `${name}(${p}:${offset}-${offset + limit - 1})`;
    }
    if (offset != null) {
      return `${name}(${p}:${offset})`;
    }
    return `${name}(${p})`;
  }

  if (nameLower === "edit") {
    const p = getPath(args);
    return p ? `${name}(${p})` : `${name}(?)`;
  }

  if (nameLower === "write") {
    const p = getPath(args);
    return p ? `${name}(${p})` : `${name}(?)`;
  }

  // KLayout tools and fallback: show first string arg
  if (args != null && typeof args === "object") {
    for (const val of Object.values(args as Record<string, unknown>)) {
      if (typeof val === "string") {
        const available = maxWidth - name.length - 4;
        return `${name}("${truncate(val, available)}")`;
      }
    }
  }
  return name;
}

// ── Compact result summary (second line with ⎿ prefix) ──

function compactResultSummary(tool: ToolExecution): string | null {
  if (tool.status === "running") return null;
  if (tool.status === "backgrounded") {
    return tool.backgroundTaskId
      ? `\u2192 ${tool.backgroundTaskId} (running in background)`
      : "running in background";
  }

  const args = tool.args as Record<string, unknown> | null;
  const result = resultAsString(tool.result);
  const nameLower = tool.toolName.toLowerCase();

  switch (nameLower) {
    case "bash": {
      if (!result || result.trim() === "") return "(no output)";
      const lines = result.split("\n").filter((l) => l !== "");
      if (lines.length === 1) return truncate(lines[0], 60);
      return `${lines.length} lines of output`;
    }
    case "read": {
      if (!result) return null;
      const lineCount = result.split("\n").length;
      return `${lineCount} lines`;
    }
    case "edit": {
      const oldText = ((args?.old_string ?? args?.oldText ?? args?.old_text ?? "") as string);
      const newText = ((args?.new_string ?? args?.newText ?? args?.new_text ?? "") as string);
      const removed = oldText ? oldText.split("\n").length : 0;
      const added = newText ? newText.split("\n").length : 0;
      if (removed === 0 && added === 0) return "Changed";
      if (removed === added) return `Changed ${removed} lines`;
      return `Added ${added} lines, removed ${removed} lines`;
    }
    case "write": {
      const content = (args?.content as string) || "";
      if (!content) return null;
      const lineCount = content.split("\n").length;
      return `${lineCount} lines`;
    }
    default:
      // For other tools, show the result if short
      if (result) {
        const lines = result.split("\n").filter((l) => l !== "");
        if (lines.length === 1) return truncate(lines[0], 60);
        if (lines.length > 1) return `${lines.length} lines`;
      }
      return null;
  }
}

// ── Edit diff preview ──

function editDiffPreview(tool: ToolExecution): string[] | null {
  if (tool.toolName.toLowerCase() !== "edit" || tool.status !== "completed") return null;

  const args = tool.args as Record<string, unknown> | null;
  if (!args) return null;

  const oldText = ((args.old_string ?? args.oldText ?? args.old_text ?? "") as string).trimEnd();
  const newText = ((args.new_string ?? args.newText ?? args.new_text ?? "") as string).trimEnd();
  if (!oldText && !newText) return null;

  const removedLines = oldText ? oldText.split("\n") : [];
  const addedLines = newText ? newText.split("\n") : [];
  const lines: string[] = [];

  const showRemoved = removedLines.slice(0, MAX_DIFF_LINES);
  for (const l of showRemoved) {
    lines.push(`- ${l}`);
  }
  if (removedLines.length > MAX_DIFF_LINES) {
    lines.push(`  ... ${removedLines.length - MAX_DIFF_LINES} more removed`);
  }

  const showAdded = addedLines.slice(0, MAX_DIFF_LINES);
  for (const l of showAdded) {
    lines.push(`+ ${l}`);
  }
  if (addedLines.length > MAX_DIFF_LINES) {
    lines.push(`  ... ${addedLines.length - MAX_DIFF_LINES} more added`);
  }

  return lines.length > 0 ? lines : null;
}

// ── Formatting helpers (for expanded view) ──

function formatArgs(args: unknown): string {
  if (args == null) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatResult(result: unknown): string {
  if (result == null) return "";
  const s = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const lines = s.split("\n");
  if (lines.length <= MAX_RESULT_LINES * 2) return s;
  const head = lines.slice(0, MAX_RESULT_LINES).join("\n");
  const tail = lines.slice(-MAX_RESULT_LINES).join("\n");
  return `${head}\n  ... ${lines.length - MAX_RESULT_LINES * 2} lines hidden ...\n${tail}`;
}

function formatDuration(tool: ToolExecution): string {
  if (!tool.endTime) return "";
  const ms = tool.endTime - tool.startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Component ──

export function ToolPanel({ tool, expanded }: ToolPanelProps) {
  const cols = process.stdout.columns || 80;

  const statusIcon = useMemo(() => {
    switch (tool.status) {
      case "running":
        return <Spinner label="" />;
      case "completed":
        return <Text>{theme.toolSuccess(figures.tick)}</Text>;
      case "error":
        return <Text>{theme.toolError(figures.cross)}</Text>;
      case "backgrounded":
        return <Text color="cyan">{"\u21E1"}</Text>;
    }
  }, [tool.status]);

  const duration = formatDuration(tool);
  const durationSuffix = duration ? ` (${duration})` : "";

  // ── Compact view (default) ──
  if (!expanded) {
    const header = compactHeader(tool, cols - 10);
    const headerLine = header + durationSuffix;
    const summary = compactResultSummary(tool);
    const diffLines = editDiffPreview(tool);

    return (
      <Box flexDirection="column">
        <Box>
          {statusIcon}
          <Text> </Text>
          <Text>{tool.status === "error"
            ? theme.toolError(headerLine)
            : theme.toolName(headerLine)}</Text>
        </Box>
        {summary && (
          <Box marginLeft={3}>
            <Text>{theme.muted("\u23BF  " + summary)}</Text>
          </Box>
        )}
        {diffLines && diffLines.map((line, i) => (
          <Box key={i} marginLeft={3}>
            <Text>
              {line.startsWith("+ ")
                ? theme.toolSuccess(`   ${line}`)
                : line.startsWith("- ")
                  ? theme.toolError(`   ${line}`)
                  : theme.muted(`   ${line}`)}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  // ── Expanded view ──
  const header = compactHeader(tool, cols - 10);
  const headerText = `${header}${durationSuffix}`;
  const argsStr = formatArgs(tool.args);

  return (
    <Box flexDirection="column" marginY={0}>
      <Box>
        {statusIcon}
        <Text> </Text>
        <Text>{tool.status === "error" ? theme.toolError(headerText) : theme.toolName(headerText)}</Text>
      </Box>
      {argsStr && (
        <Box marginLeft={3}>
          <Text>{theme.toolArgs(cliTruncate(argsStr, cols - 6))}</Text>
        </Box>
      )}
      {tool.status !== "running" && tool.result != null && (
        <Box marginLeft={3} flexDirection="column">
          <Text>{theme.muted(formatResult(tool.result))}</Text>
        </Box>
      )}
    </Box>
  );
}
