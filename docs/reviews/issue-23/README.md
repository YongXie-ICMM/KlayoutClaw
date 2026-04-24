# Issue #23 — Code Review Archive (reconstructed from memory 2026-04-24)

Merged: `efbb65a` on 2026-04-24 into `main`.

The original per-round review docs (`docs/code-review-issue-23-round*.md`) lived only in the worktree and were lost when I ran `git worktree remove --force` post-merge. This archive is a reconstruction from conversation memory, so it's paraphrased — cite the commits themselves (`git log --all --format='%h %s' -- 'agent/**' | grep "issue #23\|R[1-6] finding"`) for exact implementation details.

**Scope of the review chain:** 6 rounds of `codex review --base main`, alternating gpt-5 xhigh and gpt-5.5 xhigh models.

---

## Summary table

| Round | Model | Findings | Resolution |
|---|---|---|---|
| R1 | gpt-5 xhigh | 3 (P2, P2, P3) | Fixed in commits `b4f71fd`, `fbb1855`, `9966436` |
| R2 | gpt-5 xhigh | 2 (P2, P2) | Fixed in commits `aa9f9a0`, `3180b35` |
| R3 | gpt-5 xhigh | 2 (P2, P3) | Fixed in commits `c813521`, `4129347` |
| R4 | gpt-5 xhigh | 2 (P2, P2) | Fixed in commits `c8c4490`, `0c32d01` |
| R5 | gpt-5 xhigh | 1 (P2) | Fixed in commit `3116fce` |
| R6 | gpt-5.5 xhigh | 1 (P2) | Fixed in commit `dd0de64` |
| Final | gpt-5.5 xhigh | CLEAN | Merged |

Total real findings addressed: 11.

---

## R1 findings (gpt-5 xhigh)

1. **[P2] TUI placeholder field-name mismatch** — `App.tsx onToolStartWithId` dispatched `SUBAGENT_PLACEHOLDER` using `parsed.role`/`parsed.task` from tool args. The new delegate schema uses `subagent_type`/`prompt`, so placeholders ended up `role: "unknown"` + empty task. Reducer's idempotency meant `started` event couldn't repair it.
   - **Fix (`b4f71fd`):** Added `parseDelegatePlaceholder` helper with field-name fallback.

2. **[P2] `general-purpose` reserved-name shadow** — `resolveRole` + `resolveRoleWithFallback` short-circuited on `general-purpose` before consulting `config.roles`. User override was silently unreachable.
   - **Fix (`fbb1855`):** Config override wins, built-in is fallback. Option A from the review doc.

3. **[P3] Model-resolution error path missed lifecycle events** — new guardrail returned `status: "error"` without emitting `started` or `completed`. TUI placeholder stuck "running" forever.
   - **Fix (`9966436`):** Emit `started` + `completed` with error status before returning.

## R2 findings (gpt-5 xhigh)

1. **[P2] Delegate tool catalog double-listed general-purpose** — `buildDelegateDescription` hardcoded the built-in entry AND iterated `config.roles` (which after R1 may contain a user override). Two contradictory lines for same `subagent_type`.
   - **Fix (`aa9f9a0`):** Added `getEffectiveGeneralPurposeRole(config)` + `resolveEffectiveRoleName(name, config)` helpers as single source of truth; catalog skips duplicate entry in the loop.

2. **[P3] TUI placeholder preserved unknown role name instead of fallback** — unknown `subagent_type` silently fell back to `general-purpose` in runner, but placeholder showed the typo ("totally-made-up") for entire run.
   - **Fix (`3180b35`):** `parseDelegatePlaceholder` now takes `SubagentConfig` and routes through `resolveEffectiveRoleName` for display-name consistency.

## R3 findings (gpt-5 xhigh)

1. **[P2] Delegate unreachable on default configs** — `setup.ts` writes `subagent.enabled: true` with `roles: {}`, but `tools/index.ts` gated delegate registration on `Object.keys(roles).length > 0`. Fresh installs silently dropped delegate, defeating the general-purpose fallback.
   - **Fix (`c813521`):** Gate on `subagent.enabled === true` only. Audit follow-up: same pre-redesign gate in `prompts/sections/delegation.ts` updated to match.

2. **[P3] Malformed delegate calls left phantom TUI placeholders** — `delegate.execute()` returned validation errors before `runner.run()` was called. Placeholder never cleared; stuck "running" forever.
   - **Fix (`4129347`):** Added new `cancelled` runner event + `SUBAGENT_CANCEL_PLACEHOLDER` reducer action. Emitted from all early-return branches. Reducer guards against remapped live-run IDs.

## R4 findings (gpt-5 xhigh)

1. **[P2] Delegate schema advertised `prompt` as optional but runtime required it** — tool-calling clients that reason schema-first could issue `{description: "x"}` without `prompt`, pass validation, fail at runtime. Tried Option B (Type.Union), rejected after verifying pi-ai's anthropic-messages translator strips root unions at `providers/anthropic.js:669-678`. Tried Option A, rejected because it would break legacy `{role, task}` deprecation window.
   - **Fix (`c8c4490`):** Option C — schema descriptions explicitly mark `prompt` as REQUIRED and `task` as deprecated alias. Runtime stays the single source of truth for validation.

2. **[P2] Delegation section (system prompt) hardcoded general-purpose capabilities** — same bug as R2 #1 in a different file. Said "full tool surface" even when config narrowed the override.
   - **Fix (`0c32d01`):** Use `getEffectiveGeneralPurposeRole(config)` for display.

## R5 findings (gpt-5 xhigh)

1. **[P2] Plan-drafted freeze wrapper swallowed delegate's cancel contract** — after R3 #1's unconditional registration, delegate calls in `plan_drafted` hit `wrapToolForPlanDraftedFreeze` BEFORE `createDelegateTool`'s `plan_mode_restricted` branch. Freeze wrapper returned `plan_state_frozen` without the `cancelled` event → placeholder leak.
   - **Fix (`3116fce`):** Carve delegate out of the freeze wrapper. Let delegate's own `execute()` handle the plan-mode contract since it already emits `cancelled`.

## R6 findings (gpt-5.5 xhigh)

1. **[P2] Async race between synchronous `emitCancelled` and async `tool_execution_start`** — pi-agent-core delivers `tool_execution_start` via an async EventStream; subscriber callback fires on a later microtask. Synchronous `emitCancelled` raced ahead: cancel arrived before placeholder existed (no-op), then delayed start created placeholder that stayed "running" forever.
   - **Fix (`dd0de64`):** Wrap `emitCancelled` body in `queueMicrotask` so start subscriber flushes first.

## Final verdict (gpt-5.5 xhigh)

> "I did not find a discrete regression introduced by this patch that would block correctness."

Merged as `efbb65a`.

---

## Architectural concern flagged but out of scope

The original #23 investigation noted that `AgentSession.prompt(text)` runs a FULL agentic turn internally — the subagent runner's turn loop calls `prompt()` multiple times per task, which may not match pi-coding-agent's intended usage contract. The current fix (send "Continue the task" as a continuation nudge) works around the symptom. Deeper structural review was explicitly deferred to a follow-up issue post-merge. **This follow-up has not been opened yet** — open one when convenient.

---

## Cross-issue artifacts

- `agent/src/session-status.ts` with `lastTurnWasFailure(session)` landed in #24; #23 has no parallel helper. The extension-handled-prompt investigation in #22 R7 showed pi-coding-agent's internal extension loading reaches pi-agent-core via `customTools` alone — relevant if #23's `delegate` ever gets wired into extension dispatch.
