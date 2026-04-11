/**
 * System prompt assembly for qlaybot.
 */

import { buildToolingSection } from "./sections/tooling.js";
import { buildMCPSection } from "./sections/mcp.js";
import { buildMemorySection } from "./sections/memory.js";
import { buildContextSection } from "./sections/context.js";
import { buildSkillsSection } from "./sections/skills.js";
import { buildDelegationSection } from "./sections/delegation.js";
import type { SubagentConfig } from "../types/v04-contracts.js";

export enum PromptMode {
  Full = "full",
  Sub = "sub",
}

export interface PromptBuildContext {
  mode: PromptMode;
  workspaceDir: string;
  toolNames: string[];
  connectedServers: string[];
  subagentConfig?: SubagentConfig;
  skillsDirs?: string[];
}

/**
 * Build the complete system prompt from modular sections.
 */
export function buildSystemPrompt(ctx: PromptBuildContext): string {
  const sections: string[] = [];

  // Tooling
  const tooling = buildToolingSection(ctx.toolNames);
  if (tooling) sections.push(tooling);

  // MCP
  const mcp = buildMCPSection(ctx.connectedServers);
  if (mcp) sections.push(mcp);

  // Delegation (when subagent roles exist)
  if (ctx.subagentConfig) {
    const delegation = buildDelegationSection(ctx.subagentConfig);
    if (delegation) sections.push(delegation);
  }

  // Memory (full mode only)
  if (ctx.mode === PromptMode.Full) {
    sections.push(buildMemorySection());
  }

  // Workspace context (SOUL.md, TOOLS.md, RULES.md)
  const context = buildContextSection(ctx.workspaceDir);
  if (context) sections.push(context);

  // Skill scanning (SKILL.md frontmatter from skill directories)
  if (ctx.skillsDirs) {
    const skills = buildSkillsSection(ctx.skillsDirs);
    if (skills) sections.push(skills);
  }

  return sections.join("\n\n---\n\n");
}
