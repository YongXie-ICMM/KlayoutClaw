/**
 * Unit tests for the thinking-only termination guard (issue #22).
 *
 * These test the POST-fix behavior of `isThinkingOnlyTerminationByMessages`,
 * `createTurnActivityTracker`, and the combined `isThinkingOnlyTermination`.
 *
 * The original single-file detector in `cli.ts` only recognised the finalized
 * `{type:"thinking"}` block and assumed `msgs[msgs.length-1]` was always an
 * assistant turn with an array `content`. The failures documented in
 * `docs/early_exit_report_2026_04_23_k2p6.md` prove that is not always the
 * case. See the plan doc for the 4 hypotheses this suite covers.
 */

import { describe, it, expect } from "vitest";
import {
  createTurnActivityTracker,
  isThinkingOnlyTermination,
  isThinkingOnlyTerminationByMessages,
} from "../src/thinking-only-guard.js";

describe("isThinkingOnlyTerminationByMessages — healthy cases", () => {
  it("healthy turn with text content returns false", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think..." },
            { type: "text", text: "Here is the answer." },
          ],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });

  it("tool-call-only turn (toolCall) returns false", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "toolCall", name: "x", args: {} },
          ],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });

  it("tool-call-only turn (tool_use variant) returns false", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "tool_use", name: "x", input: {} },
          ],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });

  it("empty messages array returns false", () => {
    expect(isThinkingOnlyTerminationByMessages({ messages: [] })).toBe(false);
  });

  it("missing messages field returns false", () => {
    expect(isThinkingOnlyTerminationByMessages({})).toBe(false);
  });
});

describe("isThinkingOnlyTerminationByMessages — finalized thinking shapes", () => {
  it("finalized 'thinking' block is detected (original happy path)", () => {
    const session = {
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "reasoning body" }],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(true);
  });

  it("hypothesis 2a: 'thinking_block' variant is detected", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking_block", text: "reasoning body" }],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(true);
  });

  it("hypothesis 2b: 'reasoning' variant is detected", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "reasoning body" }],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(true);
  });

  it("empty thinking body returns false (no actual reasoning content)", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "" }],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });
});

describe("isThinkingOnlyTerminationByMessages — walk-back to last assistant", () => {
  it("skips a trailing user message to inspect the preceding assistant turn", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "..." }],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(true);
  });
});

describe("isThinkingOnlyTerminationByMessages — malformed / edge shapes", () => {
  it("hypothesis 4a: content undefined returns false (shape detector abstains)", () => {
    const session = {
      messages: [{ role: "assistant", content: undefined }],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });

  it("hypothesis 4b: content is a string returns false (shape detector abstains)", () => {
    const session = {
      messages: [{ role: "assistant", content: "just a string" as unknown as any[] }],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });

  it("hypothesis 3: no assistant message (only user) returns false", () => {
    const session = {
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });

  it("hypothesis 1: only a streaming thinking_delta returns false (not finalized)", () => {
    const session = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "thinking_delta", delta: "..." }],
        },
      ],
    };
    expect(isThinkingOnlyTerminationByMessages(session)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Activity-stream fallback
// ---------------------------------------------------------------------------

function mockSession(messages: any[] = []): {
  messages: any[];
  subscribe: (l: (ev: any) => void) => () => void;
  emit: (ev: any) => void;
} {
  const listeners: ((ev: any) => void)[] = [];
  return {
    messages,
    subscribe(l) {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit(ev) {
      for (const l of listeners) l(ev);
    },
  };
}

describe("createTurnActivityTracker", () => {
  it("records sawText when a text_delta message_update fires", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    expect(tracker.current().sawText).toBe(true);
    expect(tracker.current().sawToolCall).toBe(false);
    tracker.unsubscribe();
  });

  it("records sawToolCall when tool_execution_start fires", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({ type: "tool_execution_start", toolName: "x", args: {} });
    expect(tracker.current().sawToolCall).toBe(true);
    tracker.unsubscribe();
  });

  it("ignores thinking_delta and other unrelated events", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "..." },
    });
    s.emit({ type: "turn_start" });
    s.emit({ type: "turn_end" });
    expect(tracker.current()).toEqual({ sawText: false, sawToolCall: false });
    tracker.unsubscribe();
  });

  it("reset() clears activity for the next turn", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    expect(tracker.current().sawText).toBe(true);
    tracker.reset();
    expect(tracker.current()).toEqual({ sawText: false, sawToolCall: false });
    tracker.unsubscribe();
  });

  it("tolerates a session without a subscribe method", () => {
    const tracker = createTurnActivityTracker({} as any);
    expect(tracker.current()).toEqual({ sawText: false, sawToolCall: false });
    expect(() => tracker.unsubscribe()).not.toThrow();
  });
});

describe("isThinkingOnlyTermination — combined detector", () => {
  it("hypothesis 1 fallback: streaming-only thinking_delta with no activity → true", () => {
    // The message shape has only a thinking_delta (not a finalized block),
    // so the shape detector returns false. No text/tool events fired, so
    // the activity fallback catches it.
    const s = mockSession([
      {
        role: "assistant",
        content: [{ type: "thinking_delta", delta: "..." }],
      },
    ]);
    const tracker = createTurnActivityTracker(s);
    expect(isThinkingOnlyTerminationByMessages(s)).toBe(false);
    expect(isThinkingOnlyTermination(s, tracker)).toBe(true);
    tracker.unsubscribe();
  });

  it("hypothesis 3 fallback: no terminal assistant message + no activity → true", () => {
    const s = mockSession([
      { role: "user", content: [{ type: "text", text: "go" }] },
    ]);
    const tracker = createTurnActivityTracker(s);
    expect(isThinkingOnlyTermination(s, tracker)).toBe(true);
    tracker.unsubscribe();
  });

  it("shape detector still wins for finalized thinking blocks", () => {
    const s = mockSession([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "body" }],
      },
    ]);
    const tracker = createTurnActivityTracker(s);
    expect(isThinkingOnlyTermination(s, tracker)).toBe(true);
    tracker.unsubscribe();
  });

  it("healthy turn: text_delta fired → false", () => {
    const s = mockSession([
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    expect(isThinkingOnlyTermination(s, tracker)).toBe(false);
    tracker.unsubscribe();
  });

  it("tool-only turn: tool_execution_start fired → false", () => {
    const s = mockSession([
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "x", args: {} }],
      },
    ]);
    const tracker = createTurnActivityTracker(s);
    s.emit({ type: "tool_execution_start", toolName: "x", args: {} });
    expect(isThinkingOnlyTermination(s, tracker)).toBe(false);
    tracker.unsubscribe();
  });
});
