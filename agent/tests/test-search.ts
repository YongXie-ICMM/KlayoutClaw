/**
 * Phase I+J Search Core + Integration tests.
 *
 * Covers: Embedder, vector search, reranker, search modes,
 * database persistence, integration with auto-recall / commands / tools,
 * config validation, and error paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "fs";
import {
  makeTmpDir,
  makeConfig,
  makeSearchConfig,
  makeEmbeddingConfig,
} from "./helpers/config-builder.js";
import type {
  Embedder,
  SearchConfig,
  EmbeddingConfig,
  RerankResult,
} from "../src/types/v04-contracts.js";

// ---------------------------------------------------------------------------
// Module imports — these will fail until implementation exists
// ---------------------------------------------------------------------------

// Phase I: new modules
import { APIEmbedder, createEmbedder } from "../src/memory/embedder.js";
import {
  cosineSimilarity,
  vectorSearch,
  deduplicateResults,
} from "../src/memory/vector-search.js";
import { rerankResults } from "../src/memory/reranker.js";

// Phase I: updated module
import { MemoryManager, type SearchResult } from "../src/memory/index.js";

// Phase J: integration targets
import { createAutoRecallTransform } from "../src/memory/auto-recall.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Embedder backed by vi.fn() */
function mockEmbedder(dims = 3): Embedder {
  return {
    dimensions: dims,
    embed: vi.fn().mockResolvedValue(new Float32Array([1, 0, 0])),
    embedBatch: vi.fn().mockResolvedValue([
      new Float32Array([1, 0, 0]),
      new Float32Array([0, 1, 0]),
      new Float32Array([0, 0, 1]),
    ]),
  };
}

/** Seed a memory directory with entries so FTS5 has data. */
function seedMemory(memDir: string, entries: { category: string; content: string; tags?: string[] }[]) {
  mkdirSync(join(memDir, "log"), { recursive: true });
  for (const e of entries) {
    const ts = new Date().toISOString().slice(0, 19);
    const tagStr = e.tags?.length ? ` | ${e.tags.join(", ")}` : "";
    const text = `## ${ts}${tagStr}\n${e.content}\n\n`;
    const path = e.category === "log"
      ? join(memDir, "log", `${new Date().toISOString().slice(0, 10)}.md`)
      : join(memDir, `${e.category}.md`);
    appendFileSync(path, text);
  }
}

/** Config with an Anthropic provider for reranker tests */
function configWithAnthropicProvider() {
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
              cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
              contextWindow: 200000,
              maxTokens: 65536,
            },
          ],
        },
      },
    },
    search: { mode: "fts5+rerank", minRerank: 2, rerankMinScore: 0.3, rerankMaxTokens: 256 },
  });
}

// ---------------------------------------------------------------------------
// SCC-I1, SCC-I2, SCC-I3: Embedder
// ---------------------------------------------------------------------------

