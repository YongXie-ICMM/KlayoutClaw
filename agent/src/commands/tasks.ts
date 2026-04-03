/**
 * /tasks command — background task status.
 */

import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

export const tasksCommand: CommandHandler = {
  name: "tasks",
  description: "Show background task status",
  usage: "/tasks",
  async execute(_args: string[], context: CommandContext): Promise<CommandResult> {
    const btm = context.session.backgroundTaskManager;

    if (!btm) {
      return { output: "Background tasks not available.", exitCode: 1 };
    }

    const tasks = btm.list();
    if (tasks.length === 0) {
      return { output: "No background tasks.", exitCode: 0 };
    }

    const lines: string[] = ["Background Tasks:"];
    for (const task of tasks) {
      const elapsed = task.completedAt
        ? formatDuration(task.completedAt - task.startedAt)
        : formatDuration(Date.now() - task.startedAt);
      const statusIcon =
        task.status === "running" ? "*" : task.status === "completed" ? "v" : "x";
      const resultInfo =
        task.status === "completed" && task.result
          ? `  ${String(task.result).slice(0, 40)}`
          : task.status === "failed" && task.error
            ? `  ${task.error.slice(0, 40)}`
            : "";
      lines.push(
        `  #${task.id}  ${task.name.padEnd(30)} ${statusIcon} ${task.status.padEnd(12)} ${elapsed}${resultInfo}`,
      );
    }
    return { output: lines.join("\n"), exitCode: 0 };
  },
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
