# Issue #22 — Thinking-Only Termination Not Detected (TDD-Debug Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` and `superpowers:systematic-debugging`. Write the failing repro test first, then fix.

**Goal:** Make qlaybot's `-m` (JSON message) mode reliably detect and recover from "thinking-only" terminations — runs where the model emits only reasoning, stops with no text / no tool call, and qlaybot exits 0 with no produced artifact.

**Ground truth bug report:** `docs/early_exit_report_2026_04_23_k2p6.md`. Benchmark command: `python run_local.py --agent qlaybot --model kimi-coding/k2p6 --archive-suffix qb-k2p6-apr23-run1`. Both ml09 (4 transcript events) and ml11 (64 events) ended on an `agent_thinking` event with no follow-up tool call, `run_local.py` marked both `completed` (subprocess exited 0), and no `result.gds` was produced.

**Invocation path confirmed:** `run_local.py:293` launches `qlaybot --verbose -m <message>` → `cli.ts:344 runJSON()`. The retry loop at `cli.ts:382–398` IS wired into this path. The bug is that `isThinkingOnlyTermination()` at `cli.ts:327–340` returns `false` when the real termination happens. The detector exists but misfires.

---

## Prerequisites

- Branch off `main` at the current HEAD.
- Have access to one of the failing transcripts:
  - `/Volumes/RandomData/harbour-workspace/qlaybot/ml09/qlaybot-transcripts/session_1776927228802-20260423-065348.jsonl`
  - `/Volumes/RandomData/harbour-workspace/qlaybot/ml11/qlaybot-transcripts/session_1776927505125-20260423-065825.jsonl`
- `cd /Users/andrewwayne/testFolder/KlayoutClaw/agent && npm install` completed; `npm run build` passes on baseline.

---

## Phase 1 — Reproduce and diagnose

The detector's claim is: "last assistant message has thinking content AND no text AND no tool call → thinking-only termination." The failures prove either (a) the last message's shape doesn't match the detector's expected structure, or (b) the SDK never pushed the terminal message into `session.messages` at all.

Before touching the fix, you MUST see the actual `session.messages` shape at the moment of the misfire. Do not guess.

- [ ] **Add a one-shot diagnostic dump**

Edit `cli.ts:378` (just after `await botSession.session.prompt(args.message)`, BEFORE the retry loop). Add:

```ts
if (process.env.QLAYBOT_DEBUG_THINKING_ONLY === "1") {
  const msgs = botSession.session.messages ?? [];
  const tail = msgs.slice(-3).map((m: any) => ({
    role: m.role,
    contentTypes: Array.isArray(m.content)
      ? m.content.map((c: any) => c.type)
      : typeof m.content,
  }));
  console.error("[DEBUG thinking-only] tail:", JSON.stringify(tail));
  console.error("[DEBUG thinking-only] last-full:",
    JSON.stringify(msgs[msgs.length - 1], null, 2).slice(0, 2000));
  console.error("[DEBUG thinking-only] detector said:",
    isThinkingOnlyTermination(botSession.session));
}
```

- [ ] **Reproduce against a known-failing dataset.** The ml09 signature (exits after a single thinking event) is the easier repro target. Run:

```bash
cd /Users/andrewwayne/testFolder/KlayoutClaw/agent
npm run build
QLAYBOT_DEBUG_THINKING_ONLY=1 qlaybot --verbose -m "Read the following instructions in <path-to-ml09-instruction.md>. Finish the task." 2>stderr.log
```

You need a fresh working copy of the ml09 instruction; grab it from `/Volumes/RandomData/harbour-workspace/qlaybot/archive_23_04_26_qb-k2p6-apr23-run1/ml09/output/instruction.md` if it's still in the archive. If that archive was evicted, skip to Phase 1 alternative below.

**Record in the plan doc** (edit this file):
- The exact `contentTypes` of the last assistant message
- Whether `last.role === "assistant"` held
- Whether any `thinking`-typed content block existed
- What `isThinkingOnlyTermination()` returned

