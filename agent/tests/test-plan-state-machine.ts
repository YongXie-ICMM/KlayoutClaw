import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
