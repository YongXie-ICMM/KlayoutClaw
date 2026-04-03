/**
 * Workspace context loaders — read markdown files for system prompt.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Load workspace markdown files (SOUL.md, WORKFLOW.md, etc.).
 */
export function loadWorkspaceContext(workspaceDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const mdFiles = ["SOUL.md", "WORKFLOW.md", "TOOLS.md", "RULES.md"];

  for (const file of mdFiles) {
    const path = join(workspaceDir, file);
    if (existsSync(path)) {
      files[file] = readFileSync(path, "utf-8");
    }
  }

  return files;
}

/**
 * Load memory content for context injection.
 */
export function loadMemoryContext(memoryDir: string): string[] {
  const entries: string[] = [];
  if (!existsSync(memoryDir)) return entries;

  const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const content = readFileSync(join(memoryDir, file), "utf-8").trim();
    if (content) {
      entries.push(`[${file.replace(".md", "")}]\n${content}`);
    }
  }

  return entries;
}
