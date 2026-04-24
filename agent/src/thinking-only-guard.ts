/**
 * Early-exit termination detector + activity-stream fallback.
 *
 * Despite the "thinking-only" naming (kept for issue-#22 continuity), this
 * guard catches two modes of `session.prompt()` returning before the
 * agent actually finished:
 *
 *   1. Pure thinking-only turn (stop after a reasoning block, no text /
 *      no tool call) — the original plan-doc hypothesis.
 *   2. Terminal `stopReason: "error"` or `"aborted"` — e.g. k2p6 429
 *      rate-limit where pi-coding-agent's auto-retry exhausted. Content
 *      is typically `[]`, making the message-shape detector useless.
 *
 * NOT HANDLED HERE: stalled tool-use (stopReason="toolUse" with no
 * trailing toolResult). Sending a `"Continue..."` user message in this
 * state is actively harmful: pi-ai's `transform-messages.js:125-141`
 * injects a synthetic toolResult of `"No result provided"` (isError=true)
 * whenever a user message follows an orphan toolCall, so the model
 * continues under the confidently-wrong premise that the tool errored.
 * Stalled-toolUse recovery belongs in the agent-loop layer where the
 * original toolCall can be re-dispatched, not here.
 *
 * The message-shape detector covers (1) and as much of (2) as is
 * possible to see (content: []). The activity-stream fallback is a
 * belt-and-suspenders guard for malformed shapes and "no terminal
 * assistant message at all" cases. See
 * `docs/early_exit_report_2026_04_23_k2p6.md` and issue #22.
 */

import { isContextOverflow } from "@mariozechner/pi-ai";

export const THINKING_ONLY_MAX_RETRIES = 5;

/**
 * Canonical retryable-error regex mirrored from pi-coding-agent's
 * `_isRetryableError` (agent-session.js:1672). Any `stopReason="error"`
 * whose `errorMessage` does NOT match this pattern is treated as
 * non-retryable: auth failures, invalid_request errors, malformed body,
 * unknown 4xx, etc. Context-overflow is handled separately via pi-ai's
 * `isContextOverflow` because it has its own provider-specific patterns.
 * Keep in sync if pi-coding-agent updates theirs.
 *
 * HTTP status codes use `\b` so bare "500" doesn't match "5000" inside
 * e.g. `max_tokens must be <= 5000` (a non-retryable 4xx validation
 * error whose message happens to contain a 5xx-looking digit run).
 */
const RETRYABLE_ERROR_PATTERN =
  /overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server error|internal error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay/i;

/**
 * Whether an errorMessage looks retryable per pi-coding-agent's
 * `_isRetryableError`. Context-overflow is NOT considered retryable
 * here — callers that want both checks should additionally consult
 * `isContextOverflow`.
 */
export function isRetryableErrorMessage(em: string): boolean {
  return RETRYABLE_ERROR_PATTERN.test(em);
}

export const THINKING_ONLY_CONTINUE_PROMPT =
  "Continue. You stopped mid-task after a thinking block — keep working.";

export interface TurnActivity {
  sawText: boolean;
  sawToolCall: boolean;
}

export interface TurnActivityTracker {
  current(): TurnActivity;
  reset(): void;
  unsubscribe(): void;
}

/**
 * Message-shape detector. Walks back from the end of `session.messages`
 * to the most recent assistant turn and classifies it as an early-exit
 * termination. Returns true when any of these holds:
 *
 *   - stopReason is "aborted" (upstream disconnect / signal)
 *   - stopReason is "error" with a retryable errorMessage
 *   - Content is reasoning-only with no text and no tool call
 *
 * Stalled toolUse (stopReason="toolUse" with no trailing toolResult) is
 * intentionally NOT matched here — see the file-header comment.
 *
 * Also matches legacy / hypothetical shapes (thinking_block, reasoning,
 * tool_use, tool_call) as a defensive measure against future SDK changes —
 * the canonical pi-ai types are toolCall / thinking / text.
 */