describe("Embedder", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("SCC-I1: APIEmbedder.embed() calls POST /embeddings with correct body and headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const embedder = new APIEmbedder({
      baseUrl: "https://api.example.com",
      apiKey: "sk-test-123",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    const result = await embedder.embed("hello world");

    // Verify fetch was called with correct URL
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/embeddings");

    // Verify headers
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test-123");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    // Verify body
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toBe("hello world");

    // Verify result is Float32Array with correct values
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(3);
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[1]).toBeCloseTo(0.2);
    expect(result[2]).toBeCloseTo(0.3);
  });

  it("SCC-I2: embedBatch() sends array in single call", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { embedding: [1, 0, 0] },
          { embedding: [0, 1, 0] },
          { embedding: [0, 0, 1] },
        ],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const embedder = new APIEmbedder({
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    const results = await embedder.embedBatch(["alpha", "beta", "gamma"]);

    // Single call, not three
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Body.input is array
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input).toEqual(["alpha", "beta", "gamma"]);

    // Returns array of Float32Array
    expect(results.length).toBe(3);
    expect(results[0]).toBeInstanceOf(Float32Array);
    expect(results[1]).toBeInstanceOf(Float32Array);
    expect(results[2]).toBeInstanceOf(Float32Array);
    expect(Array.from(results[0])).toEqual([1, 0, 0]);
    expect(Array.from(results[2])).toEqual([0, 0, 1]);
  });

  it("SCC-I3: createEmbedder returns null when config missing baseUrl", () => {
    const config = makeConfig({
      embedding: { baseUrl: "", apiKey: "key", model: "m" },
    });
    const result = createEmbedder(config);
    expect(result).toBeNull();
  });

  it("SCC-I3: createEmbedder returns null when config missing apiKey", () => {
    const config = makeConfig({
      embedding: { baseUrl: "https://api.example.com", apiKey: "", model: "m" },
    });
    const result = createEmbedder(config);
    expect(result).toBeNull();
  });

  it("SCC-I3: createEmbedder returns null when config missing model", () => {
    const config = makeConfig({
      embedding: { baseUrl: "https://api.example.com", apiKey: "key", model: "" },
    });
    const result = createEmbedder(config);
    expect(result).toBeNull();
  });

  it("SCC-I3: createEmbedder returns Embedder when config is complete", () => {
    const config = makeConfig({
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "text-embedding-3-small",
        dimensions: 1536,
        similarityThreshold: 0.3,
      },
    });
    const result = createEmbedder(config);
    expect(result).not.toBeNull();
    expect(result!.dimensions).toBe(1536);
    expect(typeof result!.embed).toBe("function");
    expect(typeof result!.embedBatch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// SCC-I4, SCC-I5, SCC-I6, SCC-I7: Vector Search
// ---------------------------------------------------------------------------

describe("Vector Search", () => {
  it("SCC-I4: cosineSimilarity identical vectors = 1.0", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("SCC-I5: cosineSimilarity orthogonal vectors = 0.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("cosineSimilarity opposite vectors = -1.0", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("cosineSimilarity scaled vectors still = 1.0", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("SCC-I6: vectorSearch returns results above threshold, sorted desc", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    // Populate with entries that have known embeddings
    seedMemory(memDir, [
      { category: "knowledge", content: "Alpha entry about circuits" },
      { category: "knowledge", content: "Beta entry about routing" },
      { category: "procedures", content: "Gamma entry about testing" },
    ]);

    const emb = mockEmbedder(3);
    const config = makeConfig({
      search: { mode: "vector+rerank" },
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "m",
        dimensions: 3,
        similarityThreshold: 0.5,
      },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    // Query embedding [1,0,0] should match entries whose embeddings are close
    const queryEmb = new Float32Array([1, 0, 0]);
    const results = vectorSearch(queryEmb, mm.getDatabase(), 0.5, 10);

    // Must have at least one result to avoid vacuous loops
    expect(results.length).toBeGreaterThan(0);

    // Results should be sorted descending by similarity
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].rank).toBeGreaterThanOrEqual(results[i].rank);
    }

    // All results should be above threshold
    for (const r of results) {
      expect(r.rank).toBeGreaterThanOrEqual(0.5);
    }

    mm.close();
  });

  it("SCC-I7: deduplicateResults keeps highest-scored entry per hash", () => {
    const results: SearchResult[] = [
      { category: "knowledge", content: "same content", timestamp: "2026-01-01T00:00:00", tags: [], rank: 0.9 },
      { category: "knowledge", content: "same content", timestamp: "2026-01-01T00:00:00", tags: [], rank: 0.7 },
      { category: "procedures", content: "different content", timestamp: "2026-01-02T00:00:00", tags: [], rank: 0.8 },
    ];

    const deduped = deduplicateResults(results);

    // Should keep 2 unique entries
    expect(deduped.length).toBe(2);

    // The "same content" entry should have rank 0.9 (highest)
    const sameEntry = deduped.find((r) => r.content === "same content");
    expect(sameEntry).toBeDefined();
    expect(sameEntry!.rank).toBe(0.9);

    // The "different content" entry should still be present
    const diffEntry = deduped.find((r) => r.content === "different content");
    expect(diffEntry).toBeDefined();
    expect(diffEntry!.rank).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// SCC-I8 through SCC-I12: Reranker
// ---------------------------------------------------------------------------

describe("Reranker", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("SCC-I8: Finds Anthropic provider automatically from config.models.providers", async () => {
    const config = configWithAnthropicProvider();
    // Scores: A=95, B=20, C=80, D=60  (rerankMinScore=0.3 filters B at 0.2)
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: JSON.stringify([95, 20, 80, 60]) }],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const results: SearchResult[] = [
      { category: "knowledge", content: "A", timestamp: "t1", tags: [], rank: 1 },
      { category: "knowledge", content: "B", timestamp: "t2", tags: [], rank: 1 },
      { category: "knowledge", content: "C", timestamp: "t3", tags: [], rank: 1 },
      { category: "knowledge", content: "D", timestamp: "t4", tags: [], rank: 1 },
    ];

    const reranked = await rerankResults(results, "test query", config);

    // Should have called the Anthropic API
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    // URL should use the Anthropic provider's baseUrl
    expect(url).toContain("anthropic");

    // B (score=20 -> 0.2) should be filtered out by rerankMinScore=0.3
    expect(reranked.length).toBe(3);
    expect(reranked.find((r) => r.content === "B")).toBeUndefined();

    // Scores should be normalized to 0-1 range
    for (const r of reranked) {
      expect(r.rank).toBeGreaterThanOrEqual(0);
      expect(r.rank).toBeLessThanOrEqual(1.0);
    }

    // Results should be sorted descending by normalized score
    for (let i = 1; i < reranked.length; i++) {
      expect(reranked[i - 1].rank).toBeGreaterThanOrEqual(reranked[i].rank);
    }

    // Verify order: A(0.95) > C(0.80) > D(0.60)
    expect(reranked[0].content).toBe("A");
    expect(reranked[1].content).toBe("C");
    expect(reranked[2].content).toBe("D");
  });

  it("SCC-I9: Skips reranking when count < minRerank", async () => {
    const config = configWithAnthropicProvider();
    // minRerank = 2, provide only 1 result
    const results: SearchResult[] = [
      { category: "knowledge", content: "solo", timestamp: "t1", tags: [], rank: 0.9 },
    ];

    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    const reranked = await rerankResults(results, "query", config);

    // Should NOT call the API
    expect(mockFetch).not.toHaveBeenCalled();

    // Should return original results unchanged
    expect(reranked.length).toBe(1);
    expect(reranked[0].content).toBe("solo");
  });

  it("SCC-I10: Falls back on API error (returns original results)", async () => {
    const config = configWithAnthropicProvider();
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    globalThis.fetch = mockFetch as any;

    const results: SearchResult[] = [
      { category: "knowledge", content: "A", timestamp: "t1", tags: [], rank: 0.8 },
      { category: "knowledge", content: "B", timestamp: "t2", tags: [], rank: 0.7 },
      { category: "knowledge", content: "C", timestamp: "t3", tags: [], rank: 0.6 },
      { category: "knowledge", content: "D", timestamp: "t4", tags: [], rank: 0.5 },
    ];

    const reranked = await rerankResults(results, "query", config);

    // Should return original results since API failed
    expect(reranked.length).toBe(results.length);
    expect(reranked.map((r) => r.content).sort()).toEqual(results.map((r) => r.content).sort());
  });

  it("SCC-I11: Cache hit avoids second call", async () => {
    const config = configWithAnthropicProvider();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: JSON.stringify([90, 80, 70, 60]) }],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const results: SearchResult[] = [
      { category: "knowledge", content: "A", timestamp: "t1", tags: [], rank: 1 },
      { category: "knowledge", content: "B", timestamp: "t2", tags: [], rank: 1 },
      { category: "knowledge", content: "C", timestamp: "t3", tags: [], rank: 1 },
      { category: "knowledge", content: "D", timestamp: "t4", tags: [], rank: 1 },
    ];

    // First call
    await rerankResults(results, "same query", config);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call with same query and same entries
    await rerankResults(results, "same query", config);
    // Should NOT make a second API call (cache hit)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("SCC-I12: Cache invalidates on reindex", async () => {
    const config = configWithAnthropicProvider();
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: JSON.stringify([90, 80, 70, 60]) }],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "Entry A about circuits" },
      { category: "knowledge", content: "Entry B about routing" },
      { category: "knowledge", content: "Entry C about design" },
      { category: "knowledge", content: "Entry D about testing" },
    ]);

    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    const results: SearchResult[] = [
      { category: "knowledge", content: "A", timestamp: "t1", tags: [], rank: 1 },
      { category: "knowledge", content: "B", timestamp: "t2", tags: [], rank: 1 },
      { category: "knowledge", content: "C", timestamp: "t3", tags: [], rank: 1 },
      { category: "knowledge", content: "D", timestamp: "t4", tags: [], rank: 1 },
    ];

    // First call populates cache
    await rerankResults(results, "circuits", config);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Reindex should clear the reranker cache
    await mm.reindex();

    // Second call after reindex should miss cache
    await rerankResults(results, "circuits", config);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mm.close();
  });
});

