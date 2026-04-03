/**
 * Phase K: Search Integration Tests — mode-driven full-pipeline tests.
 *
 * Unlike test-search.ts (mock-based unit/integration), these tests exercise
 * the FULL MemoryManager pipeline: save -> reindex -> search -> verify,
 * with mock embedder/fetch for external dependencies but real SQLite,
 * real FTS5, real vector search, and real deduplication.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, appendFileSync, existsSync } from "fs";
import {
  makeTmpDir,
  makeConfig,
} from "./helpers/config-builder.js";
import type { Embedder } from "../src/types/v04-contracts.js";
import { MemoryManager, type SearchResult } from "../src/memory/index.js";
import { createAutoRecallTransform } from "../src/memory/auto-recall.js";
import { clearRerankCache } from "../src/memory/reranker.js";
import { configCommand } from "../src/commands/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock embedder that returns deterministic vectors.
 * Each call to embedBatch returns vectors that are orthogonal,
 * making cosine similarity predictable: identical = 1.0, orthogonal = 0.0.
 */
function mockEmbedder(dims = 3): Embedder & {
  embed: ReturnType<typeof vi.fn>;
  embedBatch: ReturnType<typeof vi.fn>;
} {
  let callCount = 0;
  const basisVectors: Float32Array[] = [];
  for (let i = 0; i < dims; i++) {
    const v = new Float32Array(dims);
    v[i] = 1.0;
    basisVectors.push(v);
  }

  return {
    dimensions: dims,
    embed: vi.fn().mockImplementation(async (_text: string) => {
      // Return a vector that matches the first basis vector by default
      return new Float32Array(basisVectors[0]);
    }),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
      // Return one distinct basis vector per text, cycling through dims
      return texts.map((_, i) => {
        const idx = (callCount + i) % dims;
        return new Float32Array(basisVectors[idx]);
      });
    }),
  };
}

/**
 * Seed a memory directory with entries. Writes directly to category markdown files
 * in the format the MemoryManager parser expects.
 */
function seedMemory(
  memDir: string,
  entries: { category: string; content: string; tags?: string[] }[],
): void {
  mkdirSync(join(memDir, "log"), { recursive: true });
  for (const e of entries) {
    const ts = new Date().toISOString().slice(0, 19);
    const tagStr = e.tags?.length ? ` | ${e.tags.join(", ")}` : "";
    const text = `## ${ts}${tagStr}\n${e.content}\n\n`;
    const path =
      e.category === "log"
        ? join(memDir, "log", `${new Date().toISOString().slice(0, 10)}.md`)
        : join(memDir, `${e.category}.md`);
    appendFileSync(path, text);
  }
}

/** Config with an Anthropic provider (needed for reranker) */
function configWithAnthropicProvider(
  searchMode: "fts5" | "fts5+rerank" | "fts5+vector+rerank" | "vector+rerank" = "fts5+rerank",
) {
  return makeConfig({
    models: {
      providers: {
        "custom-anthropic": {
          baseUrl: "https://api.anthropic.com",
          apiKey: "test-key",
          api: "anthropic-messages",
          models: [
            {
              id: "claude-haiku-4-5-20251001",
              name: "Claude Haiku 4.5",
              reasoning: false,
              input: ["text", "image"] as ("text" | "image")[],
              cost: {
                input: 0.8,
                output: 4,
                cacheRead: 0.08,
                cacheWrite: 1,
              },
              contextWindow: 200000,
              maxTokens: 65536,
            },
          ],
        },
      },
    },
    search: {
      mode: searchMode,
      minRerank: 2,
      rerankMinScore: 0.1,
      rerankMaxTokens: 256,
    },
  });
}