export function isThinkingOnlyTerminationByMessages(
  session: { messages?: unknown[] },
  sinceIdx: number = 0,
): boolean {
  const msgs = (session.messages ?? []) as any[];

  // Scan is bounded to messages produced by the CURRENT prompt. In a
  // persistent session (TUI / RPC) `session.messages` accumulates across
  // turns; without this boundary an extension-handled current turn would
  // read the PRIOR turn's trailing assistant shape and retry against stale
  // state. Callers pass the pre-prompt message length (or an identity-
  // derived index for compaction-tracking — see runPromptWithThinkingOnlyGuard).
  let lastAssistantIdx = -1;
  for (let i = msgs.length - 1; i >= sinceIdx; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return false;

  const last = msgs[lastAssistantIdx];

  // Aborted: upstream disconnect or signal. pi-coding-agent's
  // _autoRetry only handles some of these internally; when it exhausts,
  // the error turn is what `prompt()` resolves on.
  if (last.stopReason === "aborted") {
    return true;
  }

  // stopReason="error" collapses two very different situations in
  // pi-ai's provider normalization:
  //
  //   - Transport / rate-limit / catch-block errors: anthropic.js:318
  //     and openai-completions.js:257 set `errorMessage` AND stopReason
  //     ="error". `content` may be empty (e.g. 429 before any text
  //     streamed) OR contain partial text (mid-stream disconnect).
  //   - Deliberate provider refusals / safety filters: anthropic.js:689
  //     ("refusal"), :695 ("sensitive"), openai-completions.js:646
  //     ("content_filter"). These go through the normal stream path
  //     with `mapStopReason` setting `stopReason="error"` but leaving
  //     `errorMessage` UNSET (only the catch block sets it).
  //
  // `errorMessage` presence is the primary signal but too broad alone:
  // context-overflow, auth, and invalid_request all set it yet are not
  // fixed by retrying. Mirror pi-coding-agent's `_isRetryableError`
  // (agent-session.js:1663-1673) to narrow correctly.
  if (last.stopReason === "error") {
    const em = typeof last.errorMessage === "string" ? last.errorMessage : "";
    if (em.length === 0) {
      // Refusal / content_filter / safety — preserve the stop.
      return false;
    }
    // Context overflow is handled by compaction, never by Continue.
    if (isContextOverflow(last)) {
      return false;
    }
    // Auth, invalid_request, quota, etc. are surfaced as-is so the
    // caller sees the real error instead of burning 5 `Continue...`
    // prompts. `lastTurnTerminalError` distinguishes this path from a
    // real success and converts it to status=error at the I/O boundary.
    if (!isRetryableErrorMessage(em)) {
      return false;
    }
    return true;
  }

  // Stalled toolUse is intentionally NOT handled here — see file-header.
  // Fall through to the content-shape check below; `hasToolCall` will
  // abstain.

  if (!Array.isArray(last.content)) return false;

  const hasText = last.content.some(
    (c: any) =>
      c?.type === "text" &&
      typeof c.text === "string" &&
      c.text.trim().length > 0,
  );
  const hasToolCall = last.content.some(
    (c: any) =>
      c?.type === "toolCall" ||
      c?.type === "tool_use" ||
      c?.type === "tool_call",
  );
  if (hasText || hasToolCall) return false;

  const hasThinking = last.content.some((c: any) => {
    if (!c) return false;
    if (
      c.type === "thinking" &&
      typeof c.thinking === "string" &&
      c.thinking.trim().length > 0
    )
      return true;
    if (
      c.type === "thinking_block" &&
      typeof c.text === "string" &&
      c.text.trim().length > 0
    )
      return true;
    if (
      c.type === "reasoning" &&
      typeof c.text === "string" &&
      c.text.trim().length > 0
    )
      return true;
    return false;
  });
  return hasThinking;
}

/**
 * Returns the errorMessage of the last assistant turn iff that turn
 * ended with a non-retryable provider error; null otherwise. Callers
 * use this AFTER `runPromptWithThinkingOnlyGuard` has finished to
 * distinguish:
 *
 *   (1) `shouldRetry` cases the guard retried: thinking-only,
 *       aborted, retryable transport errors — these either recover
 *       (normal success) or hit maxRetries (`stillThinkingOnly`).
 *   (2) non-retryable terminal errors: 401 / invalid_api_key,
 *       context-overflow (`prompt_too_long`, `exceeds the context
 *       window`, …), `invalid_request_error`, `insufficient_quota`,
 *       unknown 4xx, etc. These are NOT retried and NOT
 *       thinking-only — `isThinkingOnlyTermination` returns false,
 *       so callers that only branch on `stillThinkingOnly` would
 *       fall through to the success path and emit
 *       `status: "completed"` with an empty response. This helper
 *       surfaces them instead.
 *   (3) refusals: `stopReason="error"` with no `errorMessage`, text
 *       content preserved from the provider. Those are a legitimate
 *       success and this helper returns null.
 *
 * Mirrors `lastTurnWasFailure` in `session-status.ts` — both helpers
 * walk the trailing assistant turn. Candidate for consolidation.
 */
export function lastTurnTerminalError(
  session: { messages?: unknown[] },
  sinceIdx: number = 0,
): string | null {
  const msgs = (session.messages ?? []) as any[];
  // Same boundary as isThinkingOnlyTerminationByMessages — only inspect
  // assistant messages pushed by the current prompt. Otherwise a
  // persistent-session scan could surface a PRIOR turn's errorMessage
  // on a cleanly extension-handled current turn.
  for (let i = msgs.length - 1; i >= sinceIdx; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role !== "assistant") continue;
    if (m.stopReason !== "error" && m.stopReason !== "aborted") return null;
    const em = typeof m.errorMessage === "string" ? m.errorMessage : "";
    if (em.length === 0) return null; // refusal with preserved content
    // Context-overflow must be checked BEFORE the retryable regex:
    // context-overflow messages like "prompt is too long: 250000 tokens"
    // contain "500" in "250000", which the retryable regex would match,
    // causing this helper to return null and the caller to take the
    // success path with an empty response. Mirrors pi-coding-agent's
    // ordering at agent-session.js:1666-1672.
    if (isContextOverflow(m)) return em; // non-retryable terminal
    if (isRetryableErrorMessage(em)) return null; // caller already retried
    return em; // non-retryable terminal error
  }
  return null;
}

