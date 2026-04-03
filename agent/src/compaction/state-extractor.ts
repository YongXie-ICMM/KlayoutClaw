/**
 * State extractor for compaction summaries.
 * Parses XML tags from the compaction summary and writes
 * structured state files to the workspace compaction directory.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

/** Map of XML tag names to output file names. */
const TAG_FILE_MAP: Record<string, string> = {
  "layout-state": "layout-state.md",
  "design-rules": "design-rules.md",
  "workspace-state": "workspace-state.md",
};

/**
 * Extract a single XML-style tag's content from a summary string.
 * Returns the trimmed inner content, or null if the tag is absent.
 */
export function extractTag(summary: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const match = summary.match(regex);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Parse compaction summary for XML tags and write state files.
 * If a tag is absent in the summary, the corresponding file is left untouched.
 */
export function extractStateFiles(summary: string, workspaceDir: string): void {
  const compactionDir = join(workspaceDir, "compaction");
  mkdirSync(compactionDir, { recursive: true });

  for (const [tagName, fileName] of Object.entries(TAG_FILE_MAP)) {
    const content = extractTag(summary, tagName);
    if (content !== null) {
      writeFileSync(join(compactionDir, fileName), content, "utf-8");
    }
  }
}
