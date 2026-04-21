/**
 * Shows thinking text with dim italic styling.
 * Displays a spinner while thinking is active, truncates to last ~10 lines.
 *
 * v0.4.4 §3 / TH-6 / TH-9: `source` prop distinguishes the three marker
 * origins. `"native"` (default for v0.4.3 BC) uses `theme.thinking`;
 * `"tool"` uses `theme.thinkingTool` so the TUI renders the `thinking`
 * tool scratchpad in a visually distinct color. `"inline"` shares the
 * native color (TH-9 reserves the field; no producer ships in v0.4.4).
 */

import React, { useMemo } from "react";
import { Text, Box } from "ink";
import { Spinner } from "@inkjs/ui";
import { theme } from "../theme.js";

export type ThinkingIndicatorSource = "tool" | "native" | "inline";

interface ThinkingIndicatorProps {
  chunks: string[];
  isActive: boolean;
  /**
   * v0.4.4 / TH-6 / TH-9 — source of the thinking content. Defaults to
   * `"native"` to preserve v0.4.3 rendering at call sites that don't
   * pass a source.
   */
  source?: ThinkingIndicatorSource;
}

const MAX_LINES = 10;

export function ThinkingIndicator({
  chunks,
  isActive,
  source = "native",
}: ThinkingIndicatorProps) {
  if (chunks.length === 0) return null;

  const display = useMemo(() => {
    const full = chunks.join("");
    const lines = full.split("\n");
    if (lines.length > MAX_LINES) {
      return `... ${lines.length - MAX_LINES} lines hidden ...\n${lines.slice(-MAX_LINES).join("\n")}`;
    }
    return full;
  }, [chunks]);

  // TH-6 / TH-9 — pick theme color by source. native + inline share the
  // v0.4.3 styling (dim italic); tool uses the distinct dim.italic.cyan
  // so the two surfaces are visually separable.
  const colorFn = source === "tool" ? theme.thinkingTool : theme.thinking;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {isActive && <Spinner label="" />}
        <Text>{colorFn(" thinking")}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text>{colorFn(display)}</Text>
      </Box>
    </Box>
  );
}
