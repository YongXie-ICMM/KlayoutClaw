/**
 * Plan-mode sandbox wrappers (v0.4.3, spec §1.4 + §1.5).
 *
 * Ports qdevbot's three base-tool wrappers (`wrapWriteForPlanMode`,
 * `wrapEditForPlanMode`, `wrapBashForPlanMode`) plus the MCP-tool wrapper
 * `wrapMCPToolForPlanMode` and its blocked-result constructor
 * `planModeBlockedTool`. The path predicate `isInsidePlansDir` is
 * symlink-safe (realpath-walked) — a qlaybot hardening over qdevbot.
 */

import {
  basename,
  dirname,
  join,
  normalize,
  resolve,
} from "path";
import * as fs from "fs";
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import { canonicalToolName, getReadOnlyForPlanMode } from "../tools/annotations.js";
import type { PlanManager } from "./index.js";

// =========================================================================
// v0.4.3 surface (spec §1.4 + §1.5)
// =========================================================================

/** Literal hint string required by spec §1.4 — must match EXACTLY. */
const PLAN_MODE_HINT =
  "You are in plan mode. Only the plan file can be modified. Use exit_plan_mode to leave plan mode first.";

/** Build a rejection result for plan-mode base-tool sandbox violations. */
function blocked(reason: string): AgentToolResult<any> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "plan_mode_restricted",
          message: reason,
          hint: PLAN_MODE_HINT,
        }),
      },
    ],
    details: {},
  };
}

/**
 * Resolve `p` to its realpath by walking up to the first ancestor that exists,
 * realpath'ing THAT, then re-appending the unresolved tail. This closes the
 * symlink-escape hole that plain `normalize+resolve+startsWith` leaves open
 * — e.g. `plans/link → /etc` would masquerade as inside plans.
 */
function realpathUpwards(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding an existing ancestor.
      break;
    }
    tail.unshift(basename(current));
    current = parent;
  }
  const real = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return tail.length ? join(real, ...tail) : real;
}

/**
 * Symlink-safe predicate: is `filePath` inside `plansDir`?
 *
 * Rejects both absolute and relative paths that escape the plans directory
 * even when the escape happens via symlink (T36/T37 coverage). `plansDir`
 * MUST exist at the time of the check — callers ensure this by entering
 * plan mode through `enterPlanMode` which `mkdirSync`s the directory.
 */
function isInsidePlansDir(
  filePath: string,
  plansDir: string,
  cwd: string,
): boolean {
  const candidate = normalize(resolve(cwd, filePath));
  const plansAbs = normalize(resolve(cwd, plansDir));

  const realCandidate = realpathUpwards(candidate);
  // plansDir is expected to exist at check time; if it somehow doesn't, fall
  // back to the normalized form rather than crashing — the predicate still
  // behaves correctly (just without the extra symlink-chase on plansDir
  // itself).
  const realPlans = fs.existsSync(plansAbs)
    ? fs.realpathSync(plansAbs)
    : plansAbs;

  return (
    realCandidate === realPlans ||
    realCandidate.startsWith(realPlans + "/")
  );
}

/**
 * Wrap the `write` tool so it only writes to the plans directory during
 * plan mode. Outside plan mode the wrapper is a no-op.
 */
export function wrapWriteForPlanMode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: AgentTool<any, any>,
  planManager: PlanManager,
  cwd: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any, any> {
  const originalExecute = tool.execute.bind(tool);

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
      signal?: AbortSignal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onUpdate?: AgentToolUpdateCallback<any>,
    ) => {
      if (planManager.inPlanMode) {
        const filePath: string = params?.path || params?.file_path || "";
        if (!isInsidePlansDir(filePath, planManager.plansDir, cwd)) {
          return blocked(
            `Cannot write to "${filePath}" during plan mode. ` +
              `Only files inside ${planManager.plansDir}/ can be modified.`,
          );
        }
      }
      return originalExecute(toolCallId, params, signal, onUpdate);
    },
  };
}

/** Wrap the `edit` tool with the same predicate but different phrasing. */
export function wrapEditForPlanMode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: AgentTool<any, any>,
  planManager: PlanManager,
  cwd: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any, any> {
  const originalExecute = tool.execute.bind(tool);

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
      signal?: AbortSignal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onUpdate?: AgentToolUpdateCallback<any>,
    ) => {
      if (planManager.inPlanMode) {
        const filePath: string = params?.path || params?.file_path || "";
        if (!isInsidePlansDir(filePath, planManager.plansDir, cwd)) {
          return blocked(
            `Cannot edit "${filePath}" during plan mode. ` +
              `Only files inside ${planManager.plansDir}/ can be modified.`,
          );
        }
      }
      return originalExecute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Wrap the `bash` tool to block execution during plan mode.
 * Rationale: reliably distinguishing read-only commands from destructive
 * ones is not feasible (pipes, subshells, aliases, etc.) so bash is fully
 * blocked during plan mode.
 */
export function wrapBashForPlanMode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: AgentTool<any, any>,
  planManager: PlanManager,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any, any> {
  const originalExecute = tool.execute.bind(tool);

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
      signal?: AbortSignal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onUpdate?: AgentToolUpdateCallback<any>,
    ) => {
      if (planManager.inPlanMode) {
        return blocked(
          "Bash is not available during plan mode. " +
            "Use read to inspect files, or the KLayout readonly tools.",
        );
      }
      return originalExecute(toolCallId, params, signal, onUpdate);
    },
  };
}

// =========================================================================
// MCP tool sandbox (spec §1.5)
// =========================================================================

/**
 * Build a rejection result for a blocked MCP tool. Shape matches spec §1.5:
 * `{error, tool, reasons, message, hint}` serialized as the text content.
 */
export function planModeBlockedTool(
  name: string,
  reasons: string[],
): AgentToolResult<any> {
  const reasonText = reasons.join(", ");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "plan_mode_restricted",
          tool: name,
          reasons,
          message: `Tool "${name}" is blocked during plan mode. Only readonly tools are allowed. Reasons: ${reasonText}.`,
          hint: "Use exit_plan_mode to leave plan mode. To inspect a tool's annotation classification, check src/tools/annotations.ts.",
        }),
      },
    ],
    details: {},
  };
}

/**
 * Wrap an MCP-backed tool so that in plan mode only annotations with
 * `readonly: true` pass through. Annotations with `readwrite: true` and
 * tools with no annotation entry are blocked (deny-by-default).
 */
export function wrapMCPToolForPlanMode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool: AgentTool<any, any>,
  planManager: PlanManager,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any, any> {
  const originalExecute = tool.execute.bind(tool);

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
      signal?: AbortSignal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onUpdate?: AgentToolUpdateCallback<any>,
    ) => {
      if (planManager.inPlanMode) {
        const { allowed, reasons } = getReadOnlyForPlanMode(tool.name);
        if (!allowed) {
          return planModeBlockedTool(tool.name, reasons);
        }
      }
      return originalExecute(toolCallId, params, signal, onUpdate);
    },
  };
}

// Re-export for convenience (some callers may want the canonical-name
// helper alongside the wrappers without reaching into annotations.ts).
export { canonicalToolName };
