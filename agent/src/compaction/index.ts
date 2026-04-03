/**
 * Compaction system for qlaybot.
 * Manages context window compaction with KLayout-domain awareness.
 */

export interface ToolResultPruningConfig {
  enabled: boolean;
  keepRecentResults: number;
  minResultSizeBytes: number;
  neverPruneTools: string[];
}

export interface CompactionConfig {
  enabled: boolean;
  autoThreshold: number;
  warningThreshold: number;
  toolResultPruning: ToolResultPruningConfig;
}

export const DEFAULT_TOOL_RESULT_PRUNING: ToolResultPruningConfig = {
  enabled: true,
  keepRecentResults: 3,
  minResultSizeBytes: 500,
  neverPruneTools: [],
};

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  autoThreshold: 90,
  warningThreshold: 70,
  toolResultPruning: { ...DEFAULT_TOOL_RESULT_PRUNING },
};

/**
 * Resolve a partial compaction config into a full CompactionConfig with defaults.
 */
export function resolveCompactionConfig(
  partial?: Partial<CompactionConfig> & { toolResultPruning?: Partial<ToolResultPruningConfig> },
): CompactionConfig {
  if (!partial) return { ...DEFAULT_COMPACTION_CONFIG, toolResultPruning: { ...DEFAULT_TOOL_RESULT_PRUNING } };
  return {
    enabled: partial.enabled ?? DEFAULT_COMPACTION_CONFIG.enabled,
    autoThreshold: partial.autoThreshold ?? DEFAULT_COMPACTION_CONFIG.autoThreshold,
    warningThreshold: partial.warningThreshold ?? DEFAULT_COMPACTION_CONFIG.warningThreshold,
    toolResultPruning: {
      ...DEFAULT_TOOL_RESULT_PRUNING,
      ...partial.toolResultPruning,
    },
  };
}

export { loadCompactPrompt, buildCompactInstructions } from "./prompt-loader.js";
export { createToolResultPruner } from "./tool-result-pruner.js";
export { extractStateFiles, extractTag } from "./state-extractor.js";
export { createStateLoaderTransform, loadStateBlock } from "./state-loader.js";
