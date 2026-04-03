/**
 * /model command — show/set/list model configuration.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

const CONFIG_DIR = join(homedir(), ".qlaybot", "config");

export const modelCommand: CommandHandler = {
  name: "model",
  description: "Show, set, or list available models",
  usage: "/model [show|set <provider/id>|list]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return { output: "", stateChange: { configPanel: { open: true, tab: "models" } } };
    }
    const sub = args[0];

    switch (sub) {
      case "show": {
        const model = context.session.config.agent.defaultModel;
        const thinking = context.session.config.agent.thinkingLevel;
        return {
          output: `Model: ${model}\nThinking: ${thinking}`,
          exitCode: 0,
        };
      }

      case "set": {
        const modelRef = args[1];
        if (!modelRef) {
          return {
            output: "Usage: /model set <provider/modelId>",
            exitCode: 1,
          };
        }

        // Update in-memory config
        context.session.config.agent.defaultModel = modelRef;

        // Persist to disk
        try {
          if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
          }
          const modelPath = join(CONFIG_DIR, "model.json");
          let existing: Record<string, unknown> = {};
          if (existsSync(modelPath)) {
            existing = JSON.parse(readFileSync(modelPath, "utf-8"));
          }
          existing.defaultModel = modelRef;
          writeFileSync(modelPath, JSON.stringify(existing, null, 2));
        } catch {
          // Non-fatal — runtime config is updated
        }

        return {
          output: `Model set to: ${modelRef}`,
          exitCode: 0,
        };
      }

      case "list": {
        const providers = context.session.config.models.providers;
        const lines: string[] = ["Available models:"];
        for (const [provName, provConfig] of Object.entries(providers)) {
          for (const m of provConfig.models) {
            const current =
              context.session.config.agent.defaultModel.includes(m.id) ? " *" : "";
            lines.push(`  ${provName}/${m.id} — ${m.name}${current}`);
          }
        }
        if (lines.length === 1) {
          lines.push("  (no models configured)");
        }
        return { output: lines.join("\n"), exitCode: 0 };
      }

      default:
        return {
          output: `Unknown subcommand: ${sub}. Usage: ${modelCommand.usage}`,
          exitCode: 1,
        };
    }
  },
};
