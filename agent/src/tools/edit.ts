/**
 * File editing tool — wraps Pi-Agent's edit tool. Pi-Agent >=0.53 expects
 * `{ path, edits: [{oldText, newText}] }`; this wrapper additionally
 * accepts the legacy single-edit aliases (`file_path`, `old_string`,
 * `new_string`, `oldText`, `newText`) used by skills and plan-mode
 * wrappers, folding them into an `edits[]` for the underlying tool.
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
      if (p && !Array.isArray(p.edits)) {
        const oldText = p.oldText ?? p.old_string;
        const newText = p.newText ?? p.new_string;
        if (oldText !== undefined && newText !== undefined) {
          p.edits = [{ oldText, newText }];
        }
      }
      delete p.file_path;
      delete p.old_string;
      delete p.new_string;
      delete p.oldText;
      delete p.newText;
      return originalExecute(toolCallId, p, ...rest);
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as AgentTool<any>;
}
