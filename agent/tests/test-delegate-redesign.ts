/**
 * Tests for the redesigned delegate tool API (issue #23).
 *
 * Verifies:
 * 1. {description, prompt} with no subagent_type → general-purpose, succeeds
 * 2. {description, prompt, subagent_type:"designer"} → uses configured role
 * 3. {description, prompt, subagent_type:"nonexistent"} → falls back to
 *    general-purpose with a warning (NOT an error)
 * 4. {role, task} legacy params → still works, emits deprecation note
 * 5. {} (no prompt, no task) → clear "missing required parameter" error
 */

import { describe, it, expect, vi } from "vitest";
import { createDelegateTool } from "../src/tools/delegate.js";
import type { SubagentConfig, SubagentResult } from "../src/types/v04-contracts.js";

function makeSubagentCfg(): SubagentConfig {
  return {
    enabled: true,
    logDir: "/tmp/qlaybot-test-logs",
    maxLogFiles: 10,
    roles: {
      designer: {
        label: "Designer",
        promptFile: "subagent/designer.md",
        workspaceFiles: [],
        baseTools: ["read", "write"],
        customTools: ["submit_result"],
        mcpAccess: "full",
        maxTurns: 10,
        maxTokens: 50000,
      },
    },
  };
}

function makeMockRunner() {
  const run = vi.fn(async (opts: any): Promise<SubagentResult> => ({
    role: opts.role,
    task: opts.task,
    status: "completed",
    findings: ["did the thing"],
    warnings: [],
    dataPaths: [],
    tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, turns: 1 },
    transcriptPath: "/tmp/transcript.jsonl",
  }));
  return { run } as any;
}

function parseResult(result: any): any {
  const text = result.content?.[0]?.text ?? "";
  return JSON.parse(text);
}

