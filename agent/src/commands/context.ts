/**
 * /context command — show loaded workspace context and token usage.
 */

import { existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CommandHandler, CommandContext, CommandResult } from "./index.js";

const WORKSPACE_FILES = ["SOUL.md", "TOOLS.md", "RULES.md"];

export const contextCommand: CommandHandler = {
  name: "context",
  description: "Show loaded workspace context and token estimates",
  usage: "/context",
  async execute(_args: string[], context: CommandContext): Promise<CommandResult> {
    const workspaceDir = join(homedir(), ".qlaybot", "workspace");
    const lines: string[] = ["Workspace Context:"];
    let totalBytes = 0;

    for (const file of WORKSPACE_FILES) {
      const p = join(workspaceDir, file);
      if (existsSync(p)) {
        const size = statSync(p).size;
        totalBytes += size;
        lines.push(`  ${file.padEnd(20)} ${formatBytes(size)}`);
      } else {
        lines.push(`  ${file.padEnd(20)} (not found)`);
      }
    }

    // Check for additional workspace files
    if (existsSync(workspaceDir)) {
      const allFiles = readdirSync(workspaceDir).filter(
        (f) => f.endsWith(".md") && !WORKSPACE_FILES.includes(f),
      );
      for (const file of allFiles) {
        const size = statSync(join(workspaceDir, file)).size;
        totalBytes += size;
        lines.push(`  ${file.padEnd(20)} ${formatBytes(size)}`);
      }
    }

    // Estimate tokens (~4 chars per token)
    const estimatedTokens = Math.round(totalBytes / 4);
    lines.push("");
    lines.push(`  Total: ${formatBytes(totalBytes)} (~${estimatedTokens.toLocaleString()} tokens)`);

    // Context window usage
    const usage = context.session.getContextUsage();
    if (usage) {
      lines.push(`  Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent.toFixed(1)}%)`);
    }

    return { output: lines.join("\n"), exitCode: 0 };
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
