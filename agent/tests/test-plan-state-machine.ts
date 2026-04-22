import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "qlaybot-plan-state-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function parseTextPayload(result: any): any {
  return JSON.parse(result.content[0]!.text as string);
}

describe("PlanStateMachine + exit_plan_mode (Task 2.7)", () => {
  it("emits plan_drafted followed by plan_file_written for a non-empty draft", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const {
      TranscriptMarkerEmitter,
      setTranscriptMarkerEmitter,
    } = await import("../src/events/marker-emitter.js");
    const { createExitPlanModeTool } = await import("../src/tools/plan.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);
    planManager.attachStateMachine(new PlanStateMachine(emitter));

    planManager.enterPlanMode("Draft the execution plan");
    planManager.writePlanContent("1. Inspect layout\n2. Route pads");

    const result = await createExitPlanModeTool(planManager).execute(
      "tool-call-1",
      { approved: true, summary: "Ready for approval" },
    );
    const body = JSON.parse(result.content[0]!.text as string);

    expect(body.status).toBe("plan_drafted");
    expect(markers.map((marker) => marker.type)).toEqual([
      "plan_drafted",
      "plan_file_written",
    ]);
    expect(markers[0]).toMatchObject({
      planSlug: planManager.currentPlan?.id,
      planFilePath: planManager.currentPlan?.filePath,
      replan_count: 0,
    });
    expect(markers[1]).toMatchObject({
      planFilePath: planManager.currentPlan?.filePath,
      planHash: markers[0].planHash,
    });
  });

  it("returns an empty-plan error without emitting markers", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const {
      TranscriptMarkerEmitter,
      setTranscriptMarkerEmitter,
    } = await import("../src/events/marker-emitter.js");
    const { createExitPlanModeTool } = await import("../src/tools/plan.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);
    const stateMachine = new PlanStateMachine(emitter);
    planManager.attachStateMachine(stateMachine);

    planManager.enterPlanMode("Leave file empty");

    const result = await createExitPlanModeTool(planManager).execute(
      "tool-call-2",
      { approved: true },
    );
    const body = JSON.parse(result.content[0]!.text as string);

    expect(body.status).toBe("error");
    expect(body.message).toContain("Plan file is empty");
    expect(markers).toHaveLength(0);
    expect(stateMachine.getState(planManager.sessionKey)).toBe("plan_drafting");
  });

  it("treats approved=false as the unconditional abandon shortcut", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const {
      TranscriptMarkerEmitter,
      setTranscriptMarkerEmitter,
    } = await import("../src/events/marker-emitter.js");
    const { createExitPlanModeTool } = await import("../src/tools/plan.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);
    planManager.attachStateMachine(new PlanStateMachine(emitter));

    planManager.enterPlanMode("Abandon immediately");

    const result = await createExitPlanModeTool(planManager).execute(
      "tool-call-3",
      { approved: false },
    );
    const body = JSON.parse(result.content[0]!.text as string);

    expect(body.status).toBe("plan_abandoned");
    expect(markers).toContainEqual(
      expect.objectContaining({
        type: "plan_rejected",
        action: "abandon",
        feedback: "abandoned",
      }),
    );
  });
});

describe("plan_drafted hard freeze (T36)", () => {
  it("rejects all tool calls while approval is pending", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const {
      wrapMCPToolForPlanMode,
      wrapToolForPlanDraftedFreeze,
      wrapWriteForPlanMode,
    } = await import("../src/planning/sandbox.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const stateMachine = new PlanStateMachine(new TranscriptMarkerEmitter());
    planManager.attachStateMachine(stateMachine);
    planManager.enterPlanMode("Freeze every tool");
    stateMachine.setState(planManager.sessionKey, "plan_drafted");

    const passthrough = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));

    const readTool = wrapToolForPlanDraftedFreeze(
      {
        name: "read",
        label: "Read",
        description: "read",
        parameters: Type.Object({}),
        execute: passthrough,
      },
      planManager,
    );
    const memoryTool = wrapToolForPlanDraftedFreeze(
      {
        name: "memory_search",
        label: "Memory Search",
        description: "memory_search",
        parameters: Type.Object({}),
        execute: passthrough,
      },
      planManager,
    );
    const thinkingTool = wrapToolForPlanDraftedFreeze(
      {
        name: "thinking",
        label: "Thinking",
        description: "thinking",
        parameters: Type.Object({}),
        execute: passthrough,
      },
      planManager,
    );
    const delegateTool = wrapToolForPlanDraftedFreeze(
      {
        name: "delegate",
        label: "Delegate",
        description: "delegate",
        parameters: Type.Object({}),
        execute: passthrough,
      },
      planManager,
    );
    const writeTool = wrapWriteForPlanMode(
      {
        name: "write",
        label: "Write",
        description: "write",
        parameters: Type.Object({}),
        execute: passthrough,
      },
      planManager,
      workspaceDir,
    );
    const layoutInfoTool = wrapMCPToolForPlanMode(
      {
        name: "klayout_native_get_layout_info",
        label: "Layout Info",
        description: "layout",
        parameters: Type.Object({}),
        execute: passthrough,
      },
      planManager,
    );

    const results = await Promise.all([
      thinkingTool.execute("tc-1", {}),
      readTool.execute("tc-2", {}),
      memoryTool.execute("tc-3", {}),
      layoutInfoTool.execute("tc-4", {}),
      writeTool.execute("tc-5", { path: join(workspaceDir, "plans", "plan.md") }),
      writeTool.execute("tc-6", { path: join(workspaceDir, "outside.md") }),
      delegateTool.execute("tc-7", {}),
    ]);

    for (const result of results) {
      expect(parseTextPayload(result)).toEqual({
        error: "plan_state_frozen",
        state: "plan_drafted",
        message: "tool calls suspended awaiting approval",
      });
    }

    expect(passthrough).not.toHaveBeenCalled();
  });
});
