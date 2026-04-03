/**
 * Role resolution — looks up subagent roles from config.
 */

import type { SubagentConfig, RoleConfig } from "../types/v04-contracts.js";

const VALID_MCP_ACCESS = new Set(["shared-readonly", "full", "none"]);

/**
 * Look up a role by name in the subagent config.
 * Returns null if the role does not exist.
 */
export function resolveRole(
  roleName: string,
  config: SubagentConfig,
): RoleConfig | null {
  if (!roleName) return null;
  return config.roles[roleName] ?? null;
}

/**
 * List all configured roles with their names and labels.
 */
export function listRoles(
  config: SubagentConfig,
): Array<{ name: string; label: string }> {
  return Object.entries(config.roles).map(([name, role]) => ({
    name,
    label: role.label,
  }));
}

/**
 * Validate all roles in the config. Returns an array of error strings.
 * Empty array means all roles are valid.
 */
export function validateRoles(config: SubagentConfig): string[] {
  const errors: string[] = [];

  for (const [name, role] of Object.entries(config.roles)) {
    if (!role.label) {
      errors.push(`Role '${name}': label must not be empty`);
    }
    if (!role.promptFile) {
      errors.push(`Role '${name}': promptFile must not be empty`);
    }
    if (!Array.isArray(role.baseTools) || role.baseTools.length === 0) {
      errors.push(`Role '${name}': baseTools must be a non-empty array`);
    }
    if (role.maxTurns <= 0) {
      errors.push(`Role '${name}': maxTurns must be positive (got ${role.maxTurns})`);
    }
    if (role.maxTokens < 0) {
      errors.push(`Role '${name}': maxTokens must not be negative (got ${role.maxTokens})`);
    }
    if (!VALID_MCP_ACCESS.has(role.mcpAccess)) {
      errors.push(`Role '${name}': invalid mcpAccess '${role.mcpAccess}' (must be shared-readonly, full, or none)`);
    }
  }

  return errors;
}