// ---------------------------------------------------------------------------
// SCC-I13 through SCC-I17: Search Modes
// ---------------------------------------------------------------------------

describe("Search Modes", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("SCC-I13: fts5 mode makes no embedding call", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "test entry about circuits" },
    ]);

    const emb = mockEmbedder(3);
    const config = makeConfig({ search: { mode: "fts5" } });
    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    const results = await mm.search("circuits", 5);

    // Embedder should NOT have been called
    expect(emb.embed).not.toHaveBeenCalled();
    expect(emb.embedBatch).not.toHaveBeenCalled();

    // Should still return FTS5 results
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("circuits");

    mm.close();
  });

  it("SCC-I14: fts5+rerank: FTS5 then rerank pipeline", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "Alpha about silicon wafer fabrication" },
      { category: "knowledge", content: "Beta about silicon etching processes" },
      { category: "procedures", content: "Gamma procedure for silicon deposition" },
      { category: "procedures", content: "Delta procedure for photolithography" },
    ]);

    const config = configWithAnthropicProvider();
    config.search.mode = "fts5+rerank";
    config.search.minRerank = 2;
    config.search.rerankMinScore = 0.3;

    // Scores: Alpha=95, Beta=20, Gamma=80 (3 silicon matches from FTS5)
    // Beta (0.2) should be filtered by rerankMinScore=0.3
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: JSON.stringify([95, 20, 80]) }],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const emb = mockEmbedder(3);
    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    const results = await mm.search("silicon", 5);

    // Should NOT use embedder (fts5+rerank, no vector)
    expect(emb.embed).not.toHaveBeenCalled();

    // Should have called reranker API (3 silicon matches >= minRerank=2)
    expect(mockFetch).toHaveBeenCalled();

    // Results should exist and be filtered (score 20 -> 0.2 < 0.3 threshold)
    expect(results.length).toBeGreaterThan(0);

    // Scores should be normalized to 0-1 range
    for (const r of results) {
      expect(r.rank).toBeGreaterThanOrEqual(0);
      expect(r.rank).toBeLessThanOrEqual(1.0);
    }

    // Results should be sorted descending by reranked score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].rank).toBeGreaterThanOrEqual(results[i].rank);
    }

    mm.close();
  });

  it("SCC-I15: fts5+vector+rerank: both paths then deduplicate then rerank", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    // Seed entries -- FTS5 and vector will both find "quantum" entries,
    // producing duplicates that must be deduplicated before reranking
    seedMemory(memDir, [
      { category: "knowledge", content: "Alpha about quantum computing theory" },
      { category: "knowledge", content: "Beta about quantum entanglement" },
      { category: "procedures", content: "Gamma quantum experiment procedure" },
      { category: "preferences", content: "Delta setting for quantum simulation" },
    ]);

    const config = configWithAnthropicProvider();
    config.search.mode = "fts5+vector+rerank";
    config.search.minRerank = 2;

    // Mock embedding API for vector search
    const mockFetch = vi.fn()
      // Reranker call:
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          content: [{ type: "text", text: JSON.stringify([90, 85, 80, 75]) }],
        }),
      });
    globalThis.fetch = mockFetch as any;

    const emb = mockEmbedder(3);
    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    const results = await mm.search("quantum", 10);

    // Should have used embedder for vector path
    expect(emb.embed).toHaveBeenCalled();

    // Results should exist (from both FTS5 and vector paths, deduplicated)
    expect(results.length).toBeGreaterThan(0);

    // Deduplication: there should be at most 4 unique entries (no duplicates
    // from FTS5+vector overlap). Verify by checking unique content strings.
    const uniqueContents = new Set(results.map((r) => r.content));
    expect(uniqueContents.size).toBe(results.length);

    // Results should be sorted descending by reranked score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].rank).toBeGreaterThanOrEqual(results[i].rank);
    }

    // Scores should be in 0-1 range
    for (const r of results) {
      expect(r.rank).toBeGreaterThanOrEqual(0);
      expect(r.rank).toBeLessThanOrEqual(1.0);
    }

    mm.close();
  });

  it("SCC-I16: vector+rerank: vector then rerank (no FTS5)", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "Alpha about nanodevice fabrication" },
      { category: "knowledge", content: "Beta about nanodevice characterization" },
      { category: "knowledge", content: "Gamma nanodevice measurement" },
      { category: "knowledge", content: "Delta nanodevice design" },
    ]);

    const config = configWithAnthropicProvider();
    config.search.mode = "vector+rerank";
    config.search.minRerank = 2;
    config.search.rerankMinScore = 0.3;

    // Scores: Alpha=95, Beta=20, Gamma=75, Delta=65
    // Beta (0.2) should be filtered by rerankMinScore=0.3
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: JSON.stringify([95, 20, 75, 65]) }],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const emb = mockEmbedder(3);
    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    const results = await mm.search("nanodevice", 10);

    // Should have used embedder
    expect(emb.embed).toHaveBeenCalled();

    // Should have called reranker
    expect(mockFetch).toHaveBeenCalled();

    // Results should exist
    expect(results.length).toBeGreaterThan(0);

    // Scores should be normalized to 0-1 range
    for (const r of results) {
      expect(r.rank).toBeGreaterThanOrEqual(0);
      expect(r.rank).toBeLessThanOrEqual(1.0);
    }

    // Results should be sorted descending by reranked score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].rank).toBeGreaterThanOrEqual(results[i].rank);
    }

    mm.close();
  });

  it("SCC-I17: resolveMode() falls back to fts5 without embedder", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "fallback test entry about routing" },
    ]);

    // Config says vector+rerank but no embedder
    const config = makeConfig({
      search: { mode: "vector+rerank" },
      embedding: { baseUrl: "", apiKey: "", model: "" },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    // Should fall back to fts5 and still return results
    const results = await mm.search("routing", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("routing");

    mm.close();
  });
});

