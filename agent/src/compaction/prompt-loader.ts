/**
 * Compaction prompt loader.
 * Loads workspace/compaction/COMPACT.md and composes
 * final customInstructions for session.compact().
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CompactionConfig } from "./index.js";

/** Hardcoded fallback when no workspace COMPACT.md exists. */
const FALLBACK_PROMPT = `When summarizing this conversation, preserve:
- Active KLayout layout name and cell hierarchy
- Layer definitions used (layer/datatype pairs and their purpose)
- Geometry operations performed and their parameters
- Design constraints and rules discussed
- Current GDS file paths and save locations
- Plan mode progress and next steps`;

/**
 * Load the compaction prompt from workspace/compaction/COMPACT.md.
 * Falls back to a hardcoded default if no file exists.
 */
export function loadCompactPrompt(workspaceDir: string): string {
  const compactPath = join(workspaceDir, "compaction", "COMPACT.md");

  if (existsSync(compactPath)) {
    return readFileSync(compactPath, "utf-8").trim();
  }

  return FALLBACK_PROMPT;
}

/**
 * Build the final customInstructions string for session.compact().
 * Composes: workspace prompt + optional user instructions.
 */
export function buildCompactInstructions(
  workspaceDir: string,
  _config: CompactionConfig,
  userInstructions?: string,
): string {
  let instructions = loadCompactPrompt(workspaceDir);

  if (userInstructions) {
    instructions += `\n\n## Additional User Instructions\n${userInstructions}`;
  }

  return instructions;
}
