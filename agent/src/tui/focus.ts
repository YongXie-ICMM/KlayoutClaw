/**
 * Focus state utilities for qlaybot TUI.
 */

import type { FocusState } from "../types/v04-contracts.js";

/**
 * Returns true ONLY when focusState is "input" or "completion".
 * All other states (config-panel, bar-select, workspace-bar, etc.)
 * make the InputBox inactive/inert.
 */
export function isInputActive(focusState: FocusState): boolean {
  return focusState === "input" || focusState === "completion";
}
