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

/**
 * Task 2.15 — T5 & T42 behavioural tests.
 *
 * API shape the Executor must implement (documented here so test-contracts
 * assertions of marker SHAPE don't duplicate the state-machine BEHAVIOUR
 * assertions below):
 *
 *   class PlanStateMachine {
 *     // existing methods... plus:
 *
 *     // Called by the harness on every tool-result while in plan_executing.
 *     // Returns { aborted, terminal } so callers can short-circuit execution
 *     // after an unrecoverable blocker.
 *     //
 *     //   - recoverable / not-in-scope → no side effects, returns
 *     //     { aborted: false, terminal: false }.
 *     //   - unrecoverable AND replan_count+1 <= 3 → increments replan_count,
 *     //     emits plan_execution_aborted{reason, tool, pattern, replan_count},
 *     //     emits plan_replan{replan_count, prev_reason}, transitions state
 *     //     to "plan_drafting", returns { aborted: true, terminal: false }.
 *     //   - unrecoverable AND replan_count+1 > 3 (i.e. the 4th unrecoverable
 *     //     blocker in one user turn) → increments replan_count to 4, emits
 *     //     plan_execution_aborted{replan_count: 4}, emits terminal
 *     //     plan_done{status:"failed", reason: <cumulative trail>},
 *     //     transitions state to "plan_done", returns { aborted: true,
 *     //     terminal: true }.
 *     handleToolResult(
 *       session: object,
 *       toolName: string,
 *       result: { content: [{ type: "text"; text: string }]; isError?: boolean },
 *     ): { aborted: boolean; terminal: boolean };
 *
 *     // Called at the start of each user prompt (PM-6 step 2: "reset to 0 at
 *     // the start of each new user turn"). Clears the WeakMap entry for this
 *     // session so the next unrecoverable blocker counts as replan_count=1.
 *     resetReplanCount(session: object): void;
 *   }
 *
 * Design notes:
 *   - `pattern` on plan_execution_aborted is drawn from the normative set
 *     defined in spec §4.5: "isError:true", "auto_route:failed",
 *     "auto_route:partial_with_errors", "evaluate_design:low_overall".
 *   - `reason` on plan_execution_aborted is a short human string; we don't pin
 *     the exact text — we assert it's non-empty so the executor can't silently
 *     pass an empty string.
 *   - `reason` on the terminal plan_done carries the cumulative blocker trail.
 *     We assert it mentions the tool name at minimum so the trail is non-trivial.
 *   - State at end of T5 is "plan_done" (the machine has entered its terminal
 *     state; subsequent transitions are outside PM-6's contract — §4.2 guards
 *     them via T41's PlanProtocolError work, not this task).
 */
