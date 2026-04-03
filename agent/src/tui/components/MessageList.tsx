/**
 * MessageList — renders conversation messages using sub-components.
 * Delegates to UserMessage, AssistantMessage, SystemMessage.
 */

import React from "react";
import { Box } from "ink";
import type { MessageData, AssistantMessageData } from "../types.js";
import { UserMessage } from "./UserMessage.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { SystemMessage } from "./SystemMessage.js";

interface MessageListProps {
  messages: MessageData[];
  currentStreaming: AssistantMessageData | null;
  toolDetailExpanded?: boolean;
  thinkingExpanded?: boolean;
}

export function MessageList({
  messages,
  currentStreaming,
  toolDetailExpanded = false,
  thinkingExpanded = false,
}: MessageListProps) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => {
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
          />
        </Box>
      )}
    </Box>
  );
}
