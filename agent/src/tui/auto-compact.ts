/**
 * Auto-compaction decision logic — pure function, no side effects.
 *
 * Extracted from App.tsx so it can be unit-tested without rendering
 * the full TUI component tree.
 */

export interface AutoCompactConfig {
  enabled: boolean;
  autoThreshold: number;
}

/**
 * Determine whether auto-compaction should trigger after AGENT_END.
 *
 * @param config       - compaction config (enabled flag + threshold percent)
 * @param contextPercent - current context window usage as a percentage (0-100)
 * @param isCompacting   - true if a compaction is already in progress
 * @param hasPendingMessages - true if there are unprocessed messages queued
 * @param phase          - current TUI session phase
 * @returns true if compaction should be triggered
 */
export function shouldAutoCompact(
  config: AutoCompactConfig,
  contextPercent: number,
  isCompacting: boolean,
  hasPendingMessages: boolean,
  phase: string,
): boolean {
  // Compaction must be enabled in config
  if (!config.enabled) return false;

  // Only trigger in ready phase (after AGENT_END transitions to ready)
  if (phase !== "ready") return false;

  // Reentrancy guard — never double-compact
  if (isCompacting) return false;

  // Don't compact if there are queued messages (user typed ahead)
  if (hasPendingMessages) return false;

  // Only compact when context usage meets or exceeds threshold
  return contextPercent >= config.autoThreshold;
}
