/**
 * MemoryManager — categorized markdown files with SQLite FTS5 search.
 * v0.4: disk-based SQLite, embedding support, async search with 4-mode dispatch.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { parseMemoryFile, formatEntry, type MemoryEntry } from "./parser.js";
import { vectorSearch, deduplicateResults } from "./vector-search.js";
import { rerankResults, clearRerankCache } from "./reranker.js";
import type { Embedder, SearchMode } from "../types/v04-contracts.js";
import type { QlayBotConfig } from "../config.js";

const CATEGORIES = ["knowledge", "procedures", "preferences"] as const;
type Category = (typeof CATEGORIES)[number] | "log";

export interface SearchResult {
  category: string;
  content: string;
  timestamp: string;
  tags: string[];
  rank: number;
}

export interface MemoryBudget {
  maxEntriesPerCategory: number;
  maxFileSizeBytes: number;
}

export const defaultMemoryBudget: MemoryBudget = {
  maxEntriesPerCategory: 500,
  maxFileSizeBytes: 512 * 1024, // 512 KB per category file
};

export class MemoryManager {
  private memoryDir: string;
  private lastIndexTime = 0;
  private lastEmbeddingIndexTime = 0;
  private entries: MemoryEntry[] = [];
  private db: InstanceType<typeof Database>;
  private budget: MemoryBudget;
  private embedder: Embedder | null;
  private config: QlayBotConfig | undefined;

  constructor(
    memoryDir: string,
    budget: MemoryBudget = defaultMemoryBudget,
    embedder?: Embedder | null,
    config?: QlayBotConfig,
  ) {
    this.memoryDir = memoryDir;
    this.budget = budget;
    this.embedder = embedder ?? null;
    this.config = config;
    this.ensureDirs();
    this.db = this.openDatabase();
    this.initFTS();
    this.initEmbeddingsTable();
  }

  /**
   * Open disk-based SQLite or fall back to :memory:.
   */
  private openDatabase(): InstanceType<typeof Database> {
    try {
      const dbPath = join(this.memoryDir, "index.sqlite");
      return new Database(dbPath);
    } catch {
      return new Database(":memory:");
    }
  }

  /**
   * Initialize the FTS5 virtual table.
   */
  private initFTS(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        category,
        timestamp,
        tags,
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  /**
   * Initialize the embeddings table.
   */
  private initEmbeddingsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        entry_hash TEXT PRIMARY KEY,
        category TEXT,
        timestamp TEXT,
        content TEXT,
        tags TEXT,
        embedding BLOB,
        created_at INTEGER
      );
    `);
  }

  /**
   * Expose the database for vector search access.
   */
  getDatabase(): InstanceType<typeof Database> {
    return this.db;
  }

  private ensureDirs(): void {
    try {
      if (!existsSync(this.memoryDir)) {
        mkdirSync(this.memoryDir, { recursive: true });
      }
      const logDir = join(this.memoryDir, "log");
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
    } catch {
      // Non-fatal — may be an invalid path (fallback to :memory: DB)
    }
  }

  private categoryPath(category: string): string {
    if (category === "log") {
      const today = new Date().toISOString().slice(0, 10);
      return join(this.memoryDir, "log", `${today}.md`);
    }
    return join(this.memoryDir, `${category}.md`);
  }

  /**
   * Check if a category file exceeds budget limits.
   */
  private checkBudget(category: string): { withinBudget: boolean; reason?: string } {
    const path = this.categoryPath(category);
    if (!existsSync(path)) return { withinBudget: true };

    // Check file size
    const stat = statSync(path);
    if (stat.size >= this.budget.maxFileSizeBytes) {
      return {
        withinBudget: false,
        reason: `Category '${category}' file exceeds ${Math.round(this.budget.maxFileSizeBytes / 1024)}KB limit (${Math.round(stat.size / 1024)}KB)`,
      };
    }

    // Check entry count
    const entries = this.getCategory(category);
    if (entries.length >= this.budget.maxEntriesPerCategory) {
      return {
        withinBudget: false,
        reason: `Category '${category}' has ${entries.length} entries (limit: ${this.budget.maxEntriesPerCategory})`,
      };
    }

    return { withinBudget: true };
  }

  /**
   * Save an entry to a category. Returns warning if budget exceeded.
   */
  save(category: string, content: string, tags: string[] = []): string | undefined {
    const budgetCheck = this.checkBudget(category);
    let warning: string | undefined;
    if (!budgetCheck.withinBudget) {
      warning = budgetCheck.reason;
    }

    const path = this.categoryPath(category);
    const entry = formatEntry(content, tags);
    appendFileSync(path, entry + "\n");
    // Invalidate cache so next search picks up the new entry
    this.lastIndexTime = 0;
    this.lastEmbeddingIndexTime = 0;
    return warning;
  }

  /**
   * Resolve the effective search mode, falling back to fts5 when
   * required capabilities (embedder, Anthropic provider) are missing.
   */
  private resolveMode(): SearchMode {
    const configured = this.config?.search?.mode ?? "fts5";
    if ((configured === "fts5+vector+rerank" || configured === "vector+rerank") && !this.embedder) {
      return "fts5";
    }
    if (configured.includes("+rerank") && !this.hasAnthropicProvider()) {
      return "fts5";
    }
    return configured;
  }

  /**
   * Check if any provider in config has api === "anthropic-messages".
   */
  private hasAnthropicProvider(): boolean {
    if (!this.config?.models?.providers) return false;
    return Object.values(this.config.models.providers).some(
      (p) => p.api === "anthropic-messages",
    );
  }

  /**
   * Normalize FTS5 ranks so the highest rank = 1.0.
   */
  private normalizeFTSRanks(results: SearchResult[]): SearchResult[] {
    if (results.length === 0) return results;
    const maxRank = Math.max(...results.map((r) => r.rank));
    if (maxRank === 0) return results;
    return results.map((r) => ({ ...r, rank: r.rank / maxRank }));
  }

  /**
   * Search across all categories using the configured search mode.
   * Returns a Promise when config is provided (v0.4+), synchronous array otherwise (backward compat).
   */
  search(query: string, limit?: number): SearchResult[] | Promise<SearchResult[]> {
    const lim = limit ?? 5;
    const trimmed = query.trim();
    if (!trimmed) {
      return this.config ? Promise.resolve([]) : [];
    }

    const mode = this.resolveMode();

    // When config is provided, always return a Promise for consistent async API
    if (this.config) {
      if (mode === "fts5") {
        this.reindexIfStale(5000);
        return Promise.resolve(this.fts5Search(trimmed, lim));
      }
      // asyncSearch handles its own stale reindex (including embeddings)
      return this.asyncSearch(trimmed, lim, mode);
    }

    // Legacy sync path (no config provided)
    this.reindexIfStale(5000);
    return this.fts5Search(trimmed, lim);
  }

  /**
   * Async search dispatch for modes that need embedding or reranking.
   */
  private async asyncSearch(query: string, limit: number, mode: SearchMode): Promise<SearchResult[]> {
    // Ensure embeddings are up-to-date (async reindex refreshes both FTS5 + embeddings)
    await this.reindexIfStaleAsync(5000);

    switch (mode) {
      case "fts5+rerank": {
        const ftsResults = this.fts5Search(query, limit);
        if (!this.config) return ftsResults;
        return (await rerankResults(ftsResults, query, this.config)).slice(0, limit);
      }

      case "fts5+vector+rerank": {
        const ftsResults = this.fts5Search(query, limit * 2);
        let vectorResults: SearchResult[] = [];
        try {
          if (this.embedder) {
            const queryEmb = await this.embedder.embed(query);
            const threshold = this.config?.embedding?.similarityThreshold ?? 0.3;
            vectorResults = vectorSearch(queryEmb, this.db, threshold, limit * 2);
          }
        } catch {
          // Vector search failed, continue with FTS5 only
        }
        const combined = deduplicateResults([...ftsResults, ...vectorResults]);
        if (!this.config) return combined.slice(0, limit);
        return (await rerankResults(combined, query, this.config)).slice(0, limit);
      }

      case "vector+rerank": {
        let vectorResults: SearchResult[] = [];
        try {
          if (this.embedder) {
            const queryEmb = await this.embedder.embed(query);
            const threshold = this.config?.embedding?.similarityThreshold ?? 0.3;
            vectorResults = vectorSearch(queryEmb, this.db, threshold, limit * 2);
          }
        } catch {
          // Vector search failed, fall back to empty
        }
        if (vectorResults.length === 0) {
          // If vector search returned nothing, fall back to FTS5
          return this.fts5Search(query, limit);
        }
        // Supplement with FTS5 if vector results are below minRerank threshold
        const minRerank = this.config?.search?.minRerank ?? 2;
        if (vectorResults.length < minRerank) {
          const ftsResults = this.fts5Search(query, limit * 2);
          vectorResults = deduplicateResults([...vectorResults, ...ftsResults]);
        }
        if (!this.config) return vectorResults.slice(0, limit);
        return (await rerankResults(vectorResults, query, this.config)).slice(0, limit);
      }

      default:
        return this.fts5Search(query, limit);
    }
  }

  /**
   * FTS5 search with rank normalization.
   */
  private fts5Search(query: string, limit: number): SearchResult[] {
    const terms = query.split(/\s+/).filter(Boolean);
    const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");

    try {
      const rows = this.db
        .prepare(
          `SELECT category, timestamp, tags, content, rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{
          category: string;
          timestamp: string;
          tags: string;
          content: string;
          rank: number;
        }>;

      const results = rows.map((row) => ({
        category: row.category,
        content: row.content,
        timestamp: row.timestamp,
        tags: row.tags ? row.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        rank: -row.rank, // FTS5 rank is negative (lower = better), flip for consumer
      }));

      return this.normalizeFTSRanks(results);
    } catch {
      // Fallback to simple matching if FTS5 query fails
      return this.simpleFallbackSearch(terms, limit);
    }
  }

  /**
   * Simple text fallback when FTS5 query syntax fails.
   */
  private simpleFallbackSearch(terms: string[], limit: number): SearchResult[] {
    const scored = this.entries
      .map((entry) => {
        const text = `${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
        const matchCount = terms.filter((t) => text.includes(t.toLowerCase())).length;
        return { entry, rank: matchCount / terms.length };
      })
      .filter((s) => s.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit);

    return scored.map((s) => ({
      category: s.entry.category,
      content: s.entry.content,
      timestamp: s.entry.timestamp,
      tags: s.entry.tags,
      rank: s.rank,
    }));
  }

  /**
   * Reindex if stale (throttled to avoid redundant work).
   */
  reindexIfStale(maxAgeMs: number): void {
    if (Date.now() - this.lastIndexTime < maxAgeMs) return;
    this.reindexFTS();
  }

  /**
   * Async reindex if stale — refreshes both FTS5 and embeddings.
   */
  private async reindexIfStaleAsync(maxAgeMs: number): Promise<void> {
    if (Date.now() - this.lastEmbeddingIndexTime < maxAgeMs) return;
    await this.reindex();
  }

  /**
   * Sync: rebuild FTS5 index from all category files.
   */
  private reindexFTS(): void {
    this.entries = [];

    // Clear existing FTS data
    this.db.exec("DELETE FROM memory_fts");

    // Clear reranker cache on reindex
    clearRerankCache();

    const insert = this.db.prepare(
      "INSERT INTO memory_fts (category, timestamp, tags, content) VALUES (?, ?, ?, ?)",
    );

    const loadCategory = (cat: string) => {
      const path = this.categoryPath(cat);
      if (!existsSync(path)) return;
      const content = readFileSync(path, "utf-8");
      const parsed = parseMemoryFile(content, cat);
      this.entries.push(...parsed);
      for (const entry of parsed) {
        insert.run(entry.category, entry.timestamp, entry.tags.join(", "), entry.content);
      }
    };

    // Index fixed categories
    for (const cat of CATEGORIES) {
      loadCategory(cat);
    }

    // Index today's log
    loadCategory("log");

    this.lastIndexTime = Date.now();
  }

  /**
   * Rebuild the FTS5 index and batch-embed missing entries.
   */
  async reindex(): Promise<void> {
    this.reindexFTS();
    // Batch-embed missing entries
    await this.reindexEmbeddings();
    this.lastEmbeddingIndexTime = Date.now();
  }

  /**
   * Check if the configured mode needs embeddings.
   */
  private needsEmbeddings(): boolean {
    const mode = this.config?.search?.mode ?? "fts5";
    return (mode === "fts5+vector+rerank" || mode === "vector+rerank") && !!this.embedder;
  }

  /**
   * Find entries without embeddings and batch-embed them.
   */
  private async reindexEmbeddings(): Promise<void> {
    if (!this.embedder || !this.needsEmbeddings()) return;

    // Compute hashes for all current entries
    const entryHashes = this.entries.map((e) => ({
      hash: this.entryHash(e),
      entry: e,
    }));

    // Find which ones already have embeddings
    const existingRows = this.db.prepare("SELECT entry_hash FROM memory_embeddings").all() as Array<{ entry_hash: string }>;
    const existingHashes = new Set(existingRows.map((r) => r.entry_hash));

    // Delete orphaned embeddings (entries that no longer exist)
    const currentHashes = new Set(entryHashes.map((eh) => eh.hash));
    for (const row of existingRows) {
      if (!currentHashes.has(row.entry_hash)) {
        this.db.prepare("DELETE FROM memory_embeddings WHERE entry_hash = ?").run(row.entry_hash);
      }
    }

    // Filter to only missing entries
    const missing = entryHashes.filter((eh) => !existingHashes.has(eh.hash));

    if (missing.length === 0) {
      return;
    }

    try {
      const texts = missing.map((m) => m.entry.content);
      const embeddings = await this.embedder.embedBatch(texts);

      const insertEmb = this.db.prepare(
        "INSERT OR REPLACE INTO memory_embeddings (entry_hash, category, timestamp, content, tags, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );

      const count = Math.min(missing.length, embeddings.length);
      for (let i = 0; i < count; i++) {
        const { hash, entry } = missing[i];
        const embBuffer = Buffer.from(embeddings[i].buffer, embeddings[i].byteOffset, embeddings[i].byteLength);
        insertEmb.run(
          hash,
          entry.category,
          entry.timestamp,
          entry.content,
          entry.tags.join(", "),
          embBuffer,
          Date.now(),
        );
      }
    } catch {
      // Embedding failed — continue without vector support
    }
  }

  /**
   * Compute a hash for a memory entry.
   */
  private entryHash(entry: MemoryEntry): string {
    return createHash("sha256")
      .update(`${entry.category}|${entry.timestamp}|${entry.content}`)
      .digest("hex");
  }

  /**
   * Get all entries for a category.
   */
  getCategory(category: string): MemoryEntry[] {
    const path = this.categoryPath(category);
    if (!existsSync(path)) return [];
    return parseMemoryFile(readFileSync(path, "utf-8"), category);
  }

  /**
   * Clear all entries in a category. Returns the number of entries removed.
   */
  clear(category: string): number {
    const path = this.categoryPath(category);
    if (!existsSync(path)) return 0;
    const entries = this.getCategory(category);
    const count = entries.length;
    unlinkSync(path);
    this.lastIndexTime = 0; // Invalidate cache
    this.lastEmbeddingIndexTime = 0;
    return count;
  }

  /**
   * Close the SQLite database.
   */
  close(): void {
    this.db.close();
  }
}
