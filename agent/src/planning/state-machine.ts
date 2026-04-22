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
  TranscriptMarker,
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

/**
 * PM-8 / T41 state-machine adjacency table. Every legitimate `transition()`
 * call-site in `src/tools/plan.ts` maps to one of these (from, to) pairs.
 * Direct WeakMap writes (PM-6 replan loop in `handleToolResult`, gate-driven
 * `setState` hops) intentionally bypass this guard.
 */
const LEGAL_TRANSITIONS: ReadonlyMap<PlanState, ReadonlySet<PlanState>> = new Map([
  ["plan_drafting", new Set<PlanState>(["plan_drafted", "plan_rejected"])],
  ["plan_drafted", new Set<PlanState>(["plan_approved", "plan_rejected"])],
  // plan_approved → plan_rejected covers the post-approval integrity-violation
  // path in plan.ts (executingHash !== planHash after approve_execute /
  // headless): the caller has already emitted plan_approved and must now
  // abandon via the shared `integrityViolation` helper.
  ["plan_approved", new Set<PlanState>(["plan_executing", "plan_rejected"])],
  ["plan_executing", new Set<PlanState>(["plan_done"])],
  ["plan_rejected", new Set<PlanState>([])],
  ["plan_done", new Set<PlanState>([])],
]);

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
    from: PlanState,
    to: PlanState,
    payload: MarkerPayload,
  ): void {
    // PM-8 / T41 illegal-transition guard. Validate the caller-supplied
    // (from, to) pair against the normative adjacency table. Direct WeakMap
    // writes (PM-6 replan loop in `handleToolResult`, gate-driven `setState`
    // hops in plan.ts) intentionally bypass this guard.
    const allowedTargets = LEGAL_TRANSITIONS.get(from);
    if (!allowedTargets || !allowedTargets.has(to)) {
      // Emit the terminal abandon marker BEFORE throwing so synchronous
      // subscribers (history JSONL, RPC, TUI) observe exactly one terminal
      // marker before the exception propagates to the caller.
      this.emitter.emit("marker", {
        type: "plan_rejected",
        action: "abandon",
        feedback: "protocol violation: illegal state transition",
        ts: new Date().toISOString(),
      });
      throw new PlanProtocolError(
        `illegal state transition: ${from} → ${to}`,
      );
    }

    planStates.set(session, to);
    const ts = new Date().toISOString();

    // plan_drafting is an internal-only state — no marker is emitted. All
    // other legal targets emit a marker with `type: to` and the payload
    // merged in; the (from, to) guard above + MarkerPayload union keep
    // the shape honest at the type level.
    if (to !== "plan_drafting") {
      this.emitter.emit("marker", {
        type: to,
        ...payload,
        ts,
      } as TranscriptMarker);
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