// ---------------------------------------------------------------------------
// SCC-I18, SCC-I19, SCC-I20: Database
// ---------------------------------------------------------------------------

describe("Database", () => {
  it("SCC-I18: memory_embeddings table stores hash, content, blob", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "embedding storage test entry" },
    ]);

    const emb = mockEmbedder(3);
    const config = makeConfig({
      search: { mode: "fts5+vector+rerank" },
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "m",
        dimensions: 3,
        similarityThreshold: 0.3,
      },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    // Verify the embeddings table has data
    const db = mm.getDatabase();
    const rows = db.prepare("SELECT entry_hash, category, content, embedding, created_at FROM memory_embeddings").all() as any[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].entry_hash).toBeTruthy();
    expect(rows[0].category).toBe("knowledge");
    expect(rows[0].content).toContain("embedding storage test entry");
    expect(rows[0].embedding).toBeInstanceOf(Buffer);
    expect(rows[0].created_at).toBeGreaterThan(0);

    mm.close();
  });

  it("SCC-I19: Embeddings persist on disk (survive new MemoryManager)", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "persistent embedding test" },
    ]);

    const emb = mockEmbedder(3);
    const config = makeConfig({
      search: { mode: "fts5+vector+rerank" },
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "m",
        dimensions: 3,
        similarityThreshold: 0.3,
      },
    });

    // First manager: create and reindex
    const mm1 = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm1.reindex();

    // Verify embeddings were created
    const db1 = mm1.getDatabase();
    const count1 = (db1.prepare("SELECT count(*) as c FROM memory_embeddings").get() as any).c;
    expect(count1).toBeGreaterThan(0);
    mm1.close();

    // Second manager: should find existing embeddings on disk
    const emb2 = mockEmbedder(3);
    const mm2 = new MemoryManager(memDir, config.memory.budget, emb2, config);

    const db2 = mm2.getDatabase();
    const count2 = (db2.prepare("SELECT count(*) as c FROM memory_embeddings").get() as any).c;
    expect(count2).toBe(count1);

    mm2.close();
  });

  it("SCC-I20: FTS5 table unchanged (still works)", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "FTS5 backward compatibility test" },
    ]);

    const config = makeConfig({ search: { mode: "fts5" } });
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    // Direct FTS5 query should still work
    const db = mm.getDatabase();
    const rows = db.prepare(
      "SELECT content FROM memory_fts WHERE memory_fts MATCH ? LIMIT 5",
    ).all('"FTS5"*') as any[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].content).toContain("FTS5 backward compatibility test");

    mm.close();
  });
});

