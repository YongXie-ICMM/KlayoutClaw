# Feat #24 — Plan Mode Re-Injection (TRD Build Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `trd` (Test-Reinforced Development). Overseer writes tests in Phase 1; Executor implements in Phase 2. Tests are SHA-256-locked per TRD convention.

**Goal:** Make qlaybot's plan mode stay useful beyond the initial approval. After the agent writes a plan and exits plan mode, periodically re-inject the plan content and ask the agent to check each item's status (done / in-progress / not started) before continuing. Matches the pattern Claude Code uses with its `verify_plan_reminder` attachment + `VerifyPlanExecution` tool.

**User ask** (issue #24): *"The plan mode should re inject the plan content to the agent during the runtime and ask the agent to check if each item completed or not. Similar to Hermes."*

**Clarification after investigation:** Hermes actually does NOT do this — Hermes' plan mode is one-shot (`cli.py:5912`, loads `skills/software-development/plan/SKILL.md` once and queues it). Claude Code DOES do exactly what's asked. We model on Claude Code.

**Reference pattern:**
- `~/testFolder/claude_code/start-claude-code/src/utils/attachments.ts:3894–3929` — `getVerifyPlanReminderAttachment`: every N turns after plan exit, inject a reminder attachment unless verification is already complete
- `~/testFolder/claude_code/start-claude-code/src/utils/messages.ts:4240–4251` — the reminder content template
- `~/testFolder/claude_code/start-claude-code/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:481–491` — on exit, the plan text is returned in the tool_result so the agent sees it once

---

## Prerequisites

- Branch off `main`.
- `cd /Users/andrewwayne/testFolder/KlayoutClaw/agent && npm install`
- `npm run build` passes on baseline
- Read these before starting:
  - `agent/src/planning/index.ts` (PlanManager — already owns the plan file)
  - `agent/src/agent.ts:370–381` (transformContext pipeline — where the re-injection phase attaches)
  - `agent/src/prompts/index.ts:32–96` (how system prompt sections are assembled)

---

## Phase 1 — Overseer writes the test contract (TRD)

The Overseer writes tests that lock behavior BEFORE any implementation is read or modified. Do NOT peek at or start writing implementation code during this phase.

Create `agent/tests/unit/test-plan-reinjection.ts`. Tests required:

- [ ] **T1 — No injection when not in plan mode.** Session has no active plan → transformContext returns messages unchanged (no plan-reinjection block added).

- [ ] **T2 — No injection when in plan mode but no plan written yet.** `planManager.currentPlan` is set but the plan file is empty → no injection (don't inject noise).

- [ ] **T3 — Injection on turn N (configurable).** Given `reinjectionInterval = 3` and plan active + non-empty, turns 3, 6, 9 trigger injection; turns 1, 2, 4, 5, 7, 8 do not.

- [ ] **T4 — Injection content shape.** The injected message is a system-reminder-style user message containing: (a) the full plan file contents, (b) the instruction `"For each item in the plan above, briefly state: done / in-progress / not started. Then continue with the next not-started item."`, (c) a stable marker `<plan-reinjection>` … `</plan-reinjection>` so the pruner can dedupe old ones.

- [ ] **T5 — Deduplication.** The pruner phase drops old `<plan-reinjection>` blocks so context doesn't grow unboundedly; only the most recent one survives past the next pruner pass.

- [ ] **T6 — Verification short-circuit.** When `planManager.markVerified()` has been called, no further injections fire regardless of turn count (matches Claude Code's `pending.verificationCompleted` gate). `markVerified()` can be called via a tool or via `/plan verify`.

- [ ] **T7 — Interval is configurable.** Load from `settings.json` → `plan.reinjectionInterval` (default: 3). Setting it to 0 disables re-injection entirely.

- [ ] **T8 — Works for both `-m` and RPC modes.** Both `runJSON` (cli.ts) and the RPC `prompt` handler see the injected messages.

- [ ] **Lock the tests.** After writing, compute SHA-256 of `test-plan-reinjection.ts` and paste it into this plan doc below, in the "Test Lock" section. The Executor will verify the SHA matches before starting Phase 2.

**Test Lock:**
```
SHA-256(agent/tests/unit/test-plan-reinjection.ts) = <fill in at end of Phase 1>
```

All 8 tests should run RED against the current codebase (no implementation yet).

---

## Phase 2 — Executor implements (TRD)

Executor: verify the SHA-256 of `test-plan-reinjection.ts` matches the lock in this doc before writing any implementation code. Do NOT modify the tests.

### 2.1 — Extend PlanManager with turn counter + verification state

- [ ] Add to `agent/src/planning/index.ts`:

```ts
// On PlanManager class
private _turnsSinceExit: number = 0;
private _verificationCompleted: boolean = false;

incrementTurnsSinceExit(): void {
  if (this._currentPlan && !this._inPlanMode) this._turnsSinceExit++;
}
get turnsSinceExit(): number { return this._turnsSinceExit; }

markVerified(): void {
  this._verificationCompleted = true;
  this._emit({ type: "plan_verified", planId: this._currentPlan?.id ?? "", timestamp: Date.now() });
}
get verificationCompleted(): boolean { return this._verificationCompleted; }

// Reset counter + verification on new plan
// (add to _activatePlan)
this._turnsSinceExit = 0;
this._verificationCompleted = false;
```

Add `"plan_verified"` to `PlanEvent` union in `planning/types.ts`.

### 2.2 — Build the re-injection transformContext phase

- [ ] Add `agent/src/compaction/plan-reinjector.ts`:

```ts
import type { PlanManager } from "../planning/index.js";

export const PLAN_REINJECTION_OPEN = "<plan-reinjection>";
export const PLAN_REINJECTION_CLOSE = "</plan-reinjection>";

export interface PlanReinjectorConfig {
  interval: number;  // 0 disables
}

export function createPlanReinjector(planManager: PlanManager, config: PlanReinjectorConfig) {
  return async function planReinjector(messages: any[]): Promise<any[]> {
    if (config.interval <= 0) return messages;
    if (!planManager.currentPlan) return messages;
    if (planManager.inPlanMode) return messages;  // Only re-inject AFTER exit
    if (planManager.verificationCompleted) return messages;

    const turn = planManager.turnsSinceExit;
    if (turn === 0 || turn % config.interval !== 0) return messages;

    const planContent = planManager.readPlanFile();
    if (!planContent || planContent.trim().length === 0) return messages;

    const reminder = [
      PLAN_REINJECTION_OPEN,
      "This is your plan (re-injected every " + config.interval + " turns until you call /plan verify):",
      "",
      planContent,
      "",
      "For each item in the plan above, briefly state: done / in-progress / not started.",
      "Then continue with the next not-started item.",
      PLAN_REINJECTION_CLOSE,
    ].join("\n");

    return [
      ...messages,
      { role: "user", content: reminder, isMeta: true },
    ];
  };
}

/** Pruner-side deduplication: keep only the most recent <plan-reinjection> block. */
export function prunePlanReinjections(messages: any[]): any[] {
  const keepIdx = new Set<number>();
  let lastReinjectionIdx = -1;
  messages.forEach((m, i) => {
    const text = typeof m.content === "string" ? m.content : "";
    if (text.includes(PLAN_REINJECTION_OPEN)) lastReinjectionIdx = i;
  });
  return messages.filter((m, i) => {
    const text = typeof m.content === "string" ? m.content : "";
    if (!text.includes(PLAN_REINJECTION_OPEN)) return true;
    return i === lastReinjectionIdx;
  });
}
```

### 2.3 — Wire into transformContext

- [ ] In `agent.ts:370–381`, add the planReinjector phase AFTER stateLoader, BEFORE autoRecall:

```ts
transformContext: async (messages) => {
  messages = await prunePlanReinjections(messages);   // dedup first
  messages = await toolResultPruner(messages);
  messages = await stateLoader(messages);
  messages = await planReinjector(messages);          // NEW
  messages = await autoRecall(messages);
  return messages;
}
```

(Exact ordering depends on current pipeline — verify by reading `agent.ts` before wiring.)

### 2.4 — Increment the turn counter

- [ ] In `cli.ts runJSON()` after each successful `session.prompt()` call, call `planManager.incrementTurnsSinceExit()`.
- [ ] In `rpc.ts` `prompt` handler after each successful `session.prompt()` call, same.
- [ ] Do NOT increment during plan-mode turns (the getter already skips via `!this._inPlanMode` check).

### 2.5 — Config wiring

- [ ] Add `plan.reinjectionInterval: number` to settings schema in `agent/src/types/v04-contracts.ts`, default 3.
- [ ] Read the value in `createDesignSession` and pass into `createPlanReinjector`.
- [ ] Document in `agent/CLAUDE.md` under Config.

### 2.6 — Add `/plan verify` command

- [ ] Extend the existing `/plan` command handler to accept `verify` as a subcommand.
- [ ] `/plan verify` calls `planManager.markVerified()` and prints confirmation.
- [ ] Update the `verify_plan_reminder`-style injected content to mention `/plan verify` as the way to stop the reminders: `"When all items are done, call /plan verify to stop these reminders."`

### 2.7 — Run tests

- [ ] `npm test -- --run test-plan-reinjection` — all 8 must pass.
- [ ] `npm run test:unit` — no regressions; `test-unit.ts` planning tests still pass.
- [ ] `npm run test:integration` — no regressions.

---

## Phase 3 — E2E verification

- [ ] **Manual smoke test**: start qlaybot, enter plan mode, write a plan with 3 tasks, exit plan mode, run 3 turns of regular chat, observe that turn 3 receives a `<plan-reinjection>` block and the model responds with item statuses. Turn 6 receives another block. `/plan verify` stops further injections.

- [ ] **E2E benchmark test**: re-run one of the failed benchmark instructions (e.g., ml11 from the 2026-04-23 early-exit report) with `plan.reinjectionInterval: 3`. The purpose is to confirm the re-injection doesn't break existing flows — not that it fixes ml11 (that's #22's territory). Measure: (a) does the run complete without errors? (b) how many re-injections fired? (c) did context usage stay reasonable (no unbounded growth — verify dedup works)?

- [ ] **Commit** with message `feat(agent/planning): periodic plan re-injection after exit (issue #24)`. Include co-author trailer.

---

## Success criteria

1. `test-plan-reinjection.ts`: 8/8 passing
2. `npm run test:unit` + `npm run test:integration`: no regressions
3. Manual smoke test: reminder fires on expected turns, dedup keeps context bounded, `/plan verify` short-circuits
4. Benchmark re-run: no behavioral regressions vs. baseline

## Design notes / non-goals

- **Why not build a `VerifyPlanExecution` tool like Claude Code has?** That tool does LLM-based plan-item-checkoff reasoning. Out of scope for v1 — we're asking the agent to self-check via the reminder content instead. A future enhancement could add a dedicated tool.
- **Why dedup only the `<plan-reinjection>` blocks and not all system reminders?** Scope isolation — other reminders (e.g., memory recall) have their own lifecycle. Plan reminders are uniquely repetitive because the same plan text is re-injected.
- **Why 3 turns as default?** Tuning call. Claude Code actually uses `TURNS_BETWEEN_REMINDERS: 10` (see Appendix A). Our plan files are typically shorter than a full Claude Code session plan, so 3 feels right as a starting point — but if empirically it generates too much noise, bump to 10 to match Claude Code. Adjustable via `plan.reinjectionInterval` in settings.
- **Not addressed:** plan-item-level tracking (struck-through list items per completion). Current plan files are free-form markdown; the agent self-reports status in the turn after injection. Structured plan items are a separate feature.

## References

- `agent/src/planning/index.ts` — PlanManager (extended here)
- `agent/src/agent.ts:370–381` — transformContext pipeline
- `agent/src/compaction/` — existing compaction phases to follow as patterns
- `~/testFolder/claude_code/start-claude-code/src/utils/attachments.ts:3872–3929` — reference pattern (also reproduced in Appendix A)
- `~/testFolder/claude_code/start-claude-code/src/utils/messages.ts:4240–4251` — reminder template
- `~/testFolder/claude_code/start-claude-code/src/state/AppStateStore.ts:411–417` — pendingPlanVerification state shape
- `~/testFolder/hermes-agent/skills/software-development/plan/SKILL.md` — Hermes' simpler one-shot model (NOT what we're building, but the inspiration for the user's ask)

---

## Appendix A — Claude Code reference code (verbatim)

These snippets are inlined so the Executor does not need to re-navigate the reference codebase. Paths are authoritative — if you need surrounding context, open them directly.

### A.1 — The reminder cadence constant (`attachments.ts:291–293`)

```ts
export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const
```

### A.2 — Human-turn counter since plan exit (`attachments.ts:3872–3889`)

```ts
/**
 * Count human turns since plan mode exit (plan_mode_exit attachment).
 * Returns 0 if no plan_mode_exit attachment found.
 *
 * tool_result messages are type:'user' without isMeta, so filter by
 * toolUseResult to avoid counting them — otherwise the 10-turn reminder
 * interval fires every ~10 tool calls instead of ~10 human turns.
 */
export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      turnCount++
    }
    // Stop counting at plan_mode_exit attachment (marks when implementation started)
    if (
      message?.type === 'attachment' &&
      message.attachment.type === 'plan_mode_exit'
    ) {
      return turnCount
    }
  }
  // No plan_mode_exit found
  return 0
}
```

**Important lesson for our Executor:** tool-result messages inflate naive turn counts. Our `incrementTurnsSinceExit()` must only fire on **user-initiated** prompts, not on every `session.prompt()` call (which includes auto-continue turns after tool calls). Verify by checking how qlaybot's `AgentSession.prompt()` distinguishes user vs. resumption turns before wiring.

### A.3 — The attachment gate (`attachments.ts:3894–3929`)

```ts
async function getVerifyPlanReminderAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN)
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const pending = appState.pendingPlanVerification

  // Only remind if plan exists and verification not started or completed
  if (
    !pending ||
    pending.verificationStarted ||
    pending.verificationCompleted
  ) {
    return []
  }

  // Only remind every N turns
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages)
    if (
      turnCount === 0 ||
      turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0
    ) {
      return []
    }
  }

  return [{ type: 'verify_plan_reminder' }]
}
```

Note the **two separate short-circuit states**: `verificationStarted` AND `verificationCompleted`. The "started" flag exists because VerifyPlanExecution runs in the background — once launched, don't nag. For our v1 (no verification tool), we only need `verificationCompleted`, toggled by `/plan verify`.

### A.4 — The reminder content (`messages.ts:4240–4251`)

```ts
case 'verify_plan_reminder': {
  const toolName =
    process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
      ? 'VerifyPlanExecution'
      : ''
  const content = `You have completed implementing the plan. Please call the "${toolName}" tool directly (NOT the ${AGENT_TOOL_NAME} tool or an agent) to verify that all plan items were completed correctly.`
  return wrapMessagesInSystemReminder([
    createUserMessage({ content, isMeta: true }),
  ])
}
```

**Difference for our v1:** Claude Code's reminder doesn't re-inject the plan CONTENT — it just reminds the agent to call the verification tool, which then reads the plan itself. Since we're not building a verification tool in v1, **our reminder inlines the plan content directly** (see the `PLAN_REINJECTION_OPEN`/`CLOSE` block in Phase 2.2). That's why our dedup pruner matters more than Claude Code's does — our blocks are large.

### A.5 — State shape (`AppStateStore.ts:411–417`)

```ts
// Pending plan verification state (set when exiting plan mode)
// Used by VerifyPlanExecution tool to trigger background verification
pendingPlanVerification?: {
  plan: string
  verificationStarted: boolean
  verificationCompleted: boolean
}
```

Our equivalent fields live on `PlanManager` (`_turnsSinceExit`, `_verificationCompleted`) rather than in a global app-state store because qlaybot's PlanManager is already the single authority for plan lifecycle. No `verificationStarted` for v1.

### A.6 — How `pendingPlanVerification` is seeded (`REPL.tsx:3082–3088`)

```ts
...(shouldStorePlanForVerification && {
  pendingPlanVerification: {
    plan: initialMsg.message.planContent!,
    verificationStarted: false,
    verificationCompleted: false
  }
})
```

The state is populated the moment ExitPlanMode's tool_result is processed. In our design, the equivalent seeding lives inside `PlanManager.exitPlanMode()` / `closePlanMode()` — reset `_turnsSinceExit = 0` and `_verificationCompleted = false` there so counting starts from exit, not from plan creation.
