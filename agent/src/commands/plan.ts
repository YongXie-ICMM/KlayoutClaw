/**
 * /plan command — shared across CLI, TUI, and RPC.
 *
 * Scope: minimal surface for issue #24. Only `verify` and `status` are
 * exposed here; the modal enter/exit flow remains a TUI affordance in
 * App.tsx because it needs local UI state (auto-submit, planExitMenu).
 */

import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

export const planCommand: CommandHandler = {
  name: "plan",
  description: "Plan mode status + /plan verify to stop re-injection reminders",
  usage: "/plan [verify|status]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const pm = context.session.planManager;
    if (!pm) {
      return { output: "Planning mode not available.", exitCode: 1 };
    }

    const sub = (args[0] ?? "").toLowerCase();

    if (sub === "verify") {
      if (!pm.currentPlan) {
        return {
          output:
            "No active plan to verify. Enter plan mode first (TUI: /plan <task>).",
          exitCode: 1,
        };
      }
      if (pm.inPlanMode) {
        return {
          output:
            "Still in plan mode. Call exit_plan_mode first, then /plan verify to stop re-injection reminders.",
          exitCode: 1,
        };
      }
      pm.markVerified();
      return {
        output:
          "Plan verification acknowledged; re-injection reminders paused for the current plan.",
        exitCode: 0,
      };
    }

    if (sub === "" || sub === "status") {
      if (!pm.currentPlan) {
        return { output: "No active plan.", exitCode: 0 };
      }
      const lines = [
        `Plan: ${pm.currentPlan.title}`,
        `  id:            ${pm.currentPlan.id}`,
        `  status:        ${pm.currentPlan.status}`,
        `  inPlanMode:    ${pm.inPlanMode}`,
        `  file:          ${pm.currentPlan.filePath}`,
        `  turnsSinceExit: ${pm.turnsSinceExit}`,
        `  verified:      ${pm.verificationCompleted}`,
      ];
      return { output: lines.join("\n"), exitCode: 0 };
    }

    return {
      output:
        `Unknown /plan subcommand: "${sub}". Usage: /plan [verify|status].`,
      exitCode: 1,
    };
  },
};