describe("replan cap exhaustion (T5)", () => {
  it("emits 3 abort→replan cycles then a terminal plan_done{failed} on the 4th unrecoverable blocker", async () => {
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));

    const stateMachine = new PlanStateMachine(emitter);
    const session = {} as object;

    // Seed: start from the plan_executing state that PM-6 governs.
    stateMachine.setState(session, "plan_executing");
    stateMachine.setReplanCount(session, 0);

    // Unrecoverable auto_route result — classifier row: auto_route:failed.
    const failedPayload = {
      content: [
        { type: "text" as const, text: JSON.stringify({ status: "failed", errors: ["routing blocked"] }) },
      ],
    };

    // --- Attempt 1 ---
    const r1 = (stateMachine as any).handleToolResult(
      session,
      "klayout_native_auto_route",
      failedPayload,
    );
    expect(r1).toMatchObject({ aborted: true, terminal: false });

    // --- Attempt 2 ---
    // After a replan, the harness would drive back through plan_drafted and
    // plan_executing; we simulate that externally to isolate PM-6's contract.
    stateMachine.setState(session, "plan_executing");
    const r2 = (stateMachine as any).handleToolResult(
      session,
      "klayout_native_auto_route",
      failedPayload,
    );
    expect(r2).toMatchObject({ aborted: true, terminal: false });

    // --- Attempt 3 ---
    stateMachine.setState(session, "plan_executing");
    const r3 = (stateMachine as any).handleToolResult(
      session,
      "klayout_native_auto_route",
      failedPayload,
    );
    expect(r3).toMatchObject({ aborted: true, terminal: false });

    // --- Attempt 4 → terminal plan_done{failed} ---
    stateMachine.setState(session, "plan_executing");
    const r4 = (stateMachine as any).handleToolResult(
      session,
      "klayout_native_auto_route",
      failedPayload,
    );
    expect(r4).toMatchObject({ aborted: true, terminal: true });

    // Marker ordering: 3x (aborted → replan), then aborted(4) → plan_done.
    const types = markers.map((m) => m.type);
    expect(types).toEqual([
      "plan_execution_aborted",
      "plan_replan",
      "plan_execution_aborted",
      "plan_replan",
      "plan_execution_aborted",
      "plan_replan",
      "plan_execution_aborted",
      "plan_done",
    ]);

    // replan_count increments on every aborted marker (post-increment, so the
    // FIRST aborted sees replan_count=1, not 0).
    expect(markers[0]).toMatchObject({
      type: "plan_execution_aborted",
      replan_count: 1,
      tool: "klayout_native_auto_route",
      pattern: "auto_route:failed",
    });
    expect((markers[0] as any).reason).toEqual(expect.any(String));
    expect((markers[0] as any).reason.length).toBeGreaterThan(0);

    expect(markers[1]).toMatchObject({
      type: "plan_replan",
      replan_count: 1,
    });
    expect((markers[1] as any).prev_reason).toEqual(expect.any(String));
    expect((markers[1] as any).prev_reason.length).toBeGreaterThan(0);

    expect(markers[2]).toMatchObject({
      type: "plan_execution_aborted",
      replan_count: 2,
      tool: "klayout_native_auto_route",
      pattern: "auto_route:failed",
    });
    expect(markers[3]).toMatchObject({
      type: "plan_replan",
      replan_count: 2,
    });

    expect(markers[4]).toMatchObject({
      type: "plan_execution_aborted",
      replan_count: 3,
      tool: "klayout_native_auto_route",
      pattern: "auto_route:failed",
    });
    expect(markers[5]).toMatchObject({
      type: "plan_replan",
      replan_count: 3,
    });

    // Attempt 4: aborted marker shows replan_count=4, and the terminal
    // plan_done carries the cumulative failure reason.
    expect(markers[6]).toMatchObject({
      type: "plan_execution_aborted",
      replan_count: 4,
      tool: "klayout_native_auto_route",
      pattern: "auto_route:failed",
    });

    const terminal = markers[7];
    expect(terminal.type).toBe("plan_done");
    expect(terminal.status).toBe("failed");
    expect(typeof terminal.reason).toBe("string");
    expect(terminal.reason.length).toBeGreaterThan(0);
    // The cumulative trail must reference the tool so the agent's context has
    // a hint at what failed; empty or generic reasons fail this assertion.
    expect(terminal.reason).toContain("klayout_native_auto_route");

    // Exactly one terminal marker (no second plan_done, no stray plan_replan
    // after exhaustion).
    expect(markers.filter((m) => m.type === "plan_done")).toHaveLength(1);
    const replanAfterTerminal = markers
      .slice(markers.findIndex((m) => m.type === "plan_done"))
      .filter((m) => m.type === "plan_replan");
    expect(replanAfterTerminal).toHaveLength(0);

    // State ends in plan_done (terminal).
    expect(stateMachine.getState(session)).toBe("plan_done");

    // Internal counter reflects the 4 aborts.
    expect(stateMachine.getReplanCount(session)).toBe(4);
  });

  it("is a no-op on recoverable and not-in-scope results (no markers, no state change, no counter change)", async () => {
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));

    const stateMachine = new PlanStateMachine(emitter);
    const session = {} as object;
    stateMachine.setState(session, "plan_executing");
    stateMachine.setReplanCount(session, 0);

    // Recoverable: auto_route success
    const successResult = {
      content: [
        { type: "text" as const, text: JSON.stringify({ status: "success", routed_pairs: 3 }) },
      ],
    };
    const r1 = (stateMachine as any).handleToolResult(
      session,
      "klayout_native_auto_route",
      successResult,
    );
    expect(r1).toMatchObject({ aborted: false, terminal: false });

    // Not-in-scope: vc_checkpoint error payload
    const vcErr = {
      content: [
        { type: "text" as const, text: JSON.stringify({ status: "error", error: "x" }) },
      ],
    };
    const r2 = (stateMachine as any).handleToolResult(
      session,
      "klayout_native_vc_checkpoint",
      vcErr,
    );
    expect(r2).toMatchObject({ aborted: false, terminal: false });

    // No markers emitted, state unchanged, counter still zero.
    expect(markers).toHaveLength(0);
    expect(stateMachine.getState(session)).toBe("plan_executing");
    expect(stateMachine.getReplanCount(session)).toBe(0);
  });
});

