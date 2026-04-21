/**
 * TranscriptMarker discriminated union (v0.4.4 §4.6 + TH-8).
 *
 * All 9 marker variants are declared here. Phase 0 only wires a
 * producer for `think_recorded` (via the `thinking` tool landing in
 * Phase 1). The 8 `plan_*` variants land their producers in Phase 2
 * (G3/G4), but the union MUST be complete now so consumers (history
 * JSONL writer, verbose transcript writer, RPC forwarder, TUI
 * callback) can narrow on `type` without knowing which producer is
 * live.
 *
 * Shape follows spec §4.6 verbatim — DO NOT reorder fields. Consumers
 * depend on the declared shape, and spec §4.7 invariants (canonical
 * `marker.ts`, `planHash` match across `plan_drafted` / `plan_file_written`
 * / `plan_executing`, etc.) are enforced at the call sites and reflected
 * in the runtime test-contracts assertions.
 *
 * Field notes (from spec §4.6):
 *   - `ts` is ISO-8601 (iso8601 string literal wins over any wrapper ts).
 *   - `planHash` is sha256(utf8Bytes(plan)) lowercase hex — 64 chars.
 *   - `planLengthChars` is JS String.length of the plan (code-unit count).
 *   - `planSlug` is the word-slug from PM-11, stable across replans.
 *   - `planFilePath` is an absolute path.
 *   - `requestId` is NOT part of the v0.4.4 schema — it arrives in v0.4.5
 *     with the subagent approval-gate transport (PM-9).
 *   - `executeAfterApproval` on `plan_approved` distinguishes option 1
 *     (approve & execute) from option 2 (approve draft-only).
 *   - `action` on `plan_rejected` disambiguates option 3 ("reject") from
 *     option 4 ("abandon"). `feedback: "abandoned"` is the canonical
 *     sentinel for option 4.
 *   - `plan_file_written`, `plan_execution_aborted`, `plan_replan` are
 *     new in v0.4.4 — see the field notes in §4.6 for the rationale.
 */

/** TH-8 / TH-9 — `source` distinguishes the three origins of a
 *  `think_recorded` marker. Phase 0's producer (the `thinking` tool —
 *  G2 Phase 1) emits only `"tool"`. Native extended-thinking blocks
 *  (`"native"`) and inline-tag-recovered thoughts (`"inline"`) are
 *  out of scope for v0.4.4 as producers but the field is reserved. */
export type ThinkRecordedSource = "tool" | "native" | "inline";

export interface ThinkRecordedMarker {
  type: "think_recorded";
  thought: string;
  source: ThinkRecordedSource;
  ts: string;
}

export interface PlanDraftedMarker {
  type: "plan_drafted";
  plan: string;
  /** sha256(utf8Bytes(plan)), lowercase hex, 64 chars. */
  planHash: string;
  /** JS String.length (code-unit count) of the plan. */
  planLengthChars: number;
  /** Word-slug (PM-11); stable across replans within a session. */
  planSlug: string;
  /** Absolute filesystem path the plan was written to. */
  planFilePath: string;
  replan_count: number;
  ts: string;
}

export interface PlanFileWrittenMarker {
  type: "plan_file_written";
  planFilePath: string;
  planHash: string;
  bytes: number;
  ts: string;
}

export interface PlanApprovedMarker {
  type: "plan_approved";
  /** `true` when the approval was auto-approved (subagent or skipconfirm). */
  auto: boolean;
  /** `true` = option 1 (approve & execute); `false` = option 2
   *  (approve draft-only, sandbox lifts but no execution). */
  executeAfterApproval: boolean;
  ts: string;
  // NOTE: no `requestId` field in v0.4.4 — spec §4.6 line 398 defers it
  // to v0.4.5 with the subagent approval-gate transport (PM-9) and
  // headless approval RPC (OQ-7).
}

export interface PlanRejectedMarker {
  type: "plan_rejected";
  feedback: string;
  /** `"reject"` = option 3 (replan loop per PM-6).
   *  `"abandon"` = option 4 (skip replan, exit plan mode immediately). */
  action: "reject" | "abandon";
  ts: string;
}

export interface PlanExecutingMarker {
  type: "plan_executing";
  planHash: string;
  ts: string;
}

export interface PlanExecutionAbortedMarker {
  type: "plan_execution_aborted";
  reason: string;
  replan_count: number;
  tool: string;
  pattern: string;
  ts: string;
}

export interface PlanReplanMarker {
  type: "plan_replan";
  replan_count: number;
  prev_reason: string;
  ts: string;
}

export interface PlanDoneMarker {
  type: "plan_done";
  status: "ok" | "failed";
  /** Optional free-text reason — populated especially on `status: "failed"`. */
  reason?: string;
  ts: string;
}

/**
 * The full discriminated union — every marker that can appear on the
 * `TranscriptMarkerEmitter` "marker" event. Consumers narrow via
 * `marker.type`.
 */
export type TranscriptMarker =
  | ThinkRecordedMarker
  | PlanDraftedMarker
  | PlanFileWrittenMarker
  | PlanApprovedMarker
  | PlanRejectedMarker
  | PlanExecutingMarker
  | PlanExecutionAbortedMarker
  | PlanReplanMarker
  | PlanDoneMarker;
