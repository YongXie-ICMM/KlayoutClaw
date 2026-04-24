# Issue #22 — Code Review Archive (reconstructed from memory 2026-04-24)

Merged: `25989de` on 2026-04-24 into `main`.

The R1–R8 per-round review docs lived only in the worktree and were lost when I ran `git worktree remove --force` post-merge. Two implementer-authored docs survived in git and are preserved alongside:
- `code-review-issue-22-finding2-investigation.md` — the implementer's deep-dive on the R2 #2 "activity fallback reachability" question. Concluded theoretical-only at the time; later disproven by gpt-5.5 xhigh in R7.
- `code-review-issue-22-report.md` — the implementer's response report after the R1 review pass.

This archive reconstructs the rest from conversation memory — cite commits (`git log --all --format='%h %s' -- 'agent/src/thinking-only-guard.ts'`) for exact implementation details.

**Scope:** 8 rounds of `codex review`, alternating gpt-5 xhigh and gpt-5.5 xhigh. Longest review chain of the three issues by a significant margin — the guard logic had subtle interactions between retry gate, terminal-error detection, activity fallback, message-shape bounds, and compaction.

---

## Summary table

| Round | Model | Findings | Resolution |
|---|---|---|---|
| R1 | gpt-5 xhigh | 3 (P1 chunks-buffer, P1 fallback, P2 refusals) | Fixes in `0e822f8`, `84f8a1c` (investigation only), `1f70493` |
| R2 | gpt-5 xhigh | 2 (P1 errorMessage gate, P2 empty completion) | Fixes in `a536d4a`, `2d1c529` |
| R3 | gpt-5 xhigh | 2 (P1 non-retryable, P1 exhaustion) | Fixes in `bba1126`, `22c64a5` |
| R4 | gpt-5 xhigh | 2 (P1 toolUse stall, P2 reset event) | Fixes in `7d35f74`, `b9ba519` |
| R5 | gpt-5 xhigh | 1 (P2 process.exit flush) | Fix in `d4eda27` |
| R6 | gpt-5 xhigh | 2 (P1 partial text, P2 tool-call orphan) | **REFUTED** by gpt-5.5 xhigh verification (R7) |
| R7 | gpt-5.5 xhigh | 1 (P2 extension-handled prompts) | Fix in `e19b5bc` (disabled activity fallback entirely) |
| R8 | gpt-5.5 xhigh | 3 (P1 non-retryable surface, P2 scan-boundary, P3 test early-return) | Fixes in `680cde0`, `2b5339e`, `8f19f4a` |
| Post-R8 | gpt-5.5 xhigh | 4 follow-ups landed directly | `e0dfb4a`, `9cd0a30`, `c8dbb7a`, `3343cfa` |
| Final | gpt-5.5 xhigh | CLEAN | Merged |

Total real findings addressed: **18** (14 from implementer rounds + 4 follow-up fixes).

---

## R1 findings (gpt-5 xhigh) — regressions introduced by b48b062

1. **[P1] Chunks buffer not reset on retry** — the streaming buffer accumulated partial text from the failing attempt before the retry fired, causing `chunks.join("")` to return `partial_failed_text + retry_text`. Fixed in `0e822f8` by clearing `chunks.length = 0` in `onRetry`. RPC additionally emits `thinking_only_reset` so IDE clients can discard displayed content.

2. **[P1] Activity fallback too aggressive** — the fallback fired whenever the shape detector abstained AND no text/tool activity fired. Flagged legitimate no-output paths (extension commands, input handlers). The implementer investigated (`code-review-issue-22-finding2-investigation.md`) and concluded the extension paths were unreachable because qlaybot didn't pass `extensionRunnerRef`. **This conclusion was WRONG and later caught by gpt-5.5 in R7** — pi-coding-agent loads extensions on its own based on `customTools`. Documented-only in R1 (`84f8a1c`); actual fix came in R7.

3. **[P2] Refusals retried 5x** — `stopReason: "error"` could mean either transport error OR deliberate provider refusal (anthropic "refusal"/"sensitive", openai "content_filter"). Retrying refusals wastes 5 requests and pollutes a clean refusal. Fixed in `1f70493` by checking content: empty content → transport-like → retry; has text → refusal-like → preserve.

## R2 findings (gpt-5 xhigh) — consequences of R1 fixes

1. **[P1] Content-based gate truncated mid-stream transport errors** — R1's "preserve if content has text" rule turned out wrong for transport errors that killed the stream mid-response (pi-ai preserves partial text in the error turn). Fixed in `a536d4a` by gating retry on `errorMessage` presence instead. The `errorMessage` signal is set by pi-ai's catch blocks (anthropic.js:318, openai-completions.js:257) but NOT by refusals.

