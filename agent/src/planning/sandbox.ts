/**
 * Sandbox — tool wrapper that intercepts blocked calls in plan mode.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { PlanManager } from "./index.js";

const ALLOWED_TOOLS = new Set([
  "read",
  "klayout_native_get_layout_info",
  "klayout_native_screenshot",
  "memory_save",
  "memory_search",
  "delegate",
]);

/**
 * Wrap a tool so blocked calls return an error when plan mode is active.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapToolWithSandbox(tool: AgentTool<any>, planManager: PlanManager): AgentTool<any> {
  return {
    ...tool,
    async execute(
      toolCallId: string,
      params: unknown,
      ...rest: unknown[]
    ): Promise<AgentToolResult<unknown>> {
      if (planManager.isActive() && !ALLOWED_TOOLS.has(tool.name)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool '${tool.name}' is blocked in plan mode. Exit plan mode with /plan exit to execute.`,
            },
          ],
          details: { blocked: true, planMode: true },
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (tool.execute as any)(toolCallId, params, ...rest);
    },
  };
}

export { ALLOWED_TOOLS };
