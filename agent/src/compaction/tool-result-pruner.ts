/**
 * Tool result pruner for reversible context compression.
 * Replaces old, large tool results with compact placeholders
 * to reduce context growth during long design sessions.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ToolResultPruningConfig } from "./index.js";

/**
 * Check if a message is a tool result message.
 */
function isToolResult(msg: unknown): msg is { role: "tool"; tool_use_id: string; content: Array<{ type: string; text?: string }> } {
  const m = msg as unknown as Record<string, unknown>;
  return m?.role === "tool" && Array.isArray(m.content);
}

/**
 * Check if a message is an assistant message.
 */
function isAssistantMessage(msg: unknown): boolean {
  return (msg as unknown as Record<string, unknown>)?.role === "assistant";
}

/**
 * Extract the tool name from a preceding assistant message's tool_use block.
 */
function findToolNameForResult(messages: AgentMessage[], toolResultIndex: number): string | undefined {
  const toolResult = messages[toolResultIndex] as unknown as Record<string, unknown>;
  const toolUseId = toolResult.tool_use_id as string | undefined;
  if (!toolUseId) return undefined;

  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const msg = messages[i] as unknown as Record<string, unknown>;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use" && block.id === toolUseId) {
        return block.name as string | undefined;
      }
    }
    break;
  }
  return undefined;
}

/**
 * Calculate byte size of tool result content.
 */
function resultSizeBytes(msg: unknown): number {
  const m = msg as unknown as Record<string, unknown>;
  const content = m.content as Array<{ type: string; text?: string }> | undefined;
  if (!Array.isArray(content)) return 0;
  let size = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) {
      size += new TextEncoder().encode(block.text).length;
    }
  }
  return size;
}

/**
 * Create a pruner function that replaces old large tool results with placeholders.
 *
 * Rules:
 * - Walk messages backwards; keep the N most recent tool results intact
 * - Only prune tool results that have a subsequent assistant message
 * - Never prune tools in neverPruneTools
 * - Only prune results above minResultSizeBytes
 * - Returns a new array (no mutation)
 */
export function createToolResultPruner(
  config: ToolResultPruningConfig,
): (messages: AgentMessage[]) => AgentMessage[] {
  if (!config.enabled) {
    return (messages) => messages;
  }

  const neverPrune = new Set(config.neverPruneTools);

  return (messages: AgentMessage[]): AgentMessage[] => {
    // Find indices of all tool result messages
    const toolResultIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (isToolResult(messages[i])) {
        toolResultIndices.push(i);
      }
    }

    if (toolResultIndices.length === 0) return messages;

    // Find which tool results are eligible for pruning
    const eligibleForPrune: Set<number> = new Set();
    let kept = 0;

    // Walk backwards -- keep the N most recent results
    for (let j = toolResultIndices.length - 1; j >= 0; j--) {
      const idx = toolResultIndices[j];

      // Check if there's a subsequent assistant message
      let hasSubsequentAssistant = false;
      for (let k = idx + 1; k < messages.length; k++) {
        if (isAssistantMessage(messages[k])) {
          hasSubsequentAssistant = true;
          break;
        }
      }
      if (!hasSubsequentAssistant) continue;

      // Check tool name
      const toolName = findToolNameForResult(messages, idx);
      if (toolName && neverPrune.has(toolName)) continue;

      // Check size
      if (resultSizeBytes(messages[idx]) < config.minResultSizeBytes) continue;

      // Keep recent N
      if (kept < config.keepRecentResults) {
        kept++;
        continue;
      }

      eligibleForPrune.add(idx);
    }

    if (eligibleForPrune.size === 0) return messages;

    // Build new array with pruned results
    const result: AgentMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (eligibleForPrune.has(i)) {
        const original = messages[i] as unknown as Record<string, unknown>;
        const toolName = findToolNameForResult(messages, i) || "unknown";
        const originalSize = resultSizeBytes(messages[i]);
        const prunedMsg = {
          ...original,
          content: [{ type: "text" as const, text: `[Pruned: ${toolName} \u2014 ${originalSize} bytes]` }],
        };
        result.push(prunedMsg as AgentMessage);
      } else {
        result.push(messages[i]);
      }
    }

    return result;
  };
}