/** Config WITHOUT Anthropic provider (no reranker capability) */
function configWithoutAnthropicProvider(
  searchMode: "fts5" | "fts5+rerank" | "fts5+vector+rerank" | "vector+rerank" = "fts5",
) {
  return makeConfig({
    models: {
      providers: {
        "openai": {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "test-key",
          api: "openai-chat",
          models: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              reasoning: false,
              input: ["text", "image"] as ("text" | "image")[],
              cost: { input: 5, output: 15, cacheRead: 2.5, cacheWrite: 5 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      },
    },
    search: {
      mode: searchMode,
      minRerank: 2,
      rerankMinScore: 0.1,
      rerankMaxTokens: 256,
    },
  });
}

// ---------------------------------------------------------------------------
// Mock fetch for reranker
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

function installRerankFetch(scores: number[]) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(scores) }],
      }),
  }) as any;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Search Integration Tests", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    clearRerankCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // SCC-K1: fts5 mode integration: save -> search -> found
  // =========================================================================
  describe("SCC-K1: fts5 mode integration", () => {
    it("save entries via MemoryManager, search finds them via FTS5", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = makeConfig({ search: { mode: "fts5" } });
      const mgr = new MemoryManager(memDir, undefined, null, config);

      // Save distinct entries
      mgr.save("knowledge", "KLayout uses pya for Python scripting");
      mgr.save("knowledge", "GDS2 is a standard layout format for IC design");
      mgr.save("procedures", "Run npm test to execute the test suite");

      // Search for a term present in one entry
      const results = (await mgr.search("KLayout pya scripting", 5)) as SearchResult[];

      expect(results.length).toBeGreaterThanOrEqual(1);
      const found = results.find((r) => r.content.includes("pya"));
      expect(found).toBeDefined();
      expect(found!.category).toBe("knowledge");
      expect(found!.rank).toBeGreaterThan(0);

      mgr.close();
    });

    it("search returns empty for non-matching query", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = makeConfig({ search: { mode: "fts5" } });
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "Python scripting in KLayout");

      const results = (await mgr.search("xylophone orchestra", 5)) as SearchResult[];
      expect(results.length).toBe(0);

      mgr.close();
    });

    it("FTS5 index is populated from save() without explicit reindex", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = makeConfig({ search: { mode: "fts5" } });
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "Electron beam lithography patterns");

      // Verify search works (search triggers reindexIfStale internally)
      const results = (await mgr.search("lithography", 5)) as SearchResult[];
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("lithography");

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K2: fts5+rerank integration: save -> search -> reranked order
  // =========================================================================
  describe("SCC-K2: fts5+rerank integration", () => {
    it("reranker reorders FTS5 results based on relevance scores", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = configWithAnthropicProvider("fts5+rerank");
      const mgr = new MemoryManager(memDir, undefined, null, config);

      // Save entries that all match "design" but differ in relevance
      mgr.save("knowledge", "IC design requires careful layer planning");
      mgr.save("knowledge", "Design rules check ensures manufacturing compliance");
      mgr.save("procedures", "The design review process involves three steps");

      // Mock reranker: assign scores that invert FTS5 natural order
      // Entry 2 (DRC) gets highest relevance, entry 0 (IC design) gets lowest
      installRerankFetch([20, 90, 50]);

      const results = (await mgr.search("design", 5)) as SearchResult[];

      expect(results.length).toBeGreaterThanOrEqual(2);
      // The reranker should have reordered: entry with score 90 first
      expect(results[0].content).toContain("manufacturing compliance");
      // Entry with score 50 second
      expect(results[1].content).toContain("review process");

      mgr.close();
    });

    it("reranker respects rerankMinScore filtering", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      // Set high rerankMinScore so low-scored entries get filtered
      const config = configWithAnthropicProvider("fts5+rerank");
      config.search.rerankMinScore = 0.5;
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "Layout uses layers for different materials");
      mgr.save("knowledge", "Layers in GDS represent process steps");
      mgr.save("procedures", "Layer assignment follows design rules");

      // Reranker returns scores in the order FTS5 returns results.
      // Give one entry a high score and others below the 0.5 threshold.
      // We provide enough scores for however many FTS5 returns.
      installRerankFetch([80, 10, 30]);

      const results = (await mgr.search("layer", 5)) as SearchResult[];

      // Only entries with score >= 50 (0.5) should remain — exactly 1
      expect(results.length).toBe(1);
      // The surviving result has rank = 80/100 = 0.8
      expect(results[0].rank).toBeGreaterThanOrEqual(0.5);

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K3: fts5+vector+rerank integration
  // =========================================================================
  describe("SCC-K3: fts5+vector+rerank integration", () => {
    it("combines FTS5 + vector results, deduplicates, and reranks", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const emb = mockEmbedder(4);
      const config = configWithAnthropicProvider("fts5+vector+rerank");
      config.embedding.similarityThreshold = 0.0; // Accept all vector matches
      const mgr = new MemoryManager(memDir, undefined, emb, config);

      // Save entries
      mgr.save("knowledge", "Semiconductor fabrication uses photolithography");
      mgr.save("knowledge", "Etching removes material from wafer surface");
      mgr.save("procedures", "Deposition adds thin films to the wafer");
      mgr.save("knowledge", "Doping introduces impurities into silicon");

      // Reindex to embed all entries
      await mgr.reindex();

      // Verify embeddings were created in the database
      const db = mgr.getDatabase();
      const embRows = db
        .prepare("SELECT COUNT(*) as cnt FROM memory_embeddings")
        .get() as { cnt: number };
      expect(embRows.cnt).toBe(4);

      // Mock the query embedding to match first basis vector (will be similar to first entry)
      emb.embed.mockResolvedValue(new Float32Array([1, 0, 0, 0]));

      // Mock reranker: assign scores based on content to verify ordering.
      // We inspect the fetch body to determine entry order, then return scores
      // so "Deposition" gets 90 and "photolithography" gets 70.
      const scoreMap: Record<string, number> = {
        Deposition: 90,
        photolithography: 70,
        Etching: 30,
        Doping: 50,
      };
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        const body = JSON.parse(opts.body);
        const text = body.messages[0].content as string;
        // Extract entry lines: "1. [category] content"
        const entryLines = text.split("\n").filter((l: string) => /^\d+\.\s+\[/.test(l));
        const scores = entryLines.map((line: string) => {
          for (const [key, score] of Object.entries(scoreMap)) {
            if (line.includes(key)) return score;
          }
          return 10; // default low score
        });
        return {
          ok: true,
          json: () => Promise.resolve({
            content: [{ type: "text", text: JSON.stringify(scores) }],
          }),
        };
      }) as any;

      const results = (await mgr.search("fabrication process", 5)) as SearchResult[];

      // Prove vector path was used: embedder.embed was called with the query
      expect(emb.embed).toHaveBeenCalledWith("fabrication process");

      // Prove reranker pipeline ran: fetch was called
      expect(globalThis.fetch).toHaveBeenCalled();

      // Should have results from combined FTS5 + vector, deduplicated
      expect(results.length).toBeGreaterThanOrEqual(2);

      // Verify specific reranked ordering: score 90 first, score 70 second, score 50 third
      expect(results[0].rank).toBeGreaterThan(results[1].rank);
      // Results should be in descending rank order throughout
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].rank).toBeGreaterThanOrEqual(results[i].rank);
      }

      // Content-specific ordering: "Deposition" (score 90) first, "photolithography" (score 70) second
      expect(results[0].content).toContain("Deposition");
      expect(results[1].content).toContain("photolithography");

      mgr.close();
    });

    it("deduplicates entries that appear in both FTS5 and vector results", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const emb = mockEmbedder(3);
      const config = configWithAnthropicProvider("fts5+vector+rerank");
      config.embedding.similarityThreshold = 0.0;
      const mgr = new MemoryManager(memDir, undefined, emb, config);

      mgr.save("knowledge", "Quantum dots emit light at specific wavelengths");
      mgr.save("knowledge", "Carbon nanotubes have exceptional electrical properties");

      await mgr.reindex();

      // Mock query embedding to match first entry
      emb.embed.mockResolvedValue(new Float32Array([1, 0, 0]));

      // Reranker scores for however many unique entries come through
      installRerankFetch([80, 60, 80, 60]); // extra scores in case of duplication

      const results = (await mgr.search("quantum", 10)) as SearchResult[];

      // Count unique content entries
      const uniqueContents = new Set(results.map((r) => r.content));
      // Every result should be unique (no duplicates)
      expect(results.length).toBe(uniqueContents.size);

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K4: vector+rerank integration
  // =========================================================================
  describe("SCC-K4: vector+rerank integration", () => {
    it("finds entries via vector similarity and reranks them", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const emb = mockEmbedder(3);
      const config = configWithAnthropicProvider("vector+rerank");
      config.embedding.similarityThreshold = 0.0;
      const mgr = new MemoryManager(memDir, undefined, emb, config);

      mgr.save("knowledge", "Graphene is a single layer of carbon atoms");
      mgr.save("knowledge", "Hexagonal boron nitride is an insulating substrate");
      mgr.save("procedures", "Stack assembly requires precise alignment");

      await mgr.reindex();

      // embedBatch was called for 3 entries
      expect(emb.embedBatch).toHaveBeenCalled();

      // Query embedding matches first basis vector -> highest similarity to first entry
      emb.embed.mockResolvedValue(new Float32Array([1, 0, 0]));

      // Reranker: reverse the order to verify reranking works
      installRerankFetch([30, 90, 60]);

      const results = (await mgr.search("material properties", 5)) as SearchResult[];

      expect(results.length).toBeGreaterThanOrEqual(1);
      // Verify reranking: entry with score 90 should come first
      expect(results[0].content).toContain("boron nitride");

      mgr.close();
    });

    it("falls back to FTS5 when vector search returns no results", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const emb = mockEmbedder(3);
      const config = configWithAnthropicProvider("vector+rerank");
      // Set threshold so high no vector results pass
      config.embedding.similarityThreshold = 0.999;
      const mgr = new MemoryManager(memDir, undefined, emb, config);

      mgr.save("knowledge", "Routing connects bonding pads to device contacts");

      await mgr.reindex();

      // Query embedding is orthogonal to all stored embeddings
      emb.embed.mockResolvedValue(new Float32Array([0.1, 0.1, 0.1]));

      const results = (await mgr.search("routing bonding", 5)) as SearchResult[];

      // Should still find via FTS5 fallback
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("bonding pads");

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K5: Embeddings survive restart (persistence test)
  // =========================================================================
  describe("SCC-K5: Embeddings survive restart", () => {
    it("embeddings persist across MemoryManager close/reopen cycles", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const emb = mockEmbedder(3);
      const config = configWithAnthropicProvider("fts5+vector+rerank");
      config.embedding.similarityThreshold = 0.0;

      // Phase 1: Create manager, save, embed, close
      const mgr1 = new MemoryManager(memDir, undefined, emb, config);
      mgr1.save("knowledge", "Persistent data survives restarts");
      mgr1.save("knowledge", "SQLite stores embeddings on disk");
      await mgr1.reindex();

      // Verify embeddings exist
      const db1 = mgr1.getDatabase();
      const count1 = (
        db1.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as {
          cnt: number;
        }
      ).cnt;
      expect(count1).toBe(2);

      mgr1.close();

      // Phase 2: Create NEW manager on same directory, do NOT re-embed
      const emb2 = mockEmbedder(3);
      const mgr2 = new MemoryManager(memDir, undefined, emb2, config);

      // Verify embeddings still exist in the database without calling reindex
      const db2 = mgr2.getDatabase();
      const count2 = (
        db2.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as {
          cnt: number;
        }
      ).cnt;
      expect(count2).toBe(2);

      // Verify the embedding data is valid (can be read back as Float32Array)
      const row = db2
        .prepare("SELECT embedding FROM memory_embeddings LIMIT 1")
        .get() as { embedding: Buffer };
      const restored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      expect(restored.length).toBe(3);
      // Should be a valid unit vector (one of our basis vectors)
      const norm = Math.sqrt(
        restored[0] ** 2 + restored[1] ** 2 + restored[2] ** 2,
      );
      expect(norm).toBeCloseTo(1.0, 3);

      // Phase 3: Verify reindex does NOT re-embed existing entries
      await mgr2.reindex();
      // embedBatch should NOT have been called since entries already have embeddings
      expect(emb2.embedBatch).not.toHaveBeenCalled();

      mgr2.close();
    });
  });

  // =========================================================================
  // SCC-K6: Auto-recall integration
  // =========================================================================
  describe("SCC-K6: Auto-recall integration", () => {
    it("auto-recall injects recalled memories into message context", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = makeConfig({ search: { mode: "fts5" } });
      const mgr = new MemoryManager(memDir, undefined, null, config);

      // Save a memory with a DISTINCT term ("QPC1") that will NOT appear in the user query
      mgr.save("knowledge", "QPC1 voltage is -1.2V for pinch-off characterization");
      mgr.save("procedures", "Always capture a screenshot after geometry changes");

      // Force reindex so entries are in FTS5
      await mgr.reindex();

      // Create auto-recall transform
      const transform = createAutoRecallTransform(mgr, {
        enabled: true,
        maxResults: 3,
        minReindexMs: 0, // No throttle for test
      });

      // User query uses "voltage" which matches the memory, but does NOT contain "QPC1"
      const messages = [
        { role: "user" as const, content: "What voltage settings were recorded?" },
      ];

      const transformed = await transform(messages as any);

      // Should have injected a recall message before the user message
      expect(transformed.length).toBe(2);

      // The injected message should contain recalled-memories tags
      const recallMsg = transformed[0] as unknown as {
        role: string;
        content: string;
      };
      expect(recallMsg.role).toBe("user");
      expect(recallMsg.content).toContain("<recalled-memories>");
      // Assert the recalled content contains "QPC1" — a term NOT in the user query,
      // proving the system actually searched memory rather than echoing the query
      expect(recallMsg.content).toContain("QPC1");

      // The original user message should still be last
      const lastMsg = transformed[1] as unknown as {
        role: string;
        content: string;
      };
      expect(lastMsg.content).toBe("What voltage settings were recorded?");

      mgr.close();
    });

    it("auto-recall returns messages unchanged when memory is empty", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = makeConfig({ search: { mode: "fts5" } });
      // Empty memory — no entries saved
      const mgr = new MemoryManager(memDir, undefined, null, config);

      const transform = createAutoRecallTransform(mgr, {
        enabled: true,
        maxResults: 3,
        minReindexMs: 0,
      });

      const messages = [
        { role: "user" as const, content: "Tell me about quantum computing" },
      ];

      const transformed = await transform(messages as any);

      // No entries in memory, so no recall injection
      expect(transformed.length).toBe(1);
      const lastMsg = transformed[0] as unknown as { content: string };
      expect(lastMsg.content).toBe("Tell me about quantum computing");

      mgr.close();
    });

    it("auto-recall skips when last message is not from user", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = makeConfig({ search: { mode: "fts5" } });
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "Some relevant content about testing");
      await mgr.reindex();

      const transform = createAutoRecallTransform(mgr, {
        enabled: true,
        maxResults: 3,
        minReindexMs: 0,
      });

      const messages = [
        { role: "user" as const, content: "testing" },
        { role: "assistant" as const, content: "Here are the test results" },
      ];

      const transformed = await transform(messages as any);

      // Should not inject when last message is from assistant
      expect(transformed.length).toBe(2);

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K7: Graceful degradation: vector mode + no embedding -> falls back to fts5
  // =========================================================================
  describe("SCC-K7: Graceful degradation (no embedder)", () => {
    it("vector+rerank mode falls back to fts5 when no embedder is provided", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      // Config says vector+rerank but we provide NO embedder
      const config = configWithAnthropicProvider("vector+rerank");
      const mgr = new MemoryManager(memDir, undefined, null, config);

      // Install fetch mock to verify reranker is NOT called (degraded mode skips rerank too)
      installRerankFetch([90]);

      mgr.save("knowledge", "Fallback testing for vector search mode");

      const results = (await mgr.search("fallback vector", 5)) as SearchResult[];

      // Should still find via FTS5 fallback
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("Fallback testing");

      // Negative assertion: no embedding calls were made (null embedder -> no vector path)
      // Since we passed null embedder, there's no embed/embedBatch to call.
      // Verify degradation happened by checking that the mode resolved to fts5
      // (results came from FTS5, not vector search — no embeddings in DB)
      const db = mgr.getDatabase();
      const embCount = (db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as { cnt: number }).cnt;
      expect(embCount).toBe(0); // No embeddings were created

      // Reranker was NOT called — proves resolveMode fell back to fts5, skipping rerank
      expect(globalThis.fetch).not.toHaveBeenCalled();

      mgr.close();
    });

    it("fts5+vector+rerank mode falls back to fts5 when no embedder is provided", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = configWithAnthropicProvider("fts5+vector+rerank");
      // No embedder
      const mgr = new MemoryManager(memDir, undefined, null, config);

      // Install fetch mock to verify reranker is NOT called in degraded mode
      installRerankFetch([90]);

      mgr.save("knowledge", "Combined mode degrades gracefully without embedder");

      const results = (await mgr.search("degrades gracefully", 5)) as SearchResult[];

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("degrades gracefully");

      // Negative assertion: no embeddings in DB proves vector path was skipped
      const db = mgr.getDatabase();
      const embCount = (db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as { cnt: number }).cnt;
      expect(embCount).toBe(0);

      // Reranker was NOT called — proves resolveMode fell back to fts5, skipping rerank
      expect(globalThis.fetch).not.toHaveBeenCalled();

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K8: Graceful degradation: rerank + no Anthropic -> falls back
  // =========================================================================
  describe("SCC-K8: Graceful degradation (no Anthropic provider)", () => {
    it("fts5+rerank mode falls back to fts5 when no Anthropic provider exists", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      // Config with OpenAI provider only (no anthropic-messages api)
      const config = configWithoutAnthropicProvider("fts5+rerank");
      const mgr = new MemoryManager(memDir, undefined, null, config);

      // Install fetch mock to verify it is NOT called (no Anthropic -> no reranker)
      installRerankFetch([90, 50]);

      mgr.save("knowledge", "Reranker unavailable without Anthropic");
      mgr.save("knowledge", "Second entry for reranker test");

      const results = (await mgr.search("reranker Anthropic", 5)) as SearchResult[];

      // Should still get results via FTS5 (degraded from fts5+rerank to fts5)
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("Reranker unavailable");

      // Negative assertion: fetch was NOT called — proves reranker was skipped
      expect(globalThis.fetch).not.toHaveBeenCalled();

      mgr.close();
    });

    it("vector+rerank mode falls back to fts5 when no Anthropic provider and no embedder", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = configWithoutAnthropicProvider("vector+rerank");
      const mgr = new MemoryManager(memDir, undefined, null, config);

      // Install fetch mock to verify it is NOT called
      installRerankFetch([90]);

      mgr.save("knowledge", "Double fallback from vector+rerank to fts5");

      const results = (await mgr.search("double fallback", 5)) as SearchResult[];

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("Double fallback");

      // Negative assertion: fetch was NOT called — proves both vector and rerank were skipped
      expect(globalThis.fetch).not.toHaveBeenCalled();

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K8a: /config set search.mode vector+rerank without embedding -> error
  // =========================================================================
  describe("SCC-K8a: config validation for search.mode", () => {
    it("/config set search.mode vector+rerank succeeds but resolveMode degrades to fts5 without embedder", async () => {
      // Step 1: Exercise the config command path to set vector+rerank
      const config = configWithAnthropicProvider("fts5"); // start with fts5
      const context = {
        session: { config },
      } as any;

      const result = await configCommand.execute(["set", "search.mode", "vector+rerank"], context);
      // Config command accepts it (validate only checks string membership)
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("search.mode");
      expect(config.search.mode).toBe("vector+rerank");

      // Step 2: Verify MemoryManager degrades to fts5 since no embedder is provided
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const mgr = new MemoryManager(memDir, undefined, null, config); // null embedder

      mgr.save("knowledge", "Config validation test entry for degradation");

      // Install reranker mock — it should NOT be called since resolveMode falls back to fts5
      installRerankFetch([90]);

      const results = (await mgr.search("degradation", 5)) as SearchResult[];
      // Results come back via FTS5 fallback
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("degradation");

      // No embeddings exist — proves vector path was not used
      const db = mgr.getDatabase();
      const embCount = (db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as { cnt: number }).cnt;
      expect(embCount).toBe(0);

      // Reranker was NOT called — proves resolveMode fell back to fts5, not fts5+rerank
      expect(globalThis.fetch).not.toHaveBeenCalled();

      mgr.close();
    });

    it("vector+rerank without embedder resolves to fts5 mode transparently", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = configWithAnthropicProvider("vector+rerank");
      // No embedder provided
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "This entry should be findable via FTS5 fallback");

      // Install reranker mock — it should NOT be called since resolveMode falls back to fts5
      installRerankFetch([90]);

      const results = (await mgr.search("FTS5 fallback", 5)) as SearchResult[];

      // Verify the search returned results (meaning mode fell back to fts5)
      expect(results.length).toBe(1);
      expect(results[0].content).toContain("FTS5 fallback");

      // Reranker was NOT called — proves resolveMode fell back to fts5
      expect(globalThis.fetch).not.toHaveBeenCalled();

      // Also verify: reindex does NOT attempt to embed (no embedder)
      await mgr.reindex();
      const db = mgr.getDatabase();
      const embCount = (
        db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as {
          cnt: number;
        }
      ).cnt;
      expect(embCount).toBe(0);

      mgr.close();
    });
  });

  // =========================================================================
  // SCC-K8b: /config set search.mode fts5+rerank with Anthropic -> succeeds
  // =========================================================================
  describe("SCC-K8b: fts5+rerank with Anthropic provider succeeds", () => {
    it("/config set search.mode fts5+rerank with Anthropic provider invokes reranker end-to-end", async () => {
      // Step 1: Set mode via config command path
      const config = configWithAnthropicProvider("fts5"); // start with fts5
      const context = {
        session: { config },
      } as any;

      const setResult = await configCommand.execute(["set", "search.mode", "fts5+rerank"], context);
      expect(setResult.exitCode).toBe(0);
      expect(config.search.mode).toBe("fts5+rerank");

      // Step 2: Use the config with MemoryManager and verify the full pipeline
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "Alignment uses SIFT feature matching");
      mgr.save("knowledge", "Alignment can also use Chamfer distance");
      mgr.save("procedures", "Check alignment quality with IoU metric");

      // Mock reranker to reverse the FTS5 order
      installRerankFetch([30, 60, 95]);

      const results = (await mgr.search("alignment", 5)) as SearchResult[];

      // Verify reranker was called (fetch was invoked) — proves rerank pipeline ran
      expect(globalThis.fetch).toHaveBeenCalled();

      // Verify results are reranked: highest score entry should be first
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].content).toContain("IoU metric");

      mgr.close();
    });

    it("fts5+rerank skips reranking when results below minRerank threshold", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = configWithAnthropicProvider("fts5+rerank");
      config.search.minRerank = 10; // Set very high threshold
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "Single entry below minRerank threshold");

      // Install fetch mock but it should NOT be called
      installRerankFetch([90]);

      const results = (await mgr.search("minRerank threshold", 5)) as SearchResult[];

      expect(results.length).toBe(1);
      // fetch should NOT have been called for reranking (only 1 result < minRerank of 10)
      expect(globalThis.fetch).not.toHaveBeenCalled();

      mgr.close();
    });
  });

  // =========================================================================
  // Cross-cutting: Database-level verification
  // =========================================================================
  describe("Database-level verification", () => {
    it("FTS5 table contains all saved entries after reindex", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const config = makeConfig({ search: { mode: "fts5" } });
      const mgr = new MemoryManager(memDir, undefined, null, config);

      mgr.save("knowledge", "Entry one about photonics");
      mgr.save("knowledge", "Entry two about plasmonics");
      mgr.save("procedures", "Entry three about testing");

      await mgr.reindex();

      const db = mgr.getDatabase();
      const rows = db
        .prepare("SELECT COUNT(*) as cnt FROM memory_fts")
        .get() as { cnt: number };
      expect(rows.cnt).toBe(3);

      mgr.close();
    });

    it("embedding table stores correct dimensions", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const dims = 5;
      const emb = mockEmbedder(dims);
      const config = configWithAnthropicProvider("fts5+vector+rerank");
      const mgr = new MemoryManager(memDir, undefined, emb, config);

      mgr.save("knowledge", "Dimensionality check entry");

      await mgr.reindex();

      const db = mgr.getDatabase();
      const row = db
        .prepare("SELECT embedding FROM memory_embeddings LIMIT 1")
        .get() as { embedding: Buffer };
      // Each float32 is 4 bytes
      expect(row.embedding.byteLength).toBe(dims * 4);

      const restored = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      expect(restored.length).toBe(dims);

      mgr.close();
    });

    it("orphaned embeddings are cleaned up on reindex", async () => {
      const tmpDir = makeTmpDir();
      const memDir = join(tmpDir, "memory");
      const emb = mockEmbedder(3);
      const config = configWithAnthropicProvider("fts5+vector+rerank");
      const mgr = new MemoryManager(memDir, undefined, emb, config);

      mgr.save("knowledge", "Entry that will be removed");
      mgr.save("knowledge", "Entry that will stay");

      await mgr.reindex();

      const db = mgr.getDatabase();
      let count = (
        db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as {
          cnt: number;
        }
      ).cnt;
      expect(count).toBe(2);

      // Clear the knowledge category (removes the file)
      mgr.clear("knowledge");

      // Save only one entry back
      mgr.save("knowledge", "Entry that will stay");

      // Reindex should clean up orphaned embedding for removed entry
      await mgr.reindex();

      count = (
        db.prepare("SELECT COUNT(*) as cnt FROM memory_embeddings").get() as {
          cnt: number;
        }
      ).cnt;
      expect(count).toBe(1);

      mgr.close();
    });
  });
});
