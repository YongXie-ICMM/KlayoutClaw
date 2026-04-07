/**
 * BackgroundTaskManager — runs long operations asynchronously.
 */

import type { BackgroundTask } from "./types.js";

const BACKGROUNDABLE_TOOLS = new Set([
  "klayout_nanodevice_flakedetect_detect_stack",
  "klayout_nanodevice_flakedetect_align",
  "klayout_nanodevice_flakedetect_detect",
  "klayout_nanodevice_flakedetect_combine",
  "klayout_nanodevice_gdsalign_align_to_gds",
  "klayout_native_auto_route",
  "klayout_native_save_layout",
  "klayout_native_evaluate_design",
]);

export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private taskCounter = 0;
  private listeners: Array<(task: BackgroundTask) => void> = [];

  /**
   * Check if a tool name should run in the background.
   */
  isBackgroundable(toolName: string): boolean {
    return BACKGROUNDABLE_TOOLS.has(toolName);
  }

  /**
   * Run an async function as a background task.
   */
  run(name: string, fn: () => Promise<unknown>): string {
    const id = String(++this.taskCounter);
    const task: BackgroundTask = {
      id,
      name,
      status: "running",
      startedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.notify(task);

    fn()
      .then((result) => {
        task.status = "completed";
        task.completedAt = Date.now();
        task.result = result;
        this.notify(task);
      })
      .catch((err: unknown) => {
        task.status = "failed";
        task.completedAt = Date.now();
        task.error = err instanceof Error ? err.message : String(err);
        this.notify(task);
      });

    return id;
  }

  /**
   * Get a task by ID.
   */
  status(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * List all tasks.
   */
  list(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get the result of a completed task. Returns undefined if still running.
   */
  result(id: string): unknown | undefined {
    const task = this.tasks.get(id);
    if (!task || task.status === "running") return undefined;
    return task.result;
  }

  /**
   * Subscribe to task state changes.
   */
  subscribe(listener: (task: BackgroundTask) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Cancel a running task. No-op for completed/failed tasks or invalid IDs.
   */
  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    task.status = "cancelled";
    task.completedAt = Date.now();
    this.notify(task);
  }

  private notify(task: BackgroundTask): void {
    for (const listener of this.listeners) {
      listener(task);
    }
  }
}

export { BACKGROUNDABLE_TOOLS };
