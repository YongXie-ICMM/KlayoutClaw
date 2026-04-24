/**
 * Delegate tool — allows the parent agent to dispatch work to subagents.
 *
 * The tool schema mirrors Claude Code's Agent tool (description/prompt/
 * subagent_type/model). Legacy `role`/`task` parameters are still accepted
 * for one-release backward compatibility and emit a deprecation warning.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { SubagentConfig } from "../types/v04-contracts.js";
import type { SubagentRunner } from "../subagent/runner.js";
import type { PlanManager } from "../planning/index.js";
import { Type } from "@sinclair/typebox";
import {
  resolveRoleWithFallback,
  getEffectiveGeneralPurposeRole,
} from "../subagent/role-resolver.js";
import { GENERAL_PURPOSE_ROLE_NAME } from "../subagent/built-in/generalPurposeRole.js";

const DELEGATE_GUIDANCE = `Delegate a task to a subagent. Brief it like a smart colleague who just walked in — it hasn't seen this conversation, doesn't know what you've tried. Explain what you're trying to accomplish, what you've learned, and what specifically to do. Include file paths and line numbers. Never delegate understanding — don't write "based on your findings, implement it." Write prompts that prove you understood.`;

/**
 * Emit the `cancelled` lifecycle event on the runner when a delegate call
 * is rejected at the tool layer BEFORE runner.run (R3 finding #2). The
 * TUI's App.tsx subscribes to this event and clears the placeholder the
 * SubagentPanel created from tool_execution_start.
 *
 * Guarded so SubagentRunner mocks in tests (that may not extend EventEmitter)
 * still work.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitCancelled(runner: any, toolCallId: string, reason: string): void {
  if (typeof runner?.emit === "function") {
    // R6 finding #1: pi-agent-core delivers `tool_execution_start` on an async
    // EventStream, but execute() runs synchronously. A synchronous cancel
    // emission races ahead of the start subscriber — App.tsx dispatches
    // SUBAGENT_CANCEL_PLACEHOLDER for an id that hasn't been created yet
    // (no-op), then SUBAGENT_PLACEHOLDER lands and the row stays "running"
    // forever. Defer to the next microtask so the start event creates the
    // placeholder first; queueMicrotask is preferred over setImmediate
    // (predictable, runs before I/O, no event-loop tick).
    queueMicrotask(() => {
      runner.emit("cancelled", { toolCallId, reason });
    });
  }
}

/**
 * Format a single role entry for the catalog. Kept consistent with the
 * effective-general-purpose line so both paths render identically.
 */
function formatRoleEntry(
  name: string,
  role: import("../types/v04-contracts.js").RoleConfig,
): string {
  const tools = role.baseTools.length > 0 ? role.baseTools.join("+") : "none";
  return `- ${name} — ${role.label} (tools: ${tools} · mcp: ${role.mcpAccess} · maxTurns: ${role.maxTurns})`;
}

function buildDelegateDescription(config: SubagentConfig): string {
  // R2 finding #1: anything that shows the role to an agent must go through
  // the resolver. Use the effective general-purpose role (config override
  // wins over built-in) so the catalog matches what the runner will run.
  // Skip the general-purpose entry when iterating config.roles — it is
  // already listed above with the effective values, and double-listing
  // would show two contradictory lines.
  const effectiveGeneral = getEffectiveGeneralPurposeRole(config);
  const entries: string[] = [formatRoleEntry(GENERAL_PURPOSE_ROLE_NAME, effectiveGeneral)];
  for (const [name, r] of Object.entries(config.roles)) {
    if (name === GENERAL_PURPOSE_ROLE_NAME) continue;
    entries.push(formatRoleEntry(name, r));
  }
  return `${DELEGATE_GUIDANCE}

Available subagent_type values:
${entries.join("\n")}

Parameters:
- description: 3-5 word task summary
- prompt: full briefing for the subagent
- subagent_type: (optional) one of the values above; omit for "general-purpose"
- model: (optional) model override, e.g. "custom-anthropic/claude-sonnet-4-6"`;
}

