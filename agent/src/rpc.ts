/**
 * RPC mode for qlaybot.
 * JSON-RPC over stdin/stdout for E2E testing and integration.
 */

import { createDesignSession, type QlayBotSession } from "./agent.js";
import { subscribeToSession } from "./events.js";
import { parseCommand, type CommandContext } from "./commands/index.js";
import { createInterface } from "readline";

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
}): Promise<void> {
  let botSession: QlayBotSession | null = null;

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
          botSession = await createDesignSession({
            cwd: (req.params?.cwd as string) ?? opts.cwd,
            model: (req.params?.model as string) ?? opts.model,
            thinkingLevel:
              (req.params?.thinkingLevel as "high") ?? opts.thinkingLevel,
            ephemeral: req.params?.ephemeral !== false,
          });
          sendResult(req.id, { status: "initialized" });
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

          try {
            await botSession.session.prompt(message);
            const responseText = chunks.join("");
            botSession.history.recordResponse(responseText);
            sendResult(req.id, { status: "completed", response: responseText });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            botSession.history.recordError(msg);
            sendEvent("error", { message: msg });
            sendError(req.id, -32000, `Prompt failed: ${msg}`);
          } finally {
            unsubscribe();
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
            planMode: botSession.planManager?.isActive() ?? false,
            backgroundTasks: botSession.backgroundTaskManager?.list() ?? [],
          });
          break;
        }

        case "dispose": {
          if (botSession) {
            await botSession.dispose();
            botSession = null;
          }
          sendResult(req.id, { status: "disposed" });
          break;
        }

        case "shutdown": {
          if (botSession) {
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
      await botSession.dispose();
    }
    process.exit(0);
  });

  sendEvent("ready", { version: "0.3.0" });
}
