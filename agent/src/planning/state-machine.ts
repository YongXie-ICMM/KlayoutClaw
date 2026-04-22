import { createHash } from "node:crypto";
import type { TranscriptMarkerEmitter } from "../events/marker-emitter.js";
import { planSlugCache, slugCacheState } from "./slug-cache.js";
import {
  classifyWithPattern,
  type ToolResultEnvelope,
} from "./blocker-classifier.js";
import type {
  PlanApprovedMarker,
  PlanDoneMarker,
  PlanDraftedMarker,
  PlanExecutingMarker,
  PlanExecutionAbortedMarker,
  PlanFileWrittenMarker,
  PlanRejectedMarker,
  PlanReplanMarker,
} from "../events/marker-types.js";

export type PlanState =
  | "plan_drafting"
  | "plan_drafted"
  | "plan_approved"
  | "plan_rejected"
  | "plan_executing"
  | "plan_done";

export class PlanProtocolError extends Error {}

type MarkerPayload =
  | Omit<PlanDraftedMarker, "type" | "ts">
  | Omit<PlanApprovedMarker, "type" | "ts">
  | Omit<PlanRejectedMarker, "type" | "ts">
  | Omit<PlanExecutingMarker, "type" | "ts">
  | Omit<PlanDoneMarker, "type" | "ts">;

const planStates = new WeakMap<object, PlanState>();
const initialPlanHashes = new WeakMap<object, string>();
const replanCounts = new WeakMap<object, number>();
/**
 * Per-session cumulative blocker trail. Each unrecoverable classification
 * appends `"<tool>: <pattern>"`; the terminal plan_done{failed} marker
 * joins entries with `"; "` for its `reason` field. Cleared by
 * {@link PlanStateMachine.resetReplanCount} on user-turn boundaries.
 */
const blockerReasons = new WeakMap<object, string[]>();

/** PM-6 hard cap: 3 replans allowed per user turn, terminal on the 4th abort. */
const REPLAN_CAP = 3;

export class PlanStateMachine {
  constructor(private emitter: TranscriptMarkerEmitter) {}

  getState(session: object): PlanState | undefined {
    return planStates.get(session);
  }

  setState(session: object, state: PlanState): void {
    planStates.set(session, state);
  }

  getReplanCount(session: object): number {
    return replanCounts.get(session) ?? 0;
  }

  setReplanCount(session: object, count: number): void {
    replanCounts.set(session, count);
  }

  getInitialPlanHash(session: object): string | undefined {
    return initialPlanHashes.get(session);
  }

  setInitialPlanHash(session: object, hash: string): void {
    initialPlanHashes.set(session, hash);
  }

  transition(
    session: object,
    _from: PlanState,
    to: PlanState,
    payload: MarkerPayload,
  ): void {
    planStates.set(session, to);
    const ts = new Date().toISOString();

    switch (to) {
      case "plan_drafted":
        this.emitter.emit("marker", {
          type: "plan_drafted",
          ...(payload as Omit<PlanDraftedMarker, "type" | "ts">),
          ts,
        });
        break;
      case "plan_approved":
        this.emitter.emit("marker", {
          type: "plan_approved",
          ...(payload as Omit<PlanApprovedMarker, "type" | "ts">),
          ts,
        });
        break;
      case "plan_rejected":
        this.emitter.emit("marker", {
          type: "plan_rejected",
          ...(payload as Omit<PlanRejectedMarker, "type" | "ts">),
          ts,
        });
        break;
      case "plan_executing":
        this.emitter.emit("marker", {
          type: "plan_executing",
          ...(payload as Omit<PlanExecutingMarker, "type" | "ts">),
          ts,
        });
        break;
      case "plan_done":
        this.emitter.emit("marker", {
          type: "plan_done",
          ...(payload as Omit<PlanDoneMarker, "type" | "ts">),
          ts,
        });
        break;
      case "plan_drafting":
        break;
      default:
        throw new PlanProtocolError(`unsupported plan state: ${to}`);
    }

    if (to === "plan_done") {
      slugCacheState.markTerminal(session);
    }
    if (
      to === "plan_approved" &&
      (payload as Omit<PlanApprovedMarker, "type" | "ts">).executeAfterApproval === false
    ) {
      slugCacheState.markTerminal(session);
    }
    if (
      to === "plan_rejected" &&
      (payload as Omit<PlanRejectedMarker, "type" | "ts">).action === "abandon"
    ) {
      planSlugCache.delete(session);
    }
  }

