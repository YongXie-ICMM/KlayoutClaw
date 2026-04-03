/**
 * PlanManager — modal planning state with sandbox tool wrapping.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const ALLOWED_TOOLS = new Set([
  "read",
  "klayout_native_get_layout_info",
  "klayout_native_screenshot",
  "memory_save",
  "memory_search",
]);

export class PlanManager {
  private active = false;
  private stateListeners: Array<(state: { active: boolean }) => void> = [];

  enter(): void {
    this.active = true;
    this.notifyStateChange();
  }

  exit(): void {
    this.active = false;
    this.notifyStateChange();
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Subscribe to plan mode state changes.
   * Callback fires when enter() or exit() is called.
   * Returns an unsubscribe function.
   */
  onStateChange(callback: (state: { active: boolean }) => void): () => void {
    this.stateListeners.push(callback);
    return () => {
      this.stateListeners = this.stateListeners.filter((l) => l !== callback);
    };
  }

  private notifyStateChange(): void {
    for (const listener of this.stateListeners) {
      listener({ active: this.active });
    }
  }

  /**
   * Wrap a tool so blocked calls return an error when plan mode is active.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapTool(tool: AgentTool<any>): AgentTool<any> {
    const self = this;
    return {
      ...tool,
      async execute(
        toolCallId: string,
        params: unknown,
        ...rest: unknown[]
      ): Promise<AgentToolResult<unknown>> {
        if (self.active && !ALLOWED_TOOLS.has(tool.name)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Tool '${tool.name}' is blocked in plan mode. Exit plan mode with /plan exit to execute.`,
              },
            ],
            details: { blocked: true, planMode: true },
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (tool.execute as any)(toolCallId, params, ...rest);
      },
    };
  }

  /**
   * Get the plan-mode system prompt injection.
   */
  getSystemPromptInjection(): string {
    return `You are in PLAN MODE. You can read, inspect, reason, and save to memory,
but you cannot modify the layout or workspace files (no bash, write, edit,
or KLayout mutating tools). Write your plan as structured steps.
When the user approves, they will exit plan mode and you can execute.`;
  }
}
