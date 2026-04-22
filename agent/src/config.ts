/**
 * Configuration loading and defaults for qlaybot.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, cpSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DEFAULT_COMPACTION_CONFIG } from "./compaction/index.js";
import type { CompactionConfig } from "./compaction/index.js";
import type {
  KLayoutConfig,
  SubagentConfig,
  SearchConfig,
  EmbeddingConfig,
} from "./types/v04-contracts.js";

const QLAYBOT_DIR = join(homedir(), ".qlaybot");
const CONFIG_DIR = join(QLAYBOT_DIR, "config");

export interface ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  models: ModelConfig[];
}

export interface MCPTimeouts {
  /** JSON-RPC request timeout in ms (default: 5000) */
  requestMs: number;
  /** Tool execution timeout in ms (default: 300000 = 5 min) */
  toolExecutionMs: number;
  /** Health check timeout in ms (default: 5000) */
  healthCheckMs: number;
  /** Auto-launch backoff delays in ms (default: [1000, 2000, 4000, 8000]) */
  autoLaunchDelaysMs: number[];
}

export interface TUIConfig {
  /** Context usage poll interval in ms (default: 5000) */
  contextPollMs: number;
}

export interface QlayBotConfig {
  agent: {
    defaultModel: string;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
  models: {
    providers: Record<string, ProviderConfig>;
  };
  mcp: Record<string, { url?: string; command?: string; args?: string[]; required?: boolean; disabledTools?: string[] }>;
  mcpTimeouts: MCPTimeouts;
  tui: TUIConfig;
  memory: {
    autoRecall: { enabled: boolean; maxResults: number; minReindexMs: number };
    budget: { maxEntriesPerCategory: number; maxFileSizeBytes: number };
  };
  compaction: CompactionConfig;
  klayout: KLayoutConfig;
  subagent: SubagentConfig;
  search: SearchConfig;
  embedding: EmbeddingConfig;
  /**
   * §4.4 runtime-ephemeral flag. Controls --verbose behavior (disable
   * transcript truncation, print assembled system prompt, per-turn stats,
   * VerboseTranscriptWriter). NEVER serialized to settings.json — excluded
   * at saveSettingsConfig serialization boundary.
   */
  verbose: boolean;
  autoApprovePlans: boolean;
}

/**
 * Bootstrap defaults — overridden by ~/.qlaybot/config/model.json at runtime.
 * These exist so qlaybot can start without onboarding.
 */
function defaultKLayoutConfig(): KLayoutConfig {
  return {
    url: process.env.KLAYOUT_MCP_URL ?? "http://127.0.0.1:8765/mcp",
    required: true,
    autoLaunch: true,
    disabledTools: [],
  };
}

function defaultSubagentConfig(): SubagentConfig {
  return {
    enabled: true,
    logDir: join(homedir(), ".qlaybot", "subagent-logs"),
    maxLogFiles: 100,
    roles: {
      scout: {
        label: "Scout",
        promptFile: "subagent/scout.md",
        workspaceFiles: ["TOOLS.md"],
        baseTools: ["read"],
        customTools: ["memory_search", "submit_result"],
        mcpAccess: "shared-readonly",
        maxTurns: 100,
        maxTokens: 200000,
      },
      designer: {
        label: "Designer",
        promptFile: "subagent/designer.md",
        workspaceFiles: ["TOOLS.md", "RULES.md"],
        baseTools: ["read", "bash", "write"],
        customTools: ["memory_search", "submit_result"],
        mcpAccess: "full",
        maxTurns: 100,
        maxTokens: 200000,
      },
      analyst: {
        label: "Analyst",
        promptFile: "subagent/analyst.md",
        workspaceFiles: ["TOOLS.md"],
        baseTools: ["read", "bash", "write", "edit"],
        customTools: ["memory_search", "submit_result"],
        mcpAccess: "shared-readonly",
        maxTurns: 100,
        maxTokens: 200000,
      },
      planner: {
        label: "Planner",
        promptFile: "subagent/planner.md",
        workspaceFiles: ["TOOLS.md"],
        baseTools: ["read"],
        customTools: ["memory_search", "submit_result"],
        mcpAccess: "shared-readonly",
        maxTurns: 100,
        maxTokens: 200000,
      },
    },
  };
}

function defaultSearchConfig(): SearchConfig {
  return {
    mode: "fts5",
    minRerank: 4,
    rerankMinScore: 0.3,
    rerankMaxTokens: 256,
  };
}

function defaultEmbeddingConfig(): EmbeddingConfig {
  return {
    api: "openai-embeddings",
    baseUrl: "",
    apiKey: "",
    model: "text-embedding-3-small",
    dimensions: 1536,
    similarityThreshold: 0.3,
  };
}

function defaultConfig(): QlayBotConfig {
  return {
    agent: {
      defaultModel: process.env.QLAYBOT_MODEL ?? "custom-anthropic/claude-sonnet-4-6",
      thinkingLevel: (process.env.QLAYBOT_THINKING as QlayBotConfig["agent"]["thinkingLevel"]) ?? "high",
    },
    models: {
      providers: {
        "custom-anthropic": {
          baseUrl: process.env.QLAYBOT_API_BASE_URL ?? "https://bench.physcai.com/api",
          apiKey: process.env.ANTHROPIC_API_KEY ?? "",
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
            {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
              contextWindow: 1000000,
              maxTokens: 65536,
            },
            {
              id: "claude-sonnet-4-5-20250929",
              name: "Claude Sonnet 4.5",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
              contextWindow: 200000,
              maxTokens: 65536,
            },
            {
              id: "claude-haiku-4-5-20251001",
              name: "Claude Haiku 4.5",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
              contextWindow: 200000,
              maxTokens: 65536,
            },
          ],
        },
      },
    },
    mcp: {
      klayout_mcp: { url: process.env.KLAYOUT_MCP_URL ?? "http://127.0.0.1:8765/mcp", required: true },
    },
    mcpTimeouts: {
      requestMs: 5000,
      toolExecutionMs: 300000,
      healthCheckMs: 5000,
      autoLaunchDelaysMs: [1000, 2000, 4000, 8000],
    },
    tui: {
      contextPollMs: 5000,
    },
    memory: {
      autoRecall: { enabled: true, maxResults: 3, minReindexMs: 5000 },
      budget: { maxEntriesPerCategory: 500, maxFileSizeBytes: 512 * 1024 },
    },
    compaction: { ...DEFAULT_COMPACTION_CONFIG },
    klayout: defaultKLayoutConfig(),
    subagent: defaultSubagentConfig(),
    search: defaultSearchConfig(),
    embedding: defaultEmbeddingConfig(),
    verbose: false,
    autoApprovePlans: true,
  };
}

