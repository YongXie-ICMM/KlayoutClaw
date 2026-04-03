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
  "tests/test-tier1-bugs.ts",
  "tests/test-tier2-bugs.ts",
  "tests/test-reviewer-findings.ts",
];

export const integrationFiles = [
  "tests/test-search-integration.ts",
  "tests/test-runtime-wiring.ts",
  "tests/test-subagent-e2e.ts",
];

export const e2eFiles = [
  "tests/test-e2e.ts",
];
