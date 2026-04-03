/**
 * File writing tool — wraps Pi-Agent's write tool.
 */

import { createWriteTool as piCreateWriteTool } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWriteTool(cwd: string): AgentTool<any> {
  return piCreateWriteTool(cwd);
}