/**
 * Subscribe to the live session event stream and record whether the
 * current turn produced a text delta or a tool execution. Used as the
 * belt-and-suspenders fallback when the message-shape detector can't
 * decide (streaming-delta shapes, absent terminal assistant message).
 */
export function createTurnActivityTracker(
  session: { subscribe?: (listener: (ev: any) => void) => () => void },
): TurnActivityTracker {
  let activity: TurnActivity = { sawText: false, sawToolCall: false };
  const unsub =
    session.subscribe?.((event: any) => {
      if (!event) return;
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        activity.sawText = true;
      } else if (event.type === "tool_execution_start") {
        activity.sawToolCall = true;
      }
    }) ?? (() => {});
  return {
    current: () => activity,
    reset: () => {
      activity = { sawText: false, sawToolCall: false };
    },
    unsubscribe: unsub,
  };
}

/**
 * Combined detector: message-shape first, then activity-stream fallback.
 * Returns true when the current turn was thinking-only by either signal.
 */
export function isThinkingOnlyTermination(
  session: { messages?: unknown[] },
  tracker: TurnActivityTracker,
  sinceIdx: number = 0,
): boolean {
  // The message-shape detector covers every canonical pi-ai shape that
  // ought to retry (thinking-only stops, retryable transport errors,
  // aborts). The original activity-stream fallback existed for unseen
  // shapes, but every concrete case it could fire on today is either
  // wrong or harmful:
  //
  //   - Extension-handled prompts: pi-coding-agent autoloads
  //     _extensionRunner whenever customTools are passed (agent-
  //     session.js:1583-1586) — qlaybot always does (agent.ts:397), so
  //     _tryExecuteExtensionCommand (:500-505) and emitInput (:510-514)
  //     can resolve prompt() cleanly with no assistant message and no
  //     stream activity. The fallback would retry a handled command.
  //   - Orphan toolUse: terminal assistant with stopReason="toolUse"
  //     and a toolCall the agent loop never executed. A Continue-
  //     prompt here triggers pi-ai's synthetic `"No result provided"`
  //     toolResult injection (transform-messages.js:125-141); the
  //     model then produces confidently-wrong output grounded in a
  //     fake tool error.
  //   - Legitimate empty completion: stopReason="stop" + content=[].
  //     Retrying corrupts a clean finish.
  //
  // Delegate entirely to the shape detector. The `tracker` parameter
  // is retained for API stability — callers still wire subscribe /
  // unsubscribe around the guard, which is harmless.
  void tracker;
  return isThinkingOnlyTerminationByMessages(session, sinceIdx);
}

