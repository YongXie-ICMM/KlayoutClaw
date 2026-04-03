/**
 * Displays a user message with "> " prefix in cyan.
 */

import React from "react";
import { Text, Box } from "ink";
import { theme } from "../theme.js";

interface UserMessageProps {
  text: string;
}

export function UserMessage({ text }: UserMessageProps) {
  return (
    <Box marginY={0}>
      <Box width={2} flexShrink={0}>
        <Text>{theme.userPrefix(">")}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text>{theme.userText(text)}</Text>
      </Box>
    </Box>
  );
}
