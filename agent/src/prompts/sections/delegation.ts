/**
 * Delegation section — generates the system prompt section describing available subagent roles.
 */

import type { SubagentConfig } from "../../types/v04-contracts.js";

/**
 * Build a markdown section listing all available subagent roles.
 * Returns null/empty string if no roles are configured.
 */
export function buildDelegationSection(config: SubagentConfig): string | null {
  if (!config.enabled) {
    return null;
  }
  const roleEntries = Object.entries(config.roles);
  if (roleEntries.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push("## Delegation");
  lines.push("");
  lines.push("You can delegate tasks to specialized subagent roles using the `delegate` tool.");
  lines.push("");
  lines.push("### Available Roles");
  lines.push("");

  for (const [name, role] of roleEntries) {
    lines.push(`- **${role.label}** (\`${name}\`): MCP access: ${role.mcpAccess}, max turns: ${role.maxTurns}`);
  }

  lines.push("");

  return lines.join("\n");
}
