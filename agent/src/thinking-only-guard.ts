/**
 * Thinking-only termination detector + activity-stream fallback.
 *
 * Guards qlaybot's `-m` JSON and RPC modes against runs where the model
 * emits only reasoning, stops with no text / no tool call, and the SDK
 * reports completion. See issue #22 and
 * `docs/early_exit_report_2026_04_23_k2p6.md`.
 */

export const THINKING_ONLY_MAX_RETRIES = 5;

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
 * to the most recent assistant turn and classifies it. Returns true only
 * when that turn has reasoning content but no text and no tool call.
 *
 * Handles multiple finalized reasoning-block shapes the SDK may use:
 * `thinking`, `thinking_block`, and `reasoning`. Streaming-delta content
 * (e.g. bare `thinking_delta`) is NOT detectable here — callers must
 * rely on the activity-stream fallback for that case.
 */
export function isThinkingOnlyTerminationByMessages(
  session: { messages?: unknown[] },
): boolean {
  const msgs = (session.messages ?? []) as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) return false;

    const hasText = m.content.some(
      (c: any) =>
        c?.type === "text" &&
        typeof c.text === "string" &&
        c.text.trim().length > 0,
    );
    const hasToolCall = m.content.some(
      (c: any) =>
        c?.type === "toolCall" ||
        c?.type === "tool_use" ||
        c?.type === "tool_call",
    );
    if (hasText || hasToolCall) return false;

    const hasThinking = m.content.some((c: any) => {
      if (!c) return false;
      if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim().length > 0) return true;
      if (c.type === "thinking_block" && typeof c.text === "string" && c.text.trim().length > 0) return true;
      if (c.type === "reasoning" && typeof c.text === "string" && c.text.trim().length > 0) return true;
      return false;
    });
    return hasThinking;
  }
  return false;
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
  if (isThinkingOnlyTerminationByMessages(session)) return true;
  const a = tracker.current();
  return !a.sawText && !a.sawToolCall;
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
