/**
 * Shell execution tool — wraps Pi-Agent's bash tool.
 */

import { createBashTool as piCreateBashTool } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBashTool(cwd: string): AgentTool<any> {
  return piCreateBashTool(cwd);
}
