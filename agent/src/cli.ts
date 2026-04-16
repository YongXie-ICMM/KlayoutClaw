#!/usr/bin/env node
/**
 * qlaybot CLI entry point.
 * Supports interactive, JSON, and RPC modes.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createDesignSession } from "./agent.js";
import {
  initializeUserDir,
  isInitialized,
  getQlayBotDir,
  removeUserDir,
} from "./config.js";
import { startRPCServer } from "./rpc.js";
import { subscribeToSession } from "./events.js";
import { COMMAND_NAMES, parseCommand } from "./commands/index.js";
import type { CommandContext } from "./commands/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CLIArgs {
  mode: "interactive" | "json" | "rpc";
  message?: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  cwd: string;
  command: "run" | "setup" | "onboard" | "uninstall" | "help" | "slash";
  plain?: boolean;
  slashCommand?: string;
  slashArgs?: string[];
}

export function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    mode: "interactive",
    cwd: process.cwd(),
    command: "run",
  };

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    switch (arg) {
      case "--mode":
        args.mode = argv[++i] as CLIArgs["mode"];
        break;
      case "-m":
      case "--message":
        args.message = argv[++i];
        args.mode = "json";
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--thinking":
        args.thinkingLevel = argv[++i] as CLIArgs["thinkingLevel"];
        break;
      case "--cwd":
        args.cwd = resolve(argv[++i]);
        break;
      case "--plain":
        args.plain = true;
        break;
      case "setup":
      case "onboard":
        args.command = "setup";
        break;
      case "uninstall":
        args.command = "uninstall";
        break;
      case "help":
      case "--help":
      case "-h":
        args.command = "help";
        break;
      default:
        if (!arg.startsWith("-") && i === 2) {
          if (COMMAND_NAMES.includes(arg)) {
            args.command = "slash";
            args.slashCommand = arg;
            args.slashArgs = argv.slice(i + 1);
            return args; // Consume remaining as slash args
          }
          args.command = arg as CLIArgs["command"];
        }
        break;
    }
    i++;
  }

  return args;
}

function printHelp(): void {
  console.log(`
qlaybot - Device Design Agent for KLayout (v0.3)

Usage:
  qlaybot                               Interactive TUI
  qlaybot -m "add a rectangle"          Single-shot JSON mode
  qlaybot --mode rpc                    RPC mode (stdin/stdout JSON-RPC)
  qlaybot --plain                       Plain readline

Commands:
  qlaybot model [show|set|list]         Model management
  qlaybot mcp [status|tools|reconnect]  MCP management
  qlaybot config [show|set|reset]       Config management
  qlaybot context                       Workspace context info
  qlaybot memory [show|search|clear]    Memory management
  qlaybot tasks                         Background task status
  qlaybot onboard                       First-time setup
  qlaybot uninstall                     Remove ~/.qlaybot/
  qlaybot help [<command>]              Help

Options:
  --mode <mode>       Mode: interactive, json, rpc (default: interactive)
  -m, --message <msg> Send single message (implies JSON mode)
  --model <ref>       Model to use (format: provider/modelId)
  --thinking <level>  Thinking level: off, minimal, low, medium, high, xhigh
  --cwd <path>        Working directory
  --plain             Use plain readline mode (no TUI)
  -h, --help          Show this help

TUI Shortcuts:
  Ctrl+T              Toggle thinking visibility
  Ctrl+C              Exit

In TUI, prefix with / to run commands: /model, /plan, /tasks, etc.

Examples:
  qlaybot -m "Create a new layout and add a 100x25 um rectangle"
  qlaybot model set custom-anthropic/claude-opus-4-6
  qlaybot --mode rpc  # For E2E testing
`);
}

async function runOnboard(): Promise<void> {
  const templateDir = resolve(__dirname, "..", "workspace");
  const refreshing = isInitialized();

  if (refreshing) {
    console.log("Refreshing workspace (config preserved)...\n");
  } else {
    console.log("Setting up qlaybot...\n");
  }

  initializeUserDir(templateDir);

  if (refreshing) {
    console.log(`Updated ${getQlayBotDir()}/workspace/ from template`);
    console.log("config/ was preserved.\n");
  } else {
    console.log(`Created ${getQlayBotDir()}/`);
    console.log("  config/      - Configuration files");
    console.log("    model.json     - Model provider settings");
    console.log("    mcp.json       - MCP server URLs");
    console.log("    settings.json  - Memory settings");
    console.log("  workspace/   - Domain knowledge");
    console.log("  memory/      - Persistent memory");
    console.log("  sessions/    - Session history\n");
    console.log("Next steps:");
    console.log("  1. Set ANTHROPIC_API_KEY environment variable");
    console.log("  2. Start KLayout with KlayoutClaw plugin");
    console.log("  3. Run 'qlaybot' to start");
    console.log("");
    console.log("Global CLI setup (optional):");
    console.log("  cd KlayoutClaw/agent && npm link");
    console.log("  Then 'qlaybot' works from any directory.");
  }
}

async function runUninstall(): Promise<void> {
  if (!isInitialized()) {
    console.log("Nothing to remove — ~/.qlaybot/ does not exist.");
    return;
  }

  const dir = getQlayBotDir();
  console.log(`This will permanently delete ${dir}/ and all its contents.`);

  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Are you sure? (y/N) ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  removeUserDir();
  console.log(`Removed ${dir}/`);
}

async function runInteractive(args: CLIArgs): Promise<void> {
  const useTUI = !args.plain && process.stdin.isTTY && process.stdout.isTTY;

  const botSession = await createDesignSession({
    cwd: args.cwd,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
  });

  if (useTUI) {
    const { renderTUI } = await import("./tui/render.js");
    await renderTUI(botSession);
  } else {
    await runInteractivePlain(botSession);
  }
}

async function runInteractivePlain(
  botSession: Awaited<ReturnType<typeof createDesignSession>>,
): Promise<void> {
  console.log("qlaybot - Device Design Agent\n");

  const unsubscribe = subscribeToSession(botSession.session, {
    onTextDelta: (text) => process.stdout.write(text),
  });

  const { createInterface } = await import("readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\nqlaybot> ",
  });

  rl.prompt();
  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input === "/quit" || input === "/exit") {
      unsubscribe();
      await botSession.dispose();
      rl.close();
      process.exit(0);
    }

    try {
      botSession.history.recordPrompt(input);
      await botSession.session.prompt(input);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nError: ${msg}`);
    }
    rl.prompt();
  });

  rl.on("close", async () => {
    unsubscribe();
    await botSession.dispose();
    process.exit(0);
  });
}

/**
 * Check if the last assistant message in the session was thinking-only
 * (no text, no tool calls). This indicates the model emitted a stop token
 * prematurely after a thinking block — the SDK treats it as "done" but
 * the agent was still mid-task.
 */
