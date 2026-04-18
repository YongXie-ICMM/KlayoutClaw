/**
 * State reducer for qlaybot TUI.
 * All state transitions via useReducer.
 */

import type {
  TUIState,
  TUIAction,
  AssistantMessageData,
  AssistantSegment,
  ToolExecution,
  BackgroundTaskSummaryTUI,
  ConfigPanelTab,
} from "./types.js";
import type { SubagentTUIEntry, SubagentSegment } from "../types/v04-contracts.js";

let messageCounter = 0;

function newAssistantMessage(): AssistantMessageData {
  return {
    id: `assistant-${++messageCounter}`,
    role: "assistant",
    segments: [],
    textChunks: [],
    thinkingChunks: [],
    tools: [],
    isStreaming: true,
    startedAt: Date.now(),
  };
}

function lastSegment(
  msg: AssistantMessageData,
): AssistantSegment | undefined {
  return msg.segments.length > 0
    ? msg.segments[msg.segments.length - 1]
    : undefined;
}

const BAR_NAMES = ["status", "workspace", "background"] as const;

/** Number of settable keys in the settings tab (thinking, model, memory.maxResults, memory.maxEntries) */
export const SETTABLE_KEYS_COUNT = 4;

export const initialState: TUIState = {
  phase: "initializing",
  modelName: "",
  thinkingLevel: "",
  messages: [],
  currentAssistant: null,
  error: null,
  planMode: false,
  showThinking: false,
  backgroundTaskCount: 0,
  tokenUsage: null,
  contextUsage: null,
  // v0.3 additions
  isCompacting: false,
  inPlanMode: false,
  toolDetailExpanded: false,
  thinkingExpanded: false,
  backgroundTasks: [],
  // v0.4 additions
  focusState: "input",
  completionIndex: 0,
  completionMatches: [],
  selectedBar: "status",
  inputText: "",
  configPanel: {
    open: false,
    tab: "settings" as ConfigPanelTab,
    editing: false,
    editValue: "",
    cursors: { settings: 0, models: 0, mcp: 0 },
    mcpDrilldown: { level: "servers" as const, selectedServer: null, toolIndex: 0 },
  },
  // v0.4 Phase G: subagent panel
  subagents: [],
  subagentPanelOpen: false,
  subagentSummaryIndex: 0,
  subagentInspectId: null,
  subagentInspectScroll: 0,
  subagentInjectMode: false,
  subagentInjectTarget: null,
  subagentInjectValue: "",
  // v0.4.3 Group 3: plan-mode exit menu
  planExitMenu: null,
};

