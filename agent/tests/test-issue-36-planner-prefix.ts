/**
 * Issue #36 regression test.
 *
 * Every domain tool description in `agent/src/tools/klayout/nanodevice.ts`
 * and `agent/src/tools/klayout/visual.ts` must begin with the literal
 * sentence "**PLANNER, NOT EXECUTOR.**" so the LLM understands these tools
 * only emit a workflow_plan — they do not execute anything themselves.
 */

import { describe, it, expect } from "vitest";
import { registerNanodeviceTools } from "../src/tools/klayout/nanodevice.js";
import { registerVisualTools } from "../src/tools/klayout/visual.js";

const PLANNER_PREFIX = "**PLANNER, NOT EXECUTOR.**";

describe("issue #36 — PLANNER, NOT EXECUTOR prefix", () => {
  it("every nanodevice tool description starts with the planner prefix", () => {
    const tools = registerNanodeviceTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(
        tool.description?.startsWith(PLANNER_PREFIX),
        `nanodevice tool ${tool.name} description must start with "${PLANNER_PREFIX}", got: ${tool.description?.slice(0, 60)}…`,
      ).toBe(true);
    }
  });

  it("every visual tool description starts with the planner prefix", () => {
    const tools = registerVisualTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(
        tool.description?.startsWith(PLANNER_PREFIX),
        `visual tool ${tool.name} description must start with "${PLANNER_PREFIX}", got: ${tool.description?.slice(0, 60)}…`,
      ).toBe(true);
    }
  });
});
