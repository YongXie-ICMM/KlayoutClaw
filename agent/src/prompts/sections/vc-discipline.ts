/**
 * Cross-track (§6) VC-discipline guidance section — v0.4.4.
 *
 * Emits the three §6 prose blocks (checkpoint discipline during plan
 * execution, recovery on blocker, and reasoning discipline) as a single
 * contiguous block so the drift-guard test can anchor on §6-unique
 * phrases and validate co-location of all three bullets.
 *
 * This section is emitted in Full mode only — §6 is plan-mode cross-track
 * guidance, and subagents don't own plan_executing state.
 *
 * Source of truth: docs/superpowers/specs/2026-04-19-qlaybot-0.4.4-design.md
 * §6 — three blocks verbatim. Drift is caught by test-prompts.ts (T44).
 */

export function buildVcDisciplineSection(): string {
  // The three paragraphs below are the §6 canonical wording, kept as a
  // single contiguous block (no intervening section breaks) so the
  // drift-guard test sees them within one `\n\n---\n\n`-bounded span.
  //
  // Canonical substrings that T44 asserts on (must not drift):
  //   - "before any destructive MCP call during `plan_executing`"
  //   - the three destructive MCP tool names (save_layout, auto_route,
  //     execute_script)
  //   - "klayout_native_vc_checkpoint" + "roll back"
  //   - "klayout_native_vc_status" + "vc not initialized" +
  //     "skip this guidance silently"
  //   - "klayout_native_vc_checkout" + "last good checkpoint" +
  //     "before re-drafting"
  //   - "Record the decision via `thinking`"
  //   - "unrecoverably"
  //   - "ambiguity" + "choosing between approaches"
  //   - "VC branch/checkpoint" + "load-bearing"
  return `## VC discipline during plan execution (§6)

**Checkpoint discipline during plan execution.** Before any destructive MCP call during \`plan_executing\` (\`klayout_native_save_layout\`, \`klayout_native_auto_route\`, \`klayout_native_execute_script\` that mutates geometry), consider calling \`klayout_native_vc_checkpoint\` with a short message so the user can roll back. If \`klayout_native_vc_status\` returns \`vc not initialized\`, skip this guidance silently.

**Recovery on blocker.** If a \`plan_executing\` step fails unrecoverably, consider \`klayout_native_vc_checkout\` to the last good checkpoint before re-drafting. Record the decision via \`thinking\`.

**Reasoning discipline.** Use \`thinking\` before destructive MCP calls, when resolving ambiguity, and when choosing between approaches. Reference the active VC branch/checkpoint when it's load-bearing.`;
}