/**
 * Load configuration from config files.
 * Falls back to defaults for missing values.
 *
 * @param configDir Optional config directory path. Defaults to ~/.qlaybot/config/.
 */
export function loadConfig(configDir?: string): QlayBotConfig {
  const cfgDir = configDir ?? CONFIG_DIR;
  const config = defaultConfig();

  // Override apiKey from env if available
  if (process.env.ANTHROPIC_API_KEY) {
    for (const provider of Object.values(config.models.providers)) {
      if (!provider.apiKey) {
        provider.apiKey = process.env.ANTHROPIC_API_KEY;
      }
    }
  }

  try {
    const modelPath = join(cfgDir, "model.json");
    if (existsSync(modelPath)) {
      const modelConfig = JSON.parse(readFileSync(modelPath, "utf-8"));
      if (modelConfig.defaultModel) config.agent.defaultModel = modelConfig.defaultModel;
      if (modelConfig.thinkingLevel) config.agent.thinkingLevel = modelConfig.thinkingLevel;
      // Env vars take precedence over file config (allows runtime override without rebuild)
      if (process.env.QLAYBOT_MODEL) config.agent.defaultModel = process.env.QLAYBOT_MODEL;
      if (process.env.QLAYBOT_THINKING) config.agent.thinkingLevel = process.env.QLAYBOT_THINKING as QlayBotConfig["agent"]["thinkingLevel"];
      if (modelConfig.providers) {
        config.models.providers = modelConfig.providers;
        // Still apply env var override
        if (process.env.ANTHROPIC_API_KEY) {
          for (const provider of Object.values(config.models.providers)) {
            if (!provider.apiKey) {
              provider.apiKey = process.env.ANTHROPIC_API_KEY;
            }
          }
        }
      }
    }

    const mcpPath = join(cfgDir, "mcp.json");
    if (existsSync(mcpPath)) {
      config.mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
    }

    // --- Migration: extract klayout_mcp from mcp.json ---
    const klayoutPath = join(cfgDir, "klayout.json");
    if (config.mcp.klayout_mcp) {
      if (!existsSync(klayoutPath)) {
        // Create klayout.json from klayout_mcp entry
        const klayoutMcp = config.mcp.klayout_mcp;
        const klayoutData: KLayoutConfig = {
          url: klayoutMcp.url ?? defaultKLayoutConfig().url,
          required: klayoutMcp.required ?? true,
          autoLaunch: true,
          disabledTools: [],
        };
        mkdirSync(cfgDir, { recursive: true });
        writeFileSync(join(cfgDir, "klayout.json"), JSON.stringify(klayoutData, null, 2));
      }
      // Always remove klayout_mcp from mcp config and rewrite
      delete config.mcp.klayout_mcp;
      writeFileSync(join(cfgDir, "mcp.json"), JSON.stringify(config.mcp, null, 2));
    }

    // --- Migration: bare model ID rewrite ---
    if (config.agent.defaultModel && !config.agent.defaultModel.includes("/")) {
      config.agent.defaultModel = `custom-anthropic/${config.agent.defaultModel}`;
      // Rewrite model.json with the updated defaultModel
      if (existsSync(modelPath)) {
        const modelData = JSON.parse(readFileSync(modelPath, "utf-8"));
        modelData.defaultModel = config.agent.defaultModel;
        writeFileSync(modelPath, JSON.stringify(modelData, null, 2));
      }
    }

    // --- Load klayout.json (4th config file) ---
    if (existsSync(klayoutPath)) {
      const klayoutData = JSON.parse(readFileSync(klayoutPath, "utf-8"));
      config.klayout = {
        ...defaultKLayoutConfig(),
        ...klayoutData,
      };
    }

    const settingsPath = join(cfgDir, "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.memory?.autoRecall) {
        Object.assign(config.memory.autoRecall, settings.memory.autoRecall);
      }
      if (settings.memory?.budget) {
        Object.assign(config.memory.budget, settings.memory.budget);
      }
      if (settings.mcpTimeouts) {
        Object.assign(config.mcpTimeouts, settings.mcpTimeouts);
      }
      if (settings.tui) {
        Object.assign(config.tui, settings.tui);
      }
      if (settings.compaction) {
        Object.assign(config.compaction, settings.compaction);
        if (settings.compaction.toolResultPruning) {
          Object.assign(config.compaction.toolResultPruning, settings.compaction.toolResultPruning);
        }
      }
      if (settings.subagent) {
        const defaults = defaultSubagentConfig();
        config.subagent = { ...defaults, ...settings.subagent };
        // Deep merge roles: user roles override defaults, but empty user roles don't wipe defaults
        if (!settings.subagent.roles || Object.keys(settings.subagent.roles).length === 0) {
          config.subagent.roles = defaults.roles;
        } else {
          config.subagent.roles = { ...defaults.roles, ...settings.subagent.roles };
        }
      }
      if (settings.search) {
        config.search = { ...defaultSearchConfig(), ...settings.search };
      }
      if (settings.embedding) {
        config.embedding = { ...defaultEmbeddingConfig(), ...settings.embedding };
      }
      if (typeof settings.autoApprovePlans === "boolean") {
        config.autoApprovePlans = settings.autoApprovePlans;
      }
    }
  } catch {
    // Use defaults on error
  }

  return config;
}

