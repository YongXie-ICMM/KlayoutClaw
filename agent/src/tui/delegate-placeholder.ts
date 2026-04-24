/**
 * Parse the delegate tool's `tool_execution_start` args into the fields the
 * subagent TUI placeholder needs. Shared between `App.tsx` and unit tests.
 *
 * The reducer's SUBAGENT_PLACEHOLDER action is idempotent — once an entry
 * exists for a toolCallId it is not overwritten, so these values must be
 * correct on the first dispatch. The delegate tool (issue #23) accepts both
 * the new schema (`subagent_type` / `prompt`) and legacy (`role` / `task`);
 * prefer the new names but fall back so legacy callers still produce a
 * meaningful placeholder.
 *
 * R2 finding #2: the `role` field must be the EFFECTIVE name the runner
 * will run with, not the raw string the agent passed. Unknown
 * subagent_type values fall back to "general-purpose" in the runner; the
 * TUI must show the same thing. Translation goes through
 * resolveEffectiveRoleName so the UI and the runner agree.
 */
import type { SubagentConfig } from "../types/v04-contracts.js";
import { resolveEffectiveRoleName } from "../subagent/role-resolver.js";

export interface DelegatePlaceholderFields {
  role: string;
  task: string;
}

export function parseDelegatePlaceholder(
  args: unknown,
  config: SubagentConfig,
): DelegatePlaceholderFields | null {
  let parsed: Record<string, unknown>;
  try {
    if (typeof args === "string") {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } else if (args && typeof args === "object") {
      parsed = args as Record<string, unknown>;
    } else {
      parsed = {};
    }
  } catch {
    return null;
  }

  const requestedRole =
    typeof parsed.subagent_type === "string" ? parsed.subagent_type :
    typeof parsed.role === "string" ? parsed.role :
    "";

  const task =
    typeof parsed.prompt === "string" ? parsed.prompt :
    typeof parsed.task === "string" ? parsed.task :
    "";

  return {
    role: resolveEffectiveRoleName(requestedRole, config),
    task,
  };
}