// ---------------------------------------------------------------------------
// Score normalization
// ---------------------------------------------------------------------------

describe("Score normalization", () => {
  it("FTS5 ranks normalized to 0-1 with highest = 1.0", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    // Seed entries with varying relevance: first mentions "circuit" 3x, second 1x
    seedMemory(memDir, [
      { category: "knowledge", content: "circuit design circuit optimization circuit layout techniques" },
      { category: "knowledge", content: "somewhat relevant circuit" },
      { category: "procedures", content: "unrelated entry about photolithography" },
    ]);

    const config = makeConfig({ search: { mode: "fts5" } });
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    const results = await mm.search("circuit", 10);

    // Must have multiple results to verify relative ordering
    expect(results.length).toBeGreaterThanOrEqual(2);

    // All ranks should be between 0 and 1
    for (const r of results) {
      expect(r.rank).toBeGreaterThanOrEqual(0);
      expect(r.rank).toBeLessThanOrEqual(1.0);
    }

    // The highest rank should be 1.0
    expect(results[0].rank).toBeCloseTo(1.0, 5);

    // Other ranks must be strictly less than 1.0 (non-trivial normalization)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].rank).toBeLessThan(1.0);
    }

    // Relative ordering preserved: more relevant (3x "circuit") ranked higher
    // than less relevant (1x "circuit")
    expect(results[0].rank).toBeGreaterThan(results[1].rank);

    mm.close();
  });
});

// ---------------------------------------------------------------------------
// SCC-J1, SCC-J2, SCC-J3: Integration (async search)
// ---------------------------------------------------------------------------

describe("Integration: async search", () => {
  it("SCC-J1: auto-recall awaits async search()", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "recalled memory about graphene" },
    ]);

    const config = makeConfig({ search: { mode: "fts5" } });
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    const transform = createAutoRecallTransform(mm, {
      enabled: true,
      maxResults: 3,
      minReindexMs: 0,
    });

    const messages = [
      { role: "user" as const, content: "Tell me about graphene" },
    ];

    const result = await transform(messages as any);

    // Should have injected a recalled-memories message before the user message
    expect(result.length).toBe(2);
    const recallMsg = result[0] as any;
    expect(recallMsg.role).toBe("user");
    expect(recallMsg.content).toContain("recalled-memories");
    expect(recallMsg.content).toContain("graphene");

    mm.close();
  });

  it("SCC-J2: /memory search awaits async search()", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "searchable entry about nanodevices" },
    ]);

    const config = makeConfig({ search: { mode: "fts5" } });
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    // Import the memory command handler
    const { memoryCommand } = await import("../src/commands/memory.js");

    const context = {
      session: {
        config,
        memoryManager: mm,
      },
    } as any;

    const result = await memoryCommand.execute(["search", "nanodevices"], context);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Search results");
    // Verify output contains the actual seeded content, not just the query word
    expect(result.output).toContain("searchable entry about nanodevices");

    mm.close();
  });

  it("SCC-J3: memory_search tool awaits async search()", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "tool searchable entry about EBL" },
    ]);

    const config = makeConfig({ search: { mode: "fts5" } });
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    const { createMemorySearchTool } = await import("../src/tools/memory.js");
    const tool = createMemorySearchTool(mm);

    const result = await tool.execute("call-1", { query: "EBL", limit: 5 });
    // Verify the tool returns the full seeded content, not just the query word
    expect(result.content[0].text).toContain("tool searchable entry about EBL");

    mm.close();
  });
});

// ---------------------------------------------------------------------------
// SCC-J4, SCC-J5: Config validation
// ---------------------------------------------------------------------------

