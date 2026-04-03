/**
 * Root App component for qlaybot TUI.
 * v0.3 rewrite: keyboard shortcuts, auto-compaction, PlanManager/BG subscriptions.
 */

import React, { useReducer, useEffect, useCallback, useRef, useMemo, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { tuiReducer, initialState } from "../reducer.js";
import { StatusBar } from "./StatusBar.js";
import { MessageList } from "./MessageList.js";
import { InputBox } from "./InputBox.js";
import { ErrorBanner } from "./ErrorBanner.js";
import { StreamingBar } from "./StreamingBar.js";
import { WorkspaceBar } from "./WorkspaceBar.js";
import { BackgroundBar } from "./BackgroundBar.js";
import { ConfigPanel } from "./ConfigPanel.js";
import { SubagentPanel } from "./SubagentPanel.js";
import { subscribeToSession } from "../../events.js";
import { shouldAutoCompact } from "../auto-compact.js";
import type { QlayBotSession } from "../../agent.js";
import { parseCommand } from "../../commands/index.js";
import type { CommandContext } from "../../commands/index.js";
import { listWorkspaceFiles, checkWorkspaceIntegrity } from "../workspace.js";
import { loadCommandRecency, saveCommandRecency } from "../hooks/useCommandHistory.js";
import { getConfigDir, getAllMCPServers } from "../../config.js";
import { TOOL_ANNOTATIONS } from "../../tools/annotations.js";
import type { MCPServerData } from "./ConfigPanel.js";

function isCurrentlyThinking(msg: import("../types.js").AssistantMessageData | null): boolean {
  if (!msg || !msg.isStreaming || msg.segments.length === 0) return false;
  return msg.segments[msg.segments.length - 1].type === "thinking";
}

interface AppProps {
  botSession: QlayBotSession;
}

export function App({ botSession }: AppProps) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(tuiReducer, initialState);
  // Keep phase accessible in stale closures (useInput, handleSubmit)
  const phaseRef = useRef(state.phase);
  phaseRef.current = state.phase;

  // Track compacting state in a ref for the onAgentEnd callback
  const isCompactingRef = useRef(false);
  isCompactingRef.current = state.isCompacting;

  // Global keyboard shortcuts
  useInput((_input, key) => {
    // Ctrl+T: toggle detail view (tool + thinking expanded)
    if (key.ctrl && _input === "t") {
      dispatch({ type: "TOGGLE_DETAIL_VIEW" });
      return;
    }
    // Ctrl+W: toggle workspace bar
    if (key.ctrl && _input === "w") {
      dispatch({ type: "TOGGLE_WORKSPACE" });
      return;
    }
    // Ctrl+G: toggle background bar
    if (key.ctrl && _input === "g") {
      dispatch({ type: "TOGGLE_BACKGROUND" });
      return;
    }
    // Ctrl+S: toggle subagent panel
    if (key.ctrl && _input === "s") {
      dispatch({ type: "TOGGLE_SUBAGENT_PANEL" });
      return;
    }
    // Ctrl+N: open config panel
    if (key.ctrl && _input === "n") {
      dispatch({ type: "CONFIG_PANEL_OPEN", tab: "settings" });
      return;
    }
    // Escape: abort if streaming/tool_executing, or close panels
    if (key.escape) {
      if (state.focusState === "config-panel") {
        if (state.configPanel.editing) {
          dispatch({ type: "CONFIG_PANEL_EDIT_CANCEL" });
        } else {
          dispatch({ type: "CONFIG_PANEL_CLOSE" });
        }
        return;
      }
      if (state.focusState === "subagent-summary" ||
          state.focusState === "subagent-inspect" ||
          state.focusState === "subagent-inject") {
        dispatch({ type: "FOCUS_ESCAPE" });
        return;
      }
      const currentPhase = phaseRef.current;
      if (currentPhase === "streaming" || currentPhase === "tool_executing") {
        if (typeof botSession.session.abort === "function") {
          botSession.session.abort();
        }
        return;
      }
      // Close any open panel
      if (state.focusState === "workspace-bar" || state.focusState === "background-bar") {
        dispatch({ type: "FOCUS_ESCAPE" });
        return;
      }
    }
  });

  // Subscribe to session events
  useEffect(() => {
    dispatch({
      type: "SESSION_READY",
      modelName: botSession.config.agent.defaultModel,
      thinkingLevel: botSession.config.agent.thinkingLevel,
    });

    const unsubscribe = subscribeToSession(botSession.session, {
      onTextDelta: (text) => dispatch({ type: "TEXT_DELTA", delta: text }),
      onThinkingDelta: (delta) =>
        dispatch({ type: "THINKING_DELTA", delta }),
      onToolStartWithId: (toolCallId, toolName, args) => {
        dispatch({ type: "TOOL_START", toolCallId, toolName, args });
        // Two-phase ID mapping: create placeholder entry for delegate tool
        if (toolName === "delegate") {
          try {
            const parsed = typeof args === "string" ? JSON.parse(args) : (args ?? {}) as any;
            dispatch({
              type: "SUBAGENT_PLACEHOLDER",
              toolCallId,
              role: parsed.role ?? "unknown",
              task: parsed.task ?? "",
            });
          } catch {
            // Malformed args — placeholder will be created by runner "started" fallback
          }
        }
      },
      onToolUpdate: (toolCallId, _toolName, partialResult) =>
        dispatch({ type: "TOOL_UPDATE", toolCallId, partialResult }),
      onToolEndWithId: (toolCallId, _toolName, result, isError) =>
        dispatch({ type: "TOOL_END", toolCallId, result, isError }),
      onAgentEnd: async () => {
        dispatch({ type: "AGENT_END" });

        // Auto-compaction check after agent ends
        const usage = botSession.getContextUsage();
        if (usage && botSession.compactionConfig) {
          const should = shouldAutoCompact(
            botSession.compactionConfig,
            usage.percent,
            isCompactingRef.current,
            false, // hasPendingMessages — simplified, no queue in v0.3
            "ready", // phase after AGENT_END
          );
          if (should) {
            dispatch({ type: "COMPACTION_START" });
            try {
              await botSession.compact();
            } catch {
              // Swallow compaction errors — COMPACTION_END must still fire
            } finally {
              dispatch({ type: "COMPACTION_END" });
            }
          }
        }
      },
      onUsageUpdate: (usage) =>
        dispatch({
          type: "USAGE_UPDATE",
          ...usage,
        }),
    });

    return () => unsubscribe();
  }, [botSession]);

  // Subscribe to SubagentRunner events → dispatch SUBAGENT_* actions
  useEffect(() => {
    const runner = botSession.subagentRunner;
    if (!runner) return;

    const onStarted = (ev: any) => {
      // Fallback: if tool_execution_start for "delegate" wasn't received
      // (e.g., event ordering race), create the placeholder now so SUBAGENT_START
      // has an entry to map. The reducer's SUBAGENT_PLACEHOLDER is idempotent
      // (creates a new entry only if toolCallId doesn't exist yet, or updates it).
      dispatch({
        type: "SUBAGENT_PLACEHOLDER",
        toolCallId: ev.toolCallId,
        role: ev.role,
        task: ev.task,
      });
      dispatch({
        type: "SUBAGENT_START",
        subagentId: ev.subagentId,
        toolCallId: ev.toolCallId,
      });
    };

    const onThinking = (ev: any) =>
      dispatch({ type: "SUBAGENT_THINKING", subagentId: ev.subagentId, text: ev.text });

    const onText = (ev: any) =>
      dispatch({ type: "SUBAGENT_TEXT", subagentId: ev.subagentId, text: ev.text });

    const onToolStart = (ev: any) =>
      dispatch({
        type: "SUBAGENT_TOOL_START",
        subagentId: ev.subagentId,
        toolName: ev.toolName,
        args: ev.args,
      });

    const onToolEnd = (ev: any) =>
      dispatch({
        type: "SUBAGENT_TOOL_END",
        subagentId: ev.subagentId,
        toolName: ev.toolName,
        result: ev.result,
      });

    const onCompleted = (ev: any) =>
      dispatch({
        type: "SUBAGENT_END",
        subagentId: ev.subagentId,
        status: ev.status,
        findings: ev.findings,
        warnings: ev.warnings,
        tokenUsage: ev.tokenUsage,
        errorMessage: ev.errorMessage,
      });

    runner.on("started", onStarted);
    runner.on("thinking", onThinking);
    runner.on("text", onText);
    runner.on("tool_start", onToolStart);
    runner.on("tool_end", onToolEnd);
    runner.on("completed", onCompleted);

    return () => {
      runner.off("started", onStarted);
      runner.off("thinking", onThinking);
      runner.off("text", onText);
      runner.off("tool_start", onToolStart);
      runner.off("tool_end", onToolEnd);
      runner.off("completed", onCompleted);
    };
  }, [botSession.subagentRunner]);

  // Wire subagent control actions to runner methods
  // When SubagentPanel dispatches SUBAGENT_KILL, call runner.kill()
  // When inject is submitted, call runner.inject()
  const prevKillRef = useRef<string | null>(null);
  const prevInjectRef = useRef<string | null>(null);
  useEffect(() => {
    const runner = botSession.subagentRunner;
    if (!runner) return;

    // Handle kill: when a subagent entry transitions to killed status via reducer
    // The SubagentPanel dispatches SUBAGENT_KILL which sets the entry's killed flag
    for (const entry of state.subagents) {
      if ((entry as any).killed && prevKillRef.current !== entry.id) {
        prevKillRef.current = entry.id;
        runner.kill(entry.id);
      }
    }
  }, [state.subagents, botSession.subagentRunner]);

  // Handle inject submission
  useEffect(() => {
    const runner = botSession.subagentRunner;
    if (!runner) return;

    if (state.subagentInjectTarget && state.subagentInjectValue && !(state as any).subagentInjectMode) {
      // Inject was submitted (mode turned off but target+value present)
      if (prevInjectRef.current !== `${state.subagentInjectTarget}:${state.subagentInjectValue}`) {
        prevInjectRef.current = `${state.subagentInjectTarget}:${state.subagentInjectValue}`;
        runner.inject(state.subagentInjectTarget, state.subagentInjectValue);
      }
    }
  }, [state.subagentInjectTarget, state.subagentInjectValue, (state as any).subagentInjectMode, botSession.subagentRunner]);

  // Subscribe to PlanManager state changes
  useEffect(() => {
    if (!botSession.planManager?.onStateChange) return;

    const unsubscribe = botSession.planManager.onStateChange(
      (planState: { active: boolean }) => {
        if (planState.active) {
          dispatch({ type: "PLAN_MODE_ENTERED" });
        } else {
          dispatch({ type: "PLAN_MODE_EXITED" });
        }
      },
    );

    return () => unsubscribe();
  }, [botSession]);

  // Subscribe to BackgroundTaskManager events
  useEffect(() => {
    if (!botSession.backgroundTaskManager?.subscribe) return;

    const unsubscribe = botSession.backgroundTaskManager.subscribe(
      (task: { id: string; name: string; status: string; startedAt: number; completedAt?: number; error?: string }) => {
        switch (task.status) {
          case "running":
            dispatch({
              type: "BG_TASK_CREATED",
              task: {
                id: task.id,
                name: task.name,
                status: "running",
                startedAt: task.startedAt,
              },
            });
            break;
          case "completed":
            dispatch({
              type: "BG_TASK_COMPLETED",
              taskId: task.id,
              completedAt: task.completedAt ?? Date.now(),
            });
            break;
          case "failed":
            dispatch({
              type: "BG_TASK_FAILED",
              taskId: task.id,
              error: task.error ?? "Unknown error",
            });
            break;
          case "cancelled":
            dispatch({ type: "BG_TASK_CANCELLED", taskId: task.id });
            break;
        }
      },
    );

    return () => unsubscribe();
  }, [botSession]);

  // Poll context usage
  useEffect(() => {
    const timer = setInterval(() => {
      const usage = botSession.getContextUsage();
      if (usage) {
        dispatch({
          type: "CONTEXT_USAGE_UPDATE",
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: usage.percent,
        });
      }
    }, botSession.config.tui.contextPollMs);
    return () => clearInterval(timer);
  }, [botSession]);

  const handleSubmit = useCallback(
    async (text: string) => {
      // Route slash commands
      const parsed = parseCommand(text);
      if (parsed) {
        if (parsed.name === "quit") {
          await botSession.dispose();
          exit();
          return;
        }
        if (parsed.name === "exit") {
          await botSession.dispose();
          exit();
          return;
        }

        const registry = botSession.commandRegistry;
        if (registry) {
          dispatch({ type: "USER_PROMPT", text });

          // Special handling for /compact — dispatch compaction actions
          if (parsed.name === "compact") {
            dispatch({ type: "COMPACTION_START" });
            const ctx: CommandContext = { session: botSession, mode: "tui" };
            try {
              const result = await registry.execute(parsed.name, parsed.args, ctx);
              dispatch({
                type: "COMMAND_RESULT",
                output: result.output,
                stateChange: result.stateChange,
              });
            } catch {
              // Swallow — COMPACTION_END must fire
            } finally {
              dispatch({ type: "COMPACTION_END" });
            }
            return;
          }

          const ctx: CommandContext = { session: botSession, mode: "tui" };
          const result = await registry.execute(parsed.name, parsed.args, ctx);
          dispatch({
            type: "COMMAND_RESULT",
            output: result.output,
            stateChange: result.stateChange,
          });
          // Persist command recency for ghost text ordering
          setCommandRecency((prev) => {
            const updated = { ...prev, [parsed.name]: Date.now() };
            saveCommandRecency(updated);
            return updated;
          });
          return;
        }
      }

      dispatch({ type: "USER_PROMPT", text });
      dispatch({ type: "STREAM_START" });
      botSession.history.recordPrompt(text);

      try {
        await botSession.session.prompt(text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ type: "SESSION_ERROR", error: msg });
        botSession.history.recordError(msg);
      }
    },
    [botSession, exit],
  );

  // Load command recency on mount for ghost text ordering
  const [commandRecency, setCommandRecency] = useState<Record<string, number>>({});
  useEffect(() => {
    setCommandRecency(loadCommandRecency());
  }, []);

  const workspaceFiles = useMemo(() => listWorkspaceFiles(), []);
  const workspaceIntegrity = useMemo(() => checkWorkspaceIntegrity(), []);
  const configDir = useMemo(() => getConfigDir(), []);

  // Build MCP server data for ConfigPanel
  const mcpServers: MCPServerData[] = useMemo(() => {
    const serverConfigs = getAllMCPServers(botSession.config);
    const allTools = botSession.mcpManager.allTools();
    const serverKeys = botSession.mcpManager.getServerKeys();
    const result: MCPServerData[] = [];

    for (const key of serverKeys) {
      const serverConf = serverConfigs[key] ?? serverConfigs[`${key}_mcp`];
      const connected = botSession.mcpManager.isConnected(key);
      const serverTools = allTools
        .filter((t: any) => t.serverKey === key || t.group === key)
        .map((t: any) => {
          const disabled = (serverConf?.disabledTools ?? []).includes(t.originalName ?? t.name);
          const annotation = TOOL_ANNOTATIONS.find((a) => a.name === (t.originalName ?? t.name));
          return {
            name: t.originalName ?? t.name,
            description: t.description ?? "",
            disabled,
            annotation,
          };
        });

      result.push({
        key,
        displayName: key.charAt(0).toUpperCase() + key.slice(1),
        connected,
        tools: serverTools,
      });
    }

    return result;
  }, [botSession]);

  const isThinking = isCurrentlyThinking(state.currentAssistant);

  return (
    <Box flexDirection="column" width="100%">
      {state.configPanel.open ? (
        <ConfigPanel
          config={botSession.config}
          configPanelState={state.configPanel}
          dispatch={dispatch}
          configDir={configDir}
          mcpServers={mcpServers}
        />
      ) : state.subagentPanelOpen ? (
        <SubagentPanel state={state} dispatch={dispatch} />
      ) : (
        <MessageList
          messages={state.messages}
          currentStreaming={state.currentAssistant}
          toolDetailExpanded={state.toolDetailExpanded}
          thinkingExpanded={state.thinkingExpanded}
        />
      )}
      {state.error && <ErrorBanner error={state.error} />}
      <StreamingBar
        phase={state.phase}
        tokenUsage={state.tokenUsage}
        startedAt={state.currentAssistant?.startedAt}
        isThinking={isThinking}
        hasBackgroundTasks={state.backgroundTasks.length > 0}
      />
      <InputBox
        phase={state.phase}
        onSubmit={handleSubmit}
        onToggleThinking={() => dispatch({ type: "TOGGLE_THINKING_VIEW" })}
        focusState={state.focusState}
        recency={commandRecency}
      />
      {state.focusState === "workspace-bar" && (
        <WorkspaceBar
          expanded={true}
          files={workspaceFiles}
          integrity={workspaceIntegrity}
        />
      )}
      {state.focusState === "background-bar" && (
        <BackgroundBar
          tasks={state.backgroundTasks}
          expanded={true}
        />
      )}
      <StatusBar state={state} />
    </Box>
  );
}
