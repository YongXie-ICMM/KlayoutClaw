/**
 * Prompt builder — constructs system prompts and task messages for subagents.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { RoleConfig } from "../types/v04-contracts.js";

/**
 * Build the system prompt for a subagent by reading its promptFile
 * and any workspace files listed in the role config.
 */
export function buildSubagentPrompt(
  roleConfig: RoleConfig,
  workspaceDir: string,
): string {
  const sections: string[] = [];

  // Read the main prompt file
  const promptPath = join(workspaceDir, roleConfig.promptFile);
  if (existsSync(promptPath)) {
    sections.push(readFileSync(promptPath, "utf-8"));
  }

  // Read workspace files
  for (const wsFile of roleConfig.workspaceFiles) {
    const wsPath = join(workspaceDir, wsFile);
    if (existsSync(wsPath)) {
      sections.push(readFileSync(wsPath, "utf-8"));
    }
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Build the task message sent to the subagent as the initial user prompt.
 * Includes a "Context:" section only if context is provided.
 */
export function buildTaskMessage(task: string, context?: string): string {
  if (context) {
    return `## Task\n${task}\n\n## Context:\n${context}`;
  }
  return `## Task\n${task}`;
}
