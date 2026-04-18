/**
 * AssistantMessage — segment-based chronological rendering of assistant responses.
 * Delegates to MarkdownText, ThinkingIndicator, and ToolPanel for each segment type.
 */

import React from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./MarkdownText.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { ToolPanel } from "./ToolPanel.js";
import type { AssistantMessageData, AssistantSegment } from "../types.js";
import { theme } from "../theme.js";

interface AssistantMessageProps {
  message: AssistantMessageData;
  toolDetailExpanded?: boolean;
  thinkingExpanded?: boolean;
  verbose?: boolean;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AssistantMessage({
  message,
  toolDetailExpanded = false,
  thinkingExpanded = false,
  verbose = false,
}: AssistantMessageProps) {
  const { segments, isStreaming, startedAt, completedAt } = message;

  // Streaming with no segments: show placeholder
  if (isStreaming && segments.length === 0) {
    return (
      <Box flexDirection="column" marginY={0}>
        <Text color="yellow">...</Text>
      </Box>
    );
  }

  const showFooter = !isStreaming && startedAt != null && completedAt != null;
  const elapsed = showFooter ? completedAt! - startedAt! : 0;

  return (
    <Box flexDirection="column" marginY={0}>
      {segments.map((segment, idx) => renderSegment(segment, idx, {
        thinkingExpanded,
        toolDetailExpanded,
        isLastSegment: idx === segments.length - 1,
        isStreaming,
        verbose,
      }))}
      {showFooter && (
        <Box marginLeft={2}>
          <Text>{theme.muted(formatDuration(elapsed))}</Text>
        </Box>
      )}
    </Box>
  );
}

function renderSegment(
  segment: AssistantSegment,
  idx: number,
  opts: {
    thinkingExpanded: boolean;
    toolDetailExpanded: boolean;
    isLastSegment: boolean;
    isStreaming: boolean;
    verbose?: boolean;
  },
) {
  switch (segment.type) {
    case "thinking": {
      const isActive = opts.isLastSegment && opts.isStreaming;
      if (!opts.thinkingExpanded && !isActive) {
        // Collapsed non-active thinking: show just the label
        return (
          <Box key={`thinking-${idx}`} marginLeft={2}>
            <Text>{theme.thinking("thinking")}</Text>
          </Box>
        );
      }
      if (!opts.thinkingExpanded) {
        // Collapsed but active: show label only (no text)
        return (
          <Box key={`thinking-${idx}`} marginLeft={2}>
            <Text>{theme.thinking("thinking")}</Text>
          </Box>
        );
      }
      // Expanded: delegate to ThinkingIndicator
      return (
        <Box key={`thinking-${idx}`}>
          <ThinkingIndicator chunks={segment.chunks} isActive={isActive} />
        </Box>
      );
    }
    case "text":
      return (
        <Box key={`text-${idx}`}>
          <MarkdownText>{segment.chunks.join("")}</MarkdownText>
        </Box>
      );
    case "tool":
      return (
        <Box key={`tool-${idx}`}>
          <ToolPanel tool={segment.tool} expanded={opts.toolDetailExpanded} verbose={opts.verbose ?? false} />
        </Box>
      );
  }
}
