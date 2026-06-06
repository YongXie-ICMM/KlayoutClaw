/**
 * SubagentRunner — orchestrates subagent execution with budget enforcement,
 * pause/resume/inject/kill controls, and event forwarding.
 */

import { EventEmitter } from "events";
import { Agent } from "@mariozechner/pi-agent-core";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
  AgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  AuthStorage,
  ModelRegistry,
  convertToLlm,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type {
  SubagentConfig,
  SubagentResult,
  StartedEvent,
  ThinkingEvent,
  TextEvent,
  ToolStartEvent,
  ToolEndEvent,
  ToolAnnotation,
} from "../types/v04-contracts.js";
import { applyModelHeaders, type ProviderConfig } from "../config.js";
import { resolveRole } from "./role-resolver.js";
import { createSubagentTools } from "./tool-factory.js";
import { buildSubagentPrompt, buildTaskMessage } from "./prompt-builder.js";
import { TranscriptLogger } from "./transcript.js";
import { randomUUID } from "crypto";

export interface SubagentRunnerDeps {
  config: SubagentConfig;
  mcpManager: {
    callTool: (name: string, params: Record<string, unknown>) => Promise<any>;
    allTools?: () => import("../mcp/types.js").NamespacedTool[];
  };
  memoryManager: {
    search: (query: string) => Promise<any[]>;
  };
  workspaceDir: string;
  annotations: ToolAnnotation[];
  /** API key resolver — same as parent agent's getApiKey */
  getApiKey: (provider: string) => Promise<string | undefined>;
  /** Default model ID (e.g., "custom-anthropic/claude-sonnet-4-6") for subagents without role-level override */
  defaultModel: string;
  /** Default thinking level */
  defaultThinkingLevel: string;
  /** Model registry — resolves model ID strings to Model<any> objects for Agent construction */
  modelRegistry: ModelRegistry;
  /**
   * Provider configs keyed by provider name. Used to apply per-provider header
   * overrides (e.g. a custom User-Agent) to the resolved subagent model, in
   * parity with the parent agent. Optional — the default User-Agent is applied
   * regardless.
   */
  providers?: Record<string, ProviderConfig>;
}

interface RunningSubagent {
  id: string;
  session: any;
  paused: boolean;
  pauseResolve: (() => void) | null;
  killed: boolean;
  injectedMessages: string[];
}

interface SubmittedResult {
  status: string;
  findings: string[];
  warnings: string[];
  dataPaths: string[];
}

/**
 * Runs subagent sessions with budget enforcement and lifecycle controls.
 */
export class SubagentRunner extends EventEmitter {
  private deps: SubagentRunnerDeps;
  private running: Map<string, RunningSubagent> = new Map();

  constructor(deps: SubagentRunnerDeps) {
    super();
    this.deps = deps;
  }

