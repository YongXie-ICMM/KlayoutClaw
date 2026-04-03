/**
 * /memory command — show, search, clear memory categories.
 */

import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

const VALID_CATEGORIES = ["knowledge", "procedures", "preferences", "log"];

export const memoryCommand: CommandHandler = {
  name: "memory",
  description: "Memory inspection and management",
  usage: "/memory [show [category]|search <query>|clear <category>]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    const sub = args[0] ?? "show";
    const mm = context.session.memoryManager;

    switch (sub) {
      case "show": {
        const category = args[1];
        if (category) {
          if (!VALID_CATEGORIES.includes(category)) {
            return {
              output: `Invalid category: ${category}. Valid: ${VALID_CATEGORIES.join(", ")}`,
              exitCode: 1,
            };
          }
          const entries = mm.getCategory(category);
          if (entries.length === 0) {
            return { output: `No entries in '${category}'.`, exitCode: 0 };
          }
          const lines = entries.map(
            (e) => `[${e.timestamp}] ${e.tags.length ? `(${e.tags.join(", ")}) ` : ""}${e.content.slice(0, 100)}`,
          );
          return {
            output: `Memory — ${category} (${entries.length} entries):\n${lines.join("\n")}`,
            exitCode: 0,
          };
        }

        // Show all categories summary
        const lines: string[] = ["Memory:"];
        for (const cat of VALID_CATEGORIES) {
          const entries = mm.getCategory(cat);
          lines.push(`  ${cat.padEnd(15)} ${entries.length} entries`);
        }
        return { output: lines.join("\n"), exitCode: 0 };
      }

      case "search": {
        const query = args.slice(1).join(" ");
        if (!query) {
          return { output: "Usage: /memory search <query>", exitCode: 1 };
        }
        const results = await mm.search(query, 5);
        if (results.length === 0) {
          return { output: `No results for: ${query}`, exitCode: 0 };
        }
        const lines = results.map(
          (r) => `[${r.category}] ${r.content.slice(0, 120)}`,
        );
        return {
          output: `Search results (${results.length}):\n${lines.join("\n")}`,
          exitCode: 0,
        };
      }

      case "clear": {
        const category = args[1];
        if (!category || !VALID_CATEGORIES.includes(category)) {
          return {
            output: `Usage: /memory clear <category>\nValid: ${VALID_CATEGORIES.join(", ")}`,
            exitCode: 1,
          };
        }
        const count = mm.clear(category);
        return {
          output: `Cleared ${count} entries from '${category}'.`,
          exitCode: 0,
        };
      }

      default:
        return {
          output: `Unknown subcommand: ${sub}. Usage: ${memoryCommand.usage}`,
          exitCode: 1,
        };
    }
  },
};