describe("Config validation", () => {
  it("SCC-J4: Vector mode rejected without embedding config", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "test entry for vector fallback" },
    ]);

    // Vector mode but no embedder (empty config)
    const emb = mockEmbedder(3);
    const config = makeConfig({
      search: { mode: "vector+rerank" },
      embedding: { baseUrl: "", apiKey: "", model: "" },
    });

    // Pass null embedder (createEmbedder returns null for empty config)
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    // Should fall back to fts5, not throw
    const results = await mm.search("test", 5);
    expect(Array.isArray(results)).toBe(true);

    // Verify vector path was NOT used (embedder.embed never called)
    // We passed null embedder, but also verify mock would not have been called
    expect(emb.embed).not.toHaveBeenCalled();

    // Verify results came from FTS5 by checking content matches seeded data
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("test entry for vector fallback");

    mm.close();
  });

  it("SCC-J5: Rerank mode rejected without Anthropic provider", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "test entry for rerank fallback" },
    ]);

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as any;

    // fts5+rerank mode but no anthropic provider
    const config = makeConfig({
      models: {
        providers: {
          "openai": {
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test",
            api: "openai-chat", // NOT anthropic-messages
            models: [],
          },
        },
      },
      search: { mode: "fts5+rerank" },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    // Should fall back to fts5 (no anthropic provider for reranking)
    const results = await mm.search("test", 5);
    expect(Array.isArray(results)).toBe(true);

    // Verify reranker was NOT called (no fetch to Anthropic API)
    expect(mockFetch).not.toHaveBeenCalled();

    // Verify FTS5 results are still returned
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("test entry for rerank fallback");

    globalThis.fetch = originalFetch;
    mm.close();
  });
});

// ---------------------------------------------------------------------------
// SCC-J9 through SCC-J13: Error paths
// ---------------------------------------------------------------------------

