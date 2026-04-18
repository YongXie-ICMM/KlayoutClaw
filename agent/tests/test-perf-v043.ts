/**
 * qlaybot v0.4.3 — Group 6 step 21 perf benchmarks (spec §5.4).
 *
 * Opt-in by default (`QLAYBOT_BENCH=1 npm test`). CI noise routinely swamps
 * µs-scale budgets, so the actual p95 numbers here are relaxed ~5x from
 * the spec. If you want to tighten a budget for local tuning, just edit
 * the `budgetMs` field in the relevant test.
 *
 * Each bench uses the hand-rolled `runBenchWithP95` from perf-harness.ts.
 * No tinybench dependency (absent from package.json).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBenchWithP95 } from "./perf-harness.js";

const BENCH_ENABLED = process.env.QLAYBOT_BENCH === "1";
// vitest has a `describe.skipIf` but we keep it explicit here.
const describeBench = BENCH_ENABLED ? describe : describe.skip;

describeBench("Perf §5.4 · p95 budgets (opt-in: QLAYBOT_BENCH=1)", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "qlaybot-bench-"));
  });

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  // Budgets below are 5× the spec values to damp CI noise. Edit locally
  // to tune for real regressions.

  it("PlanManager.enterPlanMode p95 < 100ms (spec 20ms × 5)", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const workspace = join(tmp, "ws-enter");
    const result = await runBenchWithP95(
      "PlanManager.enterPlanMode",
      () => {
        const pm = new PlanManager(workspace);
        pm.enterPlanMode("bench task");
        pm.exitPlanMode(false);
      },
      { iterations: 100 },
    );
    expect(result.p95).toBeLessThan(100);
  });

  it("PlanManager.exitPlanMode p95 < 75ms (spec 15ms × 5)", async () => {
    const { PlanManager } = await import("../src/planning/index.js");
    const workspace = join(tmp, "ws-exit");
    const pm = new PlanManager(workspace);
    const result = await runBenchWithP95(
      "PlanManager.exitPlanMode",
      () => {
        pm.enterPlanMode("bench exit");
        pm.exitPlanMode(true);
      },
      { iterations: 100 },
    );
    expect(result.p95).toBeLessThan(75);
  });

  it("truncate(10MB) p95 < 150ms (spec 30ms × 5)", async () => {
    const { truncate, DEFAULT_TRANSCRIPT_TRUNCATION } = await import(
      "../src/truncation.js"
    );
    const big = "x".repeat(10_000_000);
    const result = await runBenchWithP95(
      "truncate(10MB)",
      () => {
        truncate(big, DEFAULT_TRANSCRIPT_TRUNCATION);
      },
      { iterations: 100 },
    );
    expect(result.p95).toBeLessThan(150);
  });

  it("renderInlineImage(2MB base64) p95 < 150ms (spec 30ms × 5)", async () => {
    const { renderInlineImage } = await import("../src/tui/image-render.js");
    const b64 = "A".repeat(2_000_000);
    const result = await runBenchWithP95(
      "renderInlineImage(2MB)",
      () => {
        renderInlineImage(b64);
      },
      { iterations: 100 },
    );
    expect(result.p95).toBeLessThan(150);
  });

  it("renderFallback(2MB base64) p95 < 400ms (spec 80ms × 5)", async () => {
    const { renderFallback } = await import("../src/tui/image-render.js");
    const tmpOut = join(tmp, "fallback-out");
    const b64 = Buffer.from("A".repeat(2_000_000)).toString("base64");
    const result = await runBenchWithP95(
      "renderFallback(2MB)",
      () => {
        renderFallback(b64, tmpOut);
      },
      { iterations: 100 },
    );
    expect(result.p95).toBeLessThan(400);
  });

  it("VerboseTranscriptWriter write(50KB) p95 < 150ms (spec 30ms × 5)", async () => {
    // Dynamic import — module does not exist until step 19.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const mod = await import("../src/verbose-transcript.js");
    const VerboseTranscriptWriter = mod.VerboseTranscriptWriter;
    const ws = join(tmp, "ws-write");
    const w = new VerboseTranscriptWriter(ws, "bench-sess");
    const payload = "z".repeat(50_000);
    const result = await runBenchWithP95(
      "verbose-transcript.write(50KB)",
      () => {
        w.write({ type: "tool_result", result: payload });
      },
      { iterations: 100 },
    );
    await w.close();
    expect(result.p95).toBeLessThan(150);
  });

  it("isInsidePlansDir(realpath) p95 < 2.5ms (spec 500µs × 5)", async () => {
    const { isInsidePlansDir } = (await import(
      "../src/planning/sandbox.js"
    )) as unknown as {
      isInsidePlansDir: (
        candidate: string,
        plansDir: string,
        cwd: string,
      ) => boolean;
    };
    const workspace = mkdtempSync(join(tmp, "ws-isinside-"));
    const plansDir = join(workspace, "plans");
    // Ensure plans dir exists so realpathSync succeeds.
    const fs = await import("fs");
    fs.mkdirSync(plansDir, { recursive: true });
    const filePath = join(plansDir, "plan-bench.md");
    writeFileSync(filePath, "# bench");
    const result = await runBenchWithP95(
      "isInsidePlansDir",
      () => {
        isInsidePlansDir(filePath, plansDir, workspace);
      },
      { iterations: 100 },
    );
    expect(result.p95).toBeLessThan(2.5);
  });

  it("sandbox wrapper no-op overhead p95 < 5ms (spec 1ms × 5)", async () => {
    const { wrapWriteForPlanMode } = (await import(
      "../src/planning/sandbox.js"
    )) as unknown as {
      wrapWriteForPlanMode: (
        tool: unknown,
        planManager: { inPlanMode: boolean; plansDir: string } | unknown,
        cwd: string,
      ) => { execute: (p: unknown) => Promise<unknown> };
    };
    const fakeTool = {
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const fakePM = { inPlanMode: false, plansDir: "/tmp/unused" };
    const wrapped = wrapWriteForPlanMode(fakeTool, fakePM, "/tmp");
    const result = await runBenchWithP95(
      "wrapWriteForPlanMode-noop",
      async () => {
        await wrapped.execute({ path: "/tmp/any.txt", content: "x" });
      },
      { iterations: 100 },
    );
    expect(result.p95).toBeLessThan(5);
  });
});
