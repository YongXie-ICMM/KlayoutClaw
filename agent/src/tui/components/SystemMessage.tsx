/**
 * Displays a system message with markdown rendering.
 * When `sections` prop is provided, renders interactive compact/expanded view.
 */

import React from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./MarkdownText.js";
import type { ContextSection } from "../types.js";

interface SystemMessageProps {
  text: string;
  sections?: ContextSection[];
  expanded?: boolean;
}

/** Pad title to a fixed column width for alignment. */
function padTitle(title: string, width = 20): string {
  return title.length >= width ? title + "  " : title + " ".repeat(width - title.length);
}

export function SystemMessage({ text, sections, expanded }: SystemMessageProps) {
  // Plain markdown fallback (no sections)
  if (!sections || sections.length === 0) {
    return (
      <Box marginY={0} paddingLeft={2}>
        <MarkdownText indent={2}>{text}</MarkdownText>
      </Box>
    );
  }

  // Structured section rendering
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      {sections.map((section, i) => (
        <Box key={i} flexDirection="column">
          <Text>
            <Text bold>{padTitle(section.title)}</Text>
            <Text dimColor>{section.summary}</Text>
          </Text>
          {expanded && section.details != null && (
            Array.isArray(section.details)
              ? section.details.map((detail, j) => (
                  <Text key={j} dimColor>{"    "}{detail}</Text>
                ))
              : <Text dimColor>{"    "}{section.details}</Text>
          )}
        </Box>
      ))}
      <Text dimColor>{expanded ? "(ctrl+t to collapse)" : "(ctrl+t to expand details)"}</Text>
    </Box>
  );
}
