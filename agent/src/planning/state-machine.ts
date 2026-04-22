import { createHash } from "node:crypto";
import type { TranscriptMarkerEmitter } from "../events/marker-emitter.js";
import { planSlugCache, slugCacheState } from "./slug-cache.js";
import type {
  PlanApprovedMarker,
  PlanDoneMarker,
  PlanDraftedMarker,
  PlanExecutingMarker,
  PlanFileWrittenMarker,
  PlanRejectedMarker,
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
}
