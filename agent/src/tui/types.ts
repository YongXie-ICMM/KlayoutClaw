/**
 * TUI state and action types.
 */

import type { FocusState, ConfigPanelState, ConfigPanelTab, SubagentTUIEntry } from "../types/v04-contracts.js";
import type { TranscriptMarker } from "../events/marker-types.js";
import type { PlanState } from "../planning/state-machine.js";

export type { FocusState } from "../types/v04-contracts.js";
export type { ConfigPanelState, ConfigPanelTab } from "../types/v04-contracts.js";
export type { SubagentTUIEntry } from "../types/v04-contracts.js";

export type SessionPhase =
  | "initializing"
  | "ready"
  | "streaming"
  | "tool_executing"
  | "error"
  | "disposed";

export interface ToolExecution {
  id: string;
  toolName: string;
  args: unknown;
  status: "running" | "completed" | "error" | "backgrounded";
  result?: unknown;
  startTime: number;
  endTime?: number;
  backgroundTaskId?: string;
}

export interface BackgroundTaskSummaryTUI {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface ContextSection {
  title: string;
  summary: string;
  details?: string | string[];
}

export type AssistantSegment =
  | { type: "thinking"; chunks: string[]; source?: "tool" | "native" | "inline" }
  | { type: "text"; chunks: string[] }
  | { type: "tool"; tool: ToolExecution };

export interface AssistantMessageData {
  id: string;
  role: "assistant";
  segments: AssistantSegment[];
  textChunks: string[];
  thinkingChunks: string[];
  tools: ToolExecution[];
  isStreaming: boolean;
  startedAt?: number;
  completedAt?: number;
}

export interface UserMessageData {
  id: string;
  role: "user";
  text: string;
}

export interface SystemMessageData {
  id: string;
  role: "system";
  text: string;
  sections?: ContextSection[];
}

export type MessageData = AssistantMessageData | UserMessageData | SystemMessageData;

export interface TUIState {
  phase: SessionPhase;
  modelName: string;
  thinkingLevel: string;
  messages: MessageData[];
  currentAssistant: AssistantMessageData | null;
  error: string | null;
  planMode: boolean;
  showThinking: boolean;
  backgroundTaskCount: number;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  } | null;
  contextUsage: {
    tokens: number;
    contextWindow: number;
    percent: number;
  } | null;
  // v0.3 additions
  isCompacting: boolean;
  inPlanMode: boolean;
  toolDetailExpanded: boolean;
  thinkingExpanded: boolean;
  backgroundTasks: BackgroundTaskSummaryTUI[];
  // v0.4 additions
  focusState: FocusState;
  completionIndex: number;
  completionMatches: string[];
  selectedBar: string;
  inputText: string;
  configPanel: ConfigPanelState;
  // v0.4 Phase G: subagent panel
  subagents: SubagentTUIEntry[];
  subagentPanelOpen: boolean;
  subagentSummaryIndex: number;
  subagentInspectId: string | null;
  subagentInspectScroll: number;
  subagentInjectMode: boolean;
  subagentInjectTarget: string | null;
  subagentInjectValue: string;
  // v0.4.3 Group 3: plan mode exit menu (null when closed, holds plan file path when open)
  planExitMenu: string | null;
  // v0.4.4 Phase 2a: marker-driven plan approval gate
  planState: PlanState | null;
  planApprovalMenuPath: string | null;
}

