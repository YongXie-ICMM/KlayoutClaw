/**
 * /help command — dynamic help from registry.
 */

import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

export const helpCommand: CommandHandler = {
  name: "help",
  description: "Show available commands or help for a specific command",
  usage: "/help [command]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const registry = context.session.commandRegistry;
    if (!registry) {
      return { output: "Command registry not available.", exitCode: 1 };
    }

    const target = args[0];
    if (target) {
      const cmd = registry.get(target);
      if (!cmd) {
        return { output: `Unknown command: ${target}`, exitCode: 1 };
      }
      return {
        output: `/${cmd.name} — ${cmd.description}\nUsage: ${cmd.usage}`,
        exitCode: 0,
      };
    }

    const commands = registry.list();
    const lines: string[] = ["Available commands:"];
    for (const cmd of commands) {
      lines.push(`  /${cmd.name.padEnd(12)} ${cmd.description}`);
    }
    lines.push("");
    lines.push("Type /help <command> for detailed usage.");
    return { output: lines.join("\n"), exitCode: 0 };
  },
};
