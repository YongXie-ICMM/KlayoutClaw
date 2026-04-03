/**
 * Background task custom tools — background_status and background_result.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { BackgroundTaskManager } from "../background/index.js";
import { Type } from "@sinclair/typebox";

export function createBackgroundStatusTool(
  btm: BackgroundTaskManager,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any> {
  return {
    name: "background_status",
    label: "Background task status",
    description: "List all background tasks with their status (running/completed/failed)",
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<unknown>> {
      const tasks = btm.list();
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No background tasks." }],
          details: { tasks: [] },
        };
      }
      const lines = tasks.map((t) => {
        const elapsed = t.completedAt
          ? `${((t.completedAt - t.startedAt) / 1000).toFixed(1)}s`
          : `${((Date.now() - t.startedAt) / 1000).toFixed(1)}s`;
        return `#${t.id} ${t.name} [${t.status}] ${elapsed}`;
      });
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { tasks },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as AgentTool<any>;
}

export function createBackgroundResultTool(
  btm: BackgroundTaskManager,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any> {
  return {
    name: "background_result",
    label: "Background task result",
    description: "Get the result of a completed background task by ID",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string },
    ): Promise<AgentToolResult<unknown>> {
      const task = btm.status(params.id);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: `Task #${params.id} not found.` }],
          details: { error: "not_found" },
        };
      }
      if (task.status === "running") {
        return {
          content: [{ type: "text" as const, text: `Task #${params.id} is still running.` }],
          details: { status: "running" },
        };
      }
      if (task.status === "failed") {
        return {
          content: [{ type: "text" as const, text: `Task #${params.id} failed: ${task.error}` }],
          details: { status: "failed", error: task.error },
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(task.result) }],
        details: { status: "completed", result: task.result },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as AgentTool<any>;
}
