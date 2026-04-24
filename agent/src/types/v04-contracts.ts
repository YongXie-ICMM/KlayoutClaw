/**
 * v0.4 Cross-boundary interfaces and types.
 *
 * ALL groups import from this file. Changes here break contract tests.
 */

// ---------------------------------------------------------------------------
// Config: KLayout (Spec 1 §2.1)
// ---------------------------------------------------------------------------

export interface KLayoutConfig {
  url: string;
  required: boolean;
  autoLaunch: boolean;
  disabledTools: string[];
}

// ---------------------------------------------------------------------------
// Tool Annotations (Spec 1 §6.5)
// ---------------------------------------------------------------------------

export interface ToolAnnotation {
  name: string;
  readonly?: boolean;
  readwrite?: boolean;
  backgroundable?: boolean;
}

// ---------------------------------------------------------------------------
// Focus States (Spec 1 §7.2) — exactly 9 states
// ---------------------------------------------------------------------------

export type FocusState =
  | "input"
  | "completion"
  | "bar-select"
  | "config-panel"
  | "workspace-bar"
  | "background-bar"
  | "subagent-summary"
  | "subagent-inspect"
  | "subagent-inject";

// ---------------------------------------------------------------------------
// Config Panel (Spec 1 §5)
// ---------------------------------------------------------------------------

export type ConfigPanelTab = "settings" | "models" | "mcp";

export interface ConfigPanelState {
  open: boolean;
  tab: ConfigPanelTab;
  editing: boolean;
  editValue: string;
  cursors: {
    settings: number;
    models: number;
    mcp: number;
  };
  mcpDrilldown: {
    level: "servers" | "tools";
    selectedServer: string | null;
    toolIndex: number;
  };
}

// ---------------------------------------------------------------------------
// CommandResult extension (Spec 1 §5.2)
// ---------------------------------------------------------------------------

export interface CommandResultStateChange {
  planMode?: boolean;
  showThinking?: boolean;
  configPanel?: {
    open: boolean;
    tab: ConfigPanelTab;
  };
}

// ---------------------------------------------------------------------------
// Subagent Config (Spec 2 §2)
// ---------------------------------------------------------------------------

export interface SubagentConfig {
  enabled: boolean;
  logDir: string;
  maxLogFiles: number;
  roles: Record<string, RoleConfig>;
}

export interface RoleConfig {
  label: string;
  promptFile: string;
  workspaceFiles: string[];
  baseTools: string[];
  customTools: string[];
  mcpAccess: "shared-readonly" | "full" | "none";
  maxTurns: number;
  maxTokens: number;
  model?: string;
  thinkingLevel?: string;
  /** Inline system prompt — takes precedence over promptFile when set. */
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Subagent Result (Spec 2 §3.3)
// ---------------------------------------------------------------------------

export type SubagentRole = string;

export interface SubagentResult {
  role: SubagentRole;
  task: string;
  status: "completed" | "partial" | "error";
  findings: string[];
  warnings: string[];
  dataPaths: string[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    turns: number;
  };
  transcriptPath: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Subagent Run Options (Spec 2 §3.1 + §4.1)
// ---------------------------------------------------------------------------

export interface SubagentRunOptions {
  role: string;
  task: string;
  context?: string;
}

// ---------------------------------------------------------------------------
// Subagent TUI (Spec 2 §5)
// ---------------------------------------------------------------------------

export interface SubagentTUIEntry {
  id: string;
  toolCallId: string;
  role: string;
  task: string;
  status: "running" | "completed" | "partial" | "error";
  startTime: number;
  endTime?: number;
  tokenUsage?: string;
  segments: SubagentSegment[];
  currentTool?: string;
  findings?: number;
  warnings?: number;
  errorMessage?: string;
}

export type SubagentSegment =
  | ThinkingSegment
  | TextSegment
  | ToolCallSegment
  | InjectedSegment;

export interface ThinkingSegment {
  type: "thinking";
  text: string;
}

export interface TextSegment {
  type: "text";
  text: string;
}

export interface ToolCallSegment {
  type: "tool_call";
  toolName: string;
  args: string;
  result?: string;
  status: "running" | "done" | "error";
}

export interface InjectedSegment {
  type: "injected";
  text: string;
}

// ---------------------------------------------------------------------------
// Runner Event Payloads (Spec 2 §5.6-5.7)
// ---------------------------------------------------------------------------

export interface StartedEvent {
  subagentId: string;
  toolCallId: string;
  role: string;
  task: string;
}

export interface ThinkingEvent {
  subagentId: string;
  text: string;
}

export interface TextEvent {
  subagentId: string;
  text: string;
}

export interface ToolStartEvent {
  subagentId: string;
  toolName: string;
  args: string;
}

export interface ToolEndEvent {
  subagentId: string;
  toolName: string;
  result: string;
}

// ---------------------------------------------------------------------------
// Search & Retrieval (Spec 3)
// ---------------------------------------------------------------------------

export type SearchMode =
  | "fts5"
  | "fts5+rerank"
  | "fts5+vector+rerank"
  | "vector+rerank";

export interface SearchConfig {
  mode: SearchMode;
  minRerank: number;
  rerankMinScore: number;
  rerankMaxTokens: number;
}

export interface EmbeddingConfig {
  api: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  similarityThreshold: number;
}

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions: number;
}

export interface RerankResult {
  entryHash: string;
  score: number;
}
