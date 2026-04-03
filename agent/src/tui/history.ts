/**
 * Persistent command history stored in ~/.qlaybot/history.json.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { getHistoryPath } from "../config.js";

const MAX_ENTRIES = 500;

export function loadHistory(): string[] {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(data) ? data.slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: string[]): void {
  const trimmed = entries.slice(-MAX_ENTRIES);
  try {
    writeFileSync(getHistoryPath(), JSON.stringify(trimmed));
  } catch {
    // silently ignore write failures
  }
}
