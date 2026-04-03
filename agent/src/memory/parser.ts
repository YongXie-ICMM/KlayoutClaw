/**
 * Memory entry parser — parses timestamped markdown entries.
 */

export interface MemoryEntry {
  timestamp: string;
  tags: string[];
  content: string;
  category: string;
}

/**
 * Parse a memory markdown file into individual entries.
 * Format: ## YYYY-MM-DDTHH:MM:SS | tag1, tag2\nContent...
 */
export function parseMemoryFile(content: string, category: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0].trim();
    const pipeIdx = header.indexOf("|");

    let timestamp = "";
    let tags: string[] = [];

    if (pipeIdx > 0) {
      timestamp = header.slice(0, pipeIdx).trim();
      tags = header
        .slice(pipeIdx + 1)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else {
      timestamp = header;
    }

    const entryContent = lines.slice(1).join("\n").trim();
    if (entryContent) {
      entries.push({ timestamp, tags, content: entryContent, category });
    }
  }

  return entries;
}

/**
 * Format a new memory entry as markdown.
 */
export function formatEntry(content: string, tags: string[]): string {
  const ts = new Date().toISOString().slice(0, 19);
  const tagStr = tags.length > 0 ? ` | ${tags.join(", ")}` : "";
  return `## ${ts}${tagStr}\n${content}\n`;
}
