#!/usr/bin/env -S node --max-old-space-size=8192
/**
 * qlaybot CLI entry point.
 * Supports interactive, JSON, and RPC modes.
 *
 * The shebang bumps V8's old-generation heap cap from Node's default ~4 GB
 * to 8 GB. Autonomous design sessions run for hours with large transcript
 * state + MCP tool results held in the Agent's internal history; the 4 GB
 * default got hit routinely during idle waits between prompts.
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
import {
  printVerboseStartup,
  subscribePerTurnStats,
} from "./verbose-helpers.js";
import { lastTurnWasFailure } from "./session-status.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
  createTurnActivityTracker,
  lastTurnTerminalError,
  runPromptWithThinkingOnlyGuard,
} from "./thinking-only-guard.js";

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
  verbose: boolean;
}

export function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    mode: "interactive",
    cwd: process.cwd(),
    command: "run",
    verbose: false,
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
      case "--verbose":
        args.verbose = true;
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

// Re-export verbose helpers so tests and RPC can load them from cli.ts.
export {
  printVerboseStartup,
  formatTurnMessage,
  subscribePerTurnStats,
} from "./verbose-helpers.js";

/**
 * Wire verbose-mode output for the non-TUI plain / JSON / RPC CLI paths.
 * Immediately prints the assembled system prompt to `startupStream` and
 * subscribes per-turn stats to `perTurnStream`. Both streams default to
 * stderr in the normal call site so stdout (JSON protocol output) stays
 * clean. Returns a single unsubscribe function that detaches the per-turn
 * listener — callers should invoke it during session dispose.
 */
export function wireVerbosePlain(
  session: AgentSession,
  startupStream: NodeJS.WritableStream,
  perTurnStream: NodeJS.WritableStream,
  assembledSystemPrompt: string,
): () => void {
  printVerboseStartup(startupStream, { assembledSystemPrompt });
  return subscribePerTurnStats(session, perTurnStream);
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
  --verbose           Print assembled system prompt + per-turn stats (runtime-only, not persisted)
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
    headless: !useTUI,
    verbose: args.verbose,
  });

  if (useTUI) {
    const { renderTUI } = await import("./tui/render.js");
    await renderTUI(botSession);
  } else {
    await runInteractivePlain(botSession, args.verbose === true);
  }
}

async function runInteractivePlain(
  botSession: Awaited<ReturnType<typeof createDesignSession>>,
  verbose = false,
): Promise<void> {
  console.log("qlaybot - Device Design Agent\n");

  // §4.5: verbose non-TUI plain mode — dump system prompt + per-turn
  // stats to stderr. stdout stays clean for the text-delta stream.
  const verboseUnsub = verbose
    ? wireVerbosePlain(
        botSession.session,
        process.stderr,
        process.stderr,
        botSession.assembledSystemPrompt,
      )
    : () => {};

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
      verboseUnsub();
      await botSession.dispose();
      rl.close();
      process.exit(0);
    }

    // R2 finding #2: intercept slash commands so /plan verify|status work
    // in plain mode. Mirrors the RPC path (rpc.ts:244-258). Commands that
    // need live session state (like /plan verify, which reads planManager)
    // work here because we reuse the same botSession, not a fresh one.
    if (input.startsWith("/") && botSession.commandRegistry) {
      const parsed = parseCommand(input);
      if (parsed) {
        const ctx: CommandContext = { session: botSession, mode: "shell" };
        try {
          const result = await botSession.commandRegistry.execute(parsed.name, parsed.args, ctx);
          console.log(result.output);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\nError: ${msg}`);
        }
        rl.prompt();
        return;
      }
    }

    try {
      botSession.history.recordPrompt(input);
      // Bump BEFORE prompt so transformContext (running inside prompt) sees
      // the correct turn number. R2 fix: was after, causing off-by-one.
      // R4 #1: clear the per-turn latch so the reinjector can fire at
      // most ONCE per user turn across all round-trips.
      botSession.planManager?.clearRemindedThisTurn();
      botSession.planManager?.incrementTurnsSinceExit();
      await botSession.session.prompt(input);
      // R5 finding #1: pi-coding-agent swallows most provider errors and
      // resolves the promise with an error assistant turn instead of
      // throwing. The catch below only fires for true throws (rare — mostly
      // prompt_too_long after recovery exhaust). Check the trailing
      // assistant turn's stopReason to catch swallowed failures and roll
      // back the cadence bump for turns that produced no usable output.
      if (lastTurnWasFailure(botSession.session)) {
        botSession.planManager?.decrementTurnsSinceExit();
      }
    } catch (err: unknown) {
      // R3 finding #1: roll back the pre-prompt bump so failed turns don't
      // inflate the reinjection cadence. Only successful turns count.
      botSession.planManager?.decrementTurnsSinceExit();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nError: ${msg}`);
    } finally {
      // issue #24: bound the exit-turn swallow flag to one prompt cycle so
      // a rejection/abort after exit_plan_mode can't leak into the next turn.
      botSession.planManager?.consumeExitSwallow();
    }
    rl.prompt();
  });

  rl.on("close", async () => {
    unsubscribe();
    verboseUnsub();
    await botSession.dispose();
    process.exit(0);
  });
}

