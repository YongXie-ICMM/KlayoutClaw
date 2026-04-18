/**
 * CommandRegistry — unified command handling for shell, TUI, and RPC.
 */

import type { QlayBotSession } from "../agent.js";
import type { ContextSection } from "../tui/types.js";
import { modelCommand } from "./model.js";
import { mcpCommand } from "./mcp.js";
import { configCommand } from "./config.js";
import { contextCommand } from "./context.js";
import { memoryCommand } from "./memory.js";
import { tasksCommand } from "./tasks.js";
import { helpCommand } from "./help.js";
import { exitCommand } from "./exit.js";
import { compactCommand } from "./compact.js";

export interface CommandContext {
  session: QlayBotSession;
  mode: "shell" | "tui" | "rpc";
}

export interface CommandResult {
  output: string;
  stateChange?: {
    planMode?: boolean;
    showThinking?: boolean;
    configPanel?: { open: boolean; tab: string };
  };
  exitCode?: number;
  sections?: ContextSection[];
}

export interface CommandHandler {
  name: string;
  description: string;
  usage: string;
  execute: (args: string[], context: CommandContext) => Promise<CommandResult>;
}

export class CommandRegistry {
  private commands = new Map<string, CommandHandler>();

  register(handler: CommandHandler): void {
    this.commands.set(handler.name, handler);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  async execute(name: string, args: string[], context: CommandContext): Promise<CommandResult> {
    const handler = this.commands.get(name);
    if (!handler) {
      return {
        output: `Unknown command: /${name}. Type /help for available commands.`,
        exitCode: 1,
      };
    }
    return handler.execute(args, context);
  }

  list(): CommandHandler[] {
    return Array.from(this.commands.values());
  }

  get(name: string): CommandHandler | undefined {
    return this.commands.get(name);
  }
}

/**
 * Parse a command string like "/model set sonnet" into { name, args }.
 */
export function parseCommand(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0];
  if (!name) return null;
  return { name, args: parts.slice(1) };
}

/**
 * Create and populate a CommandRegistry with all built-in commands.
 */
export function createCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(modelCommand);
  registry.register(mcpCommand);
  registry.register(configCommand);
  registry.register(contextCommand);
  registry.register(memoryCommand);
  registry.register(tasksCommand);
  registry.register(compactCommand);
  registry.register(helpCommand);
  registry.register(exitCommand);
  return registry;
}

/** All command names for CLI detection */
export const COMMAND_NAMES = [
  "model", "mcp", "config", "context", "memory",
  "tasks", "compact", "help", "exit",
];
