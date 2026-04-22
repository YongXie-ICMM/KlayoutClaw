import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("exit_plan_mode compatibility without a configured state machine", () => {
  it("falls back to the legacy deferred exit flow and closes plan mode", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { createExitPlanModeTool } = await import("../src/tools/plan.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    const plan = planManager.enterPlanMode("Legacy compatibility probe");
    expect(plan).not.toBeNull();

    const result = await createExitPlanModeTool(planManager).execute(
      "tool-call-legacy-exit",
      { approved: true, summary: "Legacy summary" },
    );
    const body = parseTextPayload(result);

    expect(body.status).toBe("plan_approved");
    expect(body.plan_id).toBe(plan?.id);
    expect(body.plan_file).toBe(plan?.filePath);
    expect(body.summary).toBe("Legacy summary");
    expect(planManager.inPlanMode).toBe(false);
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

describe("waitForPlanApproval pause/resume", () => {
  async function setupInteractiveDraft() {
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
    planManager.setHeadless(false);
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);
    planManager.attachStateMachine(new PlanStateMachine(emitter));
    planManager.enterPlanMode("Draft an approval-gated plan");
    planManager.writePlanContent("1. Inspect\n2. Execute");

    return {
      planManager,
      markers,
      exitTool: createExitPlanModeTool(planManager),
    };
  }

  it("waits for approve_execute and returns the final approval result", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const { planManager, markers, exitTool } = await setupInteractiveDraft();

    let settled = false;
    const promise = exitTool.execute("tc-approve-execute", { approved: true });
    void promise.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    resolvePlanApproval(planManager.sessionKey, { action: "approve_execute" });

    const result = await promise;
    const body = parseTextPayload(result);

    expect(body.status).toBe("plan_approved");
    expect(body.executeAfterApproval).toBe(true);
    expect(markers.map((marker) => marker.type)).toEqual([
      "plan_drafted",
      "plan_file_written",
      "plan_approved",
      "plan_executing",
      "plan_done",
    ]);
  });

  it("waits for approve_only, reject, and abandon actions", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );

    for (const action of [
      { action: "approve_only" as const, expectedStatus: "plan_approved" },
      { action: "reject" as const, expectedStatus: "plan_rejected", feedback: "needs more detail" },
      { action: "abandon" as const, expectedStatus: "plan_abandoned" },
    ]) {
      const { planManager, markers, exitTool } = await setupInteractiveDraft();
      const promise = exitTool.execute(`tc-${action.action}`, { approved: true });

      await new Promise((resolve) => setTimeout(resolve, 20));
      if (action.action === "reject") {
        resolvePlanApproval(planManager.sessionKey, {
          action: "reject",
          feedback: action.feedback,
        });
      } else {
        resolvePlanApproval(planManager.sessionKey, { action: action.action });
      }

      const result = await promise;
      const body = parseTextPayload(result);

      expect(body.status).toBe(action.expectedStatus);
      expect(markers[2]).toMatchObject(
        action.action === "approve_only"
          ? {
              type: "plan_approved",
              executeAfterApproval: false,
            }
          : {
              type: "plan_rejected",
              action: action.action === "abandon" ? "abandon" : "reject",
            },
      );
    }
  });

  it("abandons the draft when the caller disconnects during the wait", async () => {
    const { rejectPlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const { planManager, markers, exitTool } = await setupInteractiveDraft();

    const promise = exitTool.execute("tc-disconnect", { approved: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    rejectPlanApproval(planManager.sessionKey, "caller_disconnected");

    const result = await promise;
    const body = parseTextPayload(result);

    expect(body.status).toBe("plan_abandoned");
    expect(body.reason).toBe("caller_disconnected");
    expect(markers[2]).toMatchObject({
      type: "plan_rejected",
      action: "abandon",
      feedback: "caller_disconnected",
    });
  });
});

describe("permission-context coupling (T23)", () => {
  it("keeps plan-mode restrictions during drafting, restores pre-plan permissions for execution, and leaves them unchanged after plan_done", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const {
      wrapMCPToolForPlanMode,
      wrapWriteForPlanMode,
    } = await import("../src/planning/sandbox.js");
    const { createExitPlanModeTool } = await import("../src/tools/plan.js");

    const workspaceDir = makeWorkspace();
    const planManager = new PlanManager(workspaceDir);
    planManager.setHeadless(true);
    const emitter = new TranscriptMarkerEmitter();
    planManager.attachStateMachine(new PlanStateMachine(emitter));
    planManager.enterPlanMode("Permission swap probe");

    const passthrough = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));

    const executeScript = wrapMCPToolForPlanMode(
      {
        name: "klayout_native_execute_script",
        label: "Execute Script",
        description: "execute_script",
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

    expect(planManager.permissionMode).toBe("plan");
    expect(parseTextPayload(await executeScript.execute("tc-blocked", {}))).toMatchObject({
      error: "plan_mode_restricted",
    });
    expect(parseTextPayload(await writeTool.execute("tc-outside", {
      path: join(workspaceDir, "outside.md"),
    }))).toMatchObject({
      error: "plan_mode_restricted",
    });
    await writeTool.execute("tc-inside-file", {
      path: join(workspaceDir, "plans", "active.md"),
    });
    await writeTool.execute("tc-inside-sibling", {
      path: join(workspaceDir, "plans", "notes.md"),
    });

    planManager.writePlanContent("1. Run execution step");
    await createExitPlanModeTool(planManager).execute("tc-exit", { approved: true });

    expect(planManager.permissionMode).toBe("default");
    await executeScript.execute("tc-after-approve", {});
    expect(passthrough).toHaveBeenCalledWith(
      "tc-after-approve",
      {},
      undefined,
      undefined,
    );
    expect(planManager.permissionMode).toBe("default");
  });
});

describe("terminal marker ordering (T4)", () => {
  async function setupPlan(actionMode: "interactive" | "headless" = "interactive") {
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
    if (actionMode === "interactive") {
      planManager.setApprovalMode("interactive");
    } else {
      planManager.setApprovalMode("headless");
    }
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);
    planManager.attachStateMachine(new PlanStateMachine(emitter));
    planManager.enterPlanMode("Marker ordering probe");
    planManager.writePlanContent("1. Prepare\n2. Execute");

    return {
      planManager,
      markers,
      exitTool: createExitPlanModeTool(planManager),
    };
  }

  it("execute path emits drafted → file_written → approved(true) → executing → done(ok)", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const { planManager, markers, exitTool } = await setupPlan("interactive");

    const promise = exitTool.execute("tc-order-execute", { approved: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(planManager.sessionKey, { action: "approve_execute" });
    await promise;

    expect(markers.map((marker) => marker.type)).toEqual([
      "plan_drafted",
      "plan_file_written",
      "plan_approved",
      "plan_executing",
      "plan_done",
    ]);
    expect(markers[2]).toMatchObject({ executeAfterApproval: true });
    expect(markers[4]).toMatchObject({ status: "ok" });
  });

  it("draft-only path terminates on plan_approved(false) without plan_done", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const { planManager, markers, exitTool } = await setupPlan("interactive");

    const promise = exitTool.execute("tc-order-draft-only", { approved: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(planManager.sessionKey, { action: "approve_only" });
    await promise;

    expect(markers.map((marker) => marker.type)).toEqual([
      "plan_drafted",
      "plan_file_written",
      "plan_approved",
    ]);
    expect(markers[2]).toMatchObject({ executeAfterApproval: false });
  });

  it("reject returns to drafting and a redraft emits a second drafted marker", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const { planManager, markers, exitTool } = await setupPlan("interactive");

    const firstAttempt = exitTool.execute("tc-order-reject", { approved: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(planManager.sessionKey, {
      action: "reject",
      feedback: "needs more detail",
    });
    await firstAttempt;

    const secondAttempt = exitTool.execute("tc-order-redraft", { approved: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(planManager.sessionKey, { action: "approve_only" });
    await secondAttempt;

    expect(markers.map((marker) => marker.type)).toEqual([
      "plan_drafted",
      "plan_file_written",
      "plan_rejected",
      "plan_drafted",
      "plan_file_written",
      "plan_approved",
    ]);
  });

  it("abandon emits a terminal rejection, and the approved=false shortcut skips the drafted preamble", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const interactive = await setupPlan("interactive");

    const gated = interactive.exitTool.execute("tc-order-abandon", { approved: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(interactive.planManager.sessionKey, { action: "abandon" });
    await gated;

    expect(interactive.markers.map((marker) => marker.type)).toEqual([
      "plan_drafted",
      "plan_file_written",
      "plan_rejected",
    ]);

    const shortcut = await setupPlan("interactive");
    await shortcut.exitTool.execute("tc-order-shortcut", { approved: false });
    expect(shortcut.markers.map((marker) => marker.type)).toEqual([
      "plan_rejected",
    ]);
  });

  it("emits exactly one terminal marker on execute, draft-only, and abandon paths", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );

    for (const action of [
      "approve_execute",
      "approve_only",
      "abandon",
    ] as const) {
      const { planManager, markers, exitTool } = await setupPlan("interactive");
      const promise = exitTool.execute(`tc-terminal-${action}`, { approved: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      resolvePlanApproval(planManager.sessionKey, { action } as any);
      await promise;

      const terminalCount = markers.filter((marker) =>
        marker.type === "plan_done" ||
        (marker.type === "plan_approved" && marker.executeAfterApproval === false) ||
        (marker.type === "plan_rejected" && marker.action === "abandon"),
      ).length;

      expect(terminalCount).toBe(1);
    }
  });
});

describe("planHash integrity chain (T6)", () => {
  it("keeps the same hash across drafted, file_written, and executing markers", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
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
    planManager.setApprovalMode("interactive");
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);
    planManager.attachStateMachine(new PlanStateMachine(emitter));
    planManager.enterPlanMode("Integrity baseline");
    planManager.writePlanContent("1. Keep hashes aligned");

    const promise = createExitPlanModeTool(planManager).execute("tc-hash-ok", {
      approved: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(planManager.sessionKey, { action: "approve_execute" });
    await promise;

    const drafted = markers.find((marker) => marker.type === "plan_drafted");
    const fileWritten = markers.find((marker) => marker.type === "plan_file_written");
    const executing = markers.find((marker) => marker.type === "plan_executing");

    expect(drafted.planHash).toBe(fileWritten.planHash);
    expect(fileWritten.planHash).toBe(executing.planHash);
  });

  it("abandons the turn when the plan bytes are tampered before execution starts", async () => {
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
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
    planManager.setApprovalMode("interactive");
    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));
    setTranscriptMarkerEmitter(planManager.sessionKey, emitter);
    planManager.attachStateMachine(new PlanStateMachine(emitter));
    const plan = planManager.enterPlanMode("Integrity violation");
    planManager.writePlanContent("1. Original plan bytes");

    const promise = createExitPlanModeTool(planManager).execute("tc-hash-bad", {
      approved: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(plan!.filePath, "tampered plan bytes", "utf-8");
    resolvePlanApproval(planManager.sessionKey, { action: "approve_execute" });
    const result = await promise;
    const body = parseTextPayload(result);

    expect(body.status).toBe("plan_abandoned");
    expect(markers.map((marker) => marker.type)).toEqual([
      "plan_drafted",
      "plan_file_written",
      "plan_approved",
      "plan_rejected",
    ]);
    expect(markers[3]).toMatchObject({
      action: "abandon",
      feedback: "plan integrity violation",
    });
  });
});
