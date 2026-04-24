/**
 * Plan re-injection transformContext phase (issue #24).
 *
 * After the agent exits plan mode, periodically re-inject the plan file
 * contents (plus a status-check instruction) so the agent revisits its
 * plan every N turns. Matches Claude Code's `verify_plan_reminder`
 * attachment pattern, but with the plan CONTENT inlined (we don't have
 * a dedicated verification tool yet).
 *
 * Skip rules:
 *   - interval <= 0 (disabled)
 *   - no current plan
 *   - still in plan mode (only re-inject AFTER exit)
 *   - verificationCompleted (user called /plan verify)
 *   - turnsSinceExit === 0 (haven't taken a real turn yet)
 *   - turnsSinceExit % interval !== 0 (not on cadence)
 *   - plan file is empty / whitespace
 */

import type { PlanManager } from "../planning/index.js";

export const PLAN_REINJECTION_OPEN = "<plan-reinjection>";
export const PLAN_REINJECTION_CLOSE = "</plan-reinjection>";

export interface PlanReinjectorConfig {
  /** Interval in turns. 0 disables re-injection entirely. */
  interval: number;
}

export function createPlanReinjector(
  planManager: PlanManager,
  config: PlanReinjectorConfig,
) {
  return async function planReinjector(messages: any[]): Promise<any[]> {
    if (config.interval <= 0) return messages;
    if (!planManager.currentPlan) return messages;
    if (planManager.currentPlan.status === "abandoned") return messages;
    if (planManager.currentPlan.status === "completed") return messages;
    if (planManager.inPlanMode) return messages;
    if (planManager.verificationCompleted) return messages;

    const turn = planManager.turnsSinceExit;
    if (turn === 0) return messages;
    if (turn % config.interval !== 0) return messages;

    const planContent = planManager.readPlanFile();
    if (!planContent || planContent.trim().length === 0) return messages;

    const reminderText = [
      PLAN_REINJECTION_OPEN,
      `<system-reminder>`,
      `This is your plan, re-injected every ${config.interval} turn(s) since you exited plan mode.`,
      `Before answering the user's next message, briefly state done / in-progress / not started for each plan item, then answer the user.`,
      "",
      planContent,
      "",
      // R3 finding #3 (2026-04-24): slash commands are user-only — the
      // model can't invoke /plan verify from its own response. Tell the
      // model to inform the user instead, so the human can run the
      // command themselves.
      `When you believe all plan items are complete, explicitly tell the user the plan is done. The user can then run /plan verify to stop these reminders.`,
      `</system-reminder>`,
      PLAN_REINJECTION_CLOSE,
    ].join("\n");

    // Find the terminal user message; insert reminder BEFORE it so the
    // user's actual request stays the last thing the model sees.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) {
      return [{ role: "user", content: reminderText, isMeta: true }, ...messages];
    }
    return [
      ...messages.slice(0, lastUserIdx),
      { role: "user", content: reminderText, isMeta: true },
      ...messages.slice(lastUserIdx),
    ];
  };
}

/**
 * Pruner-side de-duplication. Keeps only the MOST RECENT
 * `<plan-reinjection>` block; earlier ones are dropped so the context
 * doesn't grow unboundedly. Non-reinjection messages are preserved in
 * original order. Messages with non-string content are never filtered.
 */
export function prunePlanReinjections(messages: any[]): any[] {
  let lastReinjectionIdx = -1;
  messages.forEach((m, i) => {
    if (typeof m?.content === "string" && m.content.includes(PLAN_REINJECTION_OPEN)) {
      lastReinjectionIdx = i;
    }
  });
  if (lastReinjectionIdx < 0) return messages;
  return messages.filter((m, i) => {
    if (typeof m?.content !== "string") return true;
    if (!m.content.includes(PLAN_REINJECTION_OPEN)) return true;
    return i === lastReinjectionIdx;
  });
}
