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

  it("kimi-coding ml09 pattern: stalled toolUse (no toolResult) triggers re-prompt", async () => {
    // Mirrors the real ml09 failure: the final assistant turn has
    // stopReason=toolUse + a toolCall, but the tool was never executed
    // (no toolResult appended). The original detector returned false
    // because hasToolCall=true. The new stopReason-aware detector
    // catches it.
    const sentEvents: Array<{ name: string; params: any }> = [];
    const sendEvent = (name: string, params: any) =>
      sentEvents.push({ name, params });

    const session = createMockSession([
      // Turn 1: the real ml09 shape — stopReason=toolUse, has toolCall,
      // but the mock never appends a toolResult afterwards.
      (emit, messages) => {
        // tool content-block events fire (toolcall_start/end), but
        // tool_execution_start does NOT — the loop short-circuited.
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
        });
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_end", contentIndex: 1 },
        });
        messages.push({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me save the checklist." },
            {
              type: "toolCall",
              id: "t1",
              name: "write",
              arguments: { path: "/tmp/checklist.md" },
            },
          ],
          stopReason: "toolUse",
        });
      },
      // Turn 2: after the continue-prompt, the model produces text.
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "recovered" },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stopReason: "stop",
        });
      },
    ]);

    const tracker = createTurnActivityTracker(session);
    const result = await runPromptWithThinkingOnlyGuard(
      session,
      "design the device",
      tracker,
      {
        onRetry: (attempt, max) =>
          sendEvent("thinking_only_reprompt", { attempt, max }),
      },
    );

    expect(result.retries).toBe(1);
    expect(result.stillThinkingOnly).toBe(false);
    expect(sentEvents).toEqual([
      { name: "thinking_only_reprompt", params: { attempt: 1, max: 5 } },
    ]);
    tracker.unsubscribe();
  });

  it("kimi-coding rate-limit pattern: stopReason=error + content=[] triggers re-prompt", async () => {
    const session = createMockSession([
      // Turn 1: the 429 rate-limit shape.
      (_emit, messages) => {
        messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 rate_limit_error",
        });
      },
      // Turn 2: recovery.
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "ok" },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
        });
      },
    ]);
    const tracker = createTurnActivityTracker(session);
    const result = await runPromptWithThinkingOnlyGuard(
      session,
      "go",
      tracker,
    );
    expect(result.retries).toBe(1);
    expect(result.stillThinkingOnly).toBe(false);
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

  // ---------------------------------------------------------------------------
  // Finding #1 (2026-04-23): partial-text-then-error must not contaminate retry
  // ---------------------------------------------------------------------------

  it("partial text from failed turn is discarded before retry (cli-mode contract)", async () => {
    // Mirrors cli.ts runJSON: caller owns `chunks`, resets it in onRetry.
    const chunks: string[] = [];

    const session = createMockSession([
      // Turn 1: model streams "partial " then terminates with stopReason=error
      // (the ml09-style shape: rate-limit after some tokens have made it
      // through the stream).
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "partial " },
        });
        messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 rate_limit_error",
        });
      },
      // Turn 2: clean recovery.
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "retry text" },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "retry text" }],
          stopReason: "stop",
        });
      },
    ]);

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
      "go",
      tracker,
      {
        onRetry: () => {
          chunks.length = 0;
        },
      },
    );
    expect(result.retries).toBe(1);
    // If the guard did not reset chunks, this would be "partial retry text".
    expect(chunks.join("")).toBe("retry text");
    tracker.unsubscribe();
    unsub();
  });

  it("RPC mode emits thinking_only_reset between partial-text-then-error turns", async () => {
    // Mirrors rpc.ts: chunks reset + client-visible `thinking_only_reset`
    // event emitted before `thinking_only_reprompt`.
    const sentEvents: Array<{ name: string; params: any }> = [];
    const sendEvent = (name: string, params: any) =>
      sentEvents.push({ name, params });

    const chunks: string[] = [];
    const session = createMockSession([
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "half-written " },
        });
        messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "500 upstream_disconnected",
        });
      },
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "final" },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "final" }],
          stopReason: "stop",
        });
      },
    ]);

    const unsub = session.subscribe((ev: any) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent?.type === "text_delta"
      ) {
        const text = ev.assistantMessageEvent.delta;
        chunks.push(text);
        sendEvent("content_delta", { delta: { type: "text_delta", text } });
      }
    });

    const tracker = createTurnActivityTracker(session);
    await runPromptWithThinkingOnlyGuard(session, "go", tracker, {
      onRetry: (attempt, max) => {
        chunks.length = 0;
        sendEvent("thinking_only_reset", { attempt, max });
        sendEvent("thinking_only_reprompt", { attempt, max });
      },
    });

    // Final chunks contain only the retry output.
    expect(chunks.join("")).toBe("final");

    // Event ordering: partial content_delta, then reset+reprompt, then
    // the retry's content_delta.
    const names = sentEvents.map((e) => e.name);
    expect(names).toEqual([
      "content_delta",
      "thinking_only_reset",
      "thinking_only_reprompt",
      "content_delta",
    ]);
    expect(sentEvents[1].params).toEqual({ attempt: 1, max: 5 });
    expect(sentEvents[2].params).toEqual({ attempt: 1, max: 5 });

    tracker.unsubscribe();
    unsub();
  });

  // ---------------------------------------------------------------------------
  // R3 finding #2 (2026-04-24): exhausted retries must surface as error,
  // not as a false-success response containing the last attempt's partial
  // text. These tests mirror cli.ts:runJSON and rpc.ts prompt-handler
  // branching on `{ retries, stillThinkingOnly }`.
  // ---------------------------------------------------------------------------

  it("R3 RPC: exhausted retries emit error event + sendError, NOT sendResult(completed)", async () => {
    // Every turn ends with a retryable transport error + partial text.
    // The guard loops until maxRetries and returns stillThinkingOnly=true.
    // Build 1 initial + 5 retries = 6 behaviors.
    const behaviors = Array.from({ length: 6 }, () => (
      (emit: any, messages: any[]) => {
        emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "half-written chunk ",
          },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "half-written chunk " }],
          stopReason: "error",
          errorMessage: "502 Bad Gateway",
        });
      }
    ));
    const session = createMockSession(behaviors);

    const sentEvents: Array<{ name: string; params: any }> = [];
    const sendEvent = (name: string, params: any) =>
      sentEvents.push({ name, params });

    let sendResultCalled: any = null;
    let sendErrorCalled: any = null;
    const sendResult = (id: number, body: any) => {
      sendResultCalled = { id, body };
    };
    const sendError = (id: number, code: number, msg: string) => {
      sendErrorCalled = { id, code, msg };
    };

    const chunks: string[] = [];
    const unsub = session.subscribe((ev: any) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent?.type === "text_delta"
      ) {
        chunks.push(ev.assistantMessageEvent.delta);
      }
    });
    const tracker = createTurnActivityTracker(session);

    // Mirror rpc.ts prompt handler exhaustion branching.
    const { retries, stillThinkingOnly } =
      await runPromptWithThinkingOnlyGuard(session, "go", tracker, {
        onRetry: (attempt, max) => {
          chunks.length = 0;
          sendEvent("thinking_only_reset", { attempt, max });
          sendEvent("thinking_only_reprompt", { attempt, max });
        },
      });

    if (stillThinkingOnly) {
      chunks.length = 0;
      const errMsg = `Retries exhausted after ${retries} attempts — upstream unresponsive or error is non-retryable.`;
      sendEvent("error", { message: errMsg });
      sendError(1, -32000, errMsg);
    } else {
      sendResult(1, { status: "completed", response: chunks.join(""), retries });
    }

    expect(stillThinkingOnly).toBe(true);
    expect(retries).toBe(5);
    expect(sendResultCalled).toBeNull();
    expect(sendErrorCalled).not.toBeNull();
    expect(sendErrorCalled.code).toBe(-32000);
    expect(sendErrorCalled.msg).toMatch(/Retries exhausted after 5 attempts/);

    // The final `error` event is emitted; `chunks` is cleared so no
    // partial text leaks into later state.
    expect(sentEvents.some((e) => e.name === "error")).toBe(true);
    expect(chunks.length).toBe(0);

    tracker.unsubscribe();
    unsub();
  });

  it("R3 RPC: successful recovery includes `retries` in completed response", async () => {
    // Turns 1-3 fail with retryable transport error; turn 4 clean text.
    const session = createMockSession([
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "a " },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "a " }],
          stopReason: "error",
          errorMessage: "overloaded",
        });
      },
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "b " },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "b " }],
          stopReason: "error",
          errorMessage: "rate limit exceeded",
        });
      },
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "c " },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "c " }],
          stopReason: "error",
          errorMessage: "503 service unavailable",
        });
      },
      (emit, messages) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "final answer" },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
          stopReason: "stop",
        });
      },
    ]);

    const chunks: string[] = [];
    const unsub = session.subscribe((ev: any) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent?.type === "text_delta"
      ) {
        chunks.push(ev.assistantMessageEvent.delta);
      }
    });
    const tracker = createTurnActivityTracker(session);

    let sendResultCalled: any = null;
    const sendResult = (id: number, body: any) => {
      sendResultCalled = { id, body };
    };

    const { retries, stillThinkingOnly } =
      await runPromptWithThinkingOnlyGuard(session, "go", tracker, {
        onRetry: () => {
          chunks.length = 0;
        },
      });

    if (!stillThinkingOnly) {
      sendResult(1, {
        status: "completed",
        response: chunks.join(""),
        retries,
      });
    }

    expect(stillThinkingOnly).toBe(false);
    expect(retries).toBe(3);
    expect(sendResultCalled?.body).toEqual({
      status: "completed",
      response: "final answer",
      retries: 3,
    });

    tracker.unsubscribe();
    unsub();
  });

  it("R3 CLI: exhausted retries produce status='error' + exit path, not status='completed'", async () => {
    // Mirrors cli.ts:runJSON exhaustion branch. 6 consecutive retryable
    // errors drain the retry budget; caller must NOT return partial text
    // as completed.
    const behaviors = Array.from({ length: 6 }, () => (
      (emit: any, messages: any[]) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "partial " },
        });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "partial " }],
          stopReason: "error",
          errorMessage: "fetch failed",
        });
      }
    ));
    const session = createMockSession(behaviors);
    const chunks: string[] = [];
    const unsub = session.subscribe((ev: any) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent?.type === "text_delta"
      ) {
        chunks.push(ev.assistantMessageEvent.delta);
      }
    });
    const tracker = createTurnActivityTracker(session);

    const { retries, stillThinkingOnly } =
      await runPromptWithThinkingOnlyGuard(session, "go", tracker, {
        onRetry: () => {
          chunks.length = 0;
        },
      });

    // Mirror cli.ts runJSON exhaustion branch: would process.exit(1)
    // after emitting JSON status=error. Assert the contract pieces.
    expect(stillThinkingOnly).toBe(true);
    expect(retries).toBe(5);

    let output: any;
    if (stillThinkingOnly) {
      chunks.length = 0;
      output = {
        status: "error",
        error: `Session stopped producing output after ${retries} retry attempts — upstream may be failing, rate-limited, or the error is non-retryable.`,
        retries,
      };
    } else {
      output = { status: "completed", response: chunks.join(""), retries };
    }

    expect(output.status).toBe("error");
    expect(output.response).toBeUndefined();
    expect(output.retries).toBe(5);
    expect(chunks.length).toBe(0);

    tracker.unsubscribe();
    unsub();
  });
});
