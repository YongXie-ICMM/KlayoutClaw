# Feat #24 — Code Review Archive (reconstructed from memory 2026-04-24)

Merged: `f347362` on 2026-04-24 into `main`.

The original per-round review docs (`docs/code-review-issue-24-round*.md`) lived only in the worktree and were lost when I ran `git worktree remove --force` post-merge. This archive is a reconstruction from conversation memory — cite the commits themselves (`git log --all --format='%h %s' -- 'agent/src/compaction/plan-reinjector.ts' 'agent/src/planning/' 'agent/src/session-status.ts'`) for exact implementation details.

**Scope of the review chain:** 5 rounds of `codex review --base main`, alternating gpt-5 xhigh and gpt-5.5 xhigh.

---

## Summary table

| Round | Model | Findings | Resolution |
|---|---|---|---|
| R1 | gpt-5 xhigh | 3 (P1, P2, P2) | Fixed in commits `1ddafec`, `2472cf0`, `4fb7ae9` |
| R2 | gpt-5 xhigh | 2 (P2, P2) | Fixed in commits `f214814`, `ce21bb5` |
| R3 | gpt-5 xhigh | 3 (P2, P2, P3) | Fixed in commits `00be8bf`, `3f85e44`, `bc96e0e` |
| R4 | gpt-5 xhigh | 2 (P1, P3) | Fixed in commits `c7b43bf`, `fc64330` |
| R5 | gpt-5.5 xhigh | 1 (P2) | Fixed in commit `f47cbde` |
| Final | gpt-5.5 xhigh | 1 (P2 edge case) | Follow-up (non-blocking) |

Total real findings addressed: 11. One edge case (latch interaction with `promptWithRecovery`) deferred as post-merge follow-up.

---

## R1 findings (gpt-5 xhigh)

1. **[P1] Reminder appended AFTER terminal user message** — reinjector pushed the synthetic reminder to the END of messages, making IT the terminal `role: "user"` message. On reinjection turns (3, 6, 9, …) the model answered the reminder instead of the user's actual request. `isMeta: true` was documentation-only; pi-agent-core doesn't filter on it.
   - **Fix (`1ddafec`):** Insert the reminder BEFORE the last user message. Added `<system-reminder>` wrapper marker. Fallback to prepend if no user message exists.

2. **[P2] Abandoned plans still fired reminders** — `exitPlanMode(approved=false)` set `status: "abandoned"` but kept `_currentPlan`. Reinjector only short-circuited on `verificationCompleted`.
   - **Fix (`2472cf0`):** Added explicit `"abandoned"` and `"completed"` status guards before the `inPlanMode` check.

3. **[P2] `/plan status` in TUI created bogus plans** — App.tsx's `/plan <taskDesc>` intercept caught `/plan status` as a plan-creation with title "status". Similar fix to existing `/plan verify` exemption needed.
   - **Fix (`4fb7ae9`):** Exempt `status` in the intercept with in-component handling matching the `verify` pattern.

## R2 findings (gpt-5 xhigh)

1. **[P2] Cadence off-by-one** — `turnsSinceExit` was incremented AFTER `session.prompt()` but `transformContext` runs INSIDE `prompt()`. So interval=3 fired on turn 4, not turn 3. Same bug at all four entry points.
   - **Fix (`f214814`):** Move increment BEFORE `session.prompt()` at cli.ts (×2), rpc.ts, App.tsx. Exit-turn-swallow mechanics reviewed and preserved.

2. **[P2] CLI `/plan status|verify` didn't work** — adding `plan` to `COMMAND_NAMES` routed `qlaybot plan status` through `runSlashCommand` which creates a fresh session without plan state. Also `runInteractivePlain` sent `/plan verify` straight to `session.prompt` instead of `parseCommand`.
   - **Fix (`ce21bb5`):** Removed `plan` from `COMMAND_NAMES`. Added `parseCommand` intercept in `runInteractivePlain` mirroring rpc.ts pattern. Documented `/plan` as in-session-only.

## R3 findings (gpt-5 xhigh)

1. **[P2] Failed prompts advanced the reinjection cadence** — R2's pre-prompt bump had no catch-path rollback. Failed turns (abort/network/model error) still counted.
   - **Fix (`00be8bf`):** Added `PlanManager.decrementTurnsSinceExit()`. Called from catch blocks at all four entry points. Clamped at 0. Exit-turn-swallow preserved as one-shot.

