/**
 * Background task types.
 */

export interface BackgroundTask {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}
