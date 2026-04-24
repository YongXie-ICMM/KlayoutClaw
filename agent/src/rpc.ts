/**
 * RPC mode for qlaybot.
 * JSON-RPC over stdin/stdout for E2E testing and integration.
 */

import { createDesignSession, type QlayBotSession } from "./agent.js";
import { subscribeToSession } from "./events.js";
import { getTranscriptMarkerEmitter } from "./events/marker-emitter.js";
import type { TranscriptMarker } from "./events/marker-types.js";
import { parseCommand, type CommandContext } from "./commands/index.js";
import {
  createTurnActivityTracker,
  lastTurnTerminalError,
  runPromptWithThinkingOnlyGuard,
  THINKING_ONLY_MAX_RETRIES,
} from "./thinking-only-guard.js";
import { createInterface } from "readline";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __rpc_filename = fileURLToPath(import.meta.url);
const __rpc_dirname = dirname(__rpc_filename);
const PKG_VERSION = (
  JSON.parse(
    readFileSync(resolve(__rpc_dirname, "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

// Re-export §4.5 per-turn stats helper so callers can import it from
// rpc.ts (matches the spec-test import surface).
export { subscribePerTurnStats } from "./verbose-helpers.js";

/**
 * Forward TranscriptMarkerEmitter "marker" events on the session to the
 * JSON-RPC event stream as `transcript_marker` frames (v0.4.4 §4.7
 * Consumers).
 *
 * Contract:
 *   - The raw marker object is delivered as the JSON-RPC `params`
 *     payload — NO envelope wrapping. §4.7 canonical-ts rule: the
 *     marker's `ts` field is authoritative; the RPC wrapper must not
 *     add a divergent `ts`.
 *   - Returns an unsubscribe function. `startRPCServer` MUST call it
 *     on `dispose` / `shutdown` / re-initialize to avoid listener
 *     leaks across sessions.
 *   - If the session has no registered emitter (legacy / unregistered
 *     session), returns a no-op unsubscribe. Markers are forward-compat
 *     per §2.
 *
 * Exported as a named helper so unit tests can drive the real RPC
 * code-path without spinning up the full readline pump on stdin.
 */
export function subscribeMarkersToRPC(
  session: object,
  sendEvent: (method: string, params: Record<string, unknown>) => void,
): () => void {
  const emitter = getTranscriptMarkerEmitter(session);
  if (!emitter) {
    return () => {
      /* no-op — no emitter bound to the session */
    };
  }
  const listener = (marker: TranscriptMarker): void => {
    // §4.7 canonical-ts: params IS the marker (no wrapper-level `ts`).
    // Widen to the JSON-RPC index signature; the discriminated-union
    // literal keys don't auto-widen.
    sendEvent(
      "transcript_marker",
      marker as unknown as Record<string, unknown>,
    );
  };
  emitter.on("marker", listener);
  return () => emitter.off("marker", listener);
}

interface RPCRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface RPCResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RPCEvent {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

/**
 * Start the RPC server, reading JSON-RPC from stdin and writing to stdout.
 */
export async function startRPCServer(opts: {
  cwd?: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  verbose?: boolean;
}): Promise<void> {
  let botSession: QlayBotSession | null = null;
  let verbosePerTurnUnsub: (() => void) | null = null;
  // §4.7 — unsubscribe handle for the TranscriptMarkerEmitter → RPC
  // stream bridge. Installed during initialize, called on dispose /
  // shutdown / re-initialize to avoid listener leaks.
  let markerForwardUnsub: (() => void) | null = null;
  // Serialize concurrent `initialize` calls — parallel RPC init requests
  // previously leaked sessions because both would race past the null-check
  // on `botSession` before either cleanup ran.
  let initializing: Promise<void> | null = null;

  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  function send(msg: RPCResponse | RPCEvent): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  function sendResult(id: number | string, result: unknown): void {
    send({ jsonrpc: "2.0", id, result });
  }

  function sendError(
    id: number | string,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    send({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  function sendEvent(method: string, params: Record<string, unknown>): void {
    send({ jsonrpc: "2.0", method, params });
  }

  rl.on("line", async (line: string) => {
    let req: RPCRequest;
    try {
      req = JSON.parse(line.trim()) as RPCRequest;
    } catch {
      sendError(0, -32700, "Parse error");
      return;
    }

    if (req.jsonrpc !== "2.0" || !req.method) {
      sendError(req.id ?? 0, -32600, "Invalid Request");
      return;
    }

    try {
      switch (req.method) {
        case "initialize": {
          // Promise-chain serialization: every initialize call snapshots
          // the current `initializing` promise BEFORE overwriting it,
          // then chains `await prev` as the first line of its own task.
          // This guarantees strict FIFO ordering regardless of how many
          // initialize requests are in flight simultaneously — the simple
          // `if (initializing) await initializing` idiom only serializes
          // two callers because all waiters wake at once on resolve.
          const prev = initializing ?? Promise.resolve();
          const myInit = (async () => {
            await prev;
            // Clean up any prior session before re-initializing — guards
            // against listener leaks when initialize is called twice on
            // the same RPC connection.
            verbosePerTurnUnsub?.();
            verbosePerTurnUnsub = null;
            markerForwardUnsub?.();
            markerForwardUnsub = null;
            await botSession?.dispose();
            botSession = null;

            botSession = await createDesignSession({
              cwd: (req.params?.cwd as string) ?? opts.cwd,
              model: (req.params?.model as string) ?? opts.model,
              thinkingLevel:
                (req.params?.thinkingLevel as "high") ?? opts.thinkingLevel,
              ephemeral: req.params?.ephemeral !== false,
              headless: true,
              verbose:
                (req.params?.verbose as boolean) ?? opts.verbose ?? false,
            });
            // §4.7 — forward TranscriptMarkerEmitter markers to the RPC
            // event stream. Helper is exported from this module so tests
            // can drive the same code-path in isolation.
            markerForwardUnsub = subscribeMarkersToRPC(
              botSession.session,
              sendEvent,
            );
            if (opts.verbose || req.params?.verbose) {
              const { printVerboseStartup, subscribePerTurnStats } =
                await import("./verbose-helpers.js");
              printVerboseStartup(process.stderr, {
                assembledSystemPrompt: botSession.assembledSystemPrompt,
              });
              // §4.5 — wire per-turn timing to stderr so JSON-RPC responses
              // on stdout remain parseable. Unsubscribe on dispose.
              verbosePerTurnUnsub = subscribePerTurnStats(
                botSession.session,
                process.stderr,
              );
            }
          })();
          // Store the tail-of-chain promise (swallowed rejection form) so
          // the next initialize caller can await it without inheriting
          // our failure — but THIS caller still sees the original error.
          const tail = myInit.catch(() => {
            /* swallow — propagates only to this caller below */
          });
          initializing = tail;
          try {
            await myInit;
            sendResult(req.id, { status: "initialized" });
          } finally {
            // Only clear the pointer if no further initialize has chained
            // onto us (i.e. the tail is still ours).
            if (initializing === tail) initializing = null;
          }
          break;
        }

        case "prompt": {
          if (!botSession) {
            sendError(
              req.id,
              -32000,
              "Session not initialized. Call 'initialize' first.",
            );
            return;
          }
          const message = req.params?.message as string;
          if (!message) {
            sendError(req.id, -32602, "Missing 'message' parameter");
            return;
          }

          // PM-6 step 2: reset per-turn replan counter at user-turn boundary.
          botSession.planManager?.stateMachine?.resetReplanCount?.(
            botSession.planManager.sessionKey,
          );

          // Route slash commands
          const parsed = parseCommand(message);
          if (parsed && botSession.commandRegistry) {
            sendEvent("prompt_start", { message });
            const ctx: CommandContext = { session: botSession, mode: "rpc" };
            const cmdResult = await botSession.commandRegistry.execute(
              parsed.name,
              parsed.args,
              ctx,
            );
            sendResult(req.id, {
              status: "completed",
              response: cmdResult.output,
              stateChange: cmdResult.stateChange,
            });
            return;
          }

          sendEvent("prompt_start", { message });

          // Record to history
          botSession.history.recordPrompt(message);

          const chunks: string[] = [];
          const unsubscribe = subscribeToSession(botSession.session, {
            onTextDelta: (text) => {
              chunks.push(text);
              sendEvent("content_delta", {
                delta: { type: "text_delta", text },
              });
            },
            onThinkingDelta: (delta) => {
              sendEvent("thinking", { delta });
            },
            onToolStart: (name, input) => {
              sendEvent("tool_use", { name, input });
            },
            onToolEnd: (name, output) => {
              sendEvent("tool_result", { name, output });
            },
            onUsageUpdate: (usage) => {
              sendEvent("usage_update", { usage });
            },
          });

          const tracker = createTurnActivityTracker(botSession.session);
          try {
            // Defense in depth against thinking-only terminations. Same guard
            // as cli.ts runJSON — see thinking-only-guard.ts and issue #22.
            const { retries, stillThinkingOnly } =
              await runPromptWithThinkingOnlyGuard(
                botSession.session,
                message,
                tracker,
                {
                  onRetry: (attempt, max) => {
                    // Drop any partial text the failed turn streamed
                    // before the error stopReason arrived. The client has
                    // ALREADY received `content_delta` events for those
                    // chunks, so also emit `thinking_only_reset` to tell
                    // IDE clients to discard what they displayed for the
                    // failed attempt.
                    //
                    // Event contract: `{ attempt, max, final }`.
                    // - `final: false` on intermediate resets (this
                    //   callback) — a retry follows.
                    // - `final: true` on the exhaustion reset emitted
                    //   after the loop gives up (R4 finding #2) — no
                    //   retry follows, the `error` envelope comes next.
                    // Fires immediately before `thinking_only_reprompt`
                    // so clients can clear display state and then show
                    // a retry banner. See code-review finding #1
                    // (2026-04-23) and finding #2 R4 (2026-04-24).
                    chunks.length = 0;
                    sendEvent("thinking_only_reset", {
                      attempt,
                      max,
                      final: false,
                    });
                    sendEvent("thinking_only_reprompt", { attempt, max });
                  },
                },
              );

            // R3 finding #2 (2026-04-24): if retries exhausted, the
            // chunks buffer still holds the last failed attempt's
            // partial text. Returning it as `completed` masks an
            // upstream failure — surface the exhaustion instead.
            if (stillThinkingOnly) {
              chunks.length = 0;
              // R4 finding #2 (2026-04-24): also emit a terminal
              // `thinking_only_reset` so IDE clients can discard the
              // `content_delta` events from the final failed attempt
              // — intermediate retries reset their attempts via the
              // onRetry callback but the last attempt has no retry to
              // trigger one. `final: true` distinguishes this from
              // intermediate resets (followed by a retry).
              sendEvent("thinking_only_reset", {
                attempt: retries,
                max: THINKING_ONLY_MAX_RETRIES,
                final: true,
              });
              const errMsg = `Retries exhausted after ${retries} attempts — upstream unresponsive or error is non-retryable.`;
              botSession.history.recordError(errMsg);
              sendEvent("error", { message: errMsg });
              sendError(req.id, -32000, errMsg);
              break;
            }

            // R8 finding #1 (2026-04-24): same non-retryable provider
            // error check as cli.ts runJSON. Without this the success
            // path would send `sendResult(..., {status:"completed",
            // response:""})` and silently return a fake success on
            // auth / quota / context-overflow.
            const terminalError = lastTurnTerminalError(botSession.session);
            if (terminalError) {
              chunks.length = 0;
              const errMsg = `Provider error (non-retryable): ${terminalError}`;
              botSession.history.recordError(errMsg);
              sendEvent("error", { message: errMsg });
              sendError(req.id, -32000, errMsg);
              break;
            }

            const responseText = chunks.join("");
            botSession.history.recordResponse(responseText);
            sendResult(req.id, {
              status: "completed",
              response: responseText,
              retries,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            botSession.history.recordError(msg);
            sendEvent("error", { message: msg });
            sendError(req.id, -32000, `Prompt failed: ${msg}`);
          } finally {
            unsubscribe();
            tracker.unsubscribe();
          }
          break;
        }

        case "get_session_info": {
          if (!botSession) {
            sendError(
              req.id,
              -32000,
              "Session not initialized. Call 'initialize' first.",
            );
            return;
          }
          const contextUsage = botSession.getContextUsage();
          sendResult(req.id, {
            model: botSession.config.agent.defaultModel,
            thinkingLevel: botSession.config.agent.thinkingLevel,
            contextUsage,
            planMode: botSession.planManager?.inPlanMode ?? false,
            backgroundTasks: botSession.backgroundTaskManager?.list() ?? [],
          });
          break;
        }

        case "dispose": {
          if (botSession) {
            if (verbosePerTurnUnsub) {
              verbosePerTurnUnsub();
              verbosePerTurnUnsub = null;
            }
            if (markerForwardUnsub) {
              markerForwardUnsub();
              markerForwardUnsub = null;
            }
            await botSession.dispose();
            botSession = null;
          }
          sendResult(req.id, { status: "disposed" });
          break;
        }

        case "shutdown": {
          if (botSession) {
            if (verbosePerTurnUnsub) {
              verbosePerTurnUnsub();
              verbosePerTurnUnsub = null;
            }
            if (markerForwardUnsub) {
              markerForwardUnsub();
              markerForwardUnsub = null;
            }
            await botSession.dispose();
            botSession = null;
          }
          sendResult(req.id, { status: "shutdown" });
          process.exit(0);
          break;
        }

        default:
          sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(req.id, -32603, `Internal error: ${msg}`);
    }
  });

  rl.on("close", async () => {
    if (botSession) {
      if (verbosePerTurnUnsub) {
        verbosePerTurnUnsub();
        verbosePerTurnUnsub = null;
      }
      if (markerForwardUnsub) {
        markerForwardUnsub();
        markerForwardUnsub = null;
      }
      await botSession.dispose();
    }
    process.exit(0);
  });

  sendEvent("ready", { version: PKG_VERSION });
}
