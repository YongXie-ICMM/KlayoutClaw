/**
 * Early-exit termination detector + activity-stream fallback.
 *
 * Despite the "thinking-only" naming (kept for issue-#22 continuity), this
 * guard catches several modes of `session.prompt()` returning before the
 * agent actually finished:
 *
 *   1. Pure thinking-only turn (stop after a reasoning block, no text /
 *      no tool call) — the original plan-doc hypothesis.
 *   2. Terminal `stopReason: "error"` or `"aborted"` — e.g. k2p6 429
 *      rate-limit where pi-coding-agent's auto-retry exhausted. Content
 *      is typically `[]`, making the message-shape detector useless.
 *   3. Terminal `stopReason: "toolUse"` with a pending tool call that
 *      was never executed (no trailing `toolResult`) — observed in
 *      ml09/ml11 after the SDK's retry path short-circuited.
 *
 * The message-shape detector covers (1) and (3) and as much of (2) as is
 * possible to see (content: []). The activity-stream fallback is a
 * belt-and-suspenders guard for malformed shapes and "no terminal
 * assistant message at all" cases. See
 * `docs/early_exit_report_2026_04_23_k2p6.md` and issue #22.
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
 * to the most recent assistant turn and classifies it as an early-exit
 * termination. Returns true when any of these holds:
 *
 *   - stopReason is "error" or "aborted" (rate-limits, upstream disconnect)
 *   - stopReason is "toolUse" but no `toolResult` follows (pi-coding-agent
 *     retry path left the tool call dangling)
 *   - Content is reasoning-only with no text and no tool call
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
  let sawToolResultAfterAssistant = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
    if (m.role === "toolResult") {
      sawToolResultAfterAssistant = true;
    }
  }
  if (lastAssistantIdx === -1) return false;

  const last = msgs[lastAssistantIdx];

  // Rate limits, upstream disconnects, aborts — always want a retry.
  // pi-coding-agent's _autoRetry only handles some of these internally;
  // when it exhausts, the error turn is what `prompt()` resolves on.
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    return true;
  }

  // Stalled tool-use: the model emitted a tool call but the loop never
  // ran executeToolCalls on it (no trailing toolResult), so `prompt()`
  // resolved mid-turn.
  if (last.stopReason === "toolUse" && !sawToolResultAfterAssistant) {
    return true;
  }

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
  // Fallback: no text, no tool execution → treat as early-exit.
  //
  // GOTCHA for future callers: `AgentSession.prompt()` has three
  // early-return-without-assistant-event paths (agent-session.js:500-538):
  //   1. extension command handled (`/foo` routed to _tryExecuteExtensionCommand)
  //   2. input handler returned action="handled" (_extensionRunner.emitInput)
  //   3. already-streaming followUp/steer queue
  // qlaybot does NOT pass `extensionRunnerRef` to AgentSession (see
  // agent.ts:397) and slash commands are routed BEFORE `prompt()` by
  // the CommandRegistry, so paths 1 and 2 are unreachable. Path 3
  // throws without `streamingBehavior` — also unreachable silently.
  // If qlaybot ever wires up pi extensions or concurrent prompts,
  // narrow this fallback to require a terminal assistant message with
  // `stopReason` present (proof the agent loop actually ran).
  // See docs/code-review-issue-22-finding2-investigation.md.
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
