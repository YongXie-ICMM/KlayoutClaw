/**
 * MessageList — renders conversation messages using sub-components.
 * Delegates to UserMessage, AssistantMessage, SystemMessage.
 */

import React from "react";
import { Box, Text } from "ink";
import type { MessageData, AssistantMessageData } from "../types.js";
import { UserMessage } from "./UserMessage.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { SystemMessage } from "./SystemMessage.js";
import { theme } from "../theme.js";

interface MessageListProps {
  messages: MessageData[];
  currentStreaming: AssistantMessageData | null;
  toolDetailExpanded?: boolean;
  thinkingExpanded?: boolean;
  verbose?: boolean;
}

/**
 * Render only the most recent messages. Older ones remain in state for
 * /compact + history persistence but are not reconciled every frame —
 * Ink's full-tree reconciliation over a 1000-message transcript is what
 * drives the setImmediate → Set-constructor allocations that drove the TUI
 * into OOM. 50 is enough to show current context plus a scrollback buffer.
 */
const RENDER_WINDOW = 50;

export function MessageList({
  messages,
  currentStreaming,
  toolDetailExpanded = false,
  thinkingExpanded = false,
  verbose = false,
}: MessageListProps) {
  const visible =
    messages.length > RENDER_WINDOW ? messages.slice(-RENDER_WINDOW) : messages;
  const hiddenCount = messages.length - visible.length;
  return (
    <Box flexDirection="column" flexGrow={1}>
      {hiddenCount > 0 && (
        <Box marginY={0}>
          <Text>
            {theme.muted(
              `… ${hiddenCount} earlier message${hiddenCount === 1 ? "" : "s"} hidden (still in context for /compact) …`,
            )}
          </Text>
        </Box>
      )}
      {visible.map((msg) => {
        switch (msg.role) {
          case "user":
            return (
              <Box key={msg.id} marginY={0}>
                <UserMessage text={msg.text} />
              </Box>
            );
          case "system":
            return (
              <Box key={msg.id} marginY={0}>
                <SystemMessage text={msg.text} sections={msg.sections} />
              </Box>
            );
          case "assistant":
            return (
              <Box key={msg.id} marginY={0}>
                <AssistantMessage
                  message={msg}
                  toolDetailExpanded={toolDetailExpanded}
                  thinkingExpanded={thinkingExpanded}
                  verbose={verbose}
                />
              </Box>
            );
        }
      })}
      {currentStreaming && (
        <Box marginY={0}>
          <AssistantMessage
            message={currentStreaming}
            toolDetailExpanded={toolDetailExpanded}
            thinkingExpanded={thinkingExpanded}
            verbose={verbose}
          />
        </Box>
      )}
    </Box>
  );
}
