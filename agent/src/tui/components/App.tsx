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
import { PlanExitMenu } from "./PlanExitMenu.js";
import { subscribeToSession } from "../../events.js";
import { shouldAutoCompact } from "../auto-compact.js";
import type { QlayBotSession } from "../../agent.js";
import { parseCommand } from "../../commands/index.js";
import type { CommandContext } from "../../commands/index.js";
import { listWorkspaceFiles, checkWorkspaceIntegrity } from "../workspace.js";
import { loadCommandRecency, saveCommandRecency } from "../hooks/useCommandHistory.js";
import { getConfigDir, getAllMCPServers } from "../../config.js";
import { formatTurnMessage } from "../../verbose-helpers.js";
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

  // v0.4.3 Group 3: local mirror of plan-mode exit menu path (null when closed).
  // Kept in lockstep with reducer dispatches so the menu useInput gate is
  // synchronous while the UI re-renders on the open/close reducer actions.
  const [planExitMenu, setPlanExitMenu] = useState<string | null>(null);

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

  // v0.4.3 Group 3: plan-mode exit menu key handler (1/2/3/4/Escape).
  // Only active while planExitMenu !== null so it never interferes with
  // normal input otherwise. Keys 1-4 map to §1.8.2 menu choices.
  useInput(
    (_input, key) => {
      if (!planExitMenu) return;
      const planPath = planExitMenu;

      if (_input === "1") {
        setPlanExitMenu(null);
        dispatch({ type: "PLAN_EXIT_MENU_CLOSE" });
        dispatch({ type: "COMPACTION_START" });
        dispatch({
          type: "SYSTEM_MESSAGE",
          text: "Compacting context before execution...",
        });
        botSession
          .compact()
          .then(() => {
            dispatch({ type: "COMPACTION_END" });
            dispatch({
              type: "SYSTEM_MESSAGE",
              text: "Context compacted. Executing plan...",
            });
            dispatch({ type: "USER_PROMPT", text: "Execute the plan" });
            return botSession.session.prompt(
              `Execute the design plan at: ${planPath}\n` +
                `Read the plan file and execute it step by step. Full tool access is restored.`,
            );
          })
          .catch((err: any) => {
            dispatch({ type: "COMPACTION_END" });
            dispatch({
              type: "SESSION_ERROR",
              error: err?.message ?? String(err),
            });
          });
      } else if (_input === "2") {
        setPlanExitMenu(null);
        dispatch({ type: "PLAN_EXIT_MENU_CLOSE" });
        dispatch({ type: "USER_PROMPT", text: "Execute the plan" });
        botSession.session
          .prompt(
            `Execute the design plan at: ${planPath}\n` +
              `Read the plan file and execute it step by step. Full tool access is restored.`,
          )
          .catch((err: any) => {
            dispatch({
              type: "SESSION_ERROR",
              error: err?.message ?? String(err),
            });
          });
      } else if (_input === "3") {
        setPlanExitMenu(null);
        dispatch({ type: "PLAN_EXIT_MENU_CLOSE" });
        const plan = botSession.planManager?.reenterPlanMode();
        if (plan) {
          dispatch({
            type: "SYSTEM_MESSAGE",
            text: `Re-entered plan mode for revision.\nPlan file: ${plan.filePath}`,
          });
        } else {
          dispatch({ type: "SYSTEM_MESSAGE", text: "No plan to revise." });
        }
      } else if (_input === "4" || key.escape) {
        setPlanExitMenu(null);
        dispatch({ type: "PLAN_EXIT_MENU_CLOSE" });
        dispatch({
          type: "SYSTEM_MESSAGE",
          text: "Plan saved. You can execute it later.",
        });
      }
    },
    { isActive: !!planExitMenu },
  );

  // Subscribe to session events
  useEffect(() => {
    // §4 verbose: print the assembled system prompt as the FIRST
    // SYSTEM_MESSAGE so the user can verify what the model actually sees.
    if (botSession.config.verbose === true && botSession.assembledSystemPrompt) {
      dispatch({
        type: "SYSTEM_MESSAGE",
        text: botSession.assembledSystemPrompt,
      });
    }

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
      // v0.4.4 §3 / TH-6 / TH-9 — route `think_recorded` markers into
      // the THINKING_DELTA channel so the existing indicator surface
      // picks them up. The reducer's THINKING_DELTA path already
      // accumulates chunks; the TUI indicator is rendered with the
      // `source` prop when the marker's origin is known. Phase 1 only
      // ships `source:"tool"` as a live producer (the `thinking` tool);
      // native / inline producers land later.
      onTranscriptMarker: (m: unknown) => {
        const marker = m as
          | {
              type: string;
              source?: string;
              thought?: string;
              ts?: string;
            }
          | undefined;
        if (!marker || marker.type !== "think_recorded") return;
        // Feed the tool-scratchpad text into the thinking-chunk stream.
        // Propagate `source` end-to-end so the reducer can start a new
        // segment when the origin flips (tool vs. native) and the
        // renderer can pick the right theme color (TH-6 / TH-9).
        // Phase 1 only ships `source:"tool"` from the `thinking` tool
        // producer; be conservative and fall back to "tool" when the
        // marker omits/unknowns the field (think_recorded is only
        // emitted by the tool producer in v0.4.4).
        if (typeof marker.thought === "string" && marker.thought.length > 0) {
          const src: "tool" | "native" | "inline" =
            marker.source === "tool" ||
            marker.source === "native" ||
            marker.source === "inline"
              ? marker.source
              : "tool";
          dispatch({
            type: "THINKING_DELTA",
            delta: marker.thought + "\n",
            source: src,
          });
        }
      },
    });

    // §4 verbose: per-turn timing + token stats via raw session.subscribe
    // so synthetic `agent_start` / `agent_end` events fire this handler
    // regardless of the subscribeToSession bridge. Turn counter starts at 1.
    let verboseTurnN = 0;
    let verboseTurnStart = 0;
    const verboseUnsub =
      botSession.config.verbose === true
        ? botSession.session.subscribe((ev: any) => {
            if (!ev || typeof ev !== "object") return;
            if (ev.type === "agent_start") {
              verboseTurnN++;
              verboseTurnStart = Date.now();
            } else if (ev.type === "agent_end") {
              const elapsed = Date.now() - verboseTurnStart;
              const text = formatTurnMessage(verboseTurnN, elapsed, ev.usage);
              dispatch({ type: "SYSTEM_MESSAGE", text });
            }
          })
        : () => {};

    return () => {
      unsubscribe();
      verboseUnsub();
    };
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

  // Subscribe to PlanManager events (v0.4.3 Group 3 step 9)
  useEffect(() => {
    if (!botSession.planManager) return;
    const unsub = botSession.planManager.subscribe((event) => {
      if (event.type === "plan_mode_entered") {
        dispatch({ type: "PLAN_MODE_ENTERED" });
      } else if (event.type === "plan_mode_exited") {
        dispatch({ type: "PLAN_MODE_EXITED" });
      }
    });
    return () => unsub();
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

  // Poll context usage. Skip the dispatch when values are unchanged so idle
  // sessions don't re-clone state + re-reconcile Ink every 5 s for hours —
  // that was the one recurring allocation source during long idle waits and
  // drove heap growth all the way to the 4 GB cap.
  const lastUsageRef = useRef<{ tokens: number; contextWindow: number; percent: number } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const usage = botSession.getContextUsage();
      if (!usage) return;
      const prev = lastUsageRef.current;
      if (
        prev &&
        prev.tokens === usage.tokens &&
        prev.contextWindow === usage.contextWindow &&
        prev.percent === usage.percent
      ) {
        return;
      }
      lastUsageRef.current = {
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent,
      };
      dispatch({
        type: "CONTEXT_USAGE_UPDATE",
        tokens: usage.tokens,
        contextWindow: usage.contextWindow,
        percent: usage.percent,
      });
    }, botSession.config.tui.contextPollMs);
    return () => clearInterval(timer);
  }, [botSession]);

  const handleSubmit = useCallback(
    async (text: string) => {
      // v0.4.3 Group 3: intercept /plan BEFORE the CommandRegistry (spec §1.8.1).
      // This ports qdevbot's App.tsx slash handler; /plan is a modal UI affordance
      // that cannot live in the registry because it needs access to planExitMenu
      // local state + session.prompt auto-submit.
      if (text === "/plan" || text.startsWith("/plan ")) {
        const pm = botSession.planManager;
        const taskDesc = text.slice(5).trim();

        if (!pm) {
          dispatch({ type: "SYSTEM_MESSAGE", text: "Planning mode not available." });
          return;
        }

        if (pm.inPlanMode && !taskDesc) {
          // Branch A: in plan mode, no args → exit + open the 4-option menu.
          // The menu text itself is rendered by the <PlanExitMenu> component
          // (conditionally mounted on planExitMenu !== null) so that closing
          // the menu REMOVES the text from the frame — a persisted
          // SYSTEM_MESSAGE would leave it behind after dismissal.
          const planPath = pm.currentPlan?.filePath ?? "";
          pm.exitPlanMode(true);
          setPlanExitMenu(planPath);
          dispatch({ type: "PLAN_EXIT_MENU_OPEN", planFilePath: planPath });
          return;
        }

        if (!pm.inPlanMode) {
          // Branch B: not in plan → enter + optional auto-submit.
          const plannedTask = taskDesc || "User-initiated plan mode";
          // Yield once so React can process any pre-existing pending updates
          // (e.g. InputBox's buf.clear dispatch from the Enter handler) before
          // we queue our own state changes.
          await new Promise<void>((r) => setImmediate(r));
          const plan = pm.enterPlanMode(plannedTask);
          if (!plan || ("status" in plan && plan.status === "error")) {
            // D1 FS-failure surface: enterPlanMode returned null.
            dispatch({
              type: "SYSTEM_MESSAGE",
              text:
                plan && "message" in plan
                  ? plan.message
                  : "Failed to enter plan mode. The plans directory may not be writable.",
            });
            return;
          }
          dispatch({
            type: "SYSTEM_MESSAGE",
            text:
              `Plan mode active. Sandbox enforced — only the plan file can be modified.\n` +
              `Plan file: ${plan.filePath}`,
          });
          if (taskDesc) {
            dispatch({ type: "USER_PROMPT", text: taskDesc });
            try {
              await botSession.session.prompt(
                `[Plan mode activated]\n\n` +
                  `Task: ${taskDesc}\n` +
                  `Plan file: ${plan.filePath}\n\n` +
                  `You are in plan mode. Explore the current state using read and klayout read-only tools, ` +
                  `then write a detailed design plan to the plan file. ` +
                  `Only the plan file can be modified — bash, write, and edit are restricted to the plans directory.\n` +
                  `Include specific cell names, layer numbers, coordinates, and safety checks.\n\n` +
                  `When the plan is complete, call exit_plan_mode.`,
              );
            } catch (err: any) {
              dispatch({
                type: "SESSION_ERROR",
                error: err?.message ?? String(err),
              });
            }
          }
          return;
        }

        // Branch C: already in plan mode with args → nudge user.
        dispatch({
          type: "SYSTEM_MESSAGE",
          text: "Already in plan mode. Use /plan (no args) to exit.",
        });
        return;
      }

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
          verbose={botSession.config.verbose === true}
        />
      )}
      {planExitMenu !== null && <PlanExitMenu planFilePath={planExitMenu} />}
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
        frozen={!!planExitMenu}
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
