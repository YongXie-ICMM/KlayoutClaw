/**
 * File editing tool — wraps Pi-Agent's edit tool.
 */

import { createEditTool as piCreateEditTool } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createEditTool(cwd: string): AgentTool<any> {
  return piCreateEditTool(cwd);
}
