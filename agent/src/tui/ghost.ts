/**
 * Ghost text (inline completion hint) for slash commands.
 */

import { SLASH_COMMANDS } from "./commands.js";

/**
 * Return a ghost text suffix for the current input.
 *
 * - Single match: remaining suffix (e.g., "/mo" -> "del")
 * - Multiple matches: most-recent match suffix + up-arrow indicator
 * - "/model " (trailing space): subcommand hints "[show|set|list]"
 * - No match: ""
 */
export function getGhostSuffix(
  input: string,
  commands: string[],
  recency: Record<string, number>,
): string {
  if (!input.startsWith("/")) return "";

  // Check for subcommand hints: "/model " (exact command + trailing space)
  const trimmedInput = input.trimEnd();
  if (input.endsWith(" ") && input.length > 1) {
    const cmdName = trimmedInput.slice(1); // remove "/"
    const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName);
    if (cmd?.subcommands && cmd.subcommands.length > 0) {
      return `[${cmd.subcommands.join("|")}]`;
    }
    return "";
  }

  // Find matching commands
  const matches = commands.filter((c) =>
    c.toLowerCase().startsWith(input.toLowerCase()),
  );

  if (matches.length === 0) return "";

  if (matches.length === 1) {
    // Single match: return remaining suffix
    return matches[0].slice(input.length);
  }

  // Multiple matches: pick the most recent, or first if no recency data
  let bestMatch = matches[0];
  let bestTime = -1;

  for (const m of matches) {
    const t = recency[m] ?? -1;
    if (t > bestTime) {
      bestTime = t;
      bestMatch = m;
    }
  }

  const suffix = bestMatch.slice(input.length);
  return suffix + "\u2191"; // up-arrow indicator for multiple matches
}
