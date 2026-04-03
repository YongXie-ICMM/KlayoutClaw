/**
 * /plan command — enter/exit/status planning mode.
 */

import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

export const planCommand: CommandHandler = {
  name: "plan",
  description: "Planning mode control",
  usage: "/plan [enter|exit|status]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const sub = args[0] ?? "enter";
    const pm = context.session.planManager;

    if (!pm) {
      return { output: "Planning mode not available.", exitCode: 1 };
    }

    switch (sub) {
      case "enter": {
        if (pm.isActive()) {
          return { output: "Already in plan mode.", exitCode: 0 };
        }
        pm.enter();
        return {
          output: "Entered plan mode. Read-only tools only. Use /plan exit to resume execution.",
          stateChange: { planMode: true },
          exitCode: 0,
        };
      }

      case "exit": {
        if (!pm.isActive()) {
          return { output: "Not in plan mode.", exitCode: 0 };
        }
        pm.exit();
        return {
          output: "Exited plan mode. All tools available.",
          stateChange: { planMode: false },
          exitCode: 0,
        };
      }

      case "status": {
        return {
          output: `Plan mode: ${pm.isActive() ? "active" : "inactive"}`,
          exitCode: 0,
        };
      }

      default:
        return {
          output: `Unknown subcommand: ${sub}. Usage: ${planCommand.usage}`,
          exitCode: 1,
        };
    }
  },
};
