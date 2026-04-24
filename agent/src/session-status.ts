/**
 * Session-status helpers.
 *
 * Pi-coding-agent + pi-ai swallow most provider errors: the anthropic /
 * openai providers catch the IIFE's error at `providers/anthropic.js:
 * 315-322`, set `output.stopReason = "error" | "aborted"`, push an error
 * event, and resolve cleanly — `AgentSession.prompt()` never throws.
 * The failed assistant message with the terminal stopReason remains in
 * `session.messages`.
 *
 * A caller's `try { await prompt() } catch { ... }` pattern therefore
 * misses these failures. Use these helpers after `await prompt()` to
 * detect them.
 *
 * R5 finding #1 (2026-04-24): added `lastTurnWasFailure` so issue #24's
 * pre-prompt cadence bump can roll back when the provider swallowed an
 * error instead of throwing.
 *
 * Post-merge follow-up: issue #22's `isThinkingOnlyTermination` in
 * `cli.ts` and this helper share the "inspect trailing assistant turn"
 * pattern. Consolidate both into this file once #22 and #24 land.
 */

/**
 * Returns true iff the last assistant message in the session carries a
 * terminal failure stopReason ("error" or "aborted"). Use to distinguish
 * "prompt resolved but produced no usable response" from "prompt
 * resolved with a real response" — the caller's try/catch can't tell
 * the difference because pi-coding-agent resolves both cleanly.
 *
 * Intervening tool calls / user messages are ignored; only the trailing
 * assistant turn is inspected.
 */
export function lastTurnWasFailure(session: {
  messages?: unknown[];
}): boolean {
  const msgs = (session.messages ?? []) as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role !== "assistant") continue;
    return m.stopReason === "error" || m.stopReason === "aborted";
  }
  return false;
}