  /**
   * Run a subagent with the given role and task.
   */
  async run(opts: {
    role: string;
    task: string;
    toolCallId: string;
    context?: string;
    modelOverride?: string;
    roleConfigOverride?: import("../types/v04-contracts.js").RoleConfig;
  }): Promise<SubagentResult> {
    const { role, task, toolCallId, context } = opts;
    const subagentId = randomUUID();

    // Resolve role — prefer explicit override (used by delegate's general-purpose fallback)
    const roleConfig = opts.roleConfigOverride ?? resolveRole(role, this.deps.config);
    if (!roleConfig) {
      return {
        role,
        task,
        status: "error",
        findings: [],
        warnings: [],
        dataPaths: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
        transcriptPath: "",
        errorMessage: `Unknown role '${role}'. Available roles: ${Object.keys(this.deps.config.roles).join(", ")}`,
      };
    }

    // Create tools for this subagent
    // Use a container to avoid TypeScript narrowing the closure-mutated variable to never
    const resultBox: { value: SubmittedResult | null } = { value: null };

    const tools = createSubagentTools(roleConfig, {
      mcpManager: this.deps.mcpManager,
      memoryManager: this.deps.memoryManager,
      annotations: this.deps.annotations,
      mcpTools: this.deps.mcpManager.allTools?.() ?? [],
      resultCallback: (result) => {
        resultBox.value = {
          status: result.status,
          findings: result.findings,
          warnings: result.warnings,
          dataPaths: result.dataPaths ?? [],
        };
      },
    });

    // Build prompt
    const systemPrompt = buildSubagentPrompt(roleConfig, this.deps.workspaceDir);
    const taskMessage = buildTaskMessage(task, context);

    // Create transcript logger
    const logDir = this.deps.config.logDir;
    const transcript = new TranscriptLogger(
      logDir,
      role,
      task,
      this.deps.config.maxLogFiles,
    );

    // Resolve model: per-call override → role override → parent default
    const modelId = opts.modelOverride ?? roleConfig.model ?? this.deps.defaultModel;
    const thinkingLevel = (roleConfig.thinkingLevel ?? this.deps.defaultThinkingLevel) as ThinkingLevel;

    // Resolve model string to Model<any> via ModelRegistry (matches agent.ts pattern)
    const [provider, bareModelId] = modelId.includes("/")
      ? [modelId.split("/")[0], modelId.split("/").slice(1).join("/")]
      : ["", modelId];
    const resolvedModel = this.deps.modelRegistry.find(provider, bareModelId);

    // Guardrail: fail loudly with diagnostic info if model resolution failed.
    // Without this, pi-agent-core crashes deep inside the stream with an
    // opaque error (e.g. model.id / model.provider undefined reads).
    //
    // Finding #3 (code-review-issue-23): the TUI creates a placeholder entry
    // from the upstream `tool_execution_start` event and clears it on the
    // runner's `completed` event. If this early return fires WITHOUT
    // emitting started+completed, the placeholder is stuck showing "running"
    // forever. Emit both lifecycle events so every observer (TUI, logs,
    // metrics) can transition the entry cleanly.
    if (!resolvedModel) {
      const errorMessage = `Subagent model resolution failed: modelId="${modelId}" provider="${provider}" bareModelId="${bareModelId}". Check that roleConfig.model or the parent defaultModel is registered in ModelRegistry.`;
      const transcriptPath = transcript.save();
      const errorResult: SubagentResult = {
        role,
        task,
        status: "error",
        findings: [],
        warnings: [],
        dataPaths: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 },
        transcriptPath,
        errorMessage,
      };
      this.emit("started", {
        subagentId,
        toolCallId,
        role,
        task,
      } as StartedEvent);
      this.emit("completed", {
        subagentId,
        toolCallId,
        status: "error",
        findings: 0,
        warnings: 0,
        tokenUsage: "0 tokens, 0 turns",
        errorMessage,
      });
      return errorResult;
    }

    // Inject the neutral default User-Agent (plus any per-provider override) so
    // subagent requests carry the same UA as the parent agent — defeating
    // Cloudflare UA-fingerprint 403s uniformly (see applyModelHeaders).
    const model = applyModelHeaders(resolvedModel, this.deps.providers?.[provider]?.headers);

    // Create the agent + session with proper config (getApiKey, convertToLlm, model)
    const agent = new Agent({
      initialState: {
        model,
        thinkingLevel,
      },
      convertToLlm,
      getApiKey: this.deps.getApiKey,
    });
    const session: any = new (AgentSession as any)({
      agent,
      systemPrompt,
      customTools: tools,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: new DefaultResourceLoader({} as any),
      modelRegistry: this.deps.modelRegistry,
    });

    // Register running subagent
    const runState: RunningSubagent = {
      id: subagentId,
      session,
      paused: false,
      pauseResolve: null,
      killed: false,
      injectedMessages: [],
    };
    this.running.set(subagentId, runState);

    // Emit started
    this.emit("started", {
      subagentId,
      toolCallId,
      role,
      task,
    } as StartedEvent);

