/**
 * Thinking-tool guidance section — v0.4.4 §3.4.
 *
 * Emits the 6-bullet advisory block for the `thinking` tool. The block is
 * included only when `"thinking"` is in the toolNames list (i.e. when the
 * tool is actually registered in the session's toolMap — see Task 1.2).
 *
 * Source of truth: docs/superpowers/specs/2026-04-19-qlaybot-0.4.4-design.md
 * §3.4 — 6 bullets verbatim. Drift is caught by test-prompts.ts (T44).
 */

export function buildThinkingSection(toolNames: string[]): string {
  // Gate: only emit when `thinking` is in the registered tool list. This
  // mirrors how MCP / delegation sections only render when their feature
  // is live.
  if (!toolNames.includes("thinking")) return "";

  // Bullets below are the §3.4 canonical wording, adjusted only for
  // markdown list formatting. The canonical substrings that T44 asserts on:
  //   - "destructive"
  //   - "ambiguity" OR "choosing between approaches"
  //   - "trivial" OR "not required"
  //   - the five destructive MCP tool names
  //   - "One thought per call"
  //   - "plan_executing" + /VC branch|checkpoint/
  //   - "Do not paste raw tool output"
  return `## Thinking tool guidance

- Call \`thinking\` before any destructive MCP call (\`klayout_native_save_layout\`, \`klayout_native_auto_route\`, \`klayout_native_execute_script\` that mutates geometry, \`klayout_native_vc_checkpoint\`, \`klayout_native_vc_checkout\`).
- Call \`thinking\` when choosing between two or more viable approaches, when resolving an ambiguity in the user's request, or when interpreting a surprising tool result.
- Do not call \`thinking\` for trivial single-step requests.
- One thought per call; keep each call tight. Prefer two short \`thinking\` calls over one long one if the decisions are independent.
- During \`plan_executing\`, reference the active VC branch / checkpoint when it is load-bearing for the decision.
- Do not paste raw tool output back into \`thought\`; summarise the decision, not the data.`;
}
