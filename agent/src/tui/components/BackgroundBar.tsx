/**
 * BackgroundBar — collapsed summary or expanded list of background tasks.
 */

import React from "react";
import { Box, Text } from "ink";
import { Chalk } from "chalk";
import type { BackgroundTaskSummaryTUI } from "../types.js";

const chalk = new Chalk({ level: 3 });

interface BackgroundBarProps {
  tasks: BackgroundTaskSummaryTUI[];
  expanded: boolean;
  onCancel?: (id: string) => void;
}

function statusColorFn(status: BackgroundTaskSummaryTUI["status"]): (s: string) => string {
  switch (status) {
    case "running":
      return chalk.yellow;
    case "completed":
      return chalk.green;
    case "failed":
    case "cancelled":
      return chalk.red;
  }
}

function formatElapsed(startedAt: number, completedAt?: number): string {
  const now = completedAt ?? Date.now();
  const ms = now - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

export function BackgroundBar({ tasks, expanded, onCancel }: BackgroundBarProps) {
  if (tasks.length === 0) return null;

  const runningCount = tasks.filter((t) => t.status === "running").length;
  const doneCount = tasks.filter((t) => t.status !== "running").length;

  if (!expanded) {
    // Collapsed summary: running/total counts
    return (
      <Box>
        <Text>
          {chalk.yellow(`bg: ${runningCount} running, ${doneCount} done (${tasks.length} total)`)}
        </Text>
      </Box>
    );
  }

  // Expanded: bordered task list
  const hasRunning = runningCount > 0;

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text>{chalk.bold(`Background Tasks (${tasks.length})`)}</Text>
      {tasks.map((task) => {
        const colorFn = statusColorFn(task.status);
        return (
          <Box key={task.id} marginLeft={1}>
            <Text>
              {colorFn(`[${task.status}]`)} {task.name} {chalk.dim(formatElapsed(task.startedAt, task.completedAt))}
              {task.error ? chalk.red(` - ${task.error}`) : ""}
            </Text>
          </Box>
        );
      })}
      {hasRunning && (
        <Box marginLeft={1}>
          <Text>{chalk.dim("k = cancel running task")}</Text>
        </Box>
      )}
    </Box>
  );
}