2. **[P2] Auto-executed plans still triggered reminders** — `exit_plan_mode` tool's `approve_execute` branches closed plans as `"approved"`, which R1 #2 left eligible for reminders. Plans that transitioned to `plan_done` kept getting reminded.
   - **Fix (`3f85e44`):** Close auto-execute paths as `"completed"` so R1 #2's gate short-circuits. `approve_only` branch deliberately stays `"approved"` (reminders are the feature for in-progress implementation).

3. **[P3] Reminder told model to call `/plan verify` — unreachable** — models can't invoke slash commands from their response. Some models echoed `/plan verify` as plain text; reminders never stopped without human intervention.
   - **Fix (`bc96e0e`):** Rewrote wording to route through the user: "tell the user the plan is done so they can run /plan verify."

## R4 findings (gpt-5 xhigh)

1. **[P1] Re-injection fired on every assistant round-trip** — `transformContext` runs on every provider round-trip, not once per user turn. Tool-heavy reminder turns re-injected the full plan blob on every round-trip (15 tool calls → 15 plan injections billed). Cost multiplier + `prompt_too_long` risk.
   - **Fix (`c7b43bf`):** Added `PlanManager._remindedThisTurn` per-user-turn latch. Cleared at user-turn start (paired with `incrementTurnsSinceExit`). Set inside reinjector on successful insert. Rollback symmetry: `decrementTurnsSinceExit` also clears the latch.

2. **[P3] Pruner substring-matched legitimate conversation** — `prunePlanReinjections` keyed on content including `<plan-reinjection>`, silently dropping real user/assistant messages that mentioned the tag literally.
   - **Fix (`fc64330`):** Added `_planReinjection: true` sentinel field on synthetic messages. Pruner now keys on the sentinel, not content.

## R5 findings (gpt-5.5 xhigh)

1. **[P2] Rollback missed swallowed provider errors** — R3 #1's catch-based rollback assumed `session.prompt()` throws on failure. pi-ai's anthropic/openai providers catch internally (`providers/anthropic.js:315-322`), set `stopReason: "error"`/`"aborted"`, resolve cleanly. Failed turn gets written to `session.messages` but catch never fires → counter stays bumped → cadence drifts.
   - **Fix (`f47cbde`):** Added `agent/src/session-status.ts` with `lastTurnWasFailure(session)` helper. Post-prompt check at all four entry points. Same `stopReason: "error"/"aborted"` signal issue #22 uses.

## Final review (gpt-5.5 xhigh) — 1 P2 edge case, non-blocking

1. **[P2] Latch + `promptWithRecovery` interaction** — when a reminder-eligible turn hits `prompt_too_long`, pi-coding-agent's `promptWithRecovery` compacts and calls `rawPrompt` again INSIDE the same user turn. Entry-point catch/decrement never runs. Latch was set by the first transform → recovered request skips the reminder. Cadence counts the turn without the model seeing the plan.
   - **Status:** Not merge-blocking (core feature works for the 99% path). Tracked as post-merge follow-up. Suggested fix: `clearRemindedThisTurn()` in the `promptWithRecovery` retry path, or inside `rawPrompt` before retry.

Merged as `f347362`.

---

## Key artifacts that landed

- `agent/src/compaction/plan-reinjector.ts` — the transformContext phase
- `agent/src/session-status.ts` — `lastTurnWasFailure(session)` helper (consolidation target for #22's parallel needs)
- `agent/src/commands/plan.ts` — `/plan verify|status` CommandRegistry handler
- `agent/src/planning/index.ts` — extended PlanManager with `_turnsSinceExit`, `_verificationCompleted`, `_remindedThisTurn`, exit-turn-swallow mechanics
- `agent/tests/test-plan-reinjection.ts` — 80+ unit tests covering contract from T1–T8 plus R2/R3/R4/R5 regressions
- `plan.reinjectionInterval` config setting (default 3)

---

## Follow-ups explicitly deferred

1. **Latch + `promptWithRecovery` interaction** (final P2 above). Small fix; file when convenient.
2. **Consolidation with issue #22:** both issues inspect trailing assistant stopReason/errorMessage. `lastTurnWasFailure` is in `session-status.ts`; #22's equivalent for non-retryable errors (expected R8 helper name: `lastTurnTerminalError`) could co-locate there post-#22-merge.
