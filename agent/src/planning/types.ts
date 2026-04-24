/**
 * Type definitions for the qlaybot planning system (v0.4.3, spec §1.3).
 * Ported from qdevbot `src/planning/types.ts` for behavioral parity.
 */

export type PlanStatus = "active" | "approved" | "completed" | "abandoned";

export interface PlanTask {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

export interface Plan {
  id: string;
  title: string;
  task: string;
  status: PlanStatus;
  tasks: PlanTask[];
  filePath: string;
  createdAt: number;
  updatedAt: number;
}

export type PlanEventType =
  | "plan_mode_entered"
  | "plan_mode_exited"
  | "plan_created"
  | "plan_updated"
  | "plan_verified";

export interface PlanEvent {
  type: PlanEventType;
  planId?: string;
  timestamp: number;
}

export type PlanEventListener = (event: PlanEvent) => void;
