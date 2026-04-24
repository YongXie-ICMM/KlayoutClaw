# Pre-existing Test Failures on `main` (2026-04-24)

These tests fail on `main` and on every `fix/*` / `feat/*` branch that touches the agent. They are NOT caused by issues #22, #23, or #24 — all three implementers correctly flagged them as out-of-scope. Filing for follow-up after the in-flight branches merge.

Observed on `main @ 281c5cf` and later; also on all three in-flight worktrees:
- `fix/issue-22-thinking-only-termination`
- `fix/issue-23-delegate-failure`
- `feat/issue-24-plan-reinjection`

---

## Failure 1 — `test-unit.ts > package.json version > version is 0.4.3`

**File:** `agent/tests/test-unit.ts:1111–1114`

```ts
it("version is 0.4.3", () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"));
  expect(pkg.version).toBe("0.4.3");
});
```

**Why it fails:** `agent/package.json` reports `"version": "0.4.4"` (shipped v0.4.4). The test still asserts `"0.4.3"`.

**Fix:** one-line update — change `"0.4.3"` → `"0.4.4"`. Or drop the assertion entirely and replace with a regex `/^\d+\.\d+\.\d+$/` so it doesn't rot on every release.

---

## Failure 2 — `test-plan-mode-v043-group6b.ts > Step 23 · release plumbing > package.json version is 0.4.3`

**File:** `agent/tests/test-plan-mode-v043-group6b.ts` (same assertion pattern)

**Why it fails:** Identical bug to Failure 1, asserted in a second place (the plan-mode-v0.4.3 release-plumbing test group). Same package version mismatch.

**Fix:** same — update to `0.4.4`, or drop the literal and use a regex. If the two assertions are meant to enforce "this test file targets release v0.4.3 and should only be updated on a v0.4.3 bug-fix release," restructure: make the `0.4.3` check gated by an env var or rename the file to not carry a release number.

**Note:** worth doing Failures 1 and 2 together — single commit, coordinated fix, removes the worst-offender-per-release footgun.

---

## Failure 3 — `test-subagent-e2e.ts > SCC-H5h: large tool result stored in full by reducer and transcript`

**File:** `agent/tests/test-subagent-e2e.ts:920–954`

**The test asserts (line 953–954):**
```ts
const seg = state.subagents[0].segments[0] as any;
expect(seg.result).toBe(largeResult);              // 15000 X's verbatim
expect(seg.result.length).toBe(15000);
```

**Why it fails:** Commit `73ea771 "Bug Fix"` (2026-04-19) added `truncateToolResult()` (`src/tui/reducer.ts:881`) and applied it in `SUBAGENT_TOOL_END`. The reducer now replaces tool-result payloads over ~2000 chars with:

```
XXXXX... (truncated 13000 chars) ...XXXXX
```

for display purposes. The reducer change shipped without updating this test, which still asserts the 15000-char verbatim content.

**Fix options (PICK ONE):**

### Option A (minimal): update the test to match current reducer intent

The reducer truncates deliberately — that's the feature (display-side bloat prevention). Rewrite the assertion to match:

```ts
expect(seg.result).toContain("... (truncated");
expect(seg.result.length).toBeLessThan(largeResult.length);
expect(seg.result.length).toBeGreaterThan(0);
```

Keep the transcript-logger half of the test (line 956–964) as-is — the TranscriptLogger DOES preserve full content on disk, and that assertion is still correct.

### Option B (restore original invariant): separate "stored" vs "displayed"

The test's original intent was important: **don't silently lose large tool results.** The current reducer trashes the full content for both storage and display. Split them:

1. Add a new state field like `segments[].fullResult: string` that stores the untruncated content.
2. `truncateToolResult` only runs on the `result` field used by the rendering path (`ToolPanel.tsx` etc.).
3. Update the test to assert `seg.fullResult` has 15000 chars and `seg.result` is truncated.

This preserves the "no silent data loss" guarantee that the test was codifying, at the cost of 2x memory for large results.

### Option C (the deeper fix): stream large results to disk

If the full content is rarely needed in memory (which is likely — the test says "stored in full by reducer AND transcript"), the transcript is already the authoritative store. Drop the reducer-side full storage entirely, keep `truncateToolResult` as-is, and update the test to only assert the TranscriptLogger half. The "stored in full" invariant moves entirely to disk.

**Recommendation:** Option A if you want minimum friction. Option C if you think the feature doesn't actually need in-memory full storage. Option B is the most faithful to the original test intent but adds complexity.

---

## Not observed but mentioned

The user mentioned a third failure related to `env`. Across the three in-flight branches I've only seen the two version-string failures (1 and 2) plus SCC-H5h (3). No env-related failure surfaced in any of my unit or integration runs. Possibilities:

- It may be an E2E-only failure (those runs were skipped via `QLAYBOT_E2E=0`).
- It may have been fixed in one of the recent commits.
- It may be a different test that only runs under specific env flags (e.g., `QLAYBOT_NIGHTLY=1`).

Worth a focused check:

```bash
cd /Users/andrewwayne/testFolder/KlayoutClaw/agent
QLAYBOT_E2E=0 QLAYBOT_NIGHTLY=1 npm test 2>&1 | grep -E 'FAIL|✗' | head -20
```

If a third failure shows up, add it as Failure 4 to this document.

---

## Suggested rollout

1. Open a single GitHub issue: *"Pre-existing test failures on main (2026-04-24)"* referencing this document.
2. Fix Failures 1 + 2 in one commit (version strings → `0.4.4` or regex).
3. Fix Failure 3 in a second commit (pick an option above).
4. Land after #22/#23/#24 merge to avoid churn in their review iteration.

None of these block the in-flight work — they were already failing when we started, they still fail, and all three implementers handled them correctly by flagging as out-of-scope.
