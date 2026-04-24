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
 * trailing toolResult). The ml09/ml11 traces DO show this shape, but
 * the obvious fix — sending a `"Continue..."` user message — is
 * actively harmful. pi-ai's `transform-messages.js:125-141` injects a
 * synthetic toolResult of `"No result provided"` (with isError=true)
 * whenever a user message follows an orphan toolCall, so the model
 * keeps going under the confidently-wrong premise that the tool
 * returned that error. That is strictly worse than returning an empty
 * completion and letting the caller deal with it (R4 finding #1,
 * 2026-04-24). If stalled-toolUse recovery is worth doing, it belongs
 * in the agent-loop layer where the original toolCall can be re-
 * dispatched — not here.
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
 * Keep this regex in sync if pi-coding-agent updates theirs.
 */
const RETRYABLE_ERROR_PATTERN =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server error|internal error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay/i;

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
): boolean {
  const msgs = (session.messages ?? []) as any[];

  let lastAssistantIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
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
  //     ="error" together. `content` may be empty (ml09/ml11 429s that
  //     die before any text streamed) OR contain partial text (mid-
  //     stream disconnect after 30s of streaming — the signature that
  //     broke R1's `!hasAnyText` gate).
  //   - Deliberate provider refusals / safety filters: anthropic.js:689
  //     ("refusal"), :695 ("sensitive"), openai-completions.js:646
  //     ("content_filter"). These pass through the normal stream path
  //     with `mapStopReason` setting `stopReason="error"` but `error
  //     Message` is NOT set (only the catch block sets it).
  //
  // `errorMessage` (pi-ai AssistantMessage.errorMessage, types.d.ts:120)
  // is the primary signal — R2 finding #1 (2026-04-24). But presence
  // alone is too broad: context-overflow, auth, invalid_request all
  // set errorMessage yet are not fixed by retrying. R3 finding #1
  // (2026-04-24) narrows retry to the same set pi-coding-agent's
  // `_isRetryableError` handles (agent-session.js:1663-1673).
  if (last.stopReason === "error") {
    const em = typeof last.errorMessage === "string" ? last.errorMessage : "";
    if (em.length === 0) {
      // Refusal / content_filter / safety — preserve the stop.
      return false;
    }
    // Context overflow is handled by compaction, never by Continue.
    // pi-ai's isContextOverflow checks the 15+ provider-specific
    // patterns (Anthropic "prompt is too long", OpenAI "exceeds the
    // context window", etc.).
    if (isContextOverflow(last)) {
      return false;
    }
    // Only retry errors pi-coding-agent considers retryable. Auth
    // failures, invalid_request_error, insufficient_quota, etc. are
    // surfaced as-is so the caller sees the real error instead of
    // burning through 5 `Continue...` prompts. Callers use
    // `lastTurnTerminalError` to distinguish this non-retryable path
    // from a true success and surface it as status=error. (R3 #1
    // excluded these from retry; R8 #1 added the separate terminal-
    // error signal.)
    if (!isRetryableErrorMessage(em)) {
      return false;
    }
    return true;
  }

  // Stalled toolUse is intentionally NOT handled here — the obvious
  // retry path (send "Continue..." user message) is actively harmful
  // because pi-ai synthesises a fake toolResult for the orphan call.
  // See file-header comment. Fall through to the content-shape check
  // below; the toolCall-present branch at `hasToolCall` will abstain.

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
 *       `status: "completed"` with an empty response. That is the
 *       original ml09/ml11 silent-failure pattern in a different
 *       shape (R8 finding #1, 2026-04-24).
 *   (3) refusals: `stopReason="error"` with no `errorMessage`, text
 *       content preserved from the provider. Those are a legitimate
 *       success and this helper returns null.
 *
 * Mirror of issue #24's `lastTurnWasFailure` (agent/src/session-
 * status.ts on main) — both helpers walk the trailing assistant turn.
 * Once #22 and #24 both merge, consolidate this into session-status.ts.
 */
export function lastTurnTerminalError(session: {
  messages?: unknown[];
}): string | null {
  const msgs = (session.messages ?? []) as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role !== "assistant") continue;
    if (m.stopReason !== "error" && m.stopReason !== "aborted") return null;
    const em = typeof m.errorMessage === "string" ? m.errorMessage : "";
    if (em.length === 0) return null; // refusal with preserved content
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
): boolean {
  // After rounds R1–R7 the message-shape detector covers every
  // canonical pi-ai shape that ought to retry (thinking-only stops,
  // retryable transport errors, aborts). The original activity-based
  // fallback existed as belt-and-suspenders for unseen shapes, but
  // every concrete case it could fire on today is either wrong or
  // harmful:
  //
  //   - Extension-handled prompts (R7 finding #1, 2026-04-24):
  //     pi-coding-agent autoloads _extensionRunner whenever
  //     customTools are passed (agent-session.js:1583-1586) — qlaybot
  //     always passes them (agent.ts:397), so
  //     `_tryExecuteExtensionCommand` (agent-session.js:500-505) and
  //     `_extensionRunner.emitInput` (:510-514) can resolve prompt()
  //     cleanly with no assistant message and no stream activity.
  //     The previous R4 #2 gate correctly returned false for this
  //     case; an inverted "require terminal assistant with stopReason
  //     + no activity" gate would still mis-fire on (2) and (3) below.
  //   - Orphan toolUse (R4 finding #1, 2026-04-24): terminal
  //     assistant with stopReason="toolUse" + a toolCall that the
  //     agent loop never executed. Shape detector abstains
  //     (hasToolCall trusts the stop). A Continue-prompt retry here
  //     would trigger pi-ai's synthetic `"No result provided"`
  //     toolResult injection (transform-messages.js:125-141) and the
  //     model would produce confidently-wrong output grounded in a
  //     fake tool error.
  //   - Legitimate empty completion (R2 finding #2, 2026-04-24):
  //     stopReason="stop" + content=[]. Retrying the stop corrupts a
  //     clean finish.
  //
  // No remaining case requires the fallback to fire. Delegate
  // entirely to the shape detector. The `tracker` parameter is
  // retained for API stability — callers still wire subscribe /
  // unsubscribe around the guard, which is harmless.
  void tracker;
  return isThinkingOnlyTerminationByMessages(session);
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

  tracker.reset();
  await session.prompt(message);

  let retries = 0;
  while (
    isThinkingOnlyTermination(session, tracker) &&
    retries < maxRetries
  ) {
    retries++;
    opts.onRetry?.(retries, maxRetries);
    tracker.reset();
    await session.prompt(continuePrompt);
  }

  const stillThinkingOnly = isThinkingOnlyTermination(session, tracker);
  if (retries > 0 && stillThinkingOnly) {
    opts.onGiveUp?.(maxRetries);
  }
  return { retries, stillThinkingOnly };
}