export interface PromptWithGuardOptions {
  maxRetries?: number;
  continuePrompt?: string;
  onRetry?: (attempt: number, max: number) => void;
  onGiveUp?: (max: number) => void;
}

export interface PromptWithGuardResult {
  retries: number;
  stillThinkingOnly: boolean;
  /**
   * Boundary index into `session.messages` — the first position that
   * belongs to the CURRENT prompt. Pass to `lastTurnTerminalError`
   * (and other scan helpers) so inspection ignores prior-turn shapes
   * that could mis-fire on a cleanly-handled current turn.
   */
  sinceIdx: number;
}

/**
 * Wrap `session.prompt(message)` with the thinking-only retry loop.
 * Returns the retry count and a final flag indicating whether the session
 * is still thinking-only after the loop gave up. Callers own the subscribe
 * wiring for `chunks` / `sendEvent` — this helper only owns the retry
 * decision, the tracker reset between turns, and the continue-prompt text.
 */
export async function runPromptWithThinkingOnlyGuard(
  session: {
    prompt: (message: string) => Promise<void>;
    messages?: unknown[];
  },
  message: string,
  tracker: TurnActivityTracker,
  opts: PromptWithGuardOptions = {},
): Promise<PromptWithGuardResult> {
  const maxRetries = opts.maxRetries ?? THINKING_ONLY_MAX_RETRIES;
  const continuePrompt = opts.continuePrompt ?? THINKING_ONLY_CONTINUE_PROMPT;

  // Establish a "current prompt" boundary so the shape detector and
  // lastTurnTerminalError only inspect assistant messages pushed by
  // THIS prompt. Persistent sessions (TUI, RPC) accumulate history
  // across turns; without the bound, an extension-handled or no-output
  // current turn would read the prior turn's trailing assistant shape
  // and retry against stale state.
  //
  // Why track by object identity, not length:
  // `AgentSession.prompt()` can run pre-prompt or overflow compaction
  // that REPLACES `session.messages` with a shorter array before
  // appending the current turn. A length snapshot can point past the
  // new array's end (→ scans never iterate → current-turn error
  // missed → silent empty success, the original ml09/ml11 failure
  // class). A length-shrink check also misses the case where
  // compaction drops K messages AND the prompt adds K messages,
  // netting to the same length while the current assistant lives
  // BEFORE the stale snapshot. Snapshot the last pre-prompt message
  // by reference; after prompt, locate it in the post-prompt array
  // and set sinceIdx to one past it. If dropped by compaction, scan
  // everything — safe because the stale prior-turn shape the bound
  // was guarding against was also discarded.
  const initialMsgs = session.messages ?? [];
  const preLastMsgRef: unknown =
    initialMsgs.length > 0 ? initialMsgs[initialMsgs.length - 1] : null;
  let sinceIdx = initialMsgs.length;
  const reboundAfterCompaction = (): number => {
    const msgs = session.messages ?? [];
    if (preLastMsgRef === null) {
      // Empty pre-prompt history — scan everything.
      sinceIdx = 0;
      return sinceIdx;
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] === preLastMsgRef) {
        sinceIdx = i + 1;
        return sinceIdx;
      }
    }
    // preLastMsgRef dropped by compaction → scan everything new.
    sinceIdx = 0;
    return sinceIdx;
  };

  tracker.reset();
  await session.prompt(message);
  reboundAfterCompaction();

  let retries = 0;
  while (
    isThinkingOnlyTermination(session, tracker, sinceIdx) &&
    retries < maxRetries
  ) {
    retries++;
    opts.onRetry?.(retries, maxRetries);
    tracker.reset();
    await session.prompt(continuePrompt);
    reboundAfterCompaction();
  }

  const stillThinkingOnly = isThinkingOnlyTermination(
    session,
    tracker,
    sinceIdx,
  );
  if (retries > 0 && stillThinkingOnly) {
    opts.onGiveUp?.(maxRetries);
  }
  return { retries, stillThinkingOnly, sinceIdx };
}
