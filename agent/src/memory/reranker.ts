/**
 * Reranker — Haiku-based relevance scoring with cache.
 */

import { createHash } from "crypto";
import type { QlayBotConfig } from "../config.js";
import type { SearchResult } from "./index.js";

const rerankCache = new Map<string, SearchResult[]>();

export async function rerankResults(
  results: SearchResult[],
  query: string,
  config: QlayBotConfig,
): Promise<SearchResult[]> {
  try {
    // Find Anthropic provider
    const provider = findAnthropicProvider(config);
    if (!provider) return results;

    // Skip if below minimum
    if (results.length < config.search.minRerank) return results;

    // Check cache
    const cacheKey = computeCacheKey(query, results);
    const cached = rerankCache.get(cacheKey);
    if (cached) return cached;

    // Call Anthropic API
    const resp = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: config.search.rerankMaxTokens,
        system: "You are a relevance scorer. Given a query and a list of text entries, rate each entry's relevance to the query on a scale of 0-100. Return ONLY a JSON array of numbers, one per entry, in the same order as the entries.",
        messages: [
          {
            role: "user",
            content: `Query: "${query}"\n\nEntries:\n${results.map((r, i) => `${i + 1}. [${r.category}] ${r.content}`).join("\n")}\n\nReturn a JSON array of relevance scores (0-100), one per entry.`,
          },
        ],
      }),
    });

    const json = await resp.json() as { content: Array<{ type: string; text: string }> };
    const text = json.content[0].text;
    const scores: number[] = JSON.parse(text);

    // Normalize scores to 0-1 and attach
    const reranked: SearchResult[] = results.map((r, i) => ({
      ...r,
      rank: (scores[i] ?? 0) / 100,
    }));

    // Filter by minimum score
    const filtered = reranked.filter((r) => r.rank >= config.search.rerankMinScore);

    // Sort descending
    filtered.sort((a, b) => b.rank - a.rank);

    // Cache and return
    rerankCache.set(cacheKey, filtered);
    return filtered;
  } catch {
    // Fall back to original results on any error
    return results;
  }
}

export function clearRerankCache(): void {
  rerankCache.clear();
}

function findAnthropicProvider(config: QlayBotConfig): { baseUrl: string; apiKey: string } | null {
  for (const provider of Object.values(config.models.providers)) {
    if (provider.api === "anthropic-messages") {
      return { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
    }
  }
  return null;
}

function computeCacheKey(query: string, results: SearchResult[]): string {
  const contentHashes = results.map((r) => `${r.category}|${r.timestamp}|${r.content}`).sort();
  const input = query + contentHashes.join("");
  return createHash("sha256").update(input).digest("hex");
}