export function tuiReducer(state: TUIState, action: TUIAction): TUIState {
  switch (action.type) {
    case "SESSION_READY":
      return {
        ...state,
        phase: "ready",
        modelName: action.modelName,
        thinkingLevel: action.thinkingLevel,
        error: null,
      };

    case "USER_PROMPT":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `user-${++messageCounter}`,
            role: "user" as const,
            text: action.text,
          },
        ],
        error: null,
      };

    case "STREAM_START": {
      const msg = newAssistantMessage();
      return {
        ...state,
        phase: "streaming",
        currentAssistant: msg,
        error: null,
        tokenUsage: null,
      };
    }

    case "TEXT_DELTA": {
      if (!state.currentAssistant) {
        const msg = newAssistantMessage();
        msg.textChunks.push(action.delta);
        msg.segments.push({ type: "text", chunks: [action.delta] });
        return { ...state, phase: "streaming", currentAssistant: msg };
      }
      const last = lastSegment(state.currentAssistant);
      let newSegments: AssistantSegment[];
      if (last && last.type === "text") {
        newSegments = [
          ...state.currentAssistant.segments.slice(0, -1),
          { type: "text", chunks: [...last.chunks, action.delta] },
        ];
      } else {
        newSegments = [
          ...state.currentAssistant.segments,
          { type: "text", chunks: [action.delta] },
        ];
      }
      return {
        ...state,
        currentAssistant: {
          ...state.currentAssistant,
          textChunks: [...state.currentAssistant.textChunks, action.delta],
          segments: newSegments,
        },
      };
    }

    case "THINKING_DELTA": {
      if (!state.currentAssistant) {
        const msg = newAssistantMessage();
        msg.thinkingChunks.push(action.delta);
        msg.segments.push({ type: "thinking", chunks: [action.delta] });
        return { ...state, phase: "streaming", currentAssistant: msg };
      }
      const last = lastSegment(state.currentAssistant);
      let newSegments: AssistantSegment[];
      if (last && last.type === "thinking") {
        newSegments = [
          ...state.currentAssistant.segments.slice(0, -1),
          { type: "thinking", chunks: [...last.chunks, action.delta] },
        ];
      } else {
        newSegments = [
          ...state.currentAssistant.segments,
          { type: "thinking", chunks: [action.delta] },
        ];
      }
      return {
        ...state,
        currentAssistant: {
          ...state.currentAssistant,
          thinkingChunks: [
            ...state.currentAssistant.thinkingChunks,
            action.delta,
          ],
          segments: newSegments,
        },
      };
    }

    case "TOOL_START": {
      const toolExec: ToolExecution = {
        id: action.toolCallId,
        toolName: action.toolName,
        args: action.args,
        status: "running",
        startTime: Date.now(),
      };
      if (!state.currentAssistant) {
        const msg = newAssistantMessage();
        msg.tools.push(toolExec);
        msg.segments.push({ type: "tool", tool: toolExec });
        return { ...state, phase: "tool_executing", currentAssistant: msg };
      }
      return {
        ...state,
        phase: "tool_executing",
        currentAssistant: {
          ...state.currentAssistant,
          tools: [...state.currentAssistant.tools, toolExec],
          segments: [
            ...state.currentAssistant.segments,
            { type: "tool", tool: toolExec },
          ],
        },
      };
    }

    case "TOOL_UPDATE": {
      if (!state.currentAssistant) return state;
      const updatedTools = state.currentAssistant.tools.map((t) =>
        t.id === action.toolCallId
          ? { ...t, result: action.partialResult }
          : t,
      );
      const updatedSegments = state.currentAssistant.segments.map((seg) =>
        seg.type === "tool" && seg.tool.id === action.toolCallId
          ? {
              ...seg,
              tool: { ...seg.tool, result: action.partialResult },
            }
          : seg,
      );
      return {
        ...state,
        currentAssistant: {
          ...state.currentAssistant,
          tools: updatedTools,
          segments: updatedSegments,
        },
      };
    }

    case "TOOL_END": {
      if (!state.currentAssistant) return state;
      const endTime = Date.now();
      const endedStatus = action.isError
        ? ("error" as const)
        : ("completed" as const);
      const tools = state.currentAssistant.tools.map((t) =>
        t.id === action.toolCallId
          ? { ...t, status: endedStatus, result: action.result, endTime }
          : t,
      );
      const segments = state.currentAssistant.segments.map((seg) =>
        seg.type === "tool" && seg.tool.id === action.toolCallId
          ? {
              ...seg,
              tool: {
                ...seg.tool,
                status: endedStatus,
                result: action.result,
                endTime,
              },
            }
          : seg,
      );
      const anyRunning = tools.some((t) => t.status === "running");
      return {
        ...state,
        phase: anyRunning ? "tool_executing" : "streaming",
        currentAssistant: {
          ...state.currentAssistant,
          tools,
          segments,
        },
      };
    }

    case "AGENT_END": {
      if (!state.currentAssistant) {
        // Preserve config-panel focus if open
        if (state.configPanel.open) {
          return { ...state, phase: "ready", focusState: "config-panel" };
        }
        return { ...state, phase: "ready" };
      }
      const finalTools = state.currentAssistant.tools.map((t) =>
        t.status === "running"
          ? { ...t, status: "completed" as const, endTime: Date.now() }
          : t,
      );
      const finalSegments = state.currentAssistant.segments.map((seg) =>
        seg.type === "tool" && seg.tool.status === "running"
          ? {
              ...seg,
              tool: {
                ...seg.tool,
                status: "completed" as const,
                endTime: Date.now(),
              },
            }
          : seg,
      );
      const finalized: AssistantMessageData = {
        ...state.currentAssistant,
        tools: finalTools,
        segments: finalSegments,
        isStreaming: false,
        completedAt: Date.now(),
      };
      const agentEndState: TUIState = {
        ...state,
        phase: "ready",
        messages: [...state.messages, finalized],
        currentAssistant: null,
        tokenUsage: null,
      };
      // Preserve config-panel focus if open
      if (state.configPanel.open) {
        agentEndState.focusState = "config-panel";
      }
      return agentEndState;
    }

    case "USAGE_UPDATE":
      return {
        ...state,
        tokenUsage: {
          input: action.input,
          output: action.output,
          cacheRead: action.cacheRead,
          cacheWrite: action.cacheWrite,
          totalTokens: action.totalTokens,
        },
      };

    case "SESSION_ERROR":
      return { ...state, phase: "error", error: action.error };

    case "CLEAR_MESSAGES":
      return { ...state, messages: [], currentAssistant: null };

    case "SYSTEM_MESSAGE": {
      const sysMsg: { id: string; role: "system"; text: string; sections?: typeof action.sections } = {
        id: `sys-${++messageCounter}`,
        role: "system" as const,
        text: action.text,
      };
      if (action.sections) {
        sysMsg.sections = action.sections;
      }
      return {
        ...state,
        messages: [...state.messages, sysMsg],
      };
    }

    case "CONTEXT_USAGE_UPDATE":
      return {
        ...state,
        contextUsage: {
          tokens: action.tokens,
          contextWindow: action.contextWindow,
          percent: action.percent,
        },
      };

    case "COMMAND_RESULT": {
      const newState = { ...state };
      if (action.stateChange?.planMode !== undefined) {
        newState.planMode = action.stateChange.planMode;
        newState.inPlanMode = action.stateChange.planMode;
      }
      if (action.stateChange?.showThinking !== undefined) {
        newState.showThinking = action.stateChange.showThinking;
      }
      if (action.stateChange?.configPanel?.open) {
        newState.focusState = "config-panel";
        newState.configPanel = {
          ...state.configPanel,
          open: true,
          tab: action.stateChange.configPanel.tab as ConfigPanelTab,
        };
      }
      // Display command output as a system message
      const cmdMsg: { id: string; role: "system"; text: string; sections?: typeof action.sections } = {
        id: `sys-${++messageCounter}`,
        role: "system" as const,
        text: action.output,
      };
      if (action.sections) {
        cmdMsg.sections = action.sections;
      }
      newState.messages = [...state.messages, cmdMsg];
      return newState;
    }

    case "TOGGLE_THINKING_VIEW":
      return { ...state, showThinking: !state.showThinking };

    case "BACKGROUND_UPDATE":
      return { ...state, backgroundTaskCount: action.taskCount };

    // v0.3 actions
    case "BG_TASK_CREATED":
      return {
        ...state,
        backgroundTasks: [...state.backgroundTasks, action.task],
      };

    case "BG_TASK_COMPLETED": {
      const idx = state.backgroundTasks.findIndex((t) => t.id === action.taskId);
      if (idx === -1) return state;
      const updated = state.backgroundTasks.map((t) =>
        t.id === action.taskId
          ? { ...t, status: "completed" as const, completedAt: action.completedAt }
          : t,
      );
      return { ...state, backgroundTasks: updated };
    }

    case "BG_TASK_FAILED": {
      const idx = state.backgroundTasks.findIndex((t) => t.id === action.taskId);
      if (idx === -1) return state;
      const updated = state.backgroundTasks.map((t) =>
        t.id === action.taskId
          ? { ...t, status: "failed" as const, error: action.error }
          : t,
      );
      return { ...state, backgroundTasks: updated };
    }

    case "BG_TASK_CANCELLED": {
      const idx = state.backgroundTasks.findIndex((t) => t.id === action.taskId);
      if (idx === -1) return state;
      const updated = state.backgroundTasks.map((t) =>
        t.id === action.taskId
          ? { ...t, status: "cancelled" as const }
          : t,
      );
      return { ...state, backgroundTasks: updated };
    }

    case "COMPACTION_START":
      // Block compaction while config panel is open
      if (state.configPanel.open) {
        return state;
      }
      return { ...state, isCompacting: true };

    case "COMPACTION_END":
      return { ...state, isCompacting: false };

    case "PLAN_MODE_ENTERED":
      return { ...state, inPlanMode: true };

    case "PLAN_MODE_EXITED":
      return { ...state, inPlanMode: false };

    case "PLAN_EXIT_MENU_OPEN":
      return { ...state, planExitMenu: action.planFilePath };

    case "PLAN_EXIT_MENU_CLOSE":
      return { ...state, planExitMenu: null };

    case "TOGGLE_DETAIL_VIEW":
      return {
        ...state,
        toolDetailExpanded: !state.toolDetailExpanded,
        thinkingExpanded: !state.thinkingExpanded,
      };

    // v0.4 focus actions
    case "FOCUS_UP":
      if (action.hasCompletions) {
        return { ...state, focusState: "completion" };
      }
      return state;

    case "FOCUS_DOWN":
      if (!action.inputText || action.inputText === "") {
        return { ...state, focusState: "bar-select" };
      }
      return state;

    case "FOCUS_ESCAPE":
      if (state.focusState === "subagent-inject") {
        return {
          ...state,
          focusState: "subagent-inspect",
          subagentInjectMode: false,
          subagentInjectTarget: null,
          subagentInjectValue: "",
        };
      }
      if (state.focusState === "subagent-inspect") {
        return {
          ...state,
          focusState: "subagent-summary",
          subagentInspectId: null,
        };
      }
      if (state.focusState === "subagent-summary") {
        return {
          ...state,
          focusState: "input",
          subagentPanelOpen: false,
        };
      }
      return { ...state, focusState: "input" };

    case "COMPLETION_UP": {
      if (state.completionMatches.length === 0) return state;
      const newIdx = state.completionIndex <= 0
        ? state.completionMatches.length - 1
        : state.completionIndex - 1;
      return { ...state, completionIndex: newIdx };
    }

    case "COMPLETION_DOWN": {
      if (state.completionMatches.length === 0) return state;
      const newIdx = state.completionIndex >= state.completionMatches.length - 1
        ? 0
        : state.completionIndex + 1;
      return { ...state, completionIndex: newIdx };
    }

    case "COMPLETION_SELECT":
      return {
        ...state,
        focusState: "input",
        inputText: action.command + " ",
      };

    case "BAR_SELECT_DOWN": {
      const curIdx = BAR_NAMES.indexOf(state.selectedBar as typeof BAR_NAMES[number]);
      const nextIdx = curIdx >= BAR_NAMES.length - 1 ? 0 : curIdx + 1;
      return { ...state, selectedBar: BAR_NAMES[nextIdx] };
    }

    case "BAR_SELECT_UP": {
      const curIdx = BAR_NAMES.indexOf(state.selectedBar as typeof BAR_NAMES[number]);
      const nextIdx = curIdx <= 0 ? BAR_NAMES.length - 1 : curIdx - 1;
      return { ...state, selectedBar: BAR_NAMES[nextIdx] };
    }

    case "TOGGLE_WORKSPACE":
      return { ...state, focusState: state.focusState === "workspace-bar" ? "input" : "workspace-bar" };

    case "TOGGLE_BACKGROUND":
      return { ...state, focusState: state.focusState === "background-bar" ? "input" : "background-bar" };

    // v0.4 config panel actions
    case "CONFIG_PANEL_OPEN":
      // Preserve cursors and mcpDrilldown state across close/reopen (SCC-C40)
      // Close subagent panel if open (SCC-G20e)
      return {
        ...state,
        focusState: "config-panel",
        configPanel: { ...state.configPanel, open: true, tab: action.tab },
        subagentPanelOpen: false,
      };

    case "CONFIG_PANEL_CLOSE":
      // Preserve mcpDrilldown and cursors across close (SCC-C40)
      return {
        ...state,
        focusState: "input",
        configPanel: { ...state.configPanel, open: false, editing: false, editValue: "" },
      };

    case "CONFIG_PANEL_TAB_CHANGE":
      return {
        ...state,
        configPanel: { ...state.configPanel, tab: action.tab },
      };

    case "CONFIG_PANEL_NAVIGATE": {
      const currentTab = state.configPanel.tab;
      const currentCursor = state.configPanel.cursors[currentTab];
      // Determine max for current tab
      let maxIndex: number;
      if (currentTab === "settings") {
        maxIndex = SETTABLE_KEYS_COUNT - 1;
      } else {
        maxIndex = 99; // high limit for models/mcp; component handles real bounds
      }
      const newCursor = action.direction === "down"
        ? Math.min(currentCursor + 1, maxIndex)
        : Math.max(currentCursor - 1, 0);
      return {
        ...state,
        configPanel: {
          ...state.configPanel,
          cursors: { ...state.configPanel.cursors, [currentTab]: newCursor },
        },
      };
    }

    case "CONFIG_PANEL_SELECT":
      // In settings tab, entering edit mode
      if (state.configPanel.tab === "settings") {
        return {
          ...state,
          configPanel: { ...state.configPanel, editing: true },
        };
      }
      return state;

    case "CONFIG_PANEL_EDIT_START":
      return {
        ...state,
        configPanel: { ...state.configPanel, editing: true, editValue: action.currentValue },
      };

    case "CONFIG_PANEL_EDIT_CONFIRM":
      return {
        ...state,
        configPanel: { ...state.configPanel, editing: false },
      };

    case "CONFIG_PANEL_EDIT_CANCEL":
      return {
        ...state,
        configPanel: { ...state.configPanel, editing: false, editValue: "" },
      };

    // v0.4 Phase C2: MCP drilldown actions
    case "CONFIG_PANEL_MCP_DRILLDOWN":
      return {
        ...state,
        configPanel: {
          ...state.configPanel,
          mcpDrilldown: {
            ...state.configPanel.mcpDrilldown,
            level: "tools" as const,
            selectedServer: action.server,
          },
        },
      };

    case "CONFIG_PANEL_MCP_BACK":
      return {
        ...state,
        configPanel: {
          ...state.configPanel,
          mcpDrilldown: {
            ...state.configPanel.mcpDrilldown,
            level: "servers" as const,
            selectedServer: null,
          },
        },
      };

    case "CONFIG_PANEL_MCP_RECONNECT":
      // Side-effect only; no state change needed
      return state;

    case "CONFIG_PANEL_MCP_TOGGLE_TOOL":
      // Track toggle state change so UI re-renders with updated tool status
      return {
        ...state,
        configPanel: {
          ...state.configPanel,
          mcpDrilldown: {
            ...state.configPanel.mcpDrilldown,
            toolIndex: state.configPanel.mcpDrilldown.toolIndex,
          },
        },
      };

    // v0.4 Phase G: subagent actions
    case "TOGGLE_SUBAGENT_PANEL": {
      if (state.subagentPanelOpen) {
        return { ...state, subagentPanelOpen: false, focusState: "input" };
      }
      // If config panel is open, close it and cancel editing
      const newConfigPanel = state.configPanel.open
        ? { ...state.configPanel, open: false, editing: false, editValue: "" }
        : state.configPanel;
      return {
        ...state,
        subagentPanelOpen: true,
        focusState: "subagent-summary",
        configPanel: newConfigPanel,
      };
    }

    case "SUBAGENT_PLACEHOLDER": {
      // Idempotent: if a placeholder with this toolCallId already exists, skip
      if (state.subagents.some((s) => s.toolCallId === action.toolCallId)) {
        return state;
      }
      const entry: SubagentTUIEntry = {
        id: action.toolCallId,
        toolCallId: action.toolCallId,
        role: action.role,
        task: action.task,
        status: "running",
        startTime: Date.now(),
        segments: [],
      };
      return {
        ...state,
        subagents: [...state.subagents, entry],
      };
    }

    case "SUBAGENT_START": {
      const updated = state.subagents.map((s) =>
        s.toolCallId === action.toolCallId
          ? { ...s, id: action.subagentId }
          : s,
      );
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_THINKING": {
      const updated = state.subagents.map((s) =>
        s.id === action.subagentId
          ? { ...s, segments: [...s.segments, { type: "thinking" as const, text: action.text }] }
          : s,
      );
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_TEXT": {
      const updated = state.subagents.map((s) =>
        s.id === action.subagentId
          ? { ...s, segments: [...s.segments, { type: "text" as const, text: action.text }] }
          : s,
      );
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_TOOL_START": {
      const seg: SubagentSegment = {
        type: "tool_call",
        toolName: action.toolName,
        args: action.args,
        status: "running",
      };
      const updated = state.subagents.map((s) =>
        s.id === action.subagentId
          ? { ...s, segments: [...s.segments, seg], currentTool: action.toolName }
          : s,
      );
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_TOOL_END": {
      const updated = state.subagents.map((s) => {
        if (s.id !== action.subagentId) return s;
        // Find the last running tool_call segment with matching toolName
        const newSegments = [...s.segments];
        for (let i = newSegments.length - 1; i >= 0; i--) {
          const seg = newSegments[i];
          if (seg.type === "tool_call" && seg.toolName === action.toolName && seg.status === "running") {
            newSegments[i] = { ...seg, status: "done", result: action.result };
            break;
          }
        }
        return { ...s, segments: newSegments, currentTool: undefined };
      });
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_INJECT": {
      const updated = state.subagents.map((s) =>
        s.id === action.subagentId
          ? { ...s, segments: [...s.segments, { type: "injected" as const, text: action.text }] }
          : s,
      );
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_END": {
      const updated = state.subagents.map((s) =>
        s.id === action.subagentId
          ? {
              ...s,
              status: action.status as SubagentTUIEntry["status"],
              findings: action.findings,
              warnings: action.warnings,
              tokenUsage: action.tokenUsage,
              errorMessage: action.errorMessage,
              endTime: Date.now(),
            }
          : s,
      );
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_NAVIGATE": {
      const maxIdx = Math.max(0, state.subagents.length - 1);
      const newIdx = action.direction === "down"
        ? Math.min(state.subagentSummaryIndex + 1, maxIdx)
        : Math.max(state.subagentSummaryIndex - 1, 0);
      return { ...state, subagentSummaryIndex: newIdx };
    }

    case "SUBAGENT_INSPECT":
      return {
        ...state,
        focusState: "subagent-inspect",
        subagentInspectId: action.subagentId,
      };

    case "SUBAGENT_INSPECT_NAV": {
      const currentIdx = state.subagents.findIndex((s) => s.id === state.subagentInspectId);
      if (currentIdx === -1) return state;
      const newIdx = action.direction === "right"
        ? Math.min(currentIdx + 1, state.subagents.length - 1)
        : Math.max(currentIdx - 1, 0);
      return { ...state, subagentInspectId: state.subagents[newIdx].id };
    }

    case "SUBAGENT_INSPECT_SCROLL": {
      const newScroll = action.direction === "down"
        ? state.subagentInspectScroll + 1
        : Math.max(state.subagentInspectScroll - 1, 0);
      return { ...state, subagentInspectScroll: newScroll };
    }

    case "SUBAGENT_INJECT_START": {
      // Only allow inject on running subagents
      const target = state.subagents.find((s) => s.id === action.subagentId);
      if (!target || target.status !== "running") return state;
      return {
        ...state,
        focusState: "subagent-inject",
        subagentInjectMode: true,
        subagentInjectTarget: action.subagentId,
      };
    }

    case "SUBAGENT_INJECT_CANCEL":
      return {
        ...state,
        focusState: "subagent-summary",
        subagentInjectMode: false,
        subagentInjectTarget: null,
        subagentInjectValue: "",
      };

    case "SUBAGENT_INJECT_CHAR":
      return {
        ...state,
        subagentInjectValue: state.subagentInjectValue + action.char,
      };

    case "SUBAGENT_INJECT_BACKSPACE":
      return {
        ...state,
        subagentInjectValue: state.subagentInjectValue.slice(0, -1),
      };

    case "SUBAGENT_INJECT_SUBMIT": {
      const targetId = state.subagentInjectTarget;
      if (!targetId || !state.subagentInjectValue) return state;
      const updated = state.subagents.map((s) =>
        s.id === targetId
          ? { ...s, segments: [...s.segments, { type: "injected" as const, text: state.subagentInjectValue }] }
          : s,
      );
      return {
        ...state,
        subagents: updated,
        subagentInjectMode: false,
        subagentInjectTarget: null,
        subagentInjectValue: "",
        focusState: "subagent-inspect",
      };
    }

    case "SUBAGENT_KILL": {
      const target = state.subagents.find((s) => s.id === action.subagentId);
      if (!target || target.status !== "running") return state;
      const updated = state.subagents.map((s) =>
        s.id === action.subagentId
          ? { ...s, status: "partial" as const, errorMessage: "Killed by user", endTime: Date.now() }
          : s,
      );
      return { ...state, subagents: updated };
    }

    case "SUBAGENT_PAUSE": {
      const pauseTarget = state.subagents.find((s) => s.id === action.subagentId);
      if (!pauseTarget || pauseTarget.status !== "running") return state;
      const updated = state.subagents.map((s) =>
        s.id === action.subagentId
          ? { ...s, paused: !(s as any).paused }
          : s,
      );
      return { ...state, subagents: updated };
    }

    default:
      return state;
  }
}
