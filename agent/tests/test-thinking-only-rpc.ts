/**
 * Integration test for the thinking-only RPC path (issue #22).
 *
 * Exercises `runPromptWithThinkingOnlyGuard` with a mock AgentSession-
 * shaped object that emits thinking-only on turn 1 and valid text on
 * turn 2. Verifies the wrapper issues the continue re-prompt exactly
 * once and that the second turn's output flows back to the caller via
 * the existing subscribe surface.
 */

import { describe, it, expect } from "vitest";
import {
  createTurnActivityTracker,
  runPromptWithThinkingOnlyGuard,
  THINKING_ONLY_CONTINUE_PROMPT,
} from "../src/thinking-only-guard.js";

/**
 * Minimal session mock with the same subscribe/prompt shape rpc.ts uses.
 * Each call to `prompt()` advances through a scripted list of "turn
 * behaviors" — functions that receive the emit() hook and the messages
 * array and may mutate both to simulate whatever the SDK would do.
 */
function createMockSession(behaviors: Array<(emit: (ev: any) => void, messages: any[]) => void>) {
  const listeners: Array<(ev: any) => void> = [];
  const messages: any[] = [];
  let turn = 0;
  const session = {
    messages,
    subscribe(listener: (ev: any) => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(_message: string): Promise<void> {
      const emit = (ev: any) => {
        for (const l of listeners) l(ev);
      };
      const behavior = behaviors[turn++];
      if (!behavior) {
        throw new Error(`mock session: no behavior for turn ${turn}`);
      }
      behavior(emit, messages);
    },
    promptCalls: [] as string[],
  };
  const origPrompt = session.prompt.bind(session);
  session.prompt = async (m: string) => {
    session.promptCalls.push(m);
    return origPrompt(m);
  };
  return session;
}

describe("RPC-mode thinking-only retry integration", () => {
  it("turn-1 thinking-only → re-prompts → turn-2 text is returned", async () => {
    const sentEvents: Array<{ name: string; params: any }> = [];
    const sendEvent = (name: string, params: any) =>
      sentEvents.push({ name, params });

    const chunks: string[] = [];

    const session = createMockSession([
      // Turn 1: model emits only a thinking block, no text, no tool call.
      (_emit, messages) => {
        messages.push({
          role: "assistant",
          content: [{ type: "thinking", thinking: "musing..." }],
        });
      },
      // Turn 2: model emits a proper text_delta event + finalized text.
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "hello world" },
        });
        // Subscribers drive `chunks` like rpc.ts does.
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "hello world" }],
        });
      },
    ]);

    // Mirror the rpc.ts subscribe wiring for text_delta → chunks.
    const unsub = session.subscribe((ev: any) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent?.type === "text_delta"
      ) {
        chunks.push(ev.assistantMessageEvent.delta);
      }
    });

    const tracker = createTurnActivityTracker(session);

    const result = await runPromptWithThinkingOnlyGuard(
      session,
      "do the thing",
      tracker,
      {
        onRetry: (attempt, max) =>
          sendEvent("thinking_only_reprompt", { attempt, max }),
      },
    );

    expect(result.retries).toBe(1);
    expect(result.stillThinkingOnly).toBe(false);
    expect(session.promptCalls).toEqual([
      "do the thing",
      THINKING_ONLY_CONTINUE_PROMPT,
    ]);
    expect(sentEvents).toEqual([
      { name: "thinking_only_reprompt", params: { attempt: 1, max: 5 } },
    ]);
    expect(chunks.join("")).toBe("hello world");

    tracker.unsubscribe();
    unsub();
  });

  it("tool-only turn does not trigger a retry", async () => {
    const session = createMockSession([
      (emit, messages) => {
        emit({ type: "tool_execution_start", toolName: "x", args: {} });
        messages.push({
          role: "assistant",
          content: [{ type: "toolCall", name: "x", args: {} }],
        });
      },
    ]);

    const tracker = createTurnActivityTracker(session);
    const result = await runPromptWithThinkingOnlyGuard(
      session,
      "call a tool",
      tracker,
    );
    expect(result.retries).toBe(0);
    expect(result.stillThinkingOnly).toBe(false);
    expect(session.promptCalls).toEqual(["call a tool"]);
    tracker.unsubscribe();
  });

  it("keeps re-prompting and gives up at maxRetries when stuck", async () => {
    // All 6 turns stay thinking-only — the loop should stop at
    // maxRetries=2 (1 initial + 2 retries = 3 total prompts) and signal
    // give-up via onGiveUp.
    const behaviors = Array.from({ length: 6 }, () => (
      (_emit: any, messages: any[]) => {
        messages.push({
          role: "assistant",
          content: [{ type: "thinking", thinking: "stuck..." }],
        });
      }
    ));
    const session = createMockSession(behaviors);
    const tracker = createTurnActivityTracker(session);

    let gaveUp = false;
    const result = await runPromptWithThinkingOnlyGuard(
      session,
      "go",
      tracker,
      { maxRetries: 2, onGiveUp: () => { gaveUp = true; } },
    );
    expect(result.retries).toBe(2);
    expect(result.stillThinkingOnly).toBe(true);
    expect(gaveUp).toBe(true);
    expect(session.promptCalls.length).toBe(3);
    tracker.unsubscribe();
  });
});