- [ ] **Phase 1 alternative: synthesize the repro via a unit test.** If live repro against k2p6 isn't practical, write a unit test that constructs a fake `session.messages` array matching each hypothesis, and shows the detector returning `false` where it should return `true`. Hypotheses to cover:
  1. Last message has `content` array with a single `{ type: "thinking_delta", ... }` — no finalized `"thinking"` block
  2. Last message has `content` array with `{ type: "reasoning" }` or `{ type: "thinking_block" }` instead of `"thinking"`
  3. Last message is absent (`session.messages[-1].role === "user"`) because the SDK never appended the terminal assistant turn
  4. Last message has `content: undefined` or is a string (no array), causing the `.some()` call to throw or return false silently

Put the unit tests in `agent/tests/unit/test-thinking-only.ts` (new file). Each test documents one hypothesis, constructs the fake session, calls `isThinkingOnlyTermination`, and asserts the expected bug-preserving behavior (`false` where it should be `true`).

**Expected outcome of Phase 1:** a test file that runs green on the current buggy detector (proves the bug) AND a write-up (in this doc) of which hypothesis matches the real ml09/ml11 shape. You MUST NOT move to Phase 2 until you can name the exact shape mismatch.

---

## Phase 2 — Fix the detector + add an activity-stream fallback

The detector must handle all hypotheses from Phase 1 that proved true. In addition, add a **belt-and-suspenders** fallback using the subscription stream: track per-turn whether any `text_delta` or `tool_execution_start` event fired; if neither did, the turn was thinking-only regardless of `session.messages` shape.

- [ ] **Write failing tests first** in `agent/tests/unit/test-thinking-only.ts` for the POST-fix behavior:
  1. Each hypothesis from Phase 1 now returns `true` from the detector
  2. A healthy turn (text content present) returns `false`
  3. A tool-call-only turn returns `false`
  4. An empty/missing last-assistant-message case uses the fallback: a `TurnActivityTracker` that records `sawText | sawToolCall | sawOnlyThinking` from the event stream
  5. The fallback catches a case where the detector-by-message-inspection alone still returns `false`

Run `npm test -- --run test-thinking-only` — all 5 tests should fail.

- [ ] **Implement the fix**

```ts
// cli.ts — replace isThinkingOnlyTermination, add a turn tracker
function isThinkingOnlyTerminationByMessages(session: { messages: any[] }): boolean {
  const msgs = session.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) return false;
    const hasText = m.content.some(
      (c: any) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0,
    );
    const hasToolCall = m.content.some(
      (c: any) =>
        c.type === "toolCall" ||
        c.type === "tool_use" ||
        c.type === "tool_call",
    );
    if (hasText || hasToolCall) return false;
    const hasThinking = m.content.some((c: any) => {
      if (c.type === "thinking" && c.thinking?.trim().length > 0) return true;
      if (c.type === "thinking_block" && c.text?.trim().length > 0) return true;
      if (c.type === "reasoning" && c.text?.trim().length > 0) return true;
      return false;
    });
    return hasThinking;
  }
  return false;
}

interface TurnActivity { sawText: boolean; sawToolCall: boolean }
function createTurnActivityTracker(session: any): { current(): TurnActivity; reset(): void; unsubscribe(): void } {
  let activity: TurnActivity = { sawText: false, sawToolCall: false };
  const unsub = session.subscribe?.((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      activity.sawText = true;
    } else if (event.type === "tool_execution_start") {
      activity.sawToolCall = true;
    }
  }) ?? (() => {});
  return {
    current: () => activity,
    reset: () => { activity = { sawText: false, sawToolCall: false }; },
    unsubscribe: unsub,
  };
}

function isThinkingOnlyTermination(session: any, tracker: ReturnType<typeof createTurnActivityTracker>): boolean {
  if (isThinkingOnlyTerminationByMessages(session)) return true;
  const a = tracker.current();
  return !a.sawText && !a.sawToolCall;
}
```

Wire into `runJSON()`:

```ts
const tracker = createTurnActivityTracker(botSession.session);
// ...
botSession.history.recordPrompt(args.message);
tracker.reset();
await botSession.session.prompt(args.message);

let retries = 0;
while (isThinkingOnlyTermination(botSession.session, tracker) && retries < THINKING_ONLY_MAX_RETRIES) {
  retries++;
  console.error(`[qlaybot] thinking-only termination detected (attempt ${retries}/${THINKING_ONLY_MAX_RETRIES}), re-prompting...`);
  tracker.reset();
  await botSession.session.prompt("Continue. You stopped mid-task after a thinking block — keep working.");
}
// ... rest unchanged; unsubscribe tracker in finally {}
```

- [ ] **Run tests until green**: `npm test -- --run test-thinking-only` — all 5 must pass.

- [ ] **Run full unit suite**: `npm run test:unit` — no regressions.

---

## Phase 3 — Wire the same guard into RPC mode (defense in depth)

Even though `-m` is the current benchmark mode, the same bug pattern will hit RPC users (`run_local.py`'s fallback, IDE clients). Extract the guard to a shared helper and call it from `rpc.ts:289`.

- [ ] **Extract** `createTurnActivityTracker` + `isThinkingOnlyTermination` from `cli.ts` into a new `agent/src/thinking-only-guard.ts`. Update `cli.ts` to import from there.

- [ ] **Wire into RPC `prompt` handler** (`rpc.ts:289`):

```ts
const tracker = createTurnActivityTracker(botSession.session);
tracker.reset();
await botSession.session.prompt(message);

let retries = 0;
while (isThinkingOnlyTermination(botSession.session, tracker) && retries < THINKING_ONLY_MAX_RETRIES) {
  retries++;
  sendEvent("thinking_only_reprompt", { attempt: retries, max: THINKING_ONLY_MAX_RETRIES });
  tracker.reset();
  await botSession.session.prompt("Continue. You stopped mid-task after a thinking block — keep working.");
}
```

Unsubscribe tracker in the `finally` block.

- [ ] **Add an integration test** `agent/tests/integration/test-thinking-only-rpc.ts`: spin up RPC mode with a mock AgentSession that emits only thinking on turn 1 and valid text on turn 2. Verify the wrapper issues the continue re-prompt and the second turn's output is returned.

- [ ] **Do NOT wire into TUI.** In TUI the user is present and can type "continue" themselves. Skipping avoids complicating the TUI event loop.

---

## Phase 4 — E2E verification

- [ ] **Reproduce against a known-failing dataset.** Pick ml09 (the 4-event signature). Launch:

```bash
qlaybot --verbose -m "Read the following instructions in <ml09 instruction.md>. Finish the task."
```

Expected behaviors:
- `stderr.log` contains at least one `thinking-only termination detected (attempt N/5)` line
- The final agent output is no longer empty; at minimum the agent proceeds past the initial thinking block
- The run exits 0 (success path) only when the model ACTUALLY produced output — not when it silently stopped

- [ ] **Measure retries, not just correctness.** Record in this doc: how many retries were needed on ml09 and ml11? If the model exhausts 5 retries without progress, that's a different signal (k2p6 genuinely stuck) and the enhancement for that lives in a follow-up.

- [ ] **Commit** with message `fix(agent/cli): robust thinking-only termination detection (issue #22)`. Include `Co-Authored-By` trailer per repo convention.

---

## Success criteria

1. `test-thinking-only.ts` unit tests: 5/5 passing
2. `test-thinking-only-rpc.ts` integration test: passing
3. `npm run test:unit` and `npm run test:integration`: no regressions
4. Live ml09 re-run: stderr shows at least one retry attempt, run does not silently exit 0 after a bare thinking event

## Out of scope

- Redesigning the retry prompt text (separate concern; current text is acceptable)
- Fixing k2p6's underlying propensity for thinking-only stops (model-side)
- Adding a post-run `result.gds` guardrail in `run_local.py` (mitigation #1 from the report — separate PR)

## References

- `docs/early_exit_report_2026_04_23_k2p6.md` — the bug report
- `agent/src/cli.ts:327–398` — current detector + retry loop
- `agent/src/rpc.ts:289` — unguarded prompt handler
- `/Users/andrewwayne/KLayout_Harbour/run_local.py:293` — qlaybot invocation
