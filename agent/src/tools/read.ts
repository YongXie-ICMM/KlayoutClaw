/**
 * File reading tool — wraps Pi-Agent's read tool.
 */

import { createReadTool as piCreateReadTool } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createReadTool(cwd: string): AgentTool<any> {
  return piCreateReadTool(cwd);
}