2. **[P2] Activity fallback fired on legitimate empty completions** — `stopReason: "stop"` + `content: []` (user asked for nothing) triggered up to 5 retries. Fixed in `2d1c529` by narrowing the fallback: only fire when no terminal assistant message exists.

## R3 findings (gpt-5 xhigh)

1. **[P1] errorMessage gate caught non-retryable errors** — `errorMessage`-presence was too broad; context-overflow, auth failures, invalid_request all have non-empty errorMessage but are not retryable. Fixed in `bba1126` by mirroring pi-coding-agent's `_isRetryableError` logic: delegate to `isContextOverflow` for overflow detection, then apply the retryable regex.

2. **[P1] Exhausted retries returned partial text as success** — `runPromptWithThinkingOnlyGuard` returned `{stillThinkingOnly: true}` but callers ignored it. Fixed in `22c64a5` — CLI emits `status: "error"` + `process.exit(1)`, RPC emits `error` event + `sendError`.

## R4 findings (gpt-5 xhigh)

1. **[P1] Stalled-toolUse retry corrupted tool state** — the stalled-toolUse detector added in commit `b48b062` fired the `"Continue..."` prompt. But pi-ai's `transform-messages.js:125-141` injects a synthetic `"No result provided"` toolResult for orphan toolCalls followed by a user message — the model then continued under the false premise that the tool errored. Fixed in `7d35f74` by **dropping the stalled-toolUse retry branch entirely**. Verified against ml09/ml11 traces that the pattern exists but recovery via Continue is actively harmful; the right fix belongs at the agent-loop layer.

2. **[P2] RPC exhaustion missing final reset event** — intermediate retries emitted `thinking_only_reset` with `final: false`, but the exhaustion path sent `error` without a final reset. IDE clients kept stale partial text. Fixed in `b9ba519` with explicit `final: true` marker.

## R5 findings (gpt-5 xhigh)

1. **[P2] `process.exit(1)` could truncate JSON** — in `-m` mode piped to another process, `process.exit(1)` terminates before buffered stdout drains and skips `finally {}`. Fixed in `d4eda27` with `process.exitCode = 1; return;` — lets Node drain naturally on beforeExit.

## R6 findings (gpt-5 xhigh) — REFUTED

1. **[P1] chunks-reset drops recovered prefix** — claim: pi-ai preserves the failed turn's partial text; retry continues from the prefix; clearing chunks loses it. **Wrong.** Pi-ai's `transform-messages.js:103-111` explicitly skips error/aborted assistant turns before the provider call. Retry sees `[original_user, Continue...]` with no prefix. R1's chunks-reset is correct.

2. **[P2] stopReason=error with toolCall triggers fake toolResult** — claim: orphan-handling at line 125-141 injects synthetic `"No result provided"` for a toolCall in an error turn. **Wrong.** The whole error turn is dropped at line 109-111, including its toolCall content. No orphan, no synthetic result.

Verified by reading pi-ai source directly. No fix needed. Documented as R7.

## R7 findings (gpt-5.5 xhigh) — invalidated R2 #2's investigation

1. **[P2] Extension-handled prompts still misfire the fallback** — the R2 #2 investigation only checked that qlaybot doesn't pass `extensionRunnerRef` to AgentSession. But pi-coding-agent's AgentSession creates `_extensionRunner` whenever `customTools` is passed (which qlaybot always does). So the extension-command and input-handler paths are reachable. The R4 #2 hasTerminalAssistant check handled `stopReason` cases but not the pure handled-without-assistant shape.

   Fixed in `e19b5bc` with a bold design call: **disabled the activity fallback entirely.** Rationale: every canonical retryable shape (thinking-only, retryable error, aborted) is already caught by the message-shape detector. The fallback's original "belt-and-suspenders" purpose has no remaining use case. Inversion per the review doc would have regressed R4 #1 (stalled toolUse) and R2 #2 (legitimate empty stop).

## R8 findings (gpt-5 xhigh) — the longest single round

1. **[P1] Non-retryable errors hide as silent success** — R3 #1 correctly excluded non-retryable errors from retry but did NOT wire them to "surface as terminal error." The caller saw `stillThinkingOnly: false` and took success path with empty response. Exact silent-exit class of the original bug. Fixed in `680cde0` with new `lastTurnTerminalError(session, sinceIdx)` helper + wiring in both cli.ts and rpc.ts.

