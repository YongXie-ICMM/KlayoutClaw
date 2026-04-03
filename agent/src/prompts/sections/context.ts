/**
 * Context section — loads workspace markdown files.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export function buildContextSection(workspaceDir: string): string {
  const sections: string[] = [];
  const files = ["SOUL.md", "WORKFLOW.md", "TOOLS.md", "RULES.md"];

  for (const file of files) {
    const path = join(workspaceDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8").trim();
      if (content) {
        sections.push(content);
      }
    }
  }

  return sections.join("\n\n---\n\n");
}
