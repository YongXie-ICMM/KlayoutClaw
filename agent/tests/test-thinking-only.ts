/**
 * Unit tests for the early-exit / thinking-only termination guard
 * (issue #22).
 *
 * Critical design note: `@mariozechner/pi-ai` normalises all provider
 * outputs to canonical {text, thinking, toolCall} blocks before they
 * land in `session.messages` (see pi-ai/dist/types.d.ts:114). So these
 * tests use the canonical shape for every provider path. What actually
 * differs across providers (anthropic / kimi-coding / openai-completions)
 * is the FAILURE MODE, not the block types:
 *
 *   - kimi-coding (anthropic-messages API): 429 overload → stopReason
 *     "error", content=[]. Auto-retry may exhaust, or a toolUse turn
 *     may be left with an un-executed tool call.
 *   - custom-anthropic (anthropic-messages API): same canonical shape;
 *     the historical issue-#22 hypothesis was a clean thinking-only
 *     stop with a finalized `thinking` block.
 *   - custom-openai (openai-completions API): same canonical shape via
 *     pi-ai's openai-completions provider. `reasoning`-typed content
 *     would only appear if pi-ai broke its normalization; we assert
 *     the guard still catches it as a defensive measure.
 *
 * The real ml09/ml11 shapes were captured from
 *   ~/.qlaybot/sessions/2026-04-23T06-53-* .jsonl
 *   ~/.qlaybot/sessions/2026-04-23T06-58-* .jsonl
 * and are reproduced verbatim (truncated) in the provider-specific
 * fixtures below.
 */

import { describe, it, expect } from "vitest";
import {
  createTurnActivityTracker,
  isThinkingOnlyTermination,
  isThinkingOnlyTerminationByMessages,
} from "../src/thinking-only-guard.js";

// ---------------------------------------------------------------------------
// Canonical SDK message-shape helpers (matches pi-ai types.d.ts:114)
// ---------------------------------------------------------------------------

interface CanonicalAssistant {
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; thinkingSignature?: string }
    | { type: "toolCall"; id: string; name: string; arguments: any }
  >;
  api: string;
  provider: string;
  model: string;
  usage: any;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

function makeAssistant(
  provider: "kimi-coding" | "custom-anthropic" | "custom-openai",
  opts: {
    stopReason: CanonicalAssistant["stopReason"];
    content: CanonicalAssistant["content"];
    errorMessage?: string;
  },
): CanonicalAssistant {
  return {
    role: "assistant",
    content: opts.content,
    api:
      provider === "custom-openai" ? "openai-completions" : "anthropic-messages",
    provider,
    model: provider === "kimi-coding" ? "k2p6" : provider === "custom-anthropic" ? "claude-opus-4-6" : "gpt-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: opts.stopReason,
    errorMessage: opts.errorMessage,
    timestamp: Date.now(),
  };
}