describe("replan counter user-turn boundary reset (T42)", () => {
  it("resets replan_count to 0 at the start of a new user turn, so the next abort reports replan_count=1", async () => {
    const { PlanStateMachine } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));

    const stateMachine = new PlanStateMachine(emitter);
    const session = {} as object;

    // ========== Turn 1: exhaust the replan cap ==========
    stateMachine.setState(session, "plan_executing");
    stateMachine.setReplanCount(session, 0);

    const failedPayload = {
      content: [
        { type: "text" as const, text: JSON.stringify({ status: "failed", errors: ["boom"] }) },
      ],
    };

    // Drive 4 unrecoverable aborts to exhaust Turn 1.
    for (let i = 0; i < 4; i++) {
      stateMachine.setState(session, "plan_executing");
      (stateMachine as any).handleToolResult(
        session,
        "klayout_native_auto_route",
        failedPayload,
      );
    }
    expect(stateMachine.getReplanCount(session)).toBe(4);
    expect(markers.at(-1)?.type).toBe("plan_done");

    const turn1MarkerCount = markers.length;

    // ========== Turn 2 boundary: new user prompt arrives ==========
    // This is the prompt_start hook: reset the per-turn counter.
    (stateMachine as any).resetReplanCount(session);
    expect(stateMachine.getReplanCount(session)).toBe(0);

    // Fresh turn: put machine back into plan_executing and induce ONE blocker.
    stateMachine.setState(session, "plan_executing");
    const r = (stateMachine as any).handleToolResult(
      session,
      "klayout_native_auto_route",
      failedPayload,
    );

    // Must still be a non-terminal abort (replan_count=1, not 5, not terminal).
    expect(r).toMatchObject({ aborted: true, terminal: false });

    const turn2Markers = markers.slice(turn1MarkerCount);
    expect(turn2Markers.map((m) => m.type)).toEqual([
      "plan_execution_aborted",
      "plan_replan",
    ]);
    // The critical assertion: counter started fresh at 0, so the first abort
    // in Turn 2 reports replan_count=1 (not 4, not 5).
    expect(turn2Markers[0]).toMatchObject({
      type: "plan_execution_aborted",
      replan_count: 1,
    });
    expect(turn2Markers[1]).toMatchObject({
      type: "plan_replan",
      replan_count: 1,
    });
    expect(stateMachine.getReplanCount(session)).toBe(1);
  });
});

/**
 * Task 2.16 — Illegal-transition guard (T41).
 *
 * Spec §4.2 state invariants (line 271):
 *   "Direct transitions are a harness protocol violation and are treated as a
 *    fatal session error: the harness raises PlanProtocolError(...), emits
 *    plan_rejected {feedback: 'protocol violation: illegal state transition',
 *    action: 'abandon'} as the turn's terminal marker (satisfies the
 *    terminal-marker invariant), and surfaces the error to the caller. No
 *    plan_done is emitted."
 *
 * Contract the Executor must implement:
 *   - PlanStateMachine.transition() validates the (from, to) pair against a
 *     normative adjacency table. Illegal pairs:
 *       * plan_drafting      → plan_executing
 *       * plan_drafted       → plan_executing   (skips approval)
 *       * plan_executing     → plan_drafting    (PM-6 replan loop uses
 *                                                 direct WeakMap writes — it
 *                                                 does NOT call transition(),
 *                                                 so this direct call is
 *                                                 illegal by construction)
 *     ...and any other (from, to) pair not in the allow-list.
 *
 *   - On violation, BEFORE surfacing the error, the guard must emit ONE
 *     plan_rejected marker with:
 *       { type: "plan_rejected", action: "abandon",
 *         feedback: <string matching /protocol violation/> }
 *     so downstream observers (history JSONL, RPC, TUI) see exactly one
 *     terminal marker on the turn's marker bus.
 *
 *   - The guard then throws PlanProtocolError with message matching
 *     /illegal state transition/.
 *
 *   - The guard MUST NOT emit plan_done. plan_done is reserved for the
 *     execute path (turn began in plan_executing).
 *
 * Encoding decision: the marker is emitted on the emitter BEFORE throw exits,
 * so a synchronous emitter subscriber captures the marker before the caller's
 * try/catch sees the thrown error.
 */
