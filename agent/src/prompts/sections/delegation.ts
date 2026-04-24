/**
 * Delegation section — generates the system prompt section describing
 * available subagent roles. The full per-role catalog also lives in the
 * `delegate` tool's description (built by buildDelegateDescription); this
 * section is a shorter prompt-level pointer.
 */

import type { SubagentConfig } from "../../types/v04-contracts.js";
import { getEffectiveGeneralPurposeRole } from "../../subagent/role-resolver.js";

/**
 * Build a markdown section describing delegation.
 * Returns null only when the subagent layer is explicitly disabled — with
 * `enabled: true` the built-in `general-purpose` role is always a reachable
 * target after the issue-#23 redesign, so the section is emitted even when
 * `config.roles` is empty (R3 finding #1 audit).
 *
 * R4 finding #2: the general-purpose line must be derived from the effective
 * role (config override wins over built-in) — NOT hardcoded — so the system
 * prompt and the `delegate` tool catalog agree about what general-purpose
 * can actually do. Hardcoding "full tool surface" misinforms the parent
 * agent when a user narrows general-purpose via config.roles.
 */
export function buildDelegationSection(config: SubagentConfig): string | null {
  if (!config.enabled) {
    return null;
  }

  const lines: string[] = [];
  lines.push("## Delegation");
  lines.push("");
  lines.push("You can delegate tasks to specialized subagent roles using the `delegate` tool.");
  lines.push("");
  lines.push("### Available Roles");
  lines.push("");

  // Derive general-purpose display from the effective role, matching
  // buildDelegateDescription's precedence (role-resolver.ts).
  const effectiveGeneral = getEffectiveGeneralPurposeRole(config);
  const gpTools = effectiveGeneral.baseTools.length > 0
    ? effectiveGeneral.baseTools.join("+")
    : "none";
  lines.push(
    `- **${effectiveGeneral.label}** (\`general-purpose\`): tools: ${gpTools}, mcp: ${effectiveGeneral.mcpAccess}, max turns: ${effectiveGeneral.maxTurns}. Used when no specialist fits or \`subagent_type\` is omitted.`,
  );

  for (const [name, role] of Object.entries(config.roles)) {
    if (name === "general-purpose") continue; // rendered above from the effective role
    lines.push(`- **${role.label}** (\`${name}\`): MCP access: ${role.mcpAccess}, max turns: ${role.maxTurns}`);
  }

  lines.push("");

  return lines.join("\n");
}