/**
 * Save ONLY klayout fields to klayout.json.
 */
export function saveKLayoutConfig(config: QlayBotConfig, configDir?: string): void {
  const cfgDir = configDir ?? CONFIG_DIR;
  mkdirSync(cfgDir, { recursive: true });
  const data = {
    url: config.klayout.url,
    required: config.klayout.required,
    autoLaunch: config.klayout.autoLaunch,
    disabledTools: config.klayout.disabledTools,
  };
  writeFileSync(join(cfgDir, "klayout.json"), JSON.stringify(data, null, 2));
}

/**
 * Save ONLY model fields to model.json.
 */
export function saveModelConfig(config: QlayBotConfig, configDir?: string): void {
  const cfgDir = configDir ?? CONFIG_DIR;
  mkdirSync(cfgDir, { recursive: true });
  const data = {
    defaultModel: config.agent.defaultModel,
    thinkingLevel: config.agent.thinkingLevel,
    providers: config.models.providers,
  };
  writeFileSync(join(cfgDir, "model.json"), JSON.stringify(data, null, 2));
}

/**
 * Save ONLY MCP server entries to mcp.json.
 */
export function saveMCPConfig(config: QlayBotConfig, configDir?: string): void {
  const cfgDir = configDir ?? CONFIG_DIR;
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "mcp.json"), JSON.stringify(config.mcp, null, 2));
}

