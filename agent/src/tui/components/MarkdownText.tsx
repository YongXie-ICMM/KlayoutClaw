/**
 * Renders pre-formatted ANSI markdown text.
 *
 * Accepts an `indent` prop to subtract from the terminal width when
 * computing the wrap column.
 */

import React, { useMemo } from "react";
import { Text, useStdout } from "ink";
import { renderMarkdown } from "../markdown.js";

interface MarkdownTextProps {
  children: string;
  /** Number of columns consumed by parent layout (gutters, padding). */
  indent?: number;
  /**
   * When true, bypass pi-tui's word-wrap by rendering the markdown at a very
   * wide column count so long tokens (file paths, URLs) stay on their source
   * line. Ink's own text layout still handles truncation at the actual
   * terminal width. Default false (backward-compatible).
   */
  nowrap?: boolean;
}

export function MarkdownText({ children, indent = 0, nowrap = false }: MarkdownTextProps) {
  const { stdout } = useStdout();
  const cols = nowrap
    ? 100000
    : (stdout?.columns ?? process.stdout.columns ?? 80) - indent;
  const rendered = useMemo(() => renderMarkdown(children, cols), [children, cols]);
  if (!rendered) return null;
  return <Text>{rendered}</Text>;
}
