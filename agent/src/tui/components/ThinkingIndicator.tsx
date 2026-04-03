/**
 * Shows thinking text with dim italic styling.
 * Displays a spinner while thinking is active, truncates to last ~10 lines.
 */

import React, { useMemo } from "react";
import { Text, Box } from "ink";
import { Spinner } from "@inkjs/ui";
import { theme } from "../theme.js";

interface ThinkingIndicatorProps {
  chunks: string[];
  isActive: boolean;
}

const MAX_LINES = 10;

export function ThinkingIndicator({ chunks, isActive }: ThinkingIndicatorProps) {
  if (chunks.length === 0) return null;

  const display = useMemo(() => {
    const full = chunks.join("");
    const lines = full.split("\n");
    if (lines.length > MAX_LINES) {
      return `... ${lines.length - MAX_LINES} lines hidden ...\n${lines.slice(-MAX_LINES).join("\n")}`;
    }
    return full;
  }, [chunks]);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {isActive && <Spinner label="" />}
        <Text>{theme.thinking(" thinking")}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text>{theme.thinking(display)}</Text>
      </Box>
    </Box>
  );
}
