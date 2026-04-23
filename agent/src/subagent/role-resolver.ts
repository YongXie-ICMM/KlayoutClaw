/**
 * Role resolution — looks up subagent roles from config.
 */

import type { SubagentConfig, RoleConfig } from "../types/v04-contracts.js";
import { GENERAL_PURPOSE_ROLE, GENERAL_PURPOSE_ROLE_NAME } from "./built-in/generalPurposeRole.js";

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
  if (roleName === GENERAL_PURPOSE_ROLE_NAME) return GENERAL_PURPOSE_ROLE;
  return config.roles[roleName] ?? null;
}

/**
 * Resolve a role with general-purpose fallback. Used by the delegate tool:
 * if the requested role does not exist in config.roles, fall back to the
 * built-in general-purpose role and emit a warning (carried in `warning`).
 */
export function resolveRoleWithFallback(
  roleName: string,
  config: SubagentConfig,
): { role: RoleConfig; effectiveName: string; warning?: string } {
  if (!roleName || roleName === GENERAL_PURPOSE_ROLE_NAME) {
    return { role: GENERAL_PURPOSE_ROLE, effectiveName: GENERAL_PURPOSE_ROLE_NAME };
  }
  const configured = config.roles[roleName];
  if (configured) {
    return { role: configured, effectiveName: roleName };
  }
  const known = Object.keys(config.roles).concat(GENERAL_PURPOSE_ROLE_NAME).join(", ");
  return {
    role: GENERAL_PURPOSE_ROLE,
    effectiveName: GENERAL_PURPOSE_ROLE_NAME,
    warning: `Unknown subagent_type '${roleName}', falling back to 'general-purpose'. Known roles: ${known}.`,
  };
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
