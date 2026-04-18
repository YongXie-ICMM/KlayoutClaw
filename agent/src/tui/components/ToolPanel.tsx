/**
 * Displays a tool execution with Claude Code-style informative summaries.
 * Compact mode (default): header line + result summary + optional diff preview.
 * Expanded mode: full args + truncated result (8 head + 8 tail).
 */

import React, { useMemo, useState, useLayoutEffect } from "react";
import * as os from "node:os";
import { Text, Box } from "ink";
import { Spinner } from "@inkjs/ui";
import figures from "figures";
import cliTruncate from "cli-truncate";
import { theme } from "../theme.js";
import type { ToolExecution } from "../types.js";
import {
  detectImageRenderMode,
  base64DecodedSize,
  renderInlineImage,
  renderFallback,
} from "../image-render.js";

/**
 * Threshold above which the iTerm2 inline-image escape is skipped in favor
 * of the save-to-file fallback. Large base64 payloads blow up terminal
 * buffers and some terminals refuse to render them.
 */
const IMAGE_INLINE_MAX_BYTES = 2_000_000;

/**
 * Module-level LRU cache for the fallback (disk-writing) render path.
 *
 * Only the fallback path is cached here — `renderInlineImage` is pure (just
 * builds a string), no need to memoize. The cache's job is to prevent
 * re-writing the same image to tmp on re-mount / remount of a component
 * for the same tool result.
 *
 * The cache is populated inside `useLayoutEffect` (commit phase, never
 * render phase), so React's "no side effects in render" invariant holds.
 * One entry per `(tool.id, blockIdx, data.length)` for the lifetime of
 * the process — tool results in qlaybot are immutable once set by the
 * reducer on `tool_end`, so the key is safely stable.
 *
 * LRU-capped to bound memory on long sessions.
 */
const IMAGE_RENDER_CACHE_MAX = 200;
const imageRenderCache = new Map<string, string>();

function makeCacheKey(
  toolId: string,
  blockIdx: number,
  mediaType: string,
  dataLen: number,
): string {
  return `${toolId}:${blockIdx}:${mediaType}:${dataLen}`;
}

type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/**
 * Pull the `{type, ...}` content blocks out of an MCP tool result. Returns
 * empty array when the result is not shaped like an MCP tool-result.
 */
function extractContentBlocks(result: unknown): ContentBlock[] {
  if (result == null || typeof result !== "object") return [];
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const c of content) {
    if (c == null || typeof c !== "object") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = c as any;
    if (item.type === "text" && typeof item.text === "string") {
      out.push({ type: "text", text: item.text });
    } else if (
      item.type === "image" &&
      item.source != null &&
      typeof item.source === "object" &&
      typeof item.source.data === "string"
    ) {
      out.push({
        type: "image",
        source: {
          type: "base64",
          media_type:
            typeof item.source.media_type === "string"
              ? item.source.media_type
              : "image/png",
          data: item.source.data,
        },
      });
    }
  }
  return out;
}

