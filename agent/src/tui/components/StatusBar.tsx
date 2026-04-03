/**
 * StatusBar — MCP dot, phase display, model, plan badge, context colors, compaction.
 */

import React from "react";
import { Box, Text } from "ink";
import { Chalk } from "chalk";
import type { TUIState } from "../types.js";

const chalk = new Chalk({ level: 3 });

interface StatusBarProps {
  state: TUIState;
}

function contextColor(percent: number): (s: string) => string {
  if (percent >= 90) return chalk.red;
  if (percent >= 70) return chalk.yellow;
  return chalk.green;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function StatusBar({ state }: StatusBarProps) {
  // MCP dot: green when ready (no error), red when error/disconnected
  const mcpConnected = state.phase !== "error";
  const mcpDot = mcpConnected
    ? chalk.green("\u25CF")
    : chalk.red("\u25CF");

  // Phase display
  const phaseLabel = state.phase;
  const phaseColor =
    state.phase === "ready"
      ? chalk.green
      : state.phase === "streaming"
        ? chalk.yellow
        : state.phase === "tool_executing"
          ? chalk.cyan
          : state.phase === "error"
            ? chalk.red
            : chalk.gray;

  // Animated dots during streaming
  const phaseDots = state.phase === "streaming" ? "..." : "";

  // Context usage
  const ctxPct = state.contextUsage?.percent;
  const ctxLabel = ctxPct != null ? `${Math.floor(ctxPct)}%` : null;
  const ctxColorFn = ctxPct != null ? contextColor(ctxPct) : chalk.gray;

  // Background tasks
  const bgCount = state.backgroundTasks.length;

  // Build left section
  const leftParts: string[] = [
    mcpDot + " ",
    chalk.blue.bold("qlaybot"),
  ];
  if (state.modelName) {
    leftParts.push(chalk.gray(` | ${state.modelName}`));
  }
  if (state.inPlanMode) {
    leftParts.push(chalk.magenta(" | PLAN"));
  }
  if (bgCount > 0) {
    leftParts.push(chalk.yellow(` | bg: ${bgCount}`));
  }
  // Subagent badge: count running subagents
  const subRunning = state.subagents
    ? state.subagents.filter((s) => s.status === "running").length
    : 0;
  if (subRunning > 0) {
    leftParts.push(chalk.magenta(` | ${subRunning} sub`));
  }
  if (state.isCompacting) {
    leftParts.push(chalk.cyan(" | compacting"));
  }

  // Build right section
  const rightParts: string[] = [];
  if (ctxLabel) {
    rightParts.push(ctxColorFn(ctxLabel) + " ");
  }
  rightParts.push(phaseColor(phaseLabel + phaseDots));

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Text>{leftParts.join("")}</Text>
      <Text>{rightParts.join("")}</Text>
    </Box>
  );
}