interface DelegateParams {
  description?: string;
  prompt?: string;
  subagent_type?: string;
  model?: string;
  role?: string;   // legacy
  task?: string;   // legacy
  context?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDelegateTool(
  runner: SubagentRunner,
  config: SubagentConfig,
  parentPlanManager?: PlanManager,
): AgentTool<any> {
  return {
    name: "delegate",
    label: "delegate",
    description: buildDelegateDescription(config),
    // R4 finding #1: `prompt` is runtime-required (execute() rejects calls
    // without prompt OR task), but the on-the-wire JSON Schema still marks
    // every field optional. Option B (Type.Union at the root) was rejected
    // after verifying that the anthropic-messages translator
    // (node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:669-678)
    // extracts only `.properties` and `.required` from the root object and
    // drops unions — a `Type.Union` root would be serialised as `{type:
    // "object", properties: {}, required: []}`, which is worse than today.
    // Option A (mark `prompt` required at the schema) would break legacy
    // `{role, task}` callers during the deprecation window.
    // Going with Option C: keep both optional, surface the runtime contract
    // in the field descriptions so parent models reading the schema learn
    // what's expected. execute() remains the single source of truth for the
    // either-or constraint.
    parameters: Type.Object({
      description: Type.Optional(Type.String({ description: "A short (3-5 word) description of the task" })),
      prompt: Type.Optional(Type.String({
        description:
          "REQUIRED (unless the deprecated `task` field is provided). The task briefing for the subagent. Brief it like a smart colleague who just walked in — include file paths, line numbers, what specifically to do.",
      })),
      subagent_type: Type.Optional(Type.String({ description: "Specialized subagent role. Omit for 'general-purpose'." })),
      model: Type.Optional(Type.String({ description: "Optional model override. Format: provider/model-id." })),
      role: Type.Optional(Type.String({ description: "(Deprecated) Use `subagent_type`. Accepted as a fallback if `subagent_type` is absent." })),
      task: Type.Optional(Type.String({
        description:
          "(Deprecated) Use `prompt` instead. Accepted as a fallback only when `prompt` is absent; the delegate call requires either `prompt` or `task`.",
      })),
      context: Type.Optional(Type.String({ description: "Optional extra context" })),
    }),
    async execute(
      toolCallId: string,
      params: DelegateParams,
    ): Promise<AgentToolResult<any>> {
      // Plan-mode gate (spec §9 step 8): block subagent dispatch when the
      // parent is in plan mode so subagents cannot escape the sandbox.
      if (parentPlanManager?.inPlanMode === true) {
        // R3 finding #2: the TUI already created a placeholder from
        // tool_execution_start. Emit `cancelled` so App.tsx can clear it —
        // otherwise the panel shows a phantom "running" row forever.
        emitCancelled(runner, toolCallId, "plan_mode_restricted");
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "plan_mode_restricted",
              tool: "delegate",
              message: "Cannot spawn a subagent during plan mode — subagents would bypass the sandbox. Exit plan mode first.",
            }),
          }],
          details: { error: true, planModeRestricted: true },
        };
      }

      // Resolve effective prompt / role with legacy compat.
      const effectivePrompt = params.prompt ?? params.task;
      const effectiveRole = params.subagent_type ?? params.role ?? GENERAL_PURPOSE_ROLE_NAME;
      const legacyTaskUsed = params.prompt === undefined && params.task !== undefined;
      const legacyRoleUsed = params.subagent_type === undefined && params.role !== undefined;

      if (!effectivePrompt || typeof effectivePrompt !== "string" || effectivePrompt.trim().length === 0) {
        // R3 finding #2: same phantom-placeholder concern as above.
        emitCancelled(runner, toolCallId, "missing_prompt");
        return {
          content: [{
            type: "text" as const,
            text: "Error: missing required parameter 'prompt' (a non-empty task briefing for the subagent).",
          }],
          details: { error: true, reason: "missing_prompt" },
        };
      }

      const resolved = resolveRoleWithFallback(effectiveRole, config);

      // Run the subagent
      const result = await runner.run({
        role: resolved.effectiveName,
        task: effectivePrompt,
        toolCallId,
        context: params.context,
        modelOverride: params.model,
        roleConfigOverride: resolved.role,
      });

      // Accumulate tool-level warnings (legacy-usage, role-fallback) onto the
      // returned result so the parent sees them without mutating the runner.
      const extraWarnings: string[] = [...(result.warnings ?? [])];
      if (resolved.warning) extraWarnings.push(resolved.warning);
      if (legacyTaskUsed) extraWarnings.push("delegate: 'task' is deprecated — use 'prompt'.");
      if (legacyRoleUsed) extraWarnings.push("delegate: 'role' is deprecated — use 'subagent_type'.");
      const annotated = { ...result, warnings: extraWarnings };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(annotated, null, 2),
        }],
        details: annotated,
      };
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as AgentTool<any>;
}
