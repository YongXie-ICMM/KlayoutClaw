/**
 * Skill scanning — reads SKILL.md files from skill directories
 * and extracts name + description from YAML frontmatter.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * Scan multiple directories for SKILL.md files in skill subdirectories,
 * extract YAML frontmatter (name + description), and return
 * a summary list for system prompt injection.
 *
 * - Deduplicates by name (first found wins)
 * - Returns empty string for empty or nonexistent directories
 * - Handles malformed frontmatter gracefully (skip, don't crash)
 * - Handles missing name field gracefully (uses directory name as fallback)
 */
export function buildSkillsSection(skillsDirs: string[]): string {
  const seen = new Set<string>();
  const entries: Array<{ name: string; description: string }> = [];

  for (const dir of skillsDirs) {
    if (!existsSync(dir)) continue;

    let subdirs: string[];
    try {
      subdirs = readdirSync(dir);
    } catch {
      continue;
    }

    for (const subdir of subdirs) {
      const skillDir = join(dir, subdir);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const skillMd = join(skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      let content: string;
      try {
        content = readFileSync(skillMd, "utf-8");
      } catch {
        continue;
      }

      // Parse YAML frontmatter between --- delimiters
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter) continue;

      const name = frontmatter.name || subdir;
      if (seen.has(name)) continue;

      seen.add(name);
      entries.push({
        name,
        description: frontmatter.description || "",
      });
    }
  }

  if (entries.length === 0) return "";

  const lines = ["## Available Skills", ""];
  for (const entry of entries) {
    if (entry.description) {
      lines.push(`- **${entry.name}**: ${entry.description}`);
    } else {
      lines.push(`- **${entry.name}**`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse simple YAML frontmatter from a string.
 * Expects content starting with --- and ending with ---.
 * Returns null if no valid frontmatter found.
 */
function parseFrontmatter(
  content: string,
): { name?: string; description?: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const result: Record<string, string> = {};

  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }

  return result;
}
