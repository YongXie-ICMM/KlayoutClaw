/**
 * /config command — show/set/reset runtime + persisted config.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import type { CommandHandler, CommandContext, CommandResult } from "./index.js";
import { backupConfig, runSetupWizard } from "../setup.js";

const CONFIG_DIR = join(homedir(), ".qlaybot", "config");

const VALID_SEARCH_MODES = ["fts5", "fts5+rerank", "fts5+vector+rerank", "vector+rerank"];

export const SETTABLE_KEYS: Record<string, { file: string; path: string[]; validate: (v: string) => boolean }> = {
  thinking: {
    file: "model.json",
    path: ["thinkingLevel"],
    validate: (v) => ["off", "minimal", "low", "medium", "high", "xhigh"].includes(v),
  },
  model: {
    file: "model.json",
    path: ["defaultModel"],
    validate: () => true,
  },
  "memory.maxResults": {
    file: "settings.json",
    path: ["memory", "autoRecall", "maxResults"],
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  "memory.maxEntries": {
    file: "settings.json",
    path: ["memory", "budget", "maxEntriesPerCategory"],
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  "search.mode": {
    file: "settings.json",
    path: ["search", "mode"],
    validate: (v) => VALID_SEARCH_MODES.includes(v),
  },
  "search.minRerank": {
    file: "settings.json",
    path: ["search", "minRerank"],
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  "search.rerankMinScore": {
    file: "settings.json",
    path: ["search", "rerankMinScore"],
    validate: (v) => !isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 1,
  },
  "search.rerankMaxTokens": {
    file: "settings.json",
    path: ["search", "rerankMaxTokens"],
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  "embedding.baseUrl": {
    file: "settings.json",
    path: ["embedding", "baseUrl"],
    validate: () => true,
  },
  "embedding.apiKey": {
    file: "settings.json",
    path: ["embedding", "apiKey"],
    validate: () => true,
  },
  "embedding.model": {
    file: "settings.json",
    path: ["embedding", "model"],
    validate: () => true,
  },
  "embedding.dimensions": {
    file: "settings.json",
    path: ["embedding", "dimensions"],
    validate: (v) => !isNaN(Number(v)) && Number(v) > 0,
  },
  "embedding.similarityThreshold": {
    file: "settings.json",
    path: ["embedding", "similarityThreshold"],
    validate: (v) => !isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 1,
  },
};

export const configCommand: CommandHandler = {
  name: "config",
  description: "Show, set, or reset configuration",
  usage: "/config [show|set <key> <value>|reset]",
  async execute(args: string[], context: CommandContext): Promise<CommandResult> {
    if (args.length === 0) {
      return { output: "", stateChange: { configPanel: { open: true, tab: "settings" } } };
    }
    const sub = args[0];

    switch (sub) {
      case "show": {
        const cfg = context.session.config;
        const lines = [
          "Configuration:",
          `  model:             ${cfg.agent.defaultModel}`,
          `  thinking:          ${cfg.agent.thinkingLevel}`,
          `  memory.maxResults: ${cfg.memory.autoRecall.maxResults}`,
          `  memory.maxEntries: ${cfg.memory.budget.maxEntriesPerCategory}`,
          `  search.mode:       ${(cfg as any).search?.mode ?? "fts5"}`,
          `  search.minRerank:  ${(cfg as any).search?.minRerank ?? 4}`,
          `  embedding.model:   ${(cfg as any).embedding?.model ?? "(none)"}`,
          `  embedding.baseUrl: ${(cfg as any).embedding?.baseUrl ?? "(none)"}`,
          `  mcp servers:       ${Object.keys(cfg.mcp).join(", ") || "(none)"}`,
        ];
        return { output: lines.join("\n"), exitCode: 0 };
      }

      case "set": {
        const key = args[1];
        const value = args[2];
        if (!key || !value) {
          return {
            output: `Usage: /config set <key> <value>\nSettable keys: ${Object.keys(SETTABLE_KEYS).join(", ")}`,
            exitCode: 1,
          };
        }

        const spec = SETTABLE_KEYS[key];
        if (!spec) {
          return {
            output: `Unknown config key: ${key}\nSettable keys: ${Object.keys(SETTABLE_KEYS).join(", ")}`,
            exitCode: 1,
          };
        }

        if (!spec.validate(value)) {
          return {
            output: `Invalid value for ${key}: ${value}`,
            exitCode: 1,
          };
        }

        // Apply to runtime config
        if (key === "thinking") {
          context.session.config.agent.thinkingLevel = value as typeof context.session.config.agent.thinkingLevel;
        } else if (key === "model") {
          context.session.config.agent.defaultModel = value;
        } else if (key === "memory.maxResults") {
          context.session.config.memory.autoRecall.maxResults = Number(value);
        } else if (key === "memory.maxEntries") {
          context.session.config.memory.budget.maxEntriesPerCategory = Number(value);
        } else if (key === "search.mode") {
          context.session.config.search.mode = value as any;
        } else if (key === "search.minRerank") {
          context.session.config.search.minRerank = Number(value);
        } else if (key === "search.rerankMinScore") {
          context.session.config.search.rerankMinScore = Number(value);
        } else if (key === "search.rerankMaxTokens") {
          context.session.config.search.rerankMaxTokens = Number(value);
        } else if (key === "embedding.baseUrl") {
          context.session.config.embedding.baseUrl = value;
        } else if (key === "embedding.apiKey") {
          context.session.config.embedding.apiKey = value;
        } else if (key === "embedding.model") {
          context.session.config.embedding.model = value;
        } else if (key === "embedding.dimensions") {
          context.session.config.embedding.dimensions = Number(value);
        } else if (key === "embedding.similarityThreshold") {
          context.session.config.embedding.similarityThreshold = Number(value);
        }

        // Persist to disk
        try {
          if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
          }
          const filePath = join(CONFIG_DIR, spec.file);
          let existing: Record<string, unknown> = {};
          if (existsSync(filePath)) {
            existing = JSON.parse(readFileSync(filePath, "utf-8"));
          }
          // Navigate path and set value
          let obj = existing;
          for (let i = 0; i < spec.path.length - 1; i++) {
            if (!(spec.path[i] in obj) || typeof obj[spec.path[i]] !== "object") {
              obj[spec.path[i]] = {};
            }
            obj = obj[spec.path[i]] as Record<string, unknown>;
          }
          const finalKey = spec.path[spec.path.length - 1];
          obj[finalKey] = isNaN(Number(value)) ? value : Number(value);
          writeFileSync(filePath, JSON.stringify(existing, null, 2));
        } catch {
          // Non-fatal
        }

        return { output: `Set ${key} = ${value}`, exitCode: 0 };
      }

      case "reset": {
        // Delete config files to reset to defaults
        try {
          for (const file of ["model.json", "settings.json"]) {
            const p = join(CONFIG_DIR, file);
            if (existsSync(p)) rmSync(p);
          }
          return { output: "Configuration reset to defaults. Restart to apply.", exitCode: 0 };
        } catch (err: unknown) {
          return { output: `Reset failed: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
        }
      }

      case "setup": {
        // Resolve configDir and templateDir from context or defaults
        const ctx = context as any;
        const cfgDir = ctx.session?.configDir ?? CONFIG_DIR;
        const templateDir =
          ctx.session?.templateDir ??
          resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "workspace");
        const setupApiKey = ctx.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";

        // Step 1: backup existing config
        if (existsSync(cfgDir)) {
          backupConfig(cfgDir);
        }

        // Step 2: run wizard
        try {
          await runSetupWizard({
            configDir: cfgDir,
            templateDir,
            apiKey: setupApiKey,
            skipValidation: true,
          });
          return { output: "Setup complete. Configuration updated.", exitCode: 0 };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { output: `Setup failed: ${msg}`, exitCode: 1 };
        }
      }

      default:
        return {
          output: `Unknown subcommand: ${sub}. Usage: ${configCommand.usage}`,
          exitCode: 1,
        };
    }
  },
};
