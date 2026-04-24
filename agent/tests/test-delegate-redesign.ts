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

// ---------------------------------------------------------------------------
// R3 finding #1: delegate tool must be registered whenever
// `config.subagent.enabled === true`, regardless of `roles` count. Before this
// fix a pre-redesign `Object.keys(roles).length > 0` gate suppressed delegate
// on fresh-install configs (which ship with roles:{}), making the built-in
// general-purpose fallback unreachable.
// ---------------------------------------------------------------------------
import { assembleTools } from "../src/tools/index.js";
import { TOOL_ANNOTATIONS } from "../src/tools/annotations.js";

describe("R3 finding #1: delegate registration gate", () => {
  function makeMockMcpManager() {
    return {
      allTools: () => [],
      callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    } as any;
  }
  function makeMockMemoryManager() {
    return { save: async () => {}, search: async () => [] } as any;
  }
  function makeMockModelRegistry() {
    return {
      find: () => ({ id: "mock", provider: "mock", api: "anthropic-messages" }),
    } as any;
  }
  function makeFullConfig(subagent: SubagentConfig) {
    return {
      subagent,
      agent: { defaultModel: "custom-anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
    } as any;
  }
  function baseAssembleOpts(subagent: SubagentConfig) {
    return {
      config: makeFullConfig(subagent),
      mcpManager: makeMockMcpManager(),
      memoryManager: makeMockMemoryManager(),
      cwd: "/tmp",
      workspaceDir: "/tmp",
      annotations: TOOL_ANNOTATIONS,
      getApiKey: async () => "test-key",
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      defaultThinkingLevel: "medium",
      modelRegistry: makeMockModelRegistry(),
      isSubagent: false,
    };
  }

  it("enabled:true, roles:{} (fresh install) → delegate IS registered (was broken)", () => {
    const subagent: SubagentConfig = { enabled: true, logDir: "/tmp", maxLogFiles: 10, roles: {} };
    const { toolMap, runner } = assembleTools(baseAssembleOpts(subagent) as any);
    expect(toolMap.delegate).toBeDefined();
    expect(runner).not.toBeNull();
  });

  it("enabled:true, roles:{designer:...} → delegate IS registered (regression)", () => {
    const subagent: SubagentConfig = {
      enabled: true, logDir: "/tmp", maxLogFiles: 10,
      roles: {
        designer: {
          label: "Designer", promptFile: "subagent/designer.md", workspaceFiles: [],
          baseTools: ["read", "write"], customTools: ["submit_result"],
          mcpAccess: "full", maxTurns: 100, maxTokens: 200000,
        },
      },
    };
    const { toolMap, runner } = assembleTools(baseAssembleOpts(subagent) as any);
    expect(toolMap.delegate).toBeDefined();
    expect(runner).not.toBeNull();
  });

  it("enabled:false, roles:{} → delegate is NOT registered", () => {
    const subagent: SubagentConfig = { enabled: false, logDir: "/tmp", maxLogFiles: 10, roles: {} };
    const { toolMap, runner } = assembleTools(baseAssembleOpts(subagent) as any);
    expect(toolMap.delegate).toBeUndefined();
    expect(runner).toBeNull();
  });

  it("enabled:false, roles:{designer:...} → delegate is NOT registered (respect explicit disable)", () => {
    const subagent: SubagentConfig = {
      enabled: false, logDir: "/tmp", maxLogFiles: 10,
      roles: {
        designer: {
          label: "Designer", promptFile: "subagent/designer.md", workspaceFiles: [],
          baseTools: ["read", "write"], customTools: ["submit_result"],
          mcpAccess: "full", maxTurns: 100, maxTokens: 200000,
        },
      },
    };
    const { toolMap, runner } = assembleTools(baseAssembleOpts(subagent) as any);
    expect(toolMap.delegate).toBeUndefined();
    expect(runner).toBeNull();
  });

  it("end-to-end: enabled:true + empty roles → agent can delegate to general-purpose via the registered tool", async () => {
    const subagent: SubagentConfig = { enabled: true, logDir: "/tmp", maxLogFiles: 10, roles: {} };
    const { toolMap, runner } = assembleTools(baseAssembleOpts(subagent) as any);
    const delegateTool = toolMap.delegate;
    expect(delegateTool).toBeDefined();

    // Stub runner.run so we don't exercise the real subagent pipeline — only
    // verify the delegate tool dispatches to general-purpose with empty roles.
    let captured: any = null;
    (runner as any).run = async (opts: any) => {
      captured = opts;
      return {
        role: opts.role, task: opts.task, status: "completed",
        findings: ["ok"], warnings: [], dataPaths: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
        transcriptPath: "",
      };
    };

    const result = await (delegateTool as any).execute("tc-fresh-install", {
      description: "fresh install",
      prompt: "Do a simple read.",
    });
    expect(captured).not.toBeNull();
    expect(captured.role).toBe("general-purpose");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// R4 finding #1: schema contract matches runtime contract.
//
// Option B (Type.Union) is not viable on the anthropic-messages translator
// (it strips unions to {properties:{}, required:[]}), so we use Option C:
// keep both `prompt` and `task` optional at the schema but surface the
// either-or runtime requirement in the field descriptions. execute() remains
// the single source of truth for the actual validation.
// ---------------------------------------------------------------------------
describe("R4 finding #1: delegate schema surfaces runtime contract", () => {
  it("schema: `prompt` description explicitly says REQUIRED (Option C)", () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());
    const props = (tool.parameters as any).properties;
    expect(props.prompt).toBeDefined();
    expect(props.prompt.description).toMatch(/REQUIRED/i);
    expect(props.prompt.description).toMatch(/task/i);
  });

  it("schema: `task` description marks it deprecated + fallback-only for either-or contract", () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());
    const props = (tool.parameters as any).properties;
    expect(props.task).toBeDefined();
    expect(props.task.description).toMatch(/deprecated/i);
    expect(props.task.description).toMatch(/prompt/i);
  });

  it("runtime regression: new schema {description, prompt} still succeeds", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());
    await tool.execute("tc-R4F1-new", {
      description: "read a file",
      prompt: "Read README.md and report the first line.",
    } as any);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run.mock.calls[0][0].task).toContain("README");
  });

  it("runtime regression: legacy {role, task} still succeeds with deprecation warning", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());
    const result = await tool.execute("tc-R4F1-legacy", {
      role: "designer",
      task: "Legacy call style.",
    } as any);
    expect(runner.run).toHaveBeenCalledTimes(1);
    const parsed = parseResult(result);
    expect(parsed.warnings.some((w: string) => /deprecated/i.test(w))).toBe(true);
  });

  it("runtime regression: both missing → clear missing_prompt error, no runner.run call", async () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());
    const result = await tool.execute("tc-R4F1-missing", {
      description: "broken",
    } as any);
    expect(runner.run).not.toHaveBeenCalled();
    expect(result.details.error).toBe(true);
    expect(result.content[0].text).toMatch(/missing required parameter.*prompt/i);
  });

  it("root schema is Type.Object (not Type.Union) so anthropic-messages translator can serialise it", () => {
    const runner = makeMockRunner();
    const tool = createDelegateTool(runner, makeSubagentCfg());
    const schema: any = tool.parameters;
    // The root must be a plain object schema with `properties` so that
    // anthropic.js's convertTools (line 669-678) produces a non-empty
    // input_schema. A Type.Union at the root would surface as `anyOf` and
    // get stripped to {properties:{}, required:[]} by the translator.
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  });
});
