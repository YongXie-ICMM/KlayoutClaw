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
}

export function MarkdownText({ children, indent = 0 }: MarkdownTextProps) {
  const { stdout } = useStdout();
  const cols = (stdout?.columns ?? process.stdout.columns ?? 80) - indent;
  const rendered = useMemo(() => renderMarkdown(children, cols), [children, cols]);
  if (!rendered) return null;
  return <Text>{rendered}</Text>;
}
