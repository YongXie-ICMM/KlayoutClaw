/**
 * File writing tool — wraps Pi-Agent's write tool and accepts both the
 * modern `path` argument and the legacy `file_path` alias used by skills
 * and plan-mode wrappers.
 */

import { createWriteTool as piCreateWriteTool } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWriteTool(cwd: string): AgentTool<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = piCreateWriteTool(cwd) as AgentTool<any>;
  const originalExecute = base.execute.bind(base);
  return {
    ...base,
    execute: async (
      toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...rest: any[]
    ) => {
      // Accept both `path` (pi-coding-agent canonical) and `file_path` (alias).
      const p = { ...params };
      if (p && p.path === undefined && p.file_path !== undefined) {
        p.path = p.file_path;
      }
      return originalExecute(toolCallId, p, ...rest);
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as AgentTool<any>;
}