2. **[P2] Scan-boundary not bounded to current prompt** — in persistent sessions (TUI/RPC), the backward scan for last assistant could match a PRIOR turn's trailing shape when the current prompt didn't push an assistant message (extension-handled). Fixed in `2b5339e` with `sinceIdx` snapshotting threaded through all scan helpers.

3. **[P3] Test had early return that skipped assertions** — `return;` inside an `it(async () => {})` callback exits the whole test; assertions after never ran. Also found an unwired `mockProcessExit` making an assertion tautological. Fixed in `8f19f4a` with flag-based branching. Verified load-bearing by injecting a deliberate failure.

## Post-R8 follow-ups (Claude-authored, landed directly on the branch)

The R8 fixes introduced their own edges. I patched them after codex flagged each one:

1. **`e0dfb4a` — compaction-length rebind.** R8 #2's `sinceIdx` snapshot could point past the end of `session.messages` if pi-coding-agent compacted the history before appending the current turn. Added `reboundAfterCompaction()` that reset `sinceIdx = 0` when the array shrunk.

2. **`9cd0a30` — context-overflow ordering in terminal helper.** `lastTurnTerminalError` used `isRetryableErrorMessage` alone; the retryable regex (`/500/`) matches token counts like "250000" in "prompt is too long: 250000 tokens". Mirrored pi-coding-agent's ordering: `isContextOverflow` check FIRST, then retryable regex. Context-overflow returns as terminal instead of null.

3. **`c8dbb7a` — identity-tracking rebind (supersedes length-rebind).** The length check missed the case where compaction drops K messages AND the prompt adds K messages → same final length → no rebind → current assistant missed. Track the pre-prompt last message by object reference instead; if the ref is present in post-prompt array, use its position + 1 as `sinceIdx`; if dropped by compaction, reset to 0.

4. **`3343cfa` — word-boundary HTTP status codes.** Bare `500` in the retryable regex matched "5000" in e.g. `max_tokens must be <= 5000` (non-retryable 4xx validation errors). Wrapped HTTP-code alternations in `\b(?:429|500|502|503|504)\b`.

Each fix: committed with a load-bearing regression test, verified by stashing the source change and confirming the test fails, then restoring.

## Final verdict (gpt-5.5 xhigh)

> "The changes add a bounded retry/error-surfacing guard for JSON/RPC paths without breaking the existing prompt flow. I did not find a discrete introduced bug that would cause incorrect behavior relative to the current codebase."

Merged as `25989de`.

---

## Cross-issue artifacts and consolidation

- `agent/src/thinking-only-guard.ts` — the guard module, ~400 lines including file-header philosophy and many R-round comments
- `agent/src/session-status.ts` (from #24) — has `lastTurnWasFailure(session)`; #22's `lastTurnTerminalError` in thinking-only-guard.ts is a parallel helper. **Post-merge consolidation opportunity:** both inspect the trailing assistant stopReason/errorMessage. Worth co-locating in `session-status.ts`.
- `agent/tests/test-thinking-only.ts` + `test-thinking-only-rpc.ts` — total 67+ tests across the guard's surface

## Lessons from the chain

1. **Alternate reviewer models catch each other's misses.** R6 (gpt-5 xhigh) was completely wrong on the pi-ai behavior. R7 (gpt-5.5 xhigh) caught it by reading the source directly.

2. **Each fix reveals the next edge.** R1 → R2 → R3 → R4 → R5 were all downstream consequences of the R1 chunks/refusal fixes. R8 revealed non-retryable handling was split incorrectly. Follow-up 1–4 each found a narrower hole in the sinceIdx mechanism. The cycle converged, but slowly.

3. **Investigation notes can be wrong.** R2 #2's "theoretical-only" conclusion was accepted on the basis of a specific code path check that missed a parallel path. Re-verified under gpt-5.5 xhigh five rounds later. If someone ever writes a comment that says "theoretical-only," require an explicit test case or a codex-verified rationale.

4. **Object identity vs length.** When tracking "was the array replaced or extended," length is usable but identity of specific items is more robust. The compaction-rebind bug chain (length → identity) shows this.

## Follow-ups still open

1. **Post-merge consolidation:** co-locate `lastTurnTerminalError` (in thinking-only-guard) with `lastTurnWasFailure` (in session-status). Both inspect trailing assistant turn.
2. **Architectural concern from #23:** `AgentSession.prompt()` turn-loop contract. Filed separately.
3. **Pre-existing test failures** (`docs/2026-04-24-pre-existing-test-failures.md`) — 3 tests unrelated to any of the three issues.
