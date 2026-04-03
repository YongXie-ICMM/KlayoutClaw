/**
 * TDD regression tests for Tier 2 bugs from the 7-reviewer audit.
 * Each test should FAIL against the current (buggy) code and PASS once fixed.
 *
 *   BUG A: Non-KLayout MCP discovery — allTools() skips unconnected servers
 *   BUG B: ensureConnected() race — no promise memoization
 *   BUG C: Subagent token accounting — hardcodes outputTokens: 0
 *   BUG D: prompt_too_long no recovery — disabled auto-compaction with no fallback
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function srcFile(relPath: string): string {
  return readFileSync(join(__dirname, "..", "src", relPath), "utf-8");
}

// ============================================================
// BUG A: Non-KLayout MCP discovery — STRUCTURAL
// ============================================================

describe("BUG A: Non-KLayout MCP discovery", () => {
  it("must expose non-KLayout MCP tools via at least one valid path", () => {
    const managerSrc = srcFile("mcp/manager.ts");
    const toolsSrc = srcFile("tools/index.ts");

    // Extract allTools() body
    const allToolsMatch = managerSrc.match(
      /allTools\(\):\s*NamespacedTool\[\]\s*\{([\s\S]*?)\n  \}/,
    );
    expect(allToolsMatch).toBeTruthy();
    const allToolsBody = allToolsMatch![1];

    // Extract connectAll() body
    const connectAllMatch = managerSrc.match(
      /async connectAll\(\)[\s\S]*?\n  \}/,
    );
    expect(connectAllMatch).toBeTruthy();
    const connectAllBody = connectAllMatch![0];

    // Path 1: allTools() does NOT gate non-KLayout tools behind conn.connected
    const allToolsIncludesUnconnected =
      !/if\s*\(\s*conn\.connected\s*\)/.test(allToolsBody);

    // Path 2: connectAll() eagerly connects non-KLayout servers
    const connectAllEager =
      /ensureConnected|initializeSession|listTools/.test(
        connectAllBody.split("} else {")[1] ?? "",
      );

    // Path 3: assembleTools ensures lazy servers are connected
    const assembleToolsEnsures = /ensureConnected/.test(toolsSrc);

    expect(
      allToolsIncludesUnconnected || connectAllEager || assembleToolsEnsures,
    ).toBe(true);
  });
});

// ============================================================
// BUG B: ensureConnected() race — STRUCTURAL
// ============================================================

describe("BUG B: ensureConnected() race condition", () => {
  it("ensureConnected() must memoize in-flight connection promises", () => {
    const src = srcFile("mcp/manager.ts");

    // Extract ensureConnected method
    const methodMatch = src.match(
      /(?:private\s+)?async\s+ensureConnected\([\s\S]*?\n  \}/,
    );
    expect(methodMatch).toBeTruthy();
    const body = methodMatch![0];

    // Must have a promise cache check/set pattern (get + set on same map)
    const hasMemoization =
      /connecting|pending|inflight|inFlight|connectPromise/.test(body);
    expect(hasMemoization).toBe(true);
  });

  it("MCPManager must have a field for tracking in-flight connections", () => {
    const src = srcFile("mcp/manager.ts");
    const classBody = src.match(
      /export class MCPManager \{([\s\S]*?)\n\}/,
    );
    expect(classBody).toBeTruthy();

    const hasField =
      /connecting|pending|inflight|inFlight/.test(classBody![1]);
    expect(hasField).toBe(true);
  });
});

// ============================================================
// BUG C: Subagent token accounting — STRUCTURAL
// ============================================================

describe("BUG C: Subagent token accounting", () => {
  it("normal completion tokenUsage must not hardcode outputTokens: 0", () => {
    const src = srcFile("subagent/runner.ts");

    // Find the final result tokenUsage block (normal completion path)
    // It's in the `const result: SubagentResult = {` block after the loop
    const resultBlock = src.match(
      /const result: SubagentResult = \{[\s\S]*?tokenUsage:\s*\{([\s\S]*?)\}/,
    );
    expect(resultBlock).toBeTruthy();
    const tokenBlock = resultBlock![1];

    expect(tokenBlock).not.toMatch(/outputTokens:\s*0\b/);
  });

  it("runner must track actual API usage, not just context window size", () => {
    const src = srcFile("subagent/runner.ts");

    // Should use usage_update events, getUsage(), or accumulate per-turn usage
    const hasRealTracking =
      /usage_update|getUsage|inputTokenCount|cumulativeInput|apiUsage|accum/.test(src);
    expect(hasRealTracking).toBe(true);
  });
});

// ============================================================
// BUG D: prompt_too_long no recovery — STRUCTURAL
// ============================================================

describe("BUG D: prompt_too_long no error recovery", () => {
  it("agent.ts must have prompt_too_long error recovery when auto-compaction is disabled", () => {
    const src = srcFile("agent.ts");

    // Confirm auto-compaction is disabled
    expect(src).toMatch(/setAutoCompactionEnabled\s*\(\s*false\s*\)/);

    // Must have error recovery wired to compaction
    const hasRecovery =
      // try/catch with compact
      /catch[\s\S]{0,300}compact/i.test(src) ||
      // prompt_too_long handler
      /prompt_too_long[\s\S]{0,300}(compact|retry|recover)/i.test(src) ||
      // error event + compact
      /on\s*\(\s*['"]error['"][\s\S]{0,300}compact/i.test(src);

    expect(hasRecovery).toBe(true);
  });
});
