/**
 * Delegate tool — allows the parent agent to dispatch work to subagents.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { SubagentConfig } from "../types/v04-contracts.js";
import type { SubagentRunner } from "../subagent/runner.js";
import type { PlanManager } from "../planning/index.js";
import { Type } from "@sinclair/typebox";

/**
 * Create the delegate tool that dispatches tasks to subagent roles.
 *
 * When `parentPlanManager` is provided and the parent is in plan mode, the
 * delegate tool short-circuits with a `plan_mode_restricted` envelope BEFORE
 * role validation — subagents would otherwise bypass the plan-mode sandbox.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDelegateTool(
  runner: SubagentRunner,
  config: SubagentConfig,
  parentPlanManager?: PlanManager,
): AgentTool<any> {
  return {
    name: "delegate",
    label: "delegate",
    description: "Delegate a task to a specialized subagent role.",
    parameters: Type.Object({
      role: Type.String({ description: "The subagent role to delegate to" }),
      task: Type.String({ description: "The task description for the subagent" }),
      context: Type.Optional(Type.String({ description: "Optional context to provide to the subagent" })),
    }),
    async execute(
      toolCallId: string,
      params: { role: string; task: string; context?: string },
    ): Promise<AgentToolResult<any>> {
      // Plan-mode gate (spec §9 step 8): block subagent dispatch when the
      // parent is in plan mode so subagents cannot escape the sandbox.
      if (parentPlanManager?.inPlanMode === true) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "plan_mode_restricted",
              tool: "delegate",
              message: "Cannot spawn a subagent during plan mode — subagents would bypass the sandbox. Exit plan mode first.",
            }),
          }],
          details: { error: true, planModeRestricted: true },
        };
      }

      // Validate role exists
      const availableRoles = Object.keys(config.roles);
      if (!config.roles[params.role]) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: Unknown role '${params.role}'. Available roles: ${availableRoles.join(", ")}`,
          }],
          details: { error: true },
        };
      }

      // Run the subagent
      const result = await runner.run({
        role: params.role,
        task: params.task,
        toolCallId,
        context: params.context,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
        details: result,
      };
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as AgentTool<any>;
}