export type TUIAction =
  | { type: "SESSION_READY"; modelName: string; thinkingLevel: string }
  | { type: "USER_PROMPT"; text: string }
  | { type: "STREAM_START" }
  | { type: "TEXT_DELTA"; delta: string }
  | { type: "THINKING_DELTA"; delta: string; source?: "tool" | "native" | "inline" }
  | { type: "TOOL_START"; toolCallId: string; toolName: string; args: unknown }
  | { type: "TOOL_UPDATE"; toolCallId: string; partialResult: unknown }
  | { type: "TOOL_END"; toolCallId: string; result: unknown; isError: boolean }
  | { type: "AGENT_END" }
  | { type: "USAGE_UPDATE"; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  | { type: "SESSION_ERROR"; error: string }
  | { type: "CLEAR_MESSAGES" }
  | { type: "SYSTEM_MESSAGE"; text: string; sections?: ContextSection[] }
  | { type: "CONTEXT_USAGE_UPDATE"; tokens: number; contextWindow: number; percent: number }
  | { type: "COMMAND_RESULT"; output: string; stateChange?: { planMode?: boolean; showThinking?: boolean; configPanel?: { open: boolean; tab: string } }; sections?: ContextSection[] }
  | { type: "TOGGLE_THINKING_VIEW" }
  | { type: "BACKGROUND_UPDATE"; taskCount: number }
  // v0.3 actions
  | { type: "BG_TASK_CREATED"; task: BackgroundTaskSummaryTUI }
  | { type: "BG_TASK_COMPLETED"; taskId: string; completedAt: number }
  | { type: "BG_TASK_FAILED"; taskId: string; error: string }
  | { type: "BG_TASK_CANCELLED"; taskId: string }
  | { type: "COMPACTION_START" }
  | { type: "COMPACTION_END" }
  | { type: "PLAN_MODE_ENTERED" }
  | { type: "PLAN_MODE_EXITED" }
  | { type: "PLAN_EXIT_MENU_OPEN"; planFilePath: string }
  | { type: "PLAN_EXIT_MENU_CLOSE" }
  | { type: "PLAN_MARKER_RECEIVED"; marker: TranscriptMarker }
  | { type: "TOGGLE_DETAIL_VIEW" }
  // v0.4 actions
  | { type: "FOCUS_UP"; hasCompletions: boolean }
  | { type: "FOCUS_DOWN"; inputText: string }
  | { type: "FOCUS_ESCAPE" }
  | { type: "COMPLETION_UP" }
  | { type: "COMPLETION_DOWN" }
  | { type: "COMPLETION_SELECT"; command: string }
  | { type: "BAR_SELECT_DOWN" }
  | { type: "BAR_SELECT_UP" }
  | { type: "TOGGLE_WORKSPACE" }
  | { type: "TOGGLE_BACKGROUND" }
  // v0.4 config panel actions
  | { type: "CONFIG_PANEL_OPEN"; tab: ConfigPanelTab }
  | { type: "CONFIG_PANEL_CLOSE" }
  | { type: "CONFIG_PANEL_TAB_CHANGE"; tab: ConfigPanelTab }
  | { type: "CONFIG_PANEL_NAVIGATE"; direction: "up" | "down" }
  | { type: "CONFIG_PANEL_SELECT" }
  | { type: "CONFIG_PANEL_EDIT_START"; currentValue: string }
  | { type: "CONFIG_PANEL_EDIT_CONFIRM"; newValue: string }
  | { type: "CONFIG_PANEL_EDIT_CANCEL" }
  // v0.4 Phase C2: MCP drilldown actions
  | { type: "CONFIG_PANEL_MCP_DRILLDOWN"; server: string }
  | { type: "CONFIG_PANEL_MCP_BACK" }
  | { type: "CONFIG_PANEL_MCP_RECONNECT"; server: string }
  | { type: "CONFIG_PANEL_MCP_TOGGLE_TOOL"; tool: string; server: string }
  // v0.4 Phase G: subagent actions
  | { type: "TOGGLE_SUBAGENT_PANEL" }
  | { type: "SUBAGENT_PLACEHOLDER"; toolCallId: string; role: string; task: string }
  | { type: "SUBAGENT_CANCEL_PLACEHOLDER"; toolCallId: string; reason?: string }
  | { type: "SUBAGENT_START"; subagentId: string; toolCallId: string }
  | { type: "SUBAGENT_THINKING"; subagentId: string; text: string }
  | { type: "SUBAGENT_TEXT"; subagentId: string; text: string }
  | { type: "SUBAGENT_TOOL_START"; subagentId: string; toolName: string; args: string }
  | { type: "SUBAGENT_TOOL_END"; subagentId: string; toolName: string; result: string }
  | { type: "SUBAGENT_INJECT"; subagentId: string; text: string }
  | { type: "SUBAGENT_END"; subagentId: string; status: string; findings?: number; warnings?: number; tokenUsage?: string; errorMessage?: string }
  | { type: "SUBAGENT_NAVIGATE"; direction: "up" | "down" }
  | { type: "SUBAGENT_INSPECT"; subagentId: string }
  | { type: "SUBAGENT_INSPECT_NAV"; direction: "left" | "right" }
  | { type: "SUBAGENT_INSPECT_SCROLL"; direction: "up" | "down" }
  | { type: "SUBAGENT_INJECT_START"; subagentId: string }
  | { type: "SUBAGENT_INJECT_CANCEL" }
  | { type: "SUBAGENT_INJECT_SUBMIT" }
  | { type: "SUBAGENT_INJECT_CHAR"; char: string }
  | { type: "SUBAGENT_INJECT_BACKSPACE" }
  | { type: "SUBAGENT_KILL"; subagentId: string }
  | { type: "SUBAGENT_PAUSE"; subagentId: string };
