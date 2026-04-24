/** Shared test file lists for vitest configs. */

export const unitFiles = [
  "tests/test-unit.ts",
  "tests/test-components.ts",
  "tests/test-compaction.ts",
  "tests/test-contracts.ts",
  "tests/test-config-tui.ts",
  "tests/test-config-tui-components.ts",
  "tests/test-search.ts",
  "tests/test-subagent.ts",
  "tests/test-subagent-components.ts",
  "tests/test-delegate-redesign.ts",
  "tests/test-tier1-bugs.ts",
  "tests/test-tier2-bugs.ts",
  "tests/test-reviewer-findings.ts",
  "tests/test-image-escaping.ts",
  "tests/test-plan-mode-v043.ts",
  "tests/test-plan-mode-v043-group2.ts",
  "tests/test-plan-mode-v043-group3.ts",
  "tests/test-plan-mode-v043-group4.ts",
  "tests/test-plan-mode-v043-group5.ts",
  "tests/test-plan-mode-v043-group6.ts",
  "tests/test-plan-mode-v043-group6b.ts",
  "tests/test-marker-emitter.ts",
  "tests/test-plan-slug.ts",
  "tests/test-plan-state-machine.ts",
  "tests/test-blocker-classifier.ts",
  "tests/test-phase5-vc-mcp.ts",
  "tests/test-prompts.ts",
  "tests/test-t16-graceful-degradation.ts",
  "tests/test-plan-reinjection.ts",
  "tests/test-thinking-only.ts",
];

export const integrationFiles = [
  "tests/test-search-integration.ts",
  "tests/test-runtime-wiring.ts",
  "tests/test-subagent-e2e.ts",
  "tests/test-thinking-e2e.ts",
  "tests/test-thinking-only-rpc.ts",
];

export const e2eFiles = [
  "tests/test-e2e.ts",
  "tests/test-phase2b-e2e.ts",
  "tests/test-phase7-vc-cross-track.ts",
  "tests/test-delegate-e2e.ts",
];
