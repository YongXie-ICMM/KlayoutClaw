/**
 * File editing tool — wraps Pi-Agent's edit tool and accepts both the
 * modern `path`/`oldText`/`newText` arguments and the legacy
 * `file_path`/`old_string`/`new_string` aliases used by skills and
 * plan-mode wrappers.
 */

import { createEditTool as piCreateEditTool } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createEditTool(cwd: string): AgentTool<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = piCreateEditTool(cwd) as AgentTool<any>;
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
      const p = { ...params };
      if (p && p.path === undefined && p.file_path !== undefined) {
        p.path = p.file_path;
      }
      if (p && p.oldText === undefined && p.old_string !== undefined) {
        p.oldText = p.old_string;
      }
      if (p && p.newText === undefined && p.new_string !== undefined) {
        p.newText = p.new_string;
      }
      return originalExecute(toolCallId, p, ...rest);
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as AgentTool<any>;
}
