/**
 * Vector search — cosine similarity + SQLite embedding lookup.
 */

import type { SearchResult } from "./index.js";

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function vectorSearch(
  queryEmbedding: Float32Array,
  db: any,
  threshold: number,
  limit: number,
): SearchResult[] {
  const rows = db
    .prepare("SELECT entry_hash, category, timestamp, content, tags, embedding FROM memory_embeddings")
    .all() as Array<{
      entry_hash: string;
      category: string;
      timestamp: string;
      content: string;
      tags: string;
      embedding: Buffer;
    }>;

  const scored: SearchResult[] = [];
  for (const row of rows) {
    const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const sim = cosineSimilarity(queryEmbedding, emb);
    if (sim >= threshold) {
      scored.push({
        category: row.category,
        content: row.content,
        timestamp: row.timestamp,
        tags: row.tags ? row.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        rank: sim,
      });
    }
  }

  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

export function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const map = new Map<string, SearchResult>();
  for (const r of results) {
    const hash = `${r.category}|${r.timestamp}|${r.content}`;
    const existing = map.get(hash);
    if (!existing || r.rank > existing.rank) {
      map.set(hash, r);
    }
  }
  return Array.from(map.values());
}