describe("illegal-transition guard (T41)", () => {
  it("plan_drafting → plan_executing bypass emits abandon terminal and throws", async () => {
    const { PlanStateMachine, PlanProtocolError } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));

    const stateMachine = new PlanStateMachine(emitter);
    const session = {} as object;
    stateMachine.setState(session, "plan_drafting");

    let thrown: unknown = null;
    try {
      stateMachine.transition(
        session,
        "plan_drafting",
        "plan_executing",
        { planHash: "dead".padEnd(64, "0") },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PlanProtocolError);
    expect((thrown as Error).message).toMatch(/illegal state transition/);

    // Exactly one marker emitted BEFORE the throw — the abandon terminal.
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      type: "plan_rejected",
      action: "abandon",
    });
    expect(typeof (markers[0] as any).feedback).toBe("string");
    expect((markers[0] as any).feedback).toMatch(/protocol violation/);

    // No plan_done on illegal-transition paths (reserved for execute path).
    expect(markers.find((m) => m.type === "plan_done")).toBeUndefined();

    // Only ONE terminal marker: the plan_rejected{abandon}.
    const terminals = markers.filter(
      (m) =>
        m.type === "plan_done" ||
        (m.type === "plan_approved" && m.executeAfterApproval === false) ||
        (m.type === "plan_rejected" && m.action === "abandon"),
    );
    expect(terminals).toHaveLength(1);
  });

  it("plan_drafted → plan_executing (skipping approval) emits abandon terminal and throws", async () => {
    const { PlanStateMachine, PlanProtocolError } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));

    const stateMachine = new PlanStateMachine(emitter);
    const session = {} as object;

    // Legitimate entry into plan_drafted.
    stateMachine.setState(session, "plan_drafting");
    const planHash = "a".repeat(64);
    stateMachine.transition(session, "plan_drafting", "plan_drafted", {
      plan: "1. step",
      planHash,
      planLengthChars: 7,
      planSlug: "calm-otter",
      planFilePath: "/tmp/calm-otter.md",
      replan_count: 0,
    });
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe("plan_drafted");

    let thrown: unknown = null;
    try {
      stateMachine.transition(
        session,
        "plan_drafted",
        "plan_executing",
        { planHash },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PlanProtocolError);
    expect((thrown as Error).message).toMatch(/illegal state transition/);

    // Account for the legitimate plan_drafted already on the bus: total 2.
    expect(markers).toHaveLength(2);
    expect(markers[1]).toMatchObject({
      type: "plan_rejected",
      action: "abandon",
    });
    expect((markers[1] as any).feedback).toMatch(/protocol violation/);

    // No plan_done, and no plan_executing on the bus (illegal call must not
    // have emitted its intended marker).
    expect(markers.find((m) => m.type === "plan_done")).toBeUndefined();
    expect(markers.find((m) => m.type === "plan_executing")).toBeUndefined();

    // Exactly one terminal marker on the turn.
    const terminals = markers.filter(
      (m) =>
        m.type === "plan_done" ||
        (m.type === "plan_approved" && m.executeAfterApproval === false) ||
        (m.type === "plan_rejected" && m.action === "abandon"),
    );
    expect(terminals).toHaveLength(1);
  });

  it("plan_executing → plan_drafting (direct transition without PM-6 replan path) emits abandon terminal and throws", async () => {
    const { PlanStateMachine, PlanProtocolError } = await import(
      "../src/planning/state-machine.js"
    );
    const { TranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );

    const emitter = new TranscriptMarkerEmitter();
    const markers: any[] = [];
    emitter.on("marker", (marker) => markers.push(marker));

    const stateMachine = new PlanStateMachine(emitter);
    const session = {} as object;
    const planHash = "b".repeat(64);

    // Legitimate chain: drafting → drafted → approved → executing.
    stateMachine.setState(session, "plan_drafting");
    stateMachine.transition(session, "plan_drafting", "plan_drafted", {
      plan: "1. step",
      planHash,
      planLengthChars: 7,
      planSlug: "brisk-heron",
      planFilePath: "/tmp/brisk-heron.md",
      replan_count: 0,
    });
    stateMachine.transition(session, "plan_drafted", "plan_approved", {
      auto: false,
      executeAfterApproval: true,
    });
    stateMachine.transition(session, "plan_approved", "plan_executing", {
      planHash,
    });

    expect(markers.map((m) => m.type)).toEqual([
      "plan_drafted",
      "plan_approved",
      "plan_executing",
    ]);
    const preCount = markers.length;

    // Illegal: plan_executing → plan_drafting via transition(). PM-6's replan
    // loop uses direct WeakMap writes (bypassing transition()) for this hop;
    // calling transition() directly is the protocol violation.
    let thrown: unknown = null;
    try {
      stateMachine.transition(
        session,
        "plan_executing",
        "plan_drafting",
        {},
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PlanProtocolError);
    expect((thrown as Error).message).toMatch(/illegal state transition/);

    // Exactly one NEW marker after the throw: the abandon terminal.
    expect(markers.length).toBe(preCount + 1);
    const abandon = markers[preCount];
    expect(abandon).toMatchObject({
      type: "plan_rejected",
      action: "abandon",
    });
    expect((abandon as any).feedback).toMatch(/protocol violation/);

    // No plan_done anywhere on this turn.
    expect(markers.find((m) => m.type === "plan_done")).toBeUndefined();

    // Exactly one terminal marker on the turn.
    const terminals = markers.filter(
      (m) =>
        m.type === "plan_done" ||
        (m.type === "plan_approved" && m.executeAfterApproval === false) ||
        (m.type === "plan_rejected" && m.action === "abandon"),
    );
    expect(terminals).toHaveLength(1);
  });
});

