/**
 * enter_plan_mode / exit_plan_mode tool factories (v0.4.3, spec §1.6).
 *
 * Ports qdevbot `src/tools/plan.ts` (163 lines, behavioral parity) with the
 * KLayout-adapted PLAN_MODE_INSTRUCTIONS text from spec §1.7.
 *
 * Divergence D1: when PlanManager.enterPlanMode returns null (FS failure),
 * the tool wrapper surfaces a `{status:"error", message:"Failed to create
 * plan file: ..."}` result rather than letting the exception escape into
 * the RPC transport.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { getTranscriptMarkerEmitter } from "../events/marker-emitter.js";
import type {
  EnterPlanModeResult,
  PlanManager,
} from "../planning/index.js";
import { waitForPlanApproval } from "../planning/approval-gate.js";
import { planSlugCache } from "../planning/slug-cache.js";

/**
 * KLayout-adapted plan-mode instructions. Tests assert every substring in
 * this block — edit with care (spec §1.7).
 */
export const PLAN_MODE_INSTRUCTIONS = `You are now in **plan mode**. Your goal is to explore the current state, understand the task requirements, and produce a detailed plan before making any changes.

## Rules in plan mode
1. **Read-only**: Do NOT use edit, write, or bash. Use read, memory_search, and the KLayout read-only MCP tools.
   - Always available: klayout_get_layout_info, screenshot, route_inspect, validate_pixel_size
   - Tool calls: ONLY tools declared \`readonly: true\` in src/tools/annotations.ts are allowed.
     Tools declared \`readwrite: true\` or tools with no annotation entry are blocked.
2. **Explore first**: Use klayout_get_layout_info to read the current layout state,
   screenshot to inspect visually, route_inspect to examine existing routes,
   memory_search to recall prior design decisions.
3. **Ask if unclear**: If the task has ambiguities that cannot be resolved by exploration, ask the user for clarification.
4. **Write the plan**: Update the plan file with your findings and proposed approach. Include:
   - Current state summary (cells, layers, existing geometry)
   - Proposed geometry steps (with specific coordinates, layers, sizes)
   - Routing/evaluation checks required before each commit
   - Expected outcomes and decision points
   - Rollback actions if something goes wrong
5. **Call exit_plan_mode** when the plan is complete and ready for user review.

## Plan structure
Your plan should be detailed enough that it could be executed step-by-step without additional decisions. Include specific cell names, layer numbers, coordinates, and sizes.`;

function ok(data: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    details: {},
  };
}

const EnterParams = Type.Object({
  task: Type.String({
    description:
      "Description of the task that needs planning. Be specific about the device " +
      "design, geometry, routing, or evaluation goal you intend to pursue.",
  }),
  reason: Type.Optional(
    Type.String({
      description:
        "Why planning is beneficial for this task (e.g., 'multi-step device " +
        "design with cross-layer routing dependencies').",
    }),
  ),
});

export function createEnterPlanModeTool(
  planManager: PlanManager,
): AgentTool<typeof EnterParams> {
  return {
    name: "enter_plan_mode",
    label: "Enter Plan Mode",
    description:
      "Enter plan mode for complex KLayout design tasks that benefit from " +
      "exploration and planning before execution. Use this when a task involves: " +
      "(1) multi-step geometry with cross-layer dependencies, (2) routing or " +
      "evaluation work where a mistake could invalidate hours of prior steps, " +
      "(3) device layouts requiring coordination between multiple skills, or " +
      "(4) any task where the plan file should be reviewed before writing " +
      "irreversible geometry. Plan mode restricts you to read-only KLayout " +
      "tools, read, and memory operations until the plan is approved.",
    parameters: EnterParams,
    async execute(
      _toolCallId: string,
      p: Static<typeof EnterParams>,
    ): Promise<AgentToolResult<unknown>> {
      const plan = planManager.enterPlanMode(p.task, undefined);

      if (plan === null) {
        // Divergence D1: FS failure surfaced as a structured error result.
        return ok({
          status: "error",
          message:
            "Failed to create plan file: the plans directory could not be " +
            "written. Check filesystem permissions and disk space.",
        });
      }

      if (isPlanEnterError(plan)) {
        return ok(plan);
      }

      return ok({
        status: "plan_mode_active",
        plan_id: plan.id,
        plan_file: plan.filePath,
        instructions: PLAN_MODE_INSTRUCTIONS,
        task: p.task,
        reason: p.reason || "Complex task requiring planning",
      });
    },
  };
}

function isPlanEnterError(plan: EnterPlanModeResult): plan is {
  status: "error";
  message: string;
} {
  return plan !== null && "status" in plan && plan.status === "error";
}

const ExitParams = Type.Object({
  approved: Type.Optional(
    Type.Boolean({
      description:
        "Whether the plan is complete and ready for execution. " +
        "Set to false to abandon the plan. Default: true.",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description: "Brief summary of the plan for the user to review.",
    }),
  ),
});

