/**
 * Tooling section — lists registered tools with descriptions.
 */

export function buildToolingSection(toolNames: string[]): string {
  if (toolNames.length === 0) return "";
  const list = toolNames.map((n) => `- \`${n}\``).join("\n");
  return `## Available Tools\n\n${list}`;
}