    // Track actual API token usage from usage_update events
    const apiUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // Subscribe to session events and forward them
    // Uses the real AgentSession single-callback API: subscribe((event) => ...)
    const unsubscribe = session.subscribe((event: any) => {
      switch (event.type) {
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame?.type === "thinking_delta") {
            const ev: ThinkingEvent = { subagentId, text: ame.delta };
            this.emit("thinking", ev);
            transcript.logThinking(ame.delta);
          } else if (ame?.type === "text_delta") {
            const ev: TextEvent = { subagentId, text: ame.delta };
            this.emit("text", ev);
            transcript.logText(ame.delta);
          }
          break;
        }
        case "tool_execution_start": {
          const ev: ToolStartEvent = {
            subagentId,
            toolName: event.toolName,
            args: event.args ?? "{}",
          };
          this.emit("tool_start", ev);
          transcript.logToolCall(event.toolName, event.args ?? "{}");
          break;
        }
        case "tool_execution_end": {
          const ev: ToolEndEvent = {
            subagentId,
            toolName: event.toolName,
            result: event.result ?? "",
          };
          this.emit("tool_end", ev);
          transcript.logToolResult(event.toolName, event.result ?? "");
          break;
        }
        case "usage_update": {
          const usage = event.usage ?? {};
          const input = Number(usage.inputTokens ?? usage.input ?? 0);
          const output = Number(usage.outputTokens ?? usage.output ?? 0);
          apiUsage.inputTokens += input;
          apiUsage.outputTokens += output;
          apiUsage.totalTokens += input + output;
          break;
        }
      }
    });

    // Turn-counting loop with budget enforcement
    let turns = 0;
    const maxTurns = roleConfig.maxTurns;
    const maxTokens = roleConfig.maxTokens;

    try {
      while (turns < maxTurns) {
        // Check if killed
        if (runState.killed) {
          break;
        }

        // Check if paused — wait until resumed
        if (runState.paused) {
          await new Promise<void>((resolve) => {
            runState.pauseResolve = resolve;
          });
          // After resume, check killed again
          if (runState.killed) {
            break;
          }
        }

        // Check token budget before each turn
        const usage = session.getContextUsage();
        const usedTokens = usage?.tokens ?? 0;
        if (usedTokens > maxTokens) {
          const transcriptPath = transcript.save();
          this.running.delete(subagentId);
          const earlyResult: SubagentResult = {
            role,
            task,
            status: "partial",
            findings: resultBox.value?.findings ?? [],
            warnings: resultBox.value?.warnings ?? [],
            dataPaths: resultBox.value?.dataPaths ?? [],
            tokenUsage: {
              inputTokens: apiUsage.inputTokens,
              outputTokens: apiUsage.outputTokens,
              totalTokens: apiUsage.totalTokens,
              turns,
            },
            transcriptPath,
            errorMessage: "Token budget exceeded",
          };
          this.emit("completed", {
            subagentId,
            toolCallId,
            status: earlyResult.status,
            findings: earlyResult.findings.length,
            warnings: earlyResult.warnings.length,
            tokenUsage: `${apiUsage.totalTokens} tokens, ${turns} turns`,
            errorMessage: earlyResult.errorMessage,
          });
          return earlyResult;
        }

        // Check for injected messages
        let promptArg: string | undefined = undefined;
        if (runState.injectedMessages.length > 0) {
          promptArg = runState.injectedMessages.shift()!;
        }

        // Call prompt with a defined string. AgentSession.prompt(text) requires
        // `text` to be a string — it calls text.startsWith("/") internally and
        // crashes with "Cannot read properties of undefined (reading 'startsWith')"
        // if called with no argument. Previously the else-branch below called
        // `session.prompt()` with no args, which was the root cause of issue #23.
        // When the agent has gone idle without calling submit_result and nothing
        // was injected, we send a short continuation nudge so the session stays
        // alive until submit_result fires or the budget is exhausted.
        let promptText: string;
        if (promptArg !== undefined) {
          promptText = promptArg;
        } else if (turns === 0) {
          promptText = taskMessage;
        } else {
          promptText = "Continue the task. When complete, call submit_result.";
        }
        await session.prompt(promptText);

        turns++;

        // Break if submit_result was called during this turn
        if (resultBox.value) {
          break;
        }
      }
    } catch (err: any) {
      // Handle abort or other errors
      if (runState.killed) {
        // Expected — killed by user
      } else {
        const transcriptPath = transcript.save();
        this.running.delete(subagentId);
        const errorResult: SubagentResult = {
          role,
          task,
          status: "error",
          findings: resultBox.value?.findings ?? [],
          warnings: resultBox.value?.warnings ?? [],
          dataPaths: resultBox.value?.dataPaths ?? [],
          tokenUsage: {
            inputTokens: apiUsage.inputTokens,
            outputTokens: apiUsage.outputTokens,
            totalTokens: apiUsage.totalTokens,
            turns,
          },
          transcriptPath,
          errorMessage: err.message ?? String(err),
        };
        this.emit("completed", {
          subagentId,
          toolCallId,
          status: errorResult.status,
          findings: errorResult.findings.length,
          warnings: errorResult.warnings.length,
          tokenUsage: `${apiUsage.totalTokens} tokens, ${turns} turns`,
          errorMessage: errorResult.errorMessage,
        });
        return errorResult;
      }
    } finally {
      // Clean up session subscription to prevent listener leaks
      unsubscribe();
    }

    // Save transcript
    const transcriptPath = transcript.save();

    // Clean up
    this.running.delete(subagentId);

    // Determine status
    let status: "completed" | "partial" | "error";
    let errorMessage: string | undefined;

    if (runState.killed) {
      status = "partial";
      errorMessage = "Killed by user";
    } else if (resultBox.value) {
      status = resultBox.value.status as "completed" | "partial" | "error";
    } else if (turns >= maxTurns) {
      status = "partial";
      errorMessage = "Turn budget exceeded";
    } else {
      status = "completed";
    }

    const result: SubagentResult = {
      role,
      task,
      status,
      findings: resultBox.value?.findings ?? [],
      warnings: resultBox.value?.warnings ?? [],
      dataPaths: resultBox.value?.dataPaths ?? [],
      tokenUsage: {
        inputTokens: apiUsage.inputTokens,
        outputTokens: apiUsage.outputTokens,
        totalTokens: apiUsage.totalTokens,
        turns,
      },
      transcriptPath,
      errorMessage,
    };

    // Emit completed event so TUI can transition the entry from "running" to final status
    this.emit("completed", {
      subagentId,
      toolCallId,
      status,
      findings: result.findings.length,
      warnings: result.warnings.length,
      tokenUsage: `${apiUsage.totalTokens} tokens, ${turns} turns`,
      errorMessage,
    });

    return result;
  }

  /**
   * Pause a running subagent.
   */
  pause(subagentId: string): void {
    const state = this.running.get(subagentId);
    if (state) {
      state.paused = true;
    }
  }

  /**
   * Resume a paused subagent.
   */
  resume(subagentId: string): void {
    const state = this.running.get(subagentId);
    if (state && state.paused) {
      state.paused = false;
      if (state.pauseResolve) {
        state.pauseResolve();
        state.pauseResolve = null;
      }
    }
  }

  /**
   * Inject a user message into a running subagent's conversation.
   */
  inject(subagentId: string, message: string): void {
    const state = this.running.get(subagentId);
    if (state) {
      state.injectedMessages.push(message);
    }
  }

  /**
   * Kill a running subagent, aborting its session.
   */
  kill(subagentId: string): void {
    const state = this.running.get(subagentId);
    if (state) {
      state.killed = true;
      // If paused, unblock the pause wait
      if (state.pauseResolve) {
        state.pauseResolve();
        state.pauseResolve = null;
      }
      // Abort the session
      state.session.abort();
    }
  }
}
