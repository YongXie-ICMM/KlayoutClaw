/**
 * Shared config factories for v0.4 tests.
 */

import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { afterEach } from "vitest";
import type { QlayBotConfig } from "../../src/config.js";
import type {
  KLayoutConfig,
  SubagentConfig,
  SearchConfig,
  EmbeddingConfig,
} from "../../src/types/v04-contracts.js";

// Track temp dirs for cleanup
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tmpDirs.length = 0;
});

export function makeTmpDir(): string {
  const dir = join(tmpdir(), `qlaybot-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

export function makeKLayoutConfig(
  overrides?: Partial<KLayoutConfig>,
): KLayoutConfig {
  return {
    url: "http://127.0.0.1:8765/mcp",
    required: true,
    autoLaunch: true,
    disabledTools: [],
    ...overrides,
  };
}

export function makeSubagentConfig(
  overrides?: Partial<SubagentConfig>,
): SubagentConfig {
  return {
    enabled: true,
    logDir: join(tmpdir(), "qlaybot-subagent-logs"),
    maxLogFiles: 100,
    roles: {},
    ...overrides,
  };
}

export function makeSearchConfig(
  overrides?: Partial<SearchConfig>,
): SearchConfig {
  return {
    mode: "fts5",
    minRerank: 4,
    rerankMinScore: 0.3,
    rerankMaxTokens: 256,
    ...overrides,
  };
}

export function makeEmbeddingConfig(
  overrides?: Partial<EmbeddingConfig>,
): EmbeddingConfig {
  return {
    api: "openai-embeddings",
    baseUrl: "",
    apiKey: "",
    model: "text-embedding-3-small",
    dimensions: 1536,
    similarityThreshold: 0.3,
    ...overrides,
  };
}

export function makeConfig(
  overrides?: Partial<QlayBotConfig> & {
    klayout?: Partial<KLayoutConfig>;
    subagent?: Partial<SubagentConfig>;
    search?: Partial<SearchConfig>;
    embedding?: Partial<EmbeddingConfig>;
  },
): QlayBotConfig & {
  klayout: KLayoutConfig;
  subagent: SubagentConfig;
  search: SearchConfig;
  embedding: EmbeddingConfig;
} {
  const {
    klayout,
    subagent,
    search,
    embedding,
    ...rest
  } = overrides ?? {};

  const base: QlayBotConfig = {
    agent: {
      defaultModel: "custom-anthropic/claude-sonnet-4-6",
      thinkingLevel: "high",
    },
    models: {
      providers: {
        "custom-anthropic": {
          baseUrl: "https://bench.physcai.com/api",
          apiKey: "test-key",
          api: "anthropic-messages",
          models: [
            {
              id: "claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
              contextWindow: 200000,
              maxTokens: 65536,
            },
          ],
        },
      },
    },
    mcp: {},
    mcpTimeouts: {
      requestMs: 5000,
      toolExecutionMs: 300000,
      healthCheckMs: 5000,
      autoLaunchDelaysMs: [1000, 2000, 4000, 8000],
    },
    tui: { contextPollMs: 5000 },
    memory: {
      autoRecall: { enabled: true, maxResults: 3, minReindexMs: 5000 },
      budget: { maxEntriesPerCategory: 500, maxFileSizeBytes: 512 * 1024 },
    },
    compaction: {
      enabled: true,
      autoThreshold: 90,
      warningThreshold: 70,
      toolResultPruning: {
        keepRecentResults: 3,
        minResultSizeBytes: 500,
        neverPruneTools: [],
      },
    },
    ...rest,
  };

  return {
    ...base,
    klayout: makeKLayoutConfig(klayout),
    subagent: makeSubagentConfig(subagent),
    search: makeSearchConfig(search),
    embedding: makeEmbeddingConfig(embedding),
  };
}

export function writeConfigFiles(
  tmpDir: string,
  config: ReturnType<typeof makeConfig>,
): void {
  const configDir = join(tmpDir, "config");
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, "model.json"),
    JSON.stringify(
      {
        defaultModel: config.agent.defaultModel,
        thinkingLevel: config.agent.thinkingLevel,
        providers: config.models.providers,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(configDir, "klayout.json"),
    JSON.stringify(
      {
        url: config.klayout.url,
        required: config.klayout.required,
        autoLaunch: config.klayout.autoLaunch,
        disabledTools: config.klayout.disabledTools,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(configDir, "mcp.json"),
    JSON.stringify(config.mcp, null, 2),
  );

  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify(
      {
        memory: config.memory,
        mcpTimeouts: config.mcpTimeouts,
        tui: config.tui,
        compaction: config.compaction,
        subagent: config.subagent,
        search: config.search,
        embedding: config.embedding,
      },
      null,
      2,
    ),
  );
}
