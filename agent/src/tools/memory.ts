/**
 * Memory tools: memory_save and memory_search.
 * Uses MemoryManager for FTS5-backed persistent memory.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { MemoryManager } from "../memory/index.js";

const SaveParams = Type.Object({
  category: Type.String({ description: "Memory category: knowledge, procedures, preferences, or log" }),
  content: Type.String({ description: "Content to save" }),
  tags: Type.Optional(Type.String({ description: "Comma-separated tags for retrieval" })),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query for FTS5 full-text search" }),
  limit: Type.Optional(Type.Number({ description: "Max results to return (default: 5)" })),
});

function textResult(text: string): AgentToolResult<string> {
  return {
    content: [{ type: "text", text }],
    details: text,
  };
}

export function createMemorySaveTool(memoryManager: MemoryManager): AgentTool<typeof SaveParams> {
  return {
    name: "memory_save",
    label: "Memory Save",
    description: "Save information to persistent categorized memory. Categories: knowledge (device params, configs), procedures (workflows, recipes), preferences (user conventions), log (daily observations).",
    parameters: SaveParams,
    async execute(_toolCallId, params) {
      const tags = params.tags?.split(",").map((t: string) => t.trim()) ?? [];
      memoryManager.save(params.category, params.content, tags);
      return textResult(`Saved to ${params.category} memory.`);
    },
  };
}

export function createMemorySearchTool(memoryManager: MemoryManager): AgentTool<typeof SearchParams> {
  return {
    name: "memory_search",
    label: "Memory Search",
    description: "Search persistent memory using FTS5 full-text search across all categories.",
    parameters: SearchParams,
    async execute(_toolCallId, params) {
      const results = await memoryManager.search(params.query, params.limit ?? 5);
      if (results.length === 0) {
        return textResult("No memory entries found.");
      }
      const formatted = results.map((r) => `[${r.category}] ${r.content}`).join("\n---\n");
      return textResult(formatted);
    },
  };
}