function isThinkingOnlyTermination(session: { messages: any[] }): boolean {
  const msgs = session.messages;
  if (msgs.length === 0) return false;
  const last = msgs[msgs.length - 1];
  if (last.role !== "assistant" || !Array.isArray(last.content)) return false;
  const hasThinking = last.content.some(
    (c: any) => c.type === "thinking" && c.thinking?.trim().length > 0,
  );
  const hasText = last.content.some(
    (c: any) => c.type === "text" && c.text?.trim().length > 0,
  );
  const hasToolCall = last.content.some((c: any) => c.type === "toolCall");
  return hasThinking && !hasText && !hasToolCall;
}

const THINKING_ONLY_MAX_RETRIES = 5;

async function runJSON(args: CLIArgs): Promise<void> {
  if (!args.message) {
    console.error("Error: --message required for JSON mode");
    process.exit(1);
  }

  const botSession = await createDesignSession({
    cwd: args.cwd,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
  });

  const chunks: string[] = [];
  const unsubscribe = subscribeToSession(botSession.session, {
    onTextDelta: (text) => chunks.push(text),
  });

  try {
    botSession.history.recordPrompt(args.message);
    await botSession.session.prompt(args.message);

    // Guard against premature termination: if the model stopped after a
    // thinking-only response (no text, no tool call), re-prompt to continue.
    let retries = 0;
    while (
      isThinkingOnlyTermination(botSession.session) &&
      retries < THINKING_ONLY_MAX_RETRIES
    ) {
      retries++;
      console.error(
        `[qlaybot] thinking-only termination detected (attempt ${retries}/${THINKING_ONLY_MAX_RETRIES}), re-prompting...`,
      );
      await botSession.session.prompt("Continue. You stopped mid-task after a thinking block — keep working.");
    }

    if (retries > 0 && isThinkingOnlyTermination(botSession.session)) {
      console.error(
        `[qlaybot] still thinking-only after ${THINKING_ONLY_MAX_RETRIES} retries, giving up`,
      );
    }

    const output = { status: "completed", response: chunks.join("") };
    console.log(JSON.stringify(output, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const output = { status: "error", error: msg };
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  } finally {
    unsubscribe();
    await botSession.dispose();
  }
}

async function runSlashCommand(args: CLIArgs): Promise<void> {
  const botSession = await createDesignSession({
    cwd: args.cwd,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    ephemeral: true,
  });

  const ctx: CommandContext = {
    session: botSession,
    mode: "shell",
  };

  const result = await botSession.commandRegistry!.execute(
    args.slashCommand!,
    args.slashArgs ?? [],
    ctx,
  );

  console.log(result.output);
  await botSession.dispose();
  process.exit(result.exitCode ?? 0);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "help":
      printHelp();
      break;
    case "setup":
    case "onboard":
      await runOnboard();
      break;
    case "uninstall":
      await runUninstall();
      break;
    case "slash":
      await runSlashCommand(args);
      break;
    case "run":
    default:
      switch (args.mode) {
        case "rpc":
          await startRPCServer({
            cwd: args.cwd,
            model: args.model,
            thinkingLevel: args.thinkingLevel,
          });
          break;
        case "json":
          await runJSON(args);
          break;
        case "interactive":
        default:
          await runInteractive(args);
          break;
      }
      break;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