interface ToolPanelProps {
  tool: ToolExecution;
  expanded?: boolean;
  /**
   * When true (from --verbose), the 8-head/8-tail formatResult truncation
   * is skipped and the full result is rendered verbatim. Default false
   * preserves Group 5 truncation behavior.
   */
  verbose?: boolean;
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
      // Once we've identified the pi-agent / MCP tool-result shape
      // (has a `content` array), compact mode concatenates the TEXT
      // blocks only. Image blocks are intentionally skipped — they
      // must never leak as base64 or JSON in the compact summary
      // (spec §2.5, qlaybot v0.4.3 Group 4). An image-only result
      // therefore returns the empty string here, which compact-mode
      // callers treat as "no summary".
      const textParts = (obj.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      return textParts.join("\n");
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

function formatResult(result: unknown, verbose = false): string {
  if (result == null) return "";
  const s = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (verbose) return s;
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

export function ToolPanel({ tool, expanded, verbose = false }: ToolPanelProps) {
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

  // Hooks MUST run unconditionally every render. Previously the useState +
  // useLayoutEffect below lived AFTER the `if (!expanded) return` branch, so
  // toggling Ctrl+T (expanded ↔ compact) changed the hook count and React
  // threw "Rendered more hooks than during the previous render." Compute the
  // image-block detection up front and run the hooks in every branch; the
  // results are only consumed in the expanded branch's JSX.
  const resultBlocks =
    tool.status !== "running" && tool.result != null
      ? extractContentBlocks(tool.result)
      : [];
  const hasImageBlock = resultBlocks.some((b) => b.type === "image");

  const [fallbackPaths, setFallbackPaths] = useState<Map<number, string>>(() => {
    const m = new Map<number, string>();
    for (let i = 0; i < resultBlocks.length; i++) {
      const b = resultBlocks[i];
      if (b.type !== "image") continue;
      const key = makeCacheKey(tool.id, i, b.source.media_type, b.source.data.length);
      const cached = imageRenderCache.get(key);
      if (cached !== undefined) m.set(i, cached);
    }
    return m;
  });

  useLayoutEffect(() => {
    if (!hasImageBlock) return;
    const mode = detectImageRenderMode();
    let nextMap: Map<number, string> | null = null;
    for (let i = 0; i < resultBlocks.length; i++) {
      const b = resultBlocks[i];
      if (b.type !== "image") continue;
      const size = base64DecodedSize(b.source.data);
      if (mode === "iterm2" && size <= IMAGE_INLINE_MAX_BYTES) continue;

      const key = makeCacheKey(tool.id, i, b.source.media_type, b.source.data.length);
      const existing = imageRenderCache.get(key);
      if (existing !== undefined) {
        imageRenderCache.delete(key);
        imageRenderCache.set(key, existing);
        if (!fallbackPaths.has(i) || fallbackPaths.get(i) !== existing) {
          if (nextMap === null) nextMap = new Map(fallbackPaths);
          nextMap.set(i, existing);
        }
        continue;
      }
      const rendered = renderFallback(
        b.source.data,
        os.tmpdir(),
        b.source.media_type,
      );
      imageRenderCache.set(key, rendered);
      if (imageRenderCache.size > IMAGE_RENDER_CACHE_MAX) {
        const oldest = imageRenderCache.keys().next().value;
        if (oldest !== undefined) imageRenderCache.delete(oldest);
      }
      if (nextMap === null) nextMap = new Map(fallbackPaths);
      nextMap.set(i, rendered);
    }
    if (nextMap !== null) setFallbackPaths(nextMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.id, resultBlocks.length, hasImageBlock]);

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
      {tool.status !== "running" && tool.result != null && !hasImageBlock && (
        <Box marginLeft={3} flexDirection="column">
          <Text>{theme.muted(formatResult(tool.result, verbose))}</Text>
        </Box>
      )}
      {tool.status !== "running" && tool.result != null && hasImageBlock && (
        <Box marginLeft={3} flexDirection="column">
          {resultBlocks.map((block, i) => {
            if (block.type === "image") {
              // Render-phase decision: PURE string computation only.
              // iTerm2 inline → pure escape string, safe during render.
              // Fallback → read pre-populated path from state (populated
              // by the useLayoutEffect above during commit phase).
              const mode = detectImageRenderMode();
              const size = base64DecodedSize(block.source.data);
              const canInline =
                mode === "iterm2" && size <= IMAGE_INLINE_MAX_BYTES;
              const rendered = canInline
                ? renderInlineImage(block.source.data)
                : fallbackPaths.get(i) ?? "[image loading...]";
              // Pin width generously and disable wrapping so long tmp-dir
              // paths (common on macOS: ~80 chars for /var/folders/...)
              // don't get folded across lines. The iTerm2 escape is a
              // single token without whitespace so this is a no-op for
              // inline-render; it matters for the fallback marker.
              return (
                <Box key={i} width={10_000}>
                  <Text wrap="truncate-end">{rendered}</Text>
                </Box>
              );
            }
            return <Text key={i}>{theme.muted(block.text)}</Text>;
          })}
        </Box>
      )}
    </Box>
  );
}
