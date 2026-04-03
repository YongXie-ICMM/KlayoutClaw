/**
 * Memory section — instructions for memory tools.
 */

export function buildMemorySection(): string {
  return `## Memory System

You have access to persistent memory via \`memory_save\` and \`memory_search\` tools.

**Categories:**
- \`knowledge\` — device parameters, design results, configurations
- \`procedures\` — design workflows, recipes that worked
- \`preferences\` — user conventions, layer schemes, naming
- \`log\` — daily session observations

**Auto-recall:** Relevant memories are automatically injected into your context via \`<recalled-memories>\` blocks. You don't need to search explicitly unless you want more specific results.

**When to save:**
- Device parameters discovered during design
- Successful design patterns and recipes
- User preferences about layer assignments or naming
- Important observations about fabrication constraints`;
}