/**
 * Save ONLY settings fields to settings.json.
 */
export function saveSettingsConfig(config: QlayBotConfig, configDir?: string): void {
  const cfgDir = configDir ?? CONFIG_DIR;
  mkdirSync(cfgDir, { recursive: true });
  const data = {
    memory: config.memory,
    mcpTimeouts: config.mcpTimeouts,
    tui: config.tui,
    compaction: config.compaction,
    subagent: config.subagent,
    search: config.search,
    embedding: config.embedding,
    autoApprovePlans: config.autoApprovePlans,
  };
  writeFileSync(join(cfgDir, "settings.json"), JSON.stringify(data, null, 2));
}

/**
 * 5-step model resolver.
 *
 * 1. Exact provider/modelId match
 * 2. Any-provider scan (bare model ID)
 * 3. Prefix match
 * 4. First model fallback
 * 5. Error if no providers/models exist
 */
export function resolveModel(
  ref: string,
  config: QlayBotConfig,
): { provider: string; model: ModelConfig; providerConfig: ProviderConfig } {
  const providers = config.models.providers;
  const providerEntries = Object.entries(providers);

  if (providerEntries.length === 0) {
    throw new Error(`No model providers configured. Cannot resolve "${ref}".`);
  }

  // Step 1: Exact provider/modelId match
  const slashIdx = ref.indexOf("/");
  if (slashIdx > 0) {
    const providerName = ref.slice(0, slashIdx);
    const modelId = ref.slice(slashIdx + 1);
    const providerConfig = providers[providerName];
    if (providerConfig) {
      const model = providerConfig.models.find((m) => m.id === modelId);
      if (model) {
        return { provider: providerName, model, providerConfig };
      }
    }
  }

  // Step 2: Any-provider scan (bare model ID)
  const bareId = slashIdx > 0 ? ref.slice(slashIdx + 1) : ref;
  for (const [providerName, providerConfig] of providerEntries) {
    const model = providerConfig.models.find((m) => m.id === bareId);
    if (model) {
      return { provider: providerName, model, providerConfig };
    }
  }

  // Step 3: Prefix match
  for (const [providerName, providerConfig] of providerEntries) {
    const model = providerConfig.models.find((m) => m.id.startsWith(bareId));
    if (model) {
      return { provider: providerName, model, providerConfig };
    }
  }

  // Step 4: First model fallback
  for (const [providerName, providerConfig] of providerEntries) {
    if (providerConfig.models.length > 0) {
      return { provider: providerName, model: providerConfig.models[0], providerConfig };
    }
  }

  // Step 5: Error
  throw new Error(`No models available across any provider. Cannot resolve "${ref}".`);
}

