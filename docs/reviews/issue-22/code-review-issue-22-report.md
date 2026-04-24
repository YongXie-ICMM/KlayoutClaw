# Code Review Response — Issue #22 (2026-04-23)

Branch: `fix/issue-22-thinking-only-termination`
Commits added on top of `b48b062`:

| Commit | Finding | Summary |
|--------|---------|---------|
| `0e822f8` | #1 (P1) | Reset `chunks` buffer between retries; RPC emits `thinking_only_reset` |
| `84f8a1c` | #2 (P1) | Investigation — theoretical-only; added gotcha comment |
| `1f70493` | #3 (P2) | Distinguish refusals (keep) from transport errors (retry) |

All three acceptance-criteria items are complete.

---

## Finding 1 — Buffered output not reset on retry

**Root cause (confirmed):** `chunks: string[]` + the `onTextDelta`
subscription in `cli.ts:352-355` and `rpc.ts:270-290` live OUTSIDE the
retry loop. A failing turn that streams partial text before hitting
`stopReason: "error"` leaves that partial text in `chunks`; after the
retry-prompt recovers, the caller sees `partial_failed_text + retry_text`.

**Fix shape chosen:** caller-owned buffer, guard signals reset via the
existing `onRetry` callback. The guard already calls `onRetry(attempt,
max)` immediately before `tracker.reset()` + `session.prompt(continuePrompt)`,
so the callback is the natural reset point and no signature change to
`runPromptWithThinkingOnlyGuard` was needed.

- `cli.ts` — `onRetry` calls `chunks.length = 0` plus the existing stderr log.
- `rpc.ts` — `onRetry` calls `chunks.length = 0`, then emits
  `thinking_only_reset` (new event), then `thinking_only_reprompt`
  (existing). Event contract documented in the `onRetry` hook.

**Tests added (tests/test-thinking-only-rpc.ts):**
- `"partial text from failed turn is discarded before retry (cli-mode contract)"` —
  turn 1 streams `"partial "` then ends `stopReason="error"`, turn 2
  streams `"retry text"`. Asserts final `chunks.join("")` is `"retry
  text"` (not `"partial retry text"`).
- `"RPC mode emits thinking_only_reset between partial-text-then-error turns"` —
  asserts event ordering `[content_delta, thinking_only_reset,
  thinking_only_reprompt, content_delta]` and that chunks contain only
  the retry output.

---

## Finding 2 — Activity-stream fallback aggressiveness

**Investigation:** `docs/code-review-issue-22-finding2-investigation.md`.
Read `pi-coding-agent/dist/core/agent-session.js:496-608` end-to-end.
Three no-output-without-assistant-event paths exist in `prompt()`:

1. `_tryExecuteExtensionCommand` (line 500-505) — guarded by
   `this._extensionRunner` being defined (line 613-614).
2. `_extensionRunner?.hasHandlers("input")` + `emitInput` returning
   `handled` (line 510-514) — optional chain, unreachable when the
   runner is undefined.
3. `isStreaming` re-entry (line 527-538) — **throws** without
   `streamingBehavior` option; not a silent return.

qlaybot does **not** pass `extensionRunnerRef` to `AgentSession`
(agent.ts:397, runner.ts:163). Cross-checked with `grep -rn` for
`extensionRunner|emitInput|hasHandlers|registerExtension|addExtension`
over `agent/src/` → zero matches. Slash commands in `-m` / RPC mode
are routed by `CommandRegistry` before `session.prompt()` (rpc.ts:248-263,
cli.ts:393+), so path 1 can't even be attempted via user input.

**Decision:** theoretical-only. No runtime change. Added a comment at
`thinking-only-guard.ts:166-185` explaining the three paths, why they
are unreachable in qlaybot's current shape, and the condition under
which a future contributor must revisit this (wiring up pi
extensions, concurrent prompts, etc.).

Existing test at `test-thinking-only.ts:494-499` already codifies the
intended contract ("no terminal assistant + no activity → retry").

---

## Finding 3 — `stopReason: "error"` blanket retry

**Investigation (pi-ai provider source, not via probe):**

- `providers/anthropic.js:689` — `"refusal" → "error"`
- `providers/anthropic.js:695` — `"sensitive" → "error"` (safety filter)
- `providers/openai-completions.js:646` — `"content_filter" → "error"`
- Transport catch blocks (`anthropic.js:318`, `openai-completions.js:257`):
  set `errorMessage` and leave `content: []`.

The SDK collapses refusals and transport errors into the same
`stopReason: "error"`. There is no preserved `errorType` /
`errorCategory` field on the assistant message. However the two cases
differ in shape:

- **Transport error:** `errorMessage` is set, `content: []` (no output
  accumulated before the exception). This is the ml09/ml11 shape
  (429 rate-limit).
- **Refusal / content_filter:** stream proceeded through the normal
  path, so any refusal text emitted by the model before the stop is
  preserved in `content`. `errorMessage` is NOT set.

**Fix shape chosen (matches reviewer's "content-based heuristic"):**
in `isThinkingOnlyTerminationByMessages`, only retry `stopReason="error"`
when `content` has no non-empty `text` block. Refusals carry text →
honour the stop. Transport errors have `content: []` → retry.

`stopReason="aborted"` kept as-is (upstream disconnect / signal abort).

**Tests added (tests/test-thinking-only.ts):**
- `"refusal with content text (stopReason=error + 'I can't help') → false"` —
  anthropic refusal with preserved text content. Asserts **no** retry.
- `"content-filter (stopReason=error + refusal + thinking) → false"` —
  openai content_filter with thinking + refusal text. Asserts **no** retry.

Existing ml09/ml11 `content: []` retry tests and new content-aware logic
are mutually consistent; both stay green.

---

## Verification

- `npx vitest run tests/test-thinking-only.ts tests/test-thinking-only-rpc.ts`
  → **38 passed** (was 34 + 4 new: 2 for finding #1, 2 for finding #3).
- `npm run build` → clean (`tsc` exits 0).
- `npm run test:unit` → 1051 passed, 2 failed, 7 skipped. Both
  failures are the pre-existing version-string failures on main
  (`test-plan-mode-v043-group6b.ts` and `test-unit.ts` — package.json
  version check expects 0.4.3), which the review doc explicitly marks
  out of scope.

## Acceptance criteria

- [x] Finding 1 fixed with new tests (chunks buffer reset + RPC reset event).
- [x] Finding 2 investigation complete; note at `docs/code-review-issue-22-finding2-investigation.md`; justified no-fix + comment added.
- [x] Finding 3 investigation complete; refusal vs. transport distinguished; tests added.
- [x] Targeted vitest suite → 38/38 green.
- [x] `npm run test:unit` → no new failures vs. main.
- [x] `npm run build` → clean.
- [x] One commit per finding on top of `b48b062`, each referencing the finding number.

Ready for re-review.
