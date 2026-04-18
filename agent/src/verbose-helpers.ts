/**
 * Verbose-mode helpers — pure functions with no side effects or heavy
 * imports. Kept separate from cli.ts so TUI components can import them
 * without dragging in createDesignSession or the RPC runtime.
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

/**
 * Print the assembled system prompt to the provided writable stream.
 * Used by non-TUI modes (json/rpc) — the prompt is routed to stderr so
 * stdout (JSON protocol output) stays clean.
 */
export function printVerboseStartup(
  stream: NodeJS.WritableStream,
  info: { assembledSystemPrompt: string },
): void {
  const header = "----- qlaybot assembled system prompt -----\n";
  const footer = "\n----- end system prompt -----\n";
  stream.write(header);
  stream.write(info.assembledSystemPrompt);
  stream.write(footer);
}

/**
 * Build the per-turn stats message shown when --verbose is active.
 * Shape:
 *   - with thinking tokens: [turn N: XXXms, in=A, out=B, thinking=C]
 *   - with usage (no thinking): [turn N: XXXms, in=A, out=B]
 *   - timing only: [turn N: XXXms]
 */
export function formatTurnMessage(
  turn: number,
  elapsedMs: number,
  usage?: {
    input?: number;
    output?: number;
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    thinking?: number;
  },
): string {
  if (!usage) {
    return `[turn ${turn}: ${elapsedMs}ms]`;
  }
  const inTok = usage.inputTokens ?? usage.input;
  const outTok = usage.outputTokens ?? usage.output;
  const thinkTok = usage.thinkingTokens ?? usage.thinking;
  if (typeof inTok !== "number" || typeof outTok !== "number") {
    return `[turn ${turn}: ${elapsedMs}ms]`;
  }
  if (typeof thinkTok === "number" && thinkTok > 0) {
    return `[turn ${turn}: ${elapsedMs}ms, in=${inTok}, out=${outTok}, thinking=${thinkTok}]`;
  }
  return `[turn ${turn}: ${elapsedMs}ms, in=${inTok}, out=${outTok}]`;
}

/**
 * Subscribe to an AgentSession's raw event stream and write a per-turn
 * stats line (via `formatTurnMessage`) to `stream` on each `agent_end`
 * event. Tracks `agent_start` → `agent_end` deltas with `Date.now()`.
 * Turn counter starts at 1 and increments once per agent_start.
 *
 * Returns an unsubscribe function that detaches the listener.
 *
 * Shared by non-TUI verbose routing: rpc.ts (writes to process.stderr)
 * and cli.ts::runInteractivePlain (same). The TUI path in App.tsx has
 * its own inline subscription because it must dispatch SYSTEM_MESSAGE
 * actions rather than write to a stream.
 */
export function subscribePerTurnStats(
  session: AgentSession,
  stream: NodeJS.WritableStream,
): () => void {
  let turnN = 0;
  let turnStart = 0;
  const unsub = session.subscribe((ev: unknown) => {
    if (!ev || typeof ev !== "object") return;
    const e = ev as { type?: string; usage?: unknown };
    if (e.type === "agent_start") {
      turnN++;
      turnStart = Date.now();
    } else if (e.type === "agent_end") {
      const elapsed = Date.now() - turnStart;
      const line = formatTurnMessage(
        turnN,
        elapsed,
        e.usage as Parameters<typeof formatTurnMessage>[2],
      );
      try {
        stream.write(line + "\n");
      } catch {
        /* swallow — best-effort */
      }
    }
  });
  return unsub;
}