/**
 * Parse model reference: "provider/modelId" or just "modelId".
 */
export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const slashIdx = ref.indexOf("/");
  if (slashIdx > 0) {
    return { provider: ref.slice(0, slashIdx), modelId: ref.slice(slashIdx + 1) };
  }
  return { provider: "custom-anthropic", modelId: ref };
}

/**
 * Merge config.mcp (generic MCP servers) with config.klayout (KLayout server)
 * into a unified server map that MCPManager can consume.
 */
export function getAllMCPServers(config: QlayBotConfig): Record<string, { url?: string; command?: string; args?: string[]; required?: boolean; disabledTools?: string[] }> {
  const servers: Record<string, { url?: string; command?: string; args?: string[]; required?: boolean; disabledTools?: string[] }> = { ...config.mcp };
  servers.klayout = {
    url: config.klayout.url,
    required: config.klayout.required,
    disabledTools: config.klayout.disabledTools,
  };
  return servers;
}

export function getQlayBotDir(): string {
  return QLAYBOT_DIR;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getWorkspaceDir(): string {
  return join(QLAYBOT_DIR, "workspace");
}

export function getMemoryDir(): string {
  return join(QLAYBOT_DIR, "memory");
}

export function getSessionsDir(): string {
  return join(QLAYBOT_DIR, "sessions");
}

export function getHistoryPath(): string {
  return join(QLAYBOT_DIR, "history.json");
}

export function isInitialized(): boolean {
  return existsSync(QLAYBOT_DIR) && existsSync(CONFIG_DIR);
}

/**
 * Initialize ~/.qlaybot/ with defaults.
 *
 * @param templateDir  Workspace template source directory.
 * @param baseDir      Optional base directory (defaults to QLAYBOT_DIR).
 *                     When provided, all paths are relative to baseDir instead of ~/.qlaybot/.
 */
export function initializeUserDir(templateDir: string, baseDir?: string): void {
  const rootDir = baseDir ?? QLAYBOT_DIR;
  const cfgDir = join(rootDir, "config");
  const wsDir = join(rootDir, "workspace");
  const memDir = join(rootDir, "memory");
  const sessDir = join(rootDir, "sessions");

  // Create directories
  for (const dir of [rootDir, cfgDir, wsDir, memDir, sessDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Write default config files if they don't exist
  const modelPath = join(cfgDir, "model.json");
  if (!existsSync(modelPath)) {
    const config = defaultConfig();
    writeFileSync(modelPath, JSON.stringify({
      defaultModel: config.agent.defaultModel,
      thinkingLevel: config.agent.thinkingLevel,
      providers: config.models.providers,
    }, null, 2));
  }

  const mcpPath = join(cfgDir, "mcp.json");
  if (!existsSync(mcpPath)) {
    writeFileSync(mcpPath, JSON.stringify(defaultConfig().mcp, null, 2));
  }

  const settingsPath = join(cfgDir, "settings.json");
  if (!existsSync(settingsPath)) {
    const defaults = defaultConfig();
    writeFileSync(settingsPath, JSON.stringify({
      memory: defaults.memory,
      mcpTimeouts: defaults.mcpTimeouts,
      tui: defaults.tui,
      compaction: defaults.compaction,
      subagent: defaults.subagent,
      search: defaults.search,
      embedding: defaults.embedding,
      autoApprovePlans: defaults.autoApprovePlans,
    }, null, 2));
  }

  // Copy workspace template
  if (existsSync(templateDir)) {
    cpSync(templateDir, wsDir, { recursive: true, force: false });
  }

  // Ensure memory subdirs
  const logDir = join(memDir, "log");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Remove ~/.qlaybot/.
 */
export function removeUserDir(): void {
  rmSync(QLAYBOT_DIR, { recursive: true, force: true });
}