export function createExitPlanModeTool(
  planManager: PlanManager,
): AgentTool<typeof ExitParams> {
  return {
    name: "exit_plan_mode",
    label: "Exit Plan Mode",
    description:
      "Exit plan mode after the plan is complete. The plan file is preserved " +
      "for reference during execution. Call this when your plan is detailed " +
      "enough to execute step-by-step, or set approved=false to abandon the plan.",
    parameters: ExitParams,
    async execute(
      _toolCallId: string,
      p: Static<typeof ExitParams>,
    ): Promise<AgentToolResult<unknown>> {
      if (!planManager.inPlanMode) {
        return ok({
          status: "not_in_plan_mode",
          message: "Not currently in plan mode. Use enter_plan_mode first.",
        });
      }

      const approved = p.approved !== false; // default true

      if (!approved) {
        const emitter = getTranscriptMarkerEmitter(planManager.sessionKey);
        emitter?.emit("marker", {
          type: "plan_rejected",
          action: "abandon",
          feedback: "abandoned",
          ts: new Date().toISOString(),
        });
        planSlugCache.delete(planManager.sessionKey);
        const plan = planManager.exitPlanMode(false);
        if (!plan) {
          return ok({ status: "error", message: "Failed to exit plan mode." });
        }
        return ok({
          status: "plan_abandoned",
          plan_id: plan.id,
          message: "Plan abandoned. You may proceed without a formal plan.",
        });
      }

      const plan = planManager.currentPlan;
      if (!plan) {
        return ok({ status: "error", message: "Failed to exit plan mode." });
      }

      const planText = planManager.readPlanFile() ?? "";
      if (planText.trim().length === 0) {
        return ok({
          status: "error",
          message: "Plan file is empty; abandon or continue drafting",
        });
      }

      const stateMachine = planManager.stateMachine;
      if (!stateMachine) {
        return ok({
          status: "error",
          message: "Plan state machine is not configured.",
        });
      }

      const planBytes = Buffer.from(planText, "utf-8");
      const planHash = stateMachine.planHash(planBytes);
      stateMachine.setInitialPlanHash(planManager.sessionKey, planHash);
      stateMachine.transition(
        planManager.sessionKey,
        "plan_drafting",
        "plan_drafted",
        {
          plan: planText,
          planHash,
          planLengthChars: planText.length,
          planSlug: plan.id,
          planFilePath: plan.filePath,
          replan_count: stateMachine.getReplanCount(planManager.sessionKey),
        },
      );
      stateMachine.emitPlanFileWritten(plan.filePath, planHash, planBytes.length);

      if (planManager.approvalMode === "interactive") {
        try {
          const action = await waitForPlanApproval(planManager.sessionKey);
          if (action.action === "approve_execute") {
            stateMachine.transition(
              planManager.sessionKey,
              "plan_drafted",
              "plan_approved",
              { auto: false, executeAfterApproval: true },
            );
            planManager.closePlanMode("approved");
            stateMachine.transition(
              planManager.sessionKey,
              "plan_approved",
              "plan_executing",
              { planHash },
            );
            stateMachine.transition(
              planManager.sessionKey,
              "plan_executing",
              "plan_done",
              { status: "ok" },
            );
            return ok({
              status: "plan_approved",
              plan_id: plan.id,
              plan_file: plan.filePath,
              executeAfterApproval: true,
              auto: false,
              message: "Plan approved for execution.",
            });
          }
          if (action.action === "approve_only") {
            stateMachine.transition(
              planManager.sessionKey,
              "plan_drafted",
              "plan_approved",
              { auto: false, executeAfterApproval: false },
            );
            planManager.closePlanMode("approved");
            return ok({
              status: "plan_approved",
              plan_id: plan.id,
              plan_file: plan.filePath,
              executeAfterApproval: false,
              auto: false,
              message: "Plan approved without execution.",
            });
          }
          if (action.action === "reject") {
            stateMachine.transition(
              planManager.sessionKey,
              "plan_drafted",
              "plan_rejected",
              {
                action: "reject",
                feedback: action.feedback,
              },
            );
            stateMachine.setState(planManager.sessionKey, "plan_drafting");
            return ok({
              status: "plan_rejected",
              plan_id: plan.id,
              plan_file: plan.filePath,
              action: "reject",
              feedback: action.feedback,
              message: "Plan rejected. Continue drafting.",
            });
          }

          stateMachine.transition(
            planManager.sessionKey,
            "plan_drafted",
            "plan_rejected",
            {
              action: "abandon",
              feedback: "abandoned",
            },
          );
          planSlugCache.delete(planManager.sessionKey);
          planManager.exitPlanMode(false);
          return ok({
            status: "plan_abandoned",
            plan_id: plan.id,
            message: "Plan abandoned. You may proceed without a formal plan.",
          });
        } catch (error) {
          const feedback =
            error instanceof Error ? error.message : "caller_disconnected";
          stateMachine.transition(
            planManager.sessionKey,
            "plan_drafted",
            "plan_rejected",
            {
              action: "abandon",
              feedback,
            },
          );
          planSlugCache.delete(planManager.sessionKey);
          planManager.exitPlanMode(false);
          return ok({
            status: "plan_abandoned",
            reason: "caller_disconnected",
            plan_id: plan.id,
            message: "Plan abandoned because the caller disconnected.",
          });
        }
      }

      if (planManager.approvalMode === "headless") {
        stateMachine.transition(
          planManager.sessionKey,
          "plan_drafted",
          "plan_approved",
          { auto: true, executeAfterApproval: true },
        );
        planManager.closePlanMode("approved");
        stateMachine.transition(
          planManager.sessionKey,
          "plan_approved",
          "plan_executing",
          { planHash },
        );
        stateMachine.transition(
          planManager.sessionKey,
          "plan_executing",
          "plan_done",
          { status: "ok" },
        );
        return ok({
          status: "plan_approved",
          plan_id: plan.id,
          plan_file: plan.filePath,
          executeAfterApproval: true,
          auto: true,
          message: "Plan auto-approved in headless mode.",
        });
      }

      return ok({
        status: "plan_drafted",
        plan_id: plan.id,
        plan_file: plan.filePath,
        summary: p.summary || "Plan drafted and ready for approval.",
        message: "Plan drafted. Awaiting approval.",
      });
    },
  };
}