describe("Error paths", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("SCC-J9: Haiku timeout fallback to unsorted results", async () => {
    const config = configWithAnthropicProvider();
    config.search.minRerank = 2;

    // Simulate timeout via AbortError
    const mockFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );
    globalThis.fetch = mockFetch as any;

    const results: SearchResult[] = [
      { category: "knowledge", content: "A", timestamp: "t1", tags: [], rank: 0.8 },
      { category: "knowledge", content: "B", timestamp: "t2", tags: [], rank: 0.6 },
      { category: "knowledge", content: "C", timestamp: "t3", tags: [], rank: 0.7 },
      { category: "knowledge", content: "D", timestamp: "t4", tags: [], rank: 0.5 },
    ];

    const reranked = await rerankResults(results, "query", config);

    // Should return original results (fallback)
    expect(reranked.length).toBe(results.length);
  });

  it("SCC-J10: Malformed JSON from reranker fallback", async () => {
    const config = configWithAnthropicProvider();
    config.search.minRerank = 2;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: "this is not valid JSON array" }],
      }),
    });
    globalThis.fetch = mockFetch as any;

    const results: SearchResult[] = [
      { category: "knowledge", content: "A", timestamp: "t1", tags: [], rank: 0.8 },
      { category: "knowledge", content: "B", timestamp: "t2", tags: [], rank: 0.7 },
      { category: "knowledge", content: "C", timestamp: "t3", tags: [], rank: 0.6 },
      { category: "knowledge", content: "D", timestamp: "t4", tags: [], rank: 0.5 },
    ];

    const reranked = await rerankResults(results, "query", config);

    // Should fall back to original results
    expect(reranked.length).toBe(results.length);
  });

  it("SCC-J11: Embedding API 5xx fallback", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "entry for embedding failure test" },
    ]);

    const failingEmbedder: Embedder = {
      dimensions: 3,
      embed: vi.fn().mockRejectedValue(new Error("500 Internal Server Error")),
      embedBatch: vi.fn().mockRejectedValue(new Error("500 Internal Server Error")),
    };

    const config = makeConfig({
      search: { mode: "fts5+vector+rerank" },
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "m",
        dimensions: 3,
        similarityThreshold: 0.3,
      },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, failingEmbedder, config);
    await mm.reindex();

    // Search should fall back gracefully, not throw
    const results = await mm.search("embedding failure", 5);
    expect(Array.isArray(results)).toBe(true);

    mm.close();
  });

  it("SCC-J12: Zero-result search returns empty array", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    // Seed with unrelated content
    seedMemory(memDir, [
      { category: "knowledge", content: "entry about something completely different" },
    ]);

    const config = makeConfig({ search: { mode: "fts5" } });
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    const results = await mm.search("xyznonexistent123", 5);
    expect(results).toEqual([]);

    mm.close();
  });

  it("SCC-J13: Disk SQLite unavailable fallback to in-memory", async () => {
    // Create a tmp dir and use a regular file as the "memory dir"
    // so that SQLite cannot create index.sqlite inside it
    const tmpDir = makeTmpDir();
    const fakeDir = join(tmpDir, "not-a-dir");
    writeFileSync(fakeDir, "this is a file, not a directory");
    const badDir = join(fakeDir, "memory");

    const config = makeConfig({ search: { mode: "fts5" } });

    // Should not throw even if disk SQLite fails
    let mm: MemoryManager | null = null;
    try {
      // The constructor should fall back to :memory:
      mm = new MemoryManager(badDir, config.memory.budget, null, config);
      // If it gets here, it fell back to in-memory successfully
      expect(mm).toBeTruthy();

      // Should still be able to search (even if empty)
      const results = await mm.search("anything", 5);
      expect(Array.isArray(results)).toBe(true);
    } finally {
      mm?.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SETTABLE_KEYS: search.* and embedding.* config keys
// ---------------------------------------------------------------------------

describe("SETTABLE_KEYS: search and embedding config", () => {
  it("SETTABLE_KEYS contains all 9 required search/embedding keys", async () => {
    const { SETTABLE_KEYS } = await import("../src/commands/config.js");
    const requiredKeys = [
      "search.mode",
      "search.minRerank",
      "search.rerankMinScore",
      "search.rerankMaxTokens",
      "embedding.baseUrl",
      "embedding.apiKey",
      "embedding.model",
      "embedding.dimensions",
      "embedding.similarityThreshold",
    ];
    for (const key of requiredKeys) {
      expect(SETTABLE_KEYS).toHaveProperty(key);
    }
  });

  it("search.mode accepts valid modes", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "search.mode", "fts5+rerank"], context);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("search.mode");
    expect(config.search.mode).toBe("fts5+rerank");
  });

  it("search.mode rejects invalid mode", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "search.mode", "invalid"], context);
    expect(result.exitCode).toBe(1);
  });

  it("search.minRerank accepts positive number", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "search.minRerank", "8"], context);
    expect(result.exitCode).toBe(0);
    expect(config.search.minRerank).toBe(8);
  });

  it("search.rerankMinScore accepts decimal", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "search.rerankMinScore", "0.5"], context);
    expect(result.exitCode).toBe(0);
    expect(config.search.rerankMinScore).toBe(0.5);
  });

  it("search.rerankMaxTokens accepts positive integer", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "search.rerankMaxTokens", "512"], context);
    expect(result.exitCode).toBe(0);
    expect(config.search.rerankMaxTokens).toBe(512);
  });

  it("embedding.baseUrl accepts URL string", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "embedding.baseUrl", "https://api.openai.com"], context);
    expect(result.exitCode).toBe(0);
    expect(config.embedding.baseUrl).toBe("https://api.openai.com");
  });

  it("embedding.apiKey accepts string", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "embedding.apiKey", "sk-abc123"], context);
    expect(result.exitCode).toBe(0);
    expect(config.embedding.apiKey).toBe("sk-abc123");
  });

  it("embedding.model accepts string", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "embedding.model", "text-embedding-3-large"], context);
    expect(result.exitCode).toBe(0);
    expect(config.embedding.model).toBe("text-embedding-3-large");
  });

  it("embedding.dimensions accepts positive integer", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "embedding.dimensions", "3072"], context);
    expect(result.exitCode).toBe(0);
    expect(config.embedding.dimensions).toBe(3072);
  });

  it("embedding.similarityThreshold accepts decimal between 0-1", async () => {
    const { configCommand } = await import("../src/commands/config.js");
    const config = makeConfig();
    const context = {
      session: { config },
    } as any;

    const result = await configCommand.execute(["set", "embedding.similarityThreshold", "0.7"], context);
    expect(result.exitCode).toBe(0);
    expect(config.embedding.similarityThreshold).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// MemoryManager constructor changes
// ---------------------------------------------------------------------------

describe("MemoryManager constructor", () => {
  it("accepts optional embedder and config params", () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    const emb = mockEmbedder(3);
    const config = makeConfig();

    // New constructor signature: (memDir, budget, embedder, config)
    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    expect(mm).toBeTruthy();
    mm.close();
  });

  it("works without embedder (backward compatible)", () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    const config = makeConfig();

    // Should work with null embedder
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    expect(mm).toBeTruthy();
    mm.close();
  });

  it("search() returns a Promise (is async)", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    const config = makeConfig();
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);

    const result = mm.search("test", 5);
    // search() should return a Promise
    expect(result).toBeInstanceOf(Promise);
    const resolved = await result;
    expect(Array.isArray(resolved)).toBe(true);

    mm.close();
  });

  it("reindex() returns a Promise (is async)", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    const config = makeConfig();
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);

    const result = mm.reindex();
    expect(result).toBeInstanceOf(Promise);
    await result;

    mm.close();
  });

  it("uses disk-based SQLite at memoryDir/index.sqlite", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    const config = makeConfig();
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);
    await mm.reindex();

    // Check that index.sqlite exists on disk
    expect(existsSync(join(memDir, "index.sqlite"))).toBe(true);

    mm.close();
  });

  it("exposes getDatabase() for vector search access", () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    const config = makeConfig();
    const mm = new MemoryManager(memDir, config.memory.budget, null, config);

    const db = mm.getDatabase();
    expect(db).toBeTruthy();
    // Should be a better-sqlite3 database instance
    expect(typeof db.prepare).toBe("function");

    mm.close();
  });
});

