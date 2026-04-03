/**
 * /exit command — graceful shutdown (TUI-only).
 */

import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

export const exitCommand: CommandHandler = {
  name: "exit",
  description: "Graceful shutdown (TUI-only)",
  usage: "/exit",
  async execute(_args: string[], context: CommandContext): Promise<CommandResult> {
    if (context.mode === "shell") {
      return { output: "Exit is only available in interactive TUI mode.", exitCode: 0 };
    }
    // TUI/RPC mode: signal exit
    return {
      output: "Goodbye!",
      exitCode: 0,
    };
  },
};