async function runJSON(args: CLIArgs): Promise<void> {
  if (!args.message) {
    console.error("Error: --message required for JSON mode");
    process.exit(1);
  }

  const botSession = await createDesignSession({
    cwd: args.cwd,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    headless: true,
    verbose: args.verbose,
  });

  // §4.5 non-TUI verbose: route system prompt + per-turn stats to stderr
  // so stdout (JSON protocol output) stays clean. Delegates to the shared
  // wireVerbosePlain helper so the same contract applies across plain,
  // JSON, and RPC entry points.
  const turnUnsub = args.verbose
    ? wireVerbosePlain(
        botSession.session,
        process.stderr,
        process.stderr,
        botSession.assembledSystemPrompt,
      )
    : () => {};

  const chunks: string[] = [];
  const unsubscribe = subscribeToSession(botSession.session, {
    onTextDelta: (text) => chunks.push(text),
  });
  const tracker = createTurnActivityTracker(botSession.session);

  try {
    botSession.history.recordPrompt(args.message);
    // #24 bookkeeping: clear per-turn reinjection latch + bump turn counter
    // BEFORE entering the prompt flow so transformContext sees the correct
    // turn number and the plan blob is injected at most ONCE per user turn
    // across all round-trips.
    botSession.planManager?.clearRemindedThisTurn();
    botSession.planManager?.incrementTurnsSinceExit();
    const { retries, stillThinkingOnly, sinceIdx } = await runPromptWithThinkingOnlyGuard(
      botSession.session,
      args.message,
      tracker,
      {
        onRetry: (attempt, max) => {
          // Drop any partial text the failed turn streamed before the
          // error stopReason arrived — otherwise the final JSON response
          // would be `partial_failed_text + retry_text`. See code-review
          // finding #1 (2026-04-23).
          chunks.length = 0;
          console.error(
            `[qlaybot] thinking-only termination detected (attempt ${attempt}/${max}), re-prompting...`,
          );
        },
        onGiveUp: (max) => {
          console.error(
            `[qlaybot] still thinking-only after ${max} retries, giving up`,
          );
        },
      },
    );

    // R3 finding #2 (2026-04-24): if the guard exhausted its retries,
    // `chunks` still holds the LAST failed attempt's partial text
    // (onRetry clears between attempts but not after the final one).
    // Returning that as `completed` is a false-success bug — surface
    // the exhaustion as an error instead.
    //
    // R5 finding #1 (2026-04-24): use `process.exitCode = 1; return;`
    // instead of `process.exit(1)`. The latter terminates before the
    // buffered stdout write drains when piped, and skips the outer
    // `finally {}` that disposes the session. Setting exitCode lets
    // the normal control flow fall through to finally, cleanup runs,
    // stdout drains on beforeExit, and Node exits with status 1.
    if (stillThinkingOnly) {
      chunks.length = 0;
      const errMsg = `Session stopped producing output after ${retries} retry attempts — upstream may be failing, rate-limited, or the error is non-retryable.`;
      const output = { status: "error", error: errMsg, retries };
      console.log(JSON.stringify(output, null, 2));
      process.exitCode = 1;
      return;
    }

    // R8 finding #1 (2026-04-24): non-retryable provider errors
    // (401 / invalid_api_key, context-overflow, invalid_request_error,
    // insufficient_quota, unknown 4xx) are deliberately excluded from
    // the retry loop (R3 #1). Without this check the success path
    // would emit `{status:"completed", response:""}` — the original
    // ml09/ml11 silent-failure pattern in a different shape. Surface
    // the provider error instead.
    const terminalError = lastTurnTerminalError(botSession.session, sinceIdx);
    if (terminalError) {
      chunks.length = 0;
      const output = {
        status: "error",
        error: `Provider error (non-retryable): ${terminalError}`,
        retries,
      };
      console.log(JSON.stringify(output, null, 2));
      process.exitCode = 1;
      return;
    }

    // #24 R5: pi-coding-agent swallows most provider errors and resolves
    // with an error assistant turn. Check the trailing turn after the
    // retry loop so a swallowed failure rolls the cadence back instead
    // of silently inflating it. (#22's terminalError check above already
    // returned for non-retryable errors; this covers the retryable-
    // recovered AND the thinking-only-retried-to-success cases.)
    if (lastTurnWasFailure(botSession.session)) {
      botSession.planManager?.decrementTurnsSinceExit();
    }

    const output = { status: "completed", response: chunks.join(""), retries };
    console.log(JSON.stringify(output, null, 2));
  } catch (err: unknown) {
    // #24 R3 #1: roll back the pre-prompt bump so failed turns don't
    // inflate the reinjection cadence. Only successful turns count.
    // #22 R5 #1: fall through to `finally` so the JSON error envelope
    // flushes cleanly and session cleanup runs (exitCode, not exit).
    botSession.planManager?.decrementTurnsSinceExit();
    const msg = err instanceof Error ? err.message : String(err);
    const output = { status: "error", error: msg };
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  } finally {
    // issue #24: bound the exit-turn swallow flag to one prompt cycle so a
    // rejection/abort after exit_plan_mode can't leak into the next turn.
    botSession.planManager?.consumeExitSwallow();
    unsubscribe();
    tracker.unsubscribe();
    turnUnsub();
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
            verbose: args.verbose,
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