function makeUser(text: string): any {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function makeToolResult(toolCallId: string, text: string): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Healthy terminations — MUST return false (no re-prompt)
// ---------------------------------------------------------------------------

describe("healthy terminations (no retry)", () => {
  it("stopReason=stop with text content → false", () => {
    const msgs = [
      makeUser("hello"),
      makeAssistant("custom-anthropic", {
        stopReason: "stop",
        content: [{ type: "text", text: "Here is my answer." }],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("stopReason=stop with text + thinking → false", () => {
    const msgs = [
      makeUser("hello"),
      makeAssistant("custom-anthropic", {
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "let me think..." },
          { type: "text", text: "Here is my answer." },
        ],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("stopReason=toolUse FOLLOWED BY toolResult (mid-convo) → false", () => {
    const msgs = [
      makeUser("hello"),
      makeAssistant("kimi-coding", {
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "need to read" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
        ],
      }),
      makeToolResult("t1", "file content..."),
      makeAssistant("kimi-coding", {
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Early-exit patterns observed in the ml09/ml11 evidence
// ---------------------------------------------------------------------------

describe("kimi-coding (k2p6) — real ml09/ml11 failure modes", () => {
  it("rate-limit error (stopReason=error, content=[]) — auto-retry exhausted → true", () => {
    // Shape observed at
    //   ~/.qlaybot/sessions/2026-04-23T06-53-24-810Z_...jsonl entry 4
    // Historical: the original detector returned FALSE here because
    // content=[] satisfied neither hasThinking nor any other condition.
    const msgs = [
      makeUser("start work"),
      makeAssistant("kimi-coding", {
        stopReason: "error",
        content: [],
        errorMessage:
          '429 {"error":{"type":"rate_limit_error","message":"The engine is currently overloaded..."},"type":"error"}',
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });

  it("stalled toolUse — toolCall emitted but no trailing toolResult → true", () => {
    // Shape observed at
    //   ~/.qlaybot/sessions/2026-04-23T06-58-19-676Z_...jsonl LAST entry.
    // After the SDK's auto-retry shuffled state, `prompt()` resolved
    // leaving the tool call un-executed. The original detector returned
    // FALSE here because hasToolCall=true.
    const msgs = [
      makeUser("start work"),
      makeAssistant("kimi-coding", {
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            thinking:
              "This is a complex multi-step task. Let me save the checklist.",
          },
          {
            type: "toolCall",
            id: "t1",
            name: "write",
            arguments: { path: "/tmp/checklist.md", content: "..." },
          },
        ],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });

  it("refusal with content text (stopReason=error + 'I can't help') → false", () => {
    // R2 finding #1 (2026-04-24): the definitive refusal signal is
    // ABSENCE of `errorMessage`, not content-shape. pi-ai's
    // mapStopReason paths (anthropic "refusal"/"sensitive", openai
    // "content_filter") set stopReason="error" but never touch
    // errorMessage — only the provider catch block does.
    const msgs = [
      makeUser("do something policy-violating"),
      makeAssistant("custom-anthropic", {
        stopReason: "error",
        content: [{ type: "text", text: "I can't help with that." }],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("content-filter (stopReason=error + refusal + thinking) → false", () => {
    // openai-completions content_filter: thinking block may still be
    // present alongside the refusal text. No errorMessage → no retry.
    const msgs = [
      makeUser("banned request"),
      makeAssistant("custom-openai", {
        stopReason: "error",
        content: [
          { type: "thinking", thinking: "Considering policy..." },
          { type: "text", text: "I won't do that." },
        ],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("R2: mid-stream transport error (stopReason=error + errorMessage + partial text) → true", () => {
    // The regression R1's !hasAnyText gate introduced. A transport
    // error that strikes AFTER some text streamed leaves partial text
    // AND errorMessage on the final assistant message — pi-ai's
    // catch block (anthropic.js:318, openai-completions.js:257) sets
    // both. The previous gate classified this as a refusal and
    // silently returned the truncated answer.
    const msgs = [
      makeUser("write a long essay"),
      makeAssistant("custom-anthropic", {
        stopReason: "error",
        content: [
          { type: "text", text: "Once upon a time there was a long-running..." },
        ],
        errorMessage: "Connection reset by peer",
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });

  it("R2: error with no errorMessage and empty content → false (refusal-with-suppressed-text)", () => {
    // Rare: stopReason="error" with neither errorMessage nor any
    // preserved text. Treat as refusal-like — the SDK chose to end
    // the turn deliberately, so preserve the stop rather than loop.
    const msgs = [
      makeUser("go"),
      makeAssistant("custom-anthropic", {
        stopReason: "error",
        content: [],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("aborted mid-stream (stopReason=aborted) → true", () => {
    const msgs = [
      makeUser("go"),
      makeAssistant("kimi-coding", {
        stopReason: "aborted",
        content: [],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });
});

describe("custom-anthropic — issue-#22 original hypothesis", () => {
  it("clean thinking-only stop (stopReason=stop, content=[thinking]) → true", () => {
    // The plan-doc's canonical thinking-only shape. This is what the
    // ORIGINAL detector was designed to catch, and it still does.
    const msgs = [
      makeUser("solve this"),
      makeAssistant("custom-anthropic", {
        stopReason: "stop",
        content: [
          {
            type: "thinking",
            thinking:
              "Let me work through this step by step...",
            thinkingSignature: "SIG...",
          },
        ],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });

  it("thinking + empty text (only whitespace) → true", () => {
    const msgs = [
      makeUser("go"),
      makeAssistant("custom-anthropic", {
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "thinking body" },
          { type: "text", text: "   \n\t  " },
        ],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });
});

describe("custom-openai — openai-completions API", () => {
  it("clean thinking-only (canonical shape still used post-normalization) → true", () => {
    // pi-ai/providers/openai-completions.js normalizes reasoning output
    // into canonical {type:"thinking", thinking:"..."} blocks. Test the
    // canonical shape for this provider.
    const msgs = [
      makeUser("go"),
      makeAssistant("custom-openai", {
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "o1-style reasoning text..." }],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });

  it("defensive: legacy-shaped 'reasoning' block still detected → true", () => {
    // Should pi-ai ever surface a non-canonical `reasoning` type directly
    // (e.g., a new openai provider variant), the guard still catches it.
    const msgs = [
      makeUser("go"),
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "non-canonical reasoning body" }],
      } as any,
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge / defensive cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("empty messages array → false", () => {
    expect(isThinkingOnlyTerminationByMessages({ messages: [] })).toBe(false);
  });

  it("missing messages field → false", () => {
    expect(isThinkingOnlyTerminationByMessages({})).toBe(false);
  });

  it("no assistant turn anywhere → false (shape abstains, fallback decides)", () => {
    const msgs = [makeUser("hi")];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("trailing user message does not defeat walk-back to assistant", () => {
    // e.g. a pending-next-turn message injected after the assistant.
    const msgs = [
      makeUser("go"),
      makeAssistant("kimi-coding", {
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "body" }],
      }),
      makeUser("ping"),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(true);
  });

  it("empty-body thinking ('  ') with stopReason=stop → false", () => {
    const msgs = [
      makeAssistant("kimi-coding", {
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "   " }],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("tool-call-only turn followed by toolResult → false", () => {
    const msgs = [
      makeUser("go"),
      makeAssistant("kimi-coding", {
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "t1", name: "read", arguments: {} },
        ],
      }),
      makeToolResult("t1", "..."),
      makeAssistant("kimi-coding", {
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }],
      }),
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("malformed: content is a string → false (can't decide from shape)", () => {
    const msgs = [
      { role: "assistant", content: "some raw string" as any } as any,
    ];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
  });

  it("malformed: content is undefined → false (can't decide from shape)", () => {
    const msgs = [{ role: "assistant", content: undefined } as any];
    expect(isThinkingOnlyTerminationByMessages({ messages: msgs })).toBe(false);
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
  it("records sawText on a text_delta message_update", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    expect(tracker.current()).toEqual({ sawText: true, sawToolCall: false });
    tracker.unsubscribe();
  });

  it("records sawToolCall on tool_execution_start", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({ type: "tool_execution_start", toolName: "x", args: {} });
    expect(tracker.current()).toEqual({ sawText: false, sawToolCall: true });
    tracker.unsubscribe();
  });

  it("does NOT set sawToolCall on a toolcall_start content block (pre-execution)", () => {
    // Critical distinction: toolcall_start is a content_block event from
    // the model stream; tool_execution_start is a top-level agent-loop
    // event that fires only when the tool handler is actually invoked.
    // The stalled-toolUse case (issue #22) is exactly: toolcall_start
    // fires but tool_execution_start does not.
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
    });
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 },
    });
    expect(tracker.current().sawToolCall).toBe(false);
    tracker.unsubscribe();
  });

  it("ignores thinking_delta", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "..." },
    });
    expect(tracker.current()).toEqual({ sawText: false, sawToolCall: false });
    tracker.unsubscribe();
  });

  it("reset() clears between turns", () => {
    const s = mockSession();
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    tracker.reset();
    expect(tracker.current()).toEqual({ sawText: false, sawToolCall: false });
    tracker.unsubscribe();
  });

  it("tolerates session with no subscribe method", () => {
    const tracker = createTurnActivityTracker({} as any);
    expect(tracker.current()).toEqual({ sawText: false, sawToolCall: false });
    expect(() => tracker.unsubscribe()).not.toThrow();
  });
});

describe("isThinkingOnlyTermination (combined)", () => {
  it("shape catches the kimi stalled-toolUse regardless of tracker state", () => {
    const s = mockSession([
      makeUser("go"),
      makeAssistant("kimi-coding", {
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "..." },
          { type: "toolCall", id: "t1", name: "write", arguments: {} },
        ],
      }),
    ]);
    const tracker = createTurnActivityTracker(s);
    // Simulate the "toolcall emitted but not executed" event stream —
    // toolcall_start/end but no tool_execution_start.
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "..." },
    });
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
    });
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 1 },
    });
    expect(isThinkingOnlyTermination(s, tracker)).toBe(true);
    tracker.unsubscribe();
  });

  it("shape catches kimi rate-limit (stopReason=error, content=[])", () => {
    const s = mockSession([
      makeUser("go"),
      makeAssistant("kimi-coding", {
        stopReason: "error",
        content: [],
        errorMessage: "429 rate_limit_error",
      }),
    ]);
    const tracker = createTurnActivityTracker(s);
    expect(isThinkingOnlyTermination(s, tracker)).toBe(true);
    tracker.unsubscribe();
  });

  it("fallback catches 'no terminal assistant + no activity'", () => {
    const s = mockSession([makeUser("go")]);
    const tracker = createTurnActivityTracker(s);
    expect(isThinkingOnlyTermination(s, tracker)).toBe(true);
    tracker.unsubscribe();
  });

  it("healthy: text_delta fired → false", () => {
    const s = mockSession([
      makeUser("go"),
      makeAssistant("custom-anthropic", {
        stopReason: "stop",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    expect(isThinkingOnlyTermination(s, tracker)).toBe(false);
    tracker.unsubscribe();
  });

  it("healthy: tool was actually executed (tool_execution_start fired) → false", () => {
    const s = mockSession([
      makeUser("go"),
      makeAssistant("kimi-coding", {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
      }),
      makeToolResult("t1", "data"),
      makeAssistant("kimi-coding", {
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      }),
    ]);
    const tracker = createTurnActivityTracker(s);
    s.emit({ type: "tool_execution_start", toolName: "read", args: {} });
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "done" },
    });
    expect(isThinkingOnlyTermination(s, tracker)).toBe(false);
    tracker.unsubscribe();
  });

  // ---------------------------------------------------------------------------
  // R2 finding #2 (2026-04-24): the activity fallback must not fire when a
  // terminal assistant message is present. Only the "no terminal assistant at
  // all" case falls through to the activity signals.
  // ---------------------------------------------------------------------------

  it("R2: legitimate empty completion (stopReason=stop, content=[], no activity) → false", () => {
    // User asked for no output, or a tool-only turn that emitted no
    // follow-up text. Shape detector abstains (no text, no toolCall,
    // no thinking). Before the R2 gate, the fallback saw !sawText &&
    // !sawToolCall and fired a spurious `Continue...` retry.
    const s = mockSession([
      makeUser("respond with nothing"),
      makeAssistant("custom-anthropic", {
        stopReason: "stop",
        content: [],
      }),
    ]);
    const tracker = createTurnActivityTracker(s);
    expect(isThinkingOnlyTermination(s, tracker)).toBe(false);
    tracker.unsubscribe();
  });

  it("R2: legitimate empty completion with streaming (sawText=true, final content=[]) → false", () => {
    // Edge case: streaming happened but pi-ai normalized away the
    // (possibly whitespace-only) text blocks, leaving final content=[]
    // + stopReason="stop". Shape detector abstains. Fallback must not
    // fire because a terminal assistant message is present.
    const s = mockSession([
      makeUser("go"),
      makeAssistant("custom-anthropic", {
        stopReason: "stop",
        content: [],
      }),
    ]);
    const tracker = createTurnActivityTracker(s);
    s.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "something" },
    });
    // sawText=true, but shape abstains; with terminal assistant the
    // gate short-circuits before even consulting the tracker.
    expect(isThinkingOnlyTermination(s, tracker)).toBe(false);
    tracker.unsubscribe();
  });

  it("R2: no terminal assistant + no activity still retries (preserves theoretical gotcha)", () => {
    // The documented theoretical path: `AgentSession.prompt()`
    // resolves without appending any assistant message AND no
    // text/tool events fired. This is what the fallback exists to
    // catch — the narrowing must not break it.
    const s = mockSession([makeUser("go")]);
    const tracker = createTurnActivityTracker(s);
    expect(isThinkingOnlyTermination(s, tracker)).toBe(true);
    tracker.unsubscribe();
  });
});
