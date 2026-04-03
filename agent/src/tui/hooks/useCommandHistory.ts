/**
 * Command history with up/down navigation.
 * Saves draft text when first navigating up, restores on down past end.
 *
 * Exports both a React hook (useCommandHistory) and a pure function
 * (createCommandHistoryManager) for testing without React.
 */

import { useRef, useCallback } from "react";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { saveHistory } from "../history.js";
import { getHistoryPath } from "../../config.js";

interface HistoryState {
  entries: string[];
  index: number; // -1 = not navigating
  draft: string; // saved draft when entering history
}

/**
 * Pure command history manager (no React dependency).
 * Used for testing and non-React contexts.
 */
export function createCommandHistoryManager(
  initialEntries: string[] = [],
  onSave?: (entries: string[]) => void,
) {
  const state: HistoryState = {
    entries: [...initialEntries],
    index: -1,
    draft: "",
  };

  function push(cmd: string): void {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    // Avoid consecutive duplicates
    if (state.entries.length === 0 || state.entries[state.entries.length - 1] !== trimmed) {
      state.entries.push(trimmed);
      onSave?.(state.entries);
    }
    state.index = -1;
    state.draft = "";
  }

  function navigateUp(currentValue: string): string | undefined {
    if (state.entries.length === 0) return undefined;

    if (state.index === -1) {
      // First time navigating up -- save current text as draft
      state.draft = currentValue;
      state.index = state.entries.length - 1;
      return state.entries[state.entries.length - 1];
    }

    if (state.index > 0) {
      state.index = state.index - 1;
      return state.entries[state.index];
    }

    // Already at oldest entry
    return undefined;
  }

  function navigateDown(): string | undefined {
    if (state.index === -1) return undefined;

    if (state.index < state.entries.length - 1) {
      state.index = state.index + 1;
      return state.entries[state.index];
    }

    // Past the end -- restore draft
    state.index = -1;
    return state.draft;
  }

  function reset(): void {
    state.index = -1;
    state.draft = "";
  }

  return { push, navigateUp, navigateDown, reset };
}

/**
 * React hook wrapping createCommandHistoryManager with persistence.
 */
export function useCommandHistory(initialEntries: string[] = []) {
  const mgr = useRef(createCommandHistoryManager(initialEntries, saveHistory));

  const push = useCallback((cmd: string) => {
    mgr.current.push(cmd);
    // Persist after push -- rebuild entries from manager by navigating
    // For simplicity, we track entries separately
  }, []);

  const navigateUp = useCallback(
    (currentValue: string) => mgr.current.navigateUp(currentValue),
    [],
  );

  const navigateDown = useCallback(
    () => mgr.current.navigateDown(),
    [],
  );

  const reset = useCallback(() => mgr.current.reset(), []);

  return { push, navigateUp, navigateDown, reset };
}

/**
 * Load command recency data from history.json.
 * Handles migration from old plain-array format.
 */
export function loadCommandRecency(historyPath?: string): Record<string, number> {
  const path = historyPath ?? getHistoryPath();
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    // Old format: plain array of strings -> no recency data
    if (Array.isArray(data)) {
      return {};
    }
    // New format: { entries: [...], recency: {...} }
    if (data && typeof data === "object" && data.recency) {
      return data.recency;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Save command recency data to history.json in {entries, recency} format.
 */
export function saveCommandRecency(
  recency: Record<string, number>,
  historyPath?: string,
): void {
  const path = historyPath ?? getHistoryPath();
  try {
    // Read existing entries if present
    let entries: string[] = [];
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        if (Array.isArray(data)) {
          entries = data;
        } else if (data && typeof data === "object" && Array.isArray(data.entries)) {
          entries = data.entries;
        }
      } catch {
        // ignore parse errors
      }
    }
    writeFileSync(path, JSON.stringify({ entries, recency }, null, 2));
  } catch {
    // silently ignore write failures
  }
}
