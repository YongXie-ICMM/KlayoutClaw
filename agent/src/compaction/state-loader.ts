/**
 * State loader for compaction state files.
 * Reads generated state files and injects a <compaction-state>
 * block into the agent context via transformContext.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** State files to load, with their section labels. */
const STATE_FILES: Array<{ file: string; label: string }> = [
  { file: "layout-state.md", label: "Layout State" },
  { file: "design-rules.md", label: "Design Rules" },
  { file: "workspace-state.md", label: "Workspace State" },
];

/**
 * Load all existing state files from the compaction directory.
 * Returns a formatted <compaction-state> block, or null if no files exist.
 */
export function loadStateBlock(workspaceDir: string): string | null {
  const compactionDir = join(workspaceDir, "compaction");
  const sections: string[] = [];

  for (const { file, label } of STATE_FILES) {
    const filePath = join(compactionDir, file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        sections.push(`## ${label}\n${content}`);
      }
    }
  }

  if (sections.length === 0) return null;

  return `<compaction-state>\n${sections.join("\n\n")}\n</compaction-state>`;
}

/**
 * Create a transformContext function that injects compaction state
 * into the last user message. Same injection pattern as auto-recall.
 */
export function createStateLoaderTransform(
  workspaceDir: string,
): (messages: AgentMessage[]) => AgentMessage[] {
  return (messages: AgentMessage[]): AgentMessage[] => {
    if (messages.length === 0) return messages;

    const last = messages[messages.length - 1] as unknown as Record<string, unknown>;
    if (last.role !== "user") return messages;

    const stateBlock = loadStateBlock(workspaceDir);
    if (!stateBlock) return messages;

    // Clone messages and augment the last user message
    const augmented = [...messages];
    const lastMsg = augmented[augmented.length - 1] as unknown as Record<string, unknown>;

    if (typeof lastMsg.content === "string") {
      augmented[augmented.length - 1] = {
        ...lastMsg,
        content: `${stateBlock}\n\n${lastMsg.content}`,
      } as AgentMessage;
    } else if (Array.isArray(lastMsg.content)) {
      augmented[augmented.length - 1] = {
        ...lastMsg,
        content: [
          { type: "text" as const, text: stateBlock },
          ...(lastMsg.content as Array<{ type: string; text?: string }>),
        ],
      } as AgentMessage;
    }

    return augmented;
  };
}
