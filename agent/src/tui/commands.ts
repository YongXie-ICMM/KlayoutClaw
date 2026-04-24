/**
 * Slash command registry for qlaybot TUI.
 * Provides command definitions and prefix-matching for tab completion.
 */

export interface SlashCommand {
  name: string;
  description: string;
  subcommands?: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Show or change model and thinking level", subcommands: ["show", "set", "list"] },
  { name: "mcp", description: "MCP server status and tools", subcommands: ["status", "tools", "reconnect"] },
  { name: "config", description: "Show or update configuration", subcommands: ["show", "set", "reset", "setup"] },
  { name: "context", description: "Show agent context" },
  { name: "memory", description: "Show and search memory", subcommands: ["show", "search", "clear"] },
  { name: "plan", description: "Enter or exit plan mode; /plan verify stops re-injection reminders", subcommands: ["enter", "exit", "status", "verify"] },
  { name: "tasks", description: "Show background tasks" },
  { name: "compact", description: "Compact conversation context" },
  { name: "help", description: "Show available commands" },
  { name: "exit", description: "Exit qlaybot", subcommands: [] },
];

export interface CommandMatch {
  name: string;
  description: string;
}

/**
 * Return command names (with "/" prefix) matching a given prefix.
 * Prefix should start with "/".
 */
export function matchCommands(prefix: string): string[] {
  const lower = prefix.toLowerCase();
  const matches: string[] = [];
  for (const cmd of SLASH_COMMANDS) {
    const fullName = `/${cmd.name}`;
    if (fullName.toLowerCase().startsWith(lower)) {
      matches.push(fullName);
    }
  }
  return matches;
}

/**
 * Return command names with descriptions matching a given prefix.
 * Prefix should start with "/".
 */
export function matchCommandsWithInfo(prefix: string): CommandMatch[] {
  const lower = prefix.toLowerCase();
  const matches: CommandMatch[] = [];
  for (const cmd of SLASH_COMMANDS) {
    const fullName = `/${cmd.name}`;
    if (fullName.toLowerCase().startsWith(lower)) {
      matches.push({ name: fullName, description: cmd.description });
    }
  }
  return matches;
}

/**
 * Format help text listing all commands and keybindings.
 */
export function formatHelpText(): string {
  const lines: string[] = ["Available commands:"];
  for (const cmd of SLASH_COMMANDS) {
    lines.push(`  /${cmd.name.padEnd(12)} ${cmd.description}`);
  }
  lines.push("");
  lines.push("Keybindings:");
  lines.push("  Ctrl+T    Toggle thinking/detail view");
  lines.push("  Ctrl+W    Toggle workspace panel");
  lines.push("  Ctrl+G    Toggle background tasks panel");
  lines.push("  Ctrl+C    Abort current operation");
  lines.push("  Tab       Autocomplete commands");
  lines.push("  Enter     Submit prompt");
  lines.push("  Escape    Cancel / close panel");
  lines.push("  Shift+Tab Reverse cycle suggestions");
  return lines.join("\n");
}