/**
 * Task 2.17 — planLengthChars telemetry (PM-13 / T37).
 *
 * Spec §4.6 PlanDraftedMarker: planLengthChars = JS String.length of the plan
 * (UTF-16 code-unit count, NOT UTF-8 byte length).
 *
 * Much of this may already be satisfied by Task 2.7's plan_drafted emission.
 * We verify the contract with (a) a 4096-ASCII plan and (d) a multibyte plan
 * where UTF-16 code units (String.length) diverge from UTF-8 bytes.
 */
describe("planLengthChars telemetry (PM-13 / T37)", () => {
  it("T37(a): 4096-ASCII plan reports planLengthChars === 4096", async () => {
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

    planManager.enterPlanMode("ASCII length probe");
    const body = "a".repeat(4096);
    planManager.writePlanContent(body);
    expect(body.length).toBe(4096);

    // Interactive mode blocks on waitForPlanApproval; issue the exit call
    // without awaiting and resolve after the drafted marker lands.
    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const promise = createExitPlanModeTool(planManager).execute(
      "tc-t37-ascii",
      { approved: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(planManager.sessionKey, { action: "approve_execute" });
    await promise;

    const drafted = markers.find((m) => m.type === "plan_drafted");
    expect(drafted).toBeDefined();
    expect(drafted.planLengthChars).toBe(4096);
    // Sanity: the plan content must itself be 4096 chars, not truncated.
    expect(drafted.plan.length).toBe(4096);
  });

  it("T37(d): multi-byte (π×1000) plan reports UTF-16 code-units (1000), not UTF-8 bytes (2000)", async () => {
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

    planManager.enterPlanMode("Multibyte length probe");
    const body = "π".repeat(1000);
    planManager.writePlanContent(body);
    // JS String.length = UTF-16 code units; π (U+03C0) fits in ONE unit.
    expect(body.length).toBe(1000);
    // But UTF-8 bytes = 2000 (each π is 2 bytes).
    expect(Buffer.byteLength(body, "utf-8")).toBe(2000);

    const { resolvePlanApproval } = await import(
      "../src/planning/approval-gate.js"
    );
    const promise = createExitPlanModeTool(planManager).execute(
      "tc-t37-pi",
      { approved: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolvePlanApproval(planManager.sessionKey, { action: "approve_execute" });
    await promise;

    const drafted = markers.find((m) => m.type === "plan_drafted");
    expect(drafted).toBeDefined();
    // The critical assertion: 1000 (UTF-16 code units), NOT 2000 (UTF-8 bytes).
    expect(drafted.planLengthChars).toBe(1000);
    expect(drafted.planLengthChars).not.toBe(2000);
  });
});

