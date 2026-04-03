/**
 * Yellow info bar showing live streaming metrics.
 * Visible only during streaming/tool_executing phases; hidden when idle.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import type { SessionPhase } from "../types.js";
import { theme } from "../theme.js";

export interface StreamingBarProps {
  phase: SessionPhase;
  tokenUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null;
  startedAt?: number;
  isThinking: boolean;
  hasBackgroundTasks?: boolean;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function StreamingBar({ phase, tokenUsage, startedAt, isThinking, hasBackgroundTasks }: StreamingBarProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (phase !== "streaming" && phase !== "tool_executing") return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [phase]);

  if (phase !== "streaming" && phase !== "tool_executing") return null;

  const parts: string[] = [];

  if (tokenUsage) {
    const { input, output, cacheRead, totalTokens } = tokenUsage;
    if (totalTokens > 0) {
      let usage = `${formatTokens(totalTokens)} tokens`;
      if (cacheRead > 0) {
        usage += ` (${formatTokens(cacheRead)} cached)`;
      }
      parts.push(usage);
    } else if (input > 0 || output > 0) {
      parts.push(`in: ${formatTokens(input)} / out: ${formatTokens(output)}`);
    }
  }

  if (startedAt) {
    const elapsed = (now - startedAt) / 1000;
    parts.push(`${elapsed.toFixed(1)}s`);
  }

  if (isThinking) {
    parts.push("thinking...");
  }

  // Keybinding hints
  const hints: string[] = [];
  if (hasBackgroundTasks) {
    hints.push("ctrl+g tasks");
  }

  if (parts.length === 0 && hints.length === 0) return null;

  return (
    <Box paddingLeft={2}>
      <Spinner label="" />
      <Text>{theme.statusActive(" " + parts.join(" | "))}</Text>
      {hints.length > 0 && (
        <Text dimColor>{"  " + hints.join("  ")}</Text>
      )}
    </Box>
  );
}
