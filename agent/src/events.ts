/**
 * Event subscription for qlaybot agent sessions.
 * Bridges AgentSession events to structured callbacks.
 */

import type { AgentSession, AgentSessionEventListener } from "@mariozechner/pi-coding-agent";

export interface QlayBotEventCallbacks {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolStart?: (toolName: string, args: unknown) => void;
  onToolStartWithId?: (toolCallId: string, toolName: string, args: unknown) => void;
  onToolEnd?: (toolName: string, result: unknown, isError: boolean) => void;
  onToolEndWithId?: (toolCallId: string, toolName: string, result: unknown, isError: boolean) => void;
  onToolUpdate?: (toolCallId: string, toolName: string, partialResult: unknown) => void;
  onTurnStart?: () => void;
  onTurnEnd?: () => void;
  onAgentStart?: () => void;
  onAgentEnd?: () => void;
  onUsageUpdate?: (usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  }) => void;
}

export interface SubscribeOptions {
  heartbeatIntervalMs?: number;
}

/**
 * Subscribe to an AgentSession with structured callbacks.
 */
export function subscribeToSession(
  session: AgentSession,
  callbacks: QlayBotEventCallbacks,
  _options: SubscribeOptions = {},
): () => void {
  const listener: AgentSessionEventListener = (event) => {
    switch (event.type) {
      case "agent_start":
        callbacks.onAgentStart?.();
        break;

      case "agent_end":
        callbacks.onAgentEnd?.();
        break;

      case "turn_start":
        callbacks.onTurnStart?.();
        break;

      case "turn_end":
        callbacks.onTurnEnd?.();
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame.type === "text_delta") {
          callbacks.onTextDelta?.(ame.delta);
        } else if (ame.type === "thinking_delta") {
          callbacks.onThinkingDelta?.(ame.delta);
        }
        // Forward live usage
        if ("partial" in ame && (ame as Record<string, unknown>).partial) {
          const partial = (ame as Record<string, unknown>).partial as Record<string, unknown>;
          if (partial.usage) {
            const u = partial.usage as Record<string, number>;
            callbacks.onUsageUpdate?.({
              input: u.input ?? 0,
              output: u.output ?? 0,
              cacheRead: u.cacheRead ?? 0,
              cacheWrite: u.cacheWrite ?? 0,
              totalTokens: u.totalTokens ?? 0,
            });
          }
        }
        break;
      }

      case "tool_execution_start":
        callbacks.onToolStart?.(event.toolName, event.args);
        callbacks.onToolStartWithId?.(event.toolCallId, event.toolName, event.args);
        break;

      case "tool_execution_update":
        callbacks.onToolUpdate?.(event.toolCallId, event.toolName, event.partialResult);
        break;

      case "tool_execution_end":
        callbacks.onToolEnd?.(event.toolName, event.result, event.isError);
        callbacks.onToolEndWithId?.(event.toolCallId, event.toolName, event.result, event.isError);
        break;
    }
  };

  const unsubscribe = session.subscribe(listener);
  return unsubscribe;
}
