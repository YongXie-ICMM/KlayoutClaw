/**
 * Perf harness for qlaybot v0.4.3 — Group 6 step 21.
 *
 * Hand-rolled p95 wrapper over `performance.now()`. Spec §5.4 mentions
 * tinybench as the expected engine, but tinybench is NOT installed in
 * this repo (verified against package.json at authoring time) and Group
 * 6 explicitly does not add a new prod/dev dependency. The custom
 * implementation produces IDENTICAL p95 semantics to the spec formula:
 *
 *     p95 = sortedSamples[Math.ceil(0.95 * N) - 1]
 *
 * `computeP95` is unit-tested in tests/test-plan-mode-v043-group6.ts at
 * N=10, N=20, N=100 to pin the exact formula.
 *
 * Contract:
 *   - Run `fn` at least `iterations` times (default 100).
 *   - Collect per-iteration wall times in milliseconds.
 *   - Sort samples ascending, pick `samples[Math.ceil(0.95 * N) - 1]` as p95.
 *   - Return `{name, mean, p95, samples, iterations}`.
 *   - If `budgetMs` is provided and `p95 > budgetMs`, throw an Error tagged
 *     with the bench name. Callers that want to assert manually can pass
 *     `budgetMs = Infinity`.
 *
 * Supports async fns (returns Promise<void>) and sync fns.
 */
import { performance } from "node:perf_hooks";

export interface PerfResult {
  name: string;
  iterations: number;
  mean: number;
  p95: number;
  samples: number[];
}

export interface RunBenchOptions {
  /** Minimum samples. Default 100. */
  iterations?: number;
  /** Budget in milliseconds for p95. If exceeded, `runBenchWithP95` throws. */
  budgetMs?: number;
  /** Optional setup fn run once before the loop (not timed). */
  setup?: () => unknown | Promise<unknown>;
  /** Optional teardown fn run once after the loop (not timed). */
  teardown?: () => unknown | Promise<unknown>;
}

/**
 * Compute the p95 of an already-sorted-or-unsorted sample array using the
 * spec's `samples[Math.ceil(0.95 * N) - 1]` formula. For N=100 this picks
 * `samples[94]` (the 95th value in 1-indexed terms, 0-indexed 94).
 *
 * Pure function — exported so the unit test in the main Group 6 file can
 * verify the math without running a full bench.
 */
export function computeP95(samples: number[]): number {
  if (samples.length === 0) {
    throw new Error("computeP95: samples array is empty");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

export async function runBenchWithP95(
  name: string,
  fn: () => unknown | Promise<unknown>,
  opts: RunBenchOptions = {},
): Promise<PerfResult> {
  const iterations = Math.max(1, opts.iterations ?? 100);

  if (opts.setup) {
    await opts.setup();
  }

  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const ret = fn();
    if (ret && typeof (ret as Promise<unknown>).then === "function") {
      await ret;
    }
    const t1 = performance.now();
    samples[i] = t1 - t0;
  }

  if (opts.teardown) {
    await opts.teardown();
  }

  const sum = samples.reduce((a, b) => a + b, 0);
  const mean = sum / samples.length;
  const p95 = computeP95(samples);

  const result: PerfResult = { name, iterations, mean, p95, samples };

  if (opts.budgetMs !== undefined && p95 > opts.budgetMs) {
    throw new Error(
      `perf-harness: ${name} p95=${p95.toFixed(3)}ms exceeded budget ${opts.budgetMs}ms`,
    );
  }

  return result;
}
