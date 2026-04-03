/**
 * Comprehensive test suite for ALL reviewer findings from the 5-reviewer audit.
 * Each test targets a specific gap discovered by the code reviewers.
 * All tests should FAIL against the current (buggy) code and PASS once fixed.
 *
 * Findings tested:
 *   R1:  runner.ts session.subscribe() uses wrong 2-arg API (CRITICAL)
 *   R2:  runner.ts model passed as string not Model<any> (CRITICAL - already fixed, regression test)
 *   R3:  runner.ts AgentSession missing modelRegistry (HIGH - already fixed, regression test)
 *   R4:  App.tsx ConfigPanel missing mcpServers/configDir (MEDIUM - already fixed, regression test)
 *   R5:  SubagentPanel kill dispatch never calls runner.kill() (CRITICAL)
 *   R6:  SubagentPanel inject mode has no keyboard handler (CRITICAL)
 *   R7:  FOCUS_ESCAPE from inject goes to summary, spec says inspect (MEDIUM)
 *   R8:  reducer MCP tool toggle is no-op (MEDIUM)
 *   R9:  SLASH_COMMANDS missing "setup" subcommand (LOW)
 *   R10: validateRoles missing label/baseTools checks (LOW)
 *   R11: Delegation prompt ignores subagent.enabled flag (INFO→LOW)
 *   R12: useCommandHistory saveCommandRecency never called (MEDIUM)
 *   R13: SubagentPanel useInput missing isActive guard (HIGH)
 *   R14: ConfigPanel useInput missing isActive guard (HIGH)
 *   R15: tool-factory ignores disabledTools from config (HIGH)
 *   R16: /config show missing search/embedding display (LOW)
 *   R17: assembleTools silent base tool failure in extended path (MEDIUM)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function srcFile(relPath: string): string {
  return readFileSync(join(__dirname, "..", "src", relPath), "utf-8");
}

// ============================================================
// R1: runner.ts session.subscribe() must use single-callback API
// The real AgentSession.subscribe() takes one listener callback
// that receives {type: "message_update"|"tool_execution_start"|...}
// NOT the 2-arg session.subscribe("event_name", callback) pattern.
// ============================================================

describe("R1: SubagentRunner subscribe API", () => {
  it("runner.ts must NOT use 2-arg session.subscribe('event', cb) pattern", () => {
    const src = srcFile("subagent/runner.ts");
    // The WRONG pattern: session.subscribe("thinking", ...) etc.
    // Each of these indicates the wrong 2-arg API is being used.
    const wrongPattern = /session\.subscribe\(\s*["']/;
    expect(src).not.toMatch(wrongPattern);
  });

  it("runner.ts must use single-callback session.subscribe((event) => ...) pattern", () => {
    const src = srcFile("subagent/runner.ts");
    // The CORRECT pattern: session.subscribe((event: any) => { ... }) or session.subscribe(listener)
    // Must have a single-arg subscribe call that dispatches on event.type
    const correctPattern = /session\.subscribe\(\s*\((?:event|ev|e)(?:\s*:\s*\w+)?\)/;
    expect(src).toMatch(correctPattern);
  });

  it("runner.ts subscribe handler must dispatch on event.type for known event types", () => {
    const src = srcFile("subagent/runner.ts");
    // The handler must handle at least message_update and tool_execution_start/end
    expect(src).toContain("message_update");
    expect(src).toContain("tool_execution_start");
    expect(src).toContain("tool_execution_end");
  });
});

// ============================================================
// R2: runner.ts model must be Model<any>, not string (regression)
// ============================================================

describe("R2: SubagentRunner model resolution (regression)", () => {
  it("runner.ts must resolve model via modelRegistry.find(), not pass raw string", () => {
    const src = srcFile("subagent/runner.ts");
    // Must call modelRegistry.find (or deps.modelRegistry.find)
    expect(src).toMatch(/modelRegistry\.find/);
  });

  it("runner.ts SubagentRunnerDeps must include modelRegistry", () => {
    const src = srcFile("subagent/runner.ts");
    // Check the interface block contains modelRegistry (accounting for nested braces)
    expect(src).toContain("export interface SubagentRunnerDeps");
    // Between the interface declaration and the class declaration, modelRegistry must appear
    const afterDeps = src.split("export interface SubagentRunnerDeps")[1] ?? "";
    const beforeClass = afterDeps.split("export class SubagentRunner")[0] ?? "";
    expect(beforeClass).toContain("modelRegistry");
  });

  it("runner.ts Agent initialState.model must not be a raw string variable", () => {
    const src = srcFile("subagent/runner.ts");
    // The initialState block should NOT have model: modelId (a string)
    // It should have model: resolvedModel or similar
    const initStateMatch = src.match(/initialState:\s*\{([\s\S]*?)\}/);
    expect(initStateMatch).toBeTruthy();
    const initBlock = initStateMatch![1];
    // Must NOT assign modelId directly
    expect(initBlock).not.toMatch(/model:\s*modelId\b/);
  });
});

// ============================================================
// R3: runner.ts AgentSession must include modelRegistry (regression)
// ============================================================

describe("R3: SubagentRunner AgentSession config (regression)", () => {
  it("runner.ts AgentSession construction must include modelRegistry", () => {
    const src = srcFile("subagent/runner.ts");
    // Find the AgentSession constructor call and verify modelRegistry is passed
    const sessionConstruction = src.match(
      /new\s*(?:\(AgentSession\s*as\s*any\)|AgentSession)\s*\(\{([\s\S]*?)\}\)/,
    );
    expect(sessionConstruction).toBeTruthy();
    expect(sessionConstruction![1]).toContain("modelRegistry");
  });
});

// ============================================================
// R4: App.tsx must pass mcpServers and configDir to ConfigPanel (regression)
// ============================================================

describe("R4: ConfigPanel props wiring (regression)", () => {
  it("App.tsx must pass mcpServers prop to ConfigPanel", () => {
    const src = srcFile("tui/components/App.tsx");
    expect(src).toMatch(/mcpServers=\{/);
  });

  it("App.tsx must pass configDir prop to ConfigPanel", () => {
    const src = srcFile("tui/components/App.tsx");
    expect(src).toMatch(/configDir=\{/);
  });

  it("App.tsx must build mcpServers data from mcpManager", () => {
    const src = srcFile("tui/components/App.tsx");
    // Must compute server data with keys, connected status, tools
    expect(src).toContain("mcpManager");
    expect(src).toContain("isConnected");
  });
});

// ============================================================
// R5: SubagentPanel kill/inject must call runner methods, not just dispatch
// ============================================================

describe("R5: SubagentPanel runner method wiring", () => {
  it("App.tsx must wire SUBAGENT_KILL action to runner.kill()", () => {
    const src = srcFile("tui/components/App.tsx");
    // Must have a handler that calls runner.kill when kill action is dispatched
    // Either via useEffect watching state, or direct handler
    expect(src).toMatch(/runner\.kill|subagentRunner\.kill/);
  });

  it("App.tsx must wire SUBAGENT_INJECT to runner.inject()", () => {
    const src = srcFile("tui/components/App.tsx");
    expect(src).toMatch(/runner\.inject|subagentRunner\.inject/);
  });

  it("App.tsx or SubagentPanel must support runner.pause()", () => {
    const appSrc = srcFile("tui/components/App.tsx");
    const panelSrc = srcFile("tui/components/SubagentPanel.tsx");
    // pause() is a SubagentRunner method — must be callable from somewhere
    const hasPause =
      appSrc.includes("runner.pause") ||
      appSrc.includes("subagentRunner.pause") ||
      panelSrc.includes("SUBAGENT_PAUSE");
    expect(hasPause).toBe(true);
  });
});

// ============================================================
// R6: SubagentPanel inject mode must have keyboard handler
// ============================================================

describe("R6: SubagentPanel inject mode keyboard handling", () => {
  it("SubagentPanel useInput must handle subagent-inject focus state", () => {
    const src = srcFile("tui/components/SubagentPanel.tsx");
    // The useInput handler must include a branch for "subagent-inject"
    expect(src).toContain('"subagent-inject"');
    // Must handle typing (character input), Enter (submit), and cancellation
    // At minimum, must have an else-if or case for inject mode in useInput
    const useInputBlock = src.match(/useInput\(\s*\([\s\S]*?\}\s*\)/);
    expect(useInputBlock).toBeTruthy();
    expect(useInputBlock![0]).toContain("subagent-inject");
  });

  it("SubagentPanel must handle Enter key in inject mode to submit message", () => {
    const src = srcFile("tui/components/SubagentPanel.tsx");
    // Must dispatch SUBAGENT_INJECT_SUBMIT or similar on Enter in inject mode
    expect(src).toMatch(/SUBAGENT_INJECT_SUBMIT|SUBAGENT_INJECT_SEND/);
  });
});

// ============================================================
// R7: FOCUS_ESCAPE from inject must go to inspect, not summary
// ============================================================

describe("R7: FOCUS_ESCAPE from inject navigation", () => {
  it("reducer FOCUS_ESCAPE from subagent-inject must transition to subagent-inspect", () => {
    const src = srcFile("tui/reducer.ts");
    // Find the FOCUS_ESCAPE case for subagent-inject
    const focusEscapeBlock = src.match(
      /case "FOCUS_ESCAPE":([\s\S]*?)(?=case "|default:)/,
    );
    expect(focusEscapeBlock).toBeTruthy();
    const block = focusEscapeBlock![1];

    // The subagent-inject handler must set focusState to "subagent-inspect"
    const injectEscapeMatch = block.match(
      /subagent-inject[\s\S]*?focusState:\s*["']([^"']+)["']/,
    );
    expect(injectEscapeMatch).toBeTruthy();
    expect(injectEscapeMatch![1]).toBe("subagent-inspect");
  });
});

// ============================================================
// R8: reducer MCP tool toggle must update state, not be no-op
// ============================================================

describe("R8: MCP tool toggle state update", () => {
  it("CONFIG_PANEL_MCP_TOGGLE_TOOL reducer must update toggle state", () => {
    const src = srcFile("tui/reducer.ts");
    const toggleBlock = src.match(
      /case "CONFIG_PANEL_MCP_TOGGLE_TOOL":([\s\S]*?)(?=case "|default:)/,
    );
    expect(toggleBlock).toBeTruthy();
    // Must NOT just return state unchanged
    expect(toggleBlock![1]).not.toMatch(/^\s*\/\/.*\n\s*return state;/m);
    // Must produce a new state object
    expect(toggleBlock![1]).toMatch(/\.\.\.\s*state|return\s*\{/);
  });
});

// ============================================================
// R9: SLASH_COMMANDS must include "setup" subcommand for /config
// ============================================================

describe("R9: SLASH_COMMANDS completeness", () => {
  it("/config SLASH_COMMANDS entry must include 'setup' subcommand", () => {
    const src = srcFile("tui/commands.ts");
    const configEntry = src.match(
      /\{\s*name:\s*"config"[^}]*subcommands:\s*\[([^\]]*)\]/,
    );
    expect(configEntry).toBeTruthy();
    expect(configEntry![1]).toContain('"setup"');
  });
});

// ============================================================
// R10: validateRoles must check label and baseTools
// ============================================================

describe("R10: validateRoles completeness", () => {
  it("validateRoles must check for missing label", () => {
    const src = srcFile("subagent/role-resolver.ts");
    const validateBody = src.match(
      /function validateRoles[\s\S]*?return errors;/,
    );
    expect(validateBody).toBeTruthy();
    expect(validateBody![0]).toContain("label");
  });

  it("validateRoles must check for missing baseTools", () => {
    const src = srcFile("subagent/role-resolver.ts");
    const validateBody = src.match(
      /function validateRoles[\s\S]*?return errors;/,
    );
    expect(validateBody).toBeTruthy();
    expect(validateBody![0]).toContain("baseTools");
  });
});

// ============================================================
// R11: Delegation section must check subagent.enabled
// ============================================================

describe("R11: Delegation prompt enabled check", () => {
  it("buildDelegationSection or caller must check config.enabled before emitting", () => {
    const delegationSrc = srcFile("prompts/sections/delegation.ts");
    const promptsSrc = srcFile("prompts/index.ts");

    // Either buildDelegationSection checks config.enabled,
    // or the caller in prompts/index.ts checks subagentConfig.enabled
    const checksEnabled =
      delegationSrc.includes(".enabled") ||
      promptsSrc.match(/subagentConfig\.enabled|subagentConfig\?\.enabled/);
    expect(checksEnabled).toBeTruthy();
  });
});

// ============================================================
// R12: saveCommandRecency must be called after command execution
// ============================================================

describe("R12: command recency persistence", () => {
  it("App.tsx must call saveCommandRecency after command execution", () => {
    const src = srcFile("tui/components/App.tsx");
    expect(src).toContain("saveCommandRecency");
  });

  it("App.tsx must import saveCommandRecency", () => {
    const src = srcFile("tui/components/App.tsx");
    expect(src).toMatch(/import.*saveCommandRecency/);
  });
});

// ============================================================
// R13: SubagentPanel useInput must have isActive guard
// ============================================================

describe("R13: SubagentPanel useInput isActive guard", () => {
  it("SubagentPanel useInput must pass isActive option to prevent stale key handling", () => {
    const src = srcFile("tui/components/SubagentPanel.tsx");
    // useInput must have isActive option somewhere in its call
    expect(src).toContain("isActive");
    // Must be passed as second arg to useInput: }, { isActive ... })
    expect(src).toMatch(/\},\s*\{\s*isActive/);
  });
});

// ============================================================
// R14: ConfigPanel useInput must have isActive guard
// ============================================================

describe("R14: ConfigPanel useInput isActive guard", () => {
  it("ConfigPanel useInput must pass isActive option", () => {
    const src = srcFile("tui/components/ConfigPanel.tsx");
    expect(src).toContain("isActive");
    expect(src).toMatch(/\},\s*\{\s*isActive/);
  });
});

// ============================================================
// R15: tool-factory must respect disabledTools from config
// ============================================================

describe("R15: tool-factory disabledTools", () => {
  it("SubagentRunnerDeps or tool-factory must accept disabledTools", () => {
    const runnerSrc = srcFile("subagent/runner.ts");
    const factorySrc = srcFile("subagent/tool-factory.ts");
    // Either the runner deps or the tool factory deps must include disabledTools
    const hasDisabledTools =
      runnerSrc.includes("disabledTools") ||
      factorySrc.includes("disabledTools");
    expect(hasDisabledTools).toBe(true);
  });

  it("tool-factory must filter out disabled tools when creating MCP proxies", () => {
    const src = srcFile("subagent/tool-factory.ts");
    // Must check disabled status and exclude disabled tools
    expect(src).toContain("disabled");
  });
});

// ============================================================
// R16: /config show must display search and embedding settings
// ============================================================

describe("R16: /config show completeness", () => {
  it("/config show must display search.mode", () => {
    const src = srcFile("commands/config.ts");
    const showBlock = src.match(
      /case "show":([\s\S]*?)(?=case "|break;)/,
    );
    expect(showBlock).toBeTruthy();
    expect(showBlock![1]).toContain("search");
  });

  it("/config show must display embedding settings", () => {
    const src = srcFile("commands/config.ts");
    const showBlock = src.match(
      /case "show":([\s\S]*?)(?=case "|break;)/,
    );
    expect(showBlock).toBeTruthy();
    expect(showBlock![1]).toContain("embedding");
  });
});

// ============================================================
// R17: assembleTools extended path must not silently swallow base tool failures
// ============================================================

describe("R17: assembleTools base tool error handling", () => {
  it("assembleTools extended path must log base tool creation errors, not silently swallow", () => {
    const src = srcFile("tools/index.ts");
    // Find the extended signature implementation block (has opts.config)
    const extendedBlock = src.match(
      /if \(opts\.config\)([\s\S]*?)\/\/ Legacy signature/,
    );
    expect(extendedBlock).toBeTruthy();
    const block = extendedBlock![1];

    // The catch block must include logging (console.warn or console.error), not be empty
    const hasCatchWithLogging = /catch[\s\S]*?console\.(warn|error)/.test(block);
    expect(hasCatchWithLogging).toBe(true);
  });
});
