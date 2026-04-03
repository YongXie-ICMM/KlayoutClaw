/**
 * Workspace file listing for the workspace exploration bar.
 * Scans ~/.qlaybot/workspace/ and returns entries for display.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { exec } from "child_process";
import { homedir } from "os";
import * as config from "../config.js";

/**
 * Safe wrapper for getWorkspaceDir that returns a fallback
 * if the config module doesn't export it (e.g. in test mocks).
 */
function getWorkspaceDir(): string {
  try {
    return config.getWorkspaceDir();
  } catch {
    return join(homedir(), ".qlaybot", "workspace");
  }
}

export interface WorkspaceFile {
  /** Display name (relative path from workspace root) */
  name: string;
  /** Absolute path for opening */
  path: string;
  /** First heading or first non-empty line from the file */
  description: string;
}

/**
 * Extract a short description from markdown content string.
 * Uses the first `# heading` or `## heading` line, or the first non-empty line.
 * Returns empty string for empty content.
 */
export function extractDescription(content: string): string {
  if (!content) return "";
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip markdown heading markers
    const heading = trimmed.match(/^#+\s+(.*)/);
    if (heading) return heading[1];
    return trimmed.slice(0, 60);
  }
  return "";
}

/**
 * Recursively collect all .md files from a directory.
 */
function collectMarkdownFiles(dir: string, base: string): WorkspaceFile[] {
  const files: WorkspaceFile[] = [];
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath, base));
    } else if (entry.endsWith(".md")) {
      const content = (() => {
        try {
          return readFileSync(fullPath, "utf-8");
        } catch {
          return "";
        }
      })();
      files.push({
        name: relative(base, fullPath),
        path: fullPath,
        description: extractDescription(content),
      });
    }
  }
  return files;
}

/**
 * List all workspace files for the exploration bar.
 */
export function listWorkspaceFiles(): WorkspaceFile[] {
  const wsDir = getWorkspaceDir();
  return collectMarkdownFiles(wsDir, wsDir);
}

/**
 * Open a file with the system default application.
 */
export function openFile(filePath: string): void {
  exec(`open "${filePath}"`);
}

/**
 * Check workspace directory integrity.
 * Returns status with file count and any issues found.
 */
export function checkWorkspaceIntegrity(): { ok: boolean; fileCount: number; issues: string[] } {
  const wsDir = getWorkspaceDir();
  const issues: string[] = [];
  const expectedFiles = ["SOUL.md", "WORKFLOW.md", "TOOLS.md", "RULES.md"];

  if (!existsSync(wsDir)) {
    return { ok: false, fileCount: 0, issues: ["Workspace directory does not exist"] };
  }

  const files = listWorkspaceFiles();

  for (const expected of expectedFiles) {
    if (!existsSync(join(wsDir, expected))) {
      issues.push(`Missing expected file: ${expected}`);
    }
  }

  return {
    ok: issues.length === 0,
    fileCount: files.length,
    issues,
  };
}