// ---------------------------------------------------------------------------
// Reindex embeddings
// ---------------------------------------------------------------------------

describe("reindexEmbeddings", () => {
  it("batch-embeds missing entries during reindex", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "entry one about circuits" },
      { category: "knowledge", content: "entry two about layout" },
      { category: "procedures", content: "entry three about testing" },
    ]);

    const emb = mockEmbedder(3);
    const config = makeConfig({
      search: { mode: "fts5+vector+rerank" },
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "m",
        dimensions: 3,
        similarityThreshold: 0.3,
      },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    // embedBatch should have been called with the 3 entries
    expect(emb.embedBatch).toHaveBeenCalled();
    const batchArgs = (emb.embedBatch as any).mock.calls[0][0] as string[];
    expect(batchArgs.length).toBe(3);

    mm.close();
  });

  it("skips already-embedded entries on second reindex", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    seedMemory(memDir, [
      { category: "knowledge", content: "persistent embed entry" },
    ]);

    const emb = mockEmbedder(3);
    (emb.embedBatch as any).mockResolvedValue([new Float32Array([1, 0, 0])]);
    const config = makeConfig({
      search: { mode: "fts5+vector+rerank" },
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "m",
        dimensions: 3,
        similarityThreshold: 0.3,
      },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);

    // First reindex: should embed
    await mm.reindex();
    expect(emb.embedBatch).toHaveBeenCalledTimes(1);

    // Second reindex without new entries: should NOT call embedBatch again
    // (or call with empty array)
    await mm.reindex();
    const calls = (emb.embedBatch as any).mock.calls;
    if (calls.length > 1) {
      // If called again, it should be with 0 new entries
      expect(calls[1][0].length).toBe(0);
    }

    mm.close();
  });
});

// ---------------------------------------------------------------------------
// Edge cases: stale reindex + embedding cleanup
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("vector search finds newly saved memories after stale reindex (minReindexMs=0)", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    // Seed with an initial entry so the DB is non-empty
    seedMemory(memDir, [
      { category: "knowledge", content: "old entry about photolithography" },
    ]);

    const emb = mockEmbedder(3);
    // Make embed return a unique vector for query, and embedBatch return
    // distinct vectors for each entry so vector search can differentiate
    let callCount = 0;
    (emb.embedBatch as any).mockImplementation((texts: string[]) => {
      return Promise.resolve(
        texts.map((_: string, i: number) => {
          callCount++;
          // Spread vectors across dimensions so they are distinguishable
          const v = new Float32Array(3);
          v[callCount % 3] = 1;
          return v;
        }),
      );
    });
    // Query embedding: always [1,0,0] — will match entries whose embedding[0]=1
    (emb.embed as any).mockResolvedValue(new Float32Array([1, 0, 0]));

    const config = configWithAnthropicProvider();
    config.search.mode = "vector+rerank";
    config.search.minRerank = 1;
    config.search.rerankMinScore = 0.0;
    config.embedding = {
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "m",
      dimensions: 3,
      similarityThreshold: 0.0, // accept any similarity
    };

    // Mock reranker to pass all results through with high scores
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: "text", text: JSON.stringify([90, 80, 70, 60, 50]) }],
      }),
    }));
    globalThis.fetch = mockFetch as any;

    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);
    await mm.reindex();

    // Now save a NEW memory AFTER the initial reindex
    mm.save("knowledge", "freshly saved entry about graphene nanoribbons");

    // Search in vector+rerank mode (NO FTS5) — the new entry should appear
    // only if reindexIfStale() refreshes embeddings, not just FTS5.
    const results = await mm.search("graphene nanoribbons", 10);

    // The new entry must be found via the vector path
    const found = results.some((r) => r.content.includes("graphene nanoribbons"));
    expect(found).toBe(true);

    globalThis.fetch = originalFetch;

    mm.close();
  });

  it("cleared memories are purged from memory_embeddings on reindex", async () => {
    const tmpDir = makeTmpDir();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });

    seedMemory(memDir, [
      { category: "knowledge", content: "entry that will be cleared" },
    ]);

    const emb = mockEmbedder(3);
    (emb.embedBatch as any).mockResolvedValue([new Float32Array([1, 0, 0])]);

    const config = makeConfig({
      search: { mode: "fts5+vector+rerank" },
      embedding: {
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        model: "m",
        dimensions: 3,
        similarityThreshold: 0.3,
      },
    });

    const mm = new MemoryManager(memDir, config.memory.budget, emb, config);

    // Step 1: reindex to create embeddings
    await mm.reindex();
    const db = mm.getDatabase();
    const countBefore = (db.prepare("SELECT count(*) as c FROM memory_embeddings").get() as any).c;
    expect(countBefore).toBeGreaterThan(0);

    // Step 2: clear the category (deletes the .md file)
    mm.clear("knowledge");

    // Step 3: reindex again — embeddings for deleted entries should be purged
    await mm.reindex();
    const countAfter = (db.prepare("SELECT count(*) as c FROM memory_embeddings").get() as any).c;
    expect(countAfter).toBe(0);

    mm.close();
  });
});
