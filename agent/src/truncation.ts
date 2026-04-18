/**
 * Shared truncation utility for transcript / tool-result strings.
 *
 * Used by `InteractionHistory.recordToolCall` (disk transcripts) so the
 * `result` field of long tool calls is split into a head + marker + tail
 * shape instead of bloating ~/.qlaybot/history. The same module is consumed
 * by the TUI's tool-panel renderer (Group 6) so display and disk truncation
 * stay consistent — `--verbose` toggles both off via a single options bag.
 */

export interface TruncationOptions {
  threshold: number; // max chars before truncation applies
  headChars: number; // chars to keep from the start
  tailChars: number; // chars to keep from the end
}

export const DEFAULT_TRANSCRIPT_TRUNCATION: TruncationOptions = {
  threshold: 2000,
  headChars: 1000,
  tailChars: 1000,
};

export function truncate(s: string, opts: TruncationOptions): string {
  if (s.length <= opts.threshold) return s;
  const head = s.slice(0, opts.headChars);
  const tail = s.slice(s.length - opts.tailChars);
  const hidden = s.length - opts.headChars - opts.tailChars;
  return `${head}\n... (truncated ${hidden} chars) ...\n${tail}`;
}
