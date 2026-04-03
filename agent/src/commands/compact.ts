/**
 * /compact command -- compact conversation context.
 */

import type { CommandHandler, CommandContext, CommandResult } from "./index.js";
import { buildCompactInstructions } from "../compaction/index.js";
import { getWorkspaceDir } from "../config.js";

export const compactCommand: CommandHandler = {
  name: "compact",
  description: "Compact conversation context to reduce token usage",
  usage: "/compact [additional instructions]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const userInstructions = args.length > 0 ? args.join(" ") : undefined;

    if (typeof context.session.compact === "function") {
      // Use the top-level convenience method (builds instructions + extracts state)
      await context.session.compact(userInstructions);
    } else {
      // Fallback: build instructions and call inner session.compact() directly
      const workspaceDir = getWorkspaceDir();
      const instructions = buildCompactInstructions(
        workspaceDir,
        context.session.config.compaction,
        userInstructions,
      );
      await context.session.session.compact(instructions);
    }

    return {
      output: "Context compaction completed.",
      exitCode: 0,
    };
  },
};