  emitPlanFileWritten(
    planFilePath: string,
    planHash: string,
    bytes: number,
  ): void {
    this.emitter.emit("marker", {
      type: "plan_file_written",
      planFilePath,
      planHash,
      bytes,
      ts: new Date().toISOString(),
    } satisfies PlanFileWrittenMarker);
  }

  planHash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /**
   * PM-6 step 2: reset the per-turn replan counter and cumulative blocker
   * trail at the start of each new user turn. Called from the prompt_start
   * code path so the replan cap is scoped to a single user turn.
   */
  resetReplanCount(session: object): void {
    replanCounts.set(session, 0);
    blockerReasons.delete(session);
  }

  /**
   * Return the cumulative blocker trail collected since the last
   * {@link resetReplanCount}. Test-only / diagnostic surface.
   */
  getBlockerReasons(session: object): string[] {
    return blockerReasons.get(session) ?? [];
  }

  /**
   * PM-6 replan-loop interception point. Called by the harness on every
   * tool-result observed while the session is in `plan_executing`. Classifies
   * the result via {@link classifyWithPattern} and drives the state machine
   * through the abort → replan / terminal `plan_done{failed}` cycle.
   *
   * State hops here (plan_executing → plan_drafting, plan_executing →
   * plan_done) are legitimate within PM-6 but would be rejected by the
   * {@link transition} adjacency guard that PM-8 / T41 installs. We bypass
   * the guard by writing `planStates` directly and emitting markers via
   * the same `emitter` channel the normal transitions use.
   */
  handleToolResult(
    session: object,
    toolName: string,
    result: ToolResultEnvelope,
  ): { aborted: boolean; terminal: boolean } {
    const { classification, pattern, reason } = classifyWithPattern(
      toolName,
      result,
    );

    if (classification !== "unrecoverable") {
      // Recoverable / not-in-scope: no side effects, caller continues
      // execution normally.
      return { aborted: false, terminal: false };
    }

    // Post-increment: the FIRST unrecoverable blocker in a turn carries
    // `replan_count: 1` on the aborted marker, not 0.
    const nextCount = (replanCounts.get(session) ?? 0) + 1;
    replanCounts.set(session, nextCount);

    const trail = blockerReasons.get(session) ?? [];
    trail.push(`${toolName}: ${pattern}`);
    blockerReasons.set(session, trail);

    const ts = new Date().toISOString();

    const aborted: PlanExecutionAbortedMarker = {
      type: "plan_execution_aborted",
      reason,
      replan_count: nextCount,
      tool: toolName,
      pattern,
      ts,
    };
    this.emitter.emit("marker", aborted);

    if (nextCount <= REPLAN_CAP) {
      // Non-terminal: emit plan_replan, drop back to plan_drafting so the
      // harness can draft a fresh plan. Use direct WeakMap writes to bypass
      // the transition adjacency guard (plan_executing → plan_drafting is
      // PM-6-legitimate but not in the adjacency table).
      const replan: PlanReplanMarker = {
        type: "plan_replan",
        replan_count: nextCount,
        prev_reason: reason,
        ts: new Date().toISOString(),
      };
      this.emitter.emit("marker", replan);
      planStates.set(session, "plan_drafting");
      return { aborted: true, terminal: false };
    }

    // Terminal: replan cap exhausted. Emit plan_done{failed} with the
    // cumulative blocker trail and mark the slug cache terminal (same
    // side-effect as the normal transition() path).
    const done: PlanDoneMarker = {
      type: "plan_done",
      status: "failed",
      reason: trail.join("; "),
      ts: new Date().toISOString(),
    };
    this.emitter.emit("marker", done);
    planStates.set(session, "plan_done");
    slugCacheState.markTerminal(session);
    return { aborted: true, terminal: true };
  }
}