describe("delegate tool — redesigned API (issue #23)", () => {
  it("{description, prompt} with no subagent_type → general-purpose, succeeds", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());

    const result = await tool.execute("tc-1", {
      description: "read readme",
      prompt: "Read the first line of README.md and report it back.",
    } as any);

    expect(runner.run).toHaveBeenCalledTimes(1);
    const callArgs = runner.run.mock.calls[0][0];
    expect(callArgs.role).toBe("general-purpose");
    expect(callArgs.task).toContain("first line of README");
    expect(callArgs.roleConfigOverride).toBeDefined();
    expect(callArgs.roleConfigOverride.label).toBe("General-purpose");

    const parsed = parseResult(result);
    expect(parsed.status).toBe("completed");
  });

  it("{description, prompt, subagent_type:'designer'} → uses configured role", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());

    await tool.execute("tc-2", {
      description: "design device",
      prompt: "Design a Hall bar.",
      subagent_type: "designer",
    } as any);

    expect(runner.run).toHaveBeenCalledTimes(1);
    const callArgs = runner.run.mock.calls[0][0];
    expect(callArgs.role).toBe("designer");
    expect(callArgs.roleConfigOverride.label).toBe("Designer");
  });

  it("{subagent_type:'nonexistent'} → falls back to general-purpose with warning (not error)", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());

    const result = await tool.execute("tc-3", {
      description: "test fallback",
      prompt: "Do something.",
      subagent_type: "totally-made-up-role",
    } as any);

    expect(runner.run).toHaveBeenCalledTimes(1);
    const callArgs = runner.run.mock.calls[0][0];
    expect(callArgs.role).toBe("general-purpose");

    const parsed = parseResult(result);
    expect(parsed.status).toBe("completed");
    expect(parsed.warnings.some((w: string) => w.includes("totally-made-up-role"))).toBe(true);
    expect(parsed.warnings.some((w: string) => w.includes("general-purpose"))).toBe(true);
  });

  it("legacy {role, task} still works, emits deprecation warning", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());

    const result = await tool.execute("tc-4", {
      role: "designer",
      task: "Legacy call style.",
    } as any);

    expect(runner.run).toHaveBeenCalledTimes(1);
    const callArgs = runner.run.mock.calls[0][0];
    expect(callArgs.role).toBe("designer");
    expect(callArgs.task).toBe("Legacy call style.");

    const parsed = parseResult(result);
    expect(parsed.warnings.some((w: string) => /deprecated/i.test(w) && w.includes("task"))).toBe(true);
    expect(parsed.warnings.some((w: string) => /deprecated/i.test(w) && w.includes("role"))).toBe(true);
  });

  it("{} (no prompt and no task) → clear missing-parameter error, no runner.run call", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());

    const result = await tool.execute("tc-5", {
      description: "missing prompt",
    } as any);

    expect(runner.run).not.toHaveBeenCalled();
    expect(result.details.error).toBe(true);
    expect(result.content[0].text).toMatch(/missing required parameter.*prompt/i);
  });

  it("per-call model override is threaded through to runner.run", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());

    await tool.execute("tc-6", {
      description: "test model override",
      prompt: "Do thing.",
      model: "custom-anthropic/claude-opus-4-6",
    } as any);

    const callArgs = runner.run.mock.calls[0][0];
    expect(callArgs.modelOverride).toBe("custom-anthropic/claude-opus-4-6");
  });

  it("tool description lists every available subagent_type (catalog exposed to the agent)", () => {
    const cfg = makeSubagentCfg();
    cfg.roles.scout = {
      label: "Scout",
      promptFile: "subagent/scout.md",
      workspaceFiles: [],
      baseTools: ["read"],
      customTools: ["submit_result"],
      mcpAccess: "shared-readonly",
      maxTurns: 50,
      maxTokens: 100000,
    };
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, cfg);

    expect(tool.description).toContain("general-purpose");
    expect(tool.description).toContain("designer");
    expect(tool.description).toContain("Designer");       // label
    expect(tool.description).toContain("scout");
    expect(tool.description).toContain("Scout");
    expect(tool.description).toContain("mcp: full");       // designer's mcpAccess
    expect(tool.description).toContain("mcp: shared-readonly"); // scout's mcpAccess
    expect(tool.description).toMatch(/smart colleague/i);  // guidance preserved
  });

  // R2 finding #1: catalog must use the effective general-purpose role so
  // the agent never sees two contradictory lines for the same subagent_type.
  describe("R2 finding #1: catalog shows effective general-purpose, never double-lists", () => {
    function countOccurrences(hay: string, needle: string): number {
      let n = 0, idx = 0;
      while ((idx = hay.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
      return n;
    }

    it("empty config (no general-purpose override) → exactly one GP line with built-in capabilities", () => {
      const cfg: SubagentConfig = {
        enabled: true, logDir: "/tmp", maxLogFiles: 10, roles: {},
      };
      const runner = makeMockRunner();
      const tool = createDelegateTool(runner, cfg);

      const lines = tool.description.split("\n").filter((l) => l.startsWith("- general-purpose "));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("General-purpose");          // built-in label
      expect(lines[0]).toContain("read+bash+edit+write");     // built-in baseTools
      expect(lines[0]).toContain("mcp: full");                 // built-in mcpAccess
      expect(lines[0]).toContain("maxTurns: 30");              // built-in maxTurns
    });

    it("config with general-purpose override narrowing mcpAccess → ONE GP line with override values", () => {
      const cfg: SubagentConfig = {
        enabled: true, logDir: "/tmp", maxLogFiles: 10,
        roles: {
          "general-purpose": {
            label: "Narrow GP",
            promptFile: "",
            workspaceFiles: [],
            baseTools: ["read"],
            customTools: ["submit_result"],
            mcpAccess: "shared-readonly",
            maxTurns: 10,
            maxTokens: 50000,
            systemPrompt: "narrow",
          },
        },
      };
      const runner = makeMockRunner();
      const tool = createDelegateTool(runner, cfg);

      // Exactly ONE line for general-purpose
      const lines = tool.description.split("\n").filter((l) => l.startsWith("- general-purpose "));
      expect(lines.length).toBe(1);
      // Override values, not built-in defaults
      expect(lines[0]).toContain("Narrow GP");
      expect(lines[0]).toContain("tools: read");
      expect(lines[0]).toContain("mcp: shared-readonly");
      expect(lines[0]).toContain("maxTurns: 10");
      // Must NOT contain the built-in defaults
      expect(lines[0]).not.toContain("read+bash+edit+write");
      expect(lines[0]).not.toContain("General-purpose ");      // built-in label (space suffix avoids matching "general-purpose")
    });

    it("override + other roles → general-purpose once (with override), others once each", () => {
      const cfg: SubagentConfig = {
        enabled: true, logDir: "/tmp", maxLogFiles: 10,
        roles: {
          "general-purpose": {
            label: "Custom GP", promptFile: "", workspaceFiles: [],
            baseTools: ["read"], customTools: ["submit_result"],
            mcpAccess: "none", maxTurns: 5, maxTokens: 10000,
            systemPrompt: "x",
          },
          designer: {
            label: "Designer", promptFile: "subagent/designer.md", workspaceFiles: [],
            baseTools: ["read", "write"], customTools: ["submit_result"],
            mcpAccess: "full", maxTurns: 100, maxTokens: 200000,
          },
          scout: {
            label: "Scout", promptFile: "subagent/scout.md", workspaceFiles: [],
            baseTools: ["read"], customTools: ["submit_result"],
            mcpAccess: "shared-readonly", maxTurns: 50, maxTokens: 100000,
          },
        },
      };
      const runner = makeMockRunner();
      const tool = createDelegateTool(runner, cfg);

      // Exactly one line per role
      expect(countOccurrences(tool.description, "- general-purpose ")).toBe(1);
      expect(countOccurrences(tool.description, "- designer ")).toBe(1);
      expect(countOccurrences(tool.description, "- scout ")).toBe(1);
      // general-purpose shows override
      const gpLine = tool.description.split("\n").find((l) => l.startsWith("- general-purpose "))!;
      expect(gpLine).toContain("Custom GP");
      expect(gpLine).toContain("mcp: none");
      expect(gpLine).toContain("maxTurns: 5");
    });
  });
});
