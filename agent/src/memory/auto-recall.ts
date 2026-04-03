/**
 * Auto-recall via transformContext hook.
 * Searches memory before each LLM call if the last message is from the user.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "./index.js";

export interface AutoRecallConfig {
  enabled: boolean;
  maxResults: number;
  minReindexMs: number;
}

export const defaultAutoRecallConfig: AutoRecallConfig = {
  enabled: true,
  maxResults: 3,
  minReindexMs: 5000,
};

/**
 * Create a transformContext function that injects recalled memories.
 */
export function createAutoRecallTransform(
  memoryManager: MemoryManager,
  config: AutoRecallConfig = defaultAutoRecallConfig,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (!config.enabled || messages.length === 0) return messages;

    // Only recall when last message is from user
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || (lastMsg as unknown as Record<string, unknown>).role !== "user") return messages;

    // Extract text from user message
    const content = (lastMsg as unknown as Record<string, unknown>).content;
    let userText = "";
    if (typeof content === "string") {
      userText = content;
    } else if (Array.isArray(content)) {
      userText = (content as Array<Record<string, unknown>>)
        .filter((c) => c.type === "text")
        .map((c) => c.text as string)
        .join(" ");
    }

    if (!userText.trim()) return messages;

    // Search memory
    memoryManager.reindexIfStale(config.minReindexMs);
    const results = await memoryManager.search(userText, config.maxResults);

    if (results.length === 0) return messages;

    // Format recalled memories
    const recallBlock = results
      .map((r) => `[${r.category}] ${r.content}`)
      .join("\n");

    const recallMessage = {
      role: "user" as const,
      content: `<recalled-memories>\n${recallBlock}\n</recalled-memories>`,
    };

    // Insert recall before the last user message
    return [
      ...messages.slice(0, -1),
      recallMessage as AgentMessage,
      lastMsg,
    ];
  };
}
