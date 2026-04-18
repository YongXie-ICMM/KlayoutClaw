/**
 * qlaybot v0.4.3 — Group 6b TRD tests (Test Overseer owned).
 *
 * Covers spec §9 steps 20-23 + §5.3 (shell harness) + §5.4 (perf budgets) +
 * §6 (Version & Release).
 *
 * Split from test-plan-mode-v043-group6.ts by the Group 6a Overseer —
 * the G6a file kept steps 15-19 + §4.5; this file holds the G6b scope.
 *
 * NOTE: This file is NOT yet wired into vitest.files.ts. G6b's Overseer
 * will add `"tests/test-plan-mode-v043-group6b.ts"` (and
 * `"tests/test-perf-v043.ts"`) when G6b begins.
 */

import {
  describe,
  it,
  expect,
} from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

import { computeP95, runBenchWithP95 } from "./perf-harness.js";

const __filename_g6b = fileURLToPath(import.meta.url);
const __dirname_g6b = dirname(__filename_g6b);
const REPO_ROOT = resolve(__dirname_g6b, "..");

async function loadPrompts(): Promise<typeof import("../src/prompts/index.js")> {
  return await import("../src/prompts/index.js");
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 20 — TOOLS-section plan-mode paragraph
// FIX (D): exact multi-line block + ordering anchor.
// ═════════════════════════════════════════════════════════════════════════════

const EXACT_PLAN_MODE_BLOCK = [
  "### Plan Mode",
  "Use `enter_plan_mode` proactively when the task involves:",
  "- Multi-step device design with dependencies between steps",
  "- Complex routing, layout, or fabrication decisions",
  "- Any operation where a mistake could invalidate hours of work",
  "During plan mode, only the plan file can be written. Read, klayout_get_layout_info,",
  "screenshot, route_inspect, and memory_search remain available. Bash and file writes",
  "outside the plan are blocked.",
  "The user can also type `/plan` to request plan mode.",
].join("\n");

describe("Group 6b · Step 20 · plan-mode paragraph in TOOLS section", () => {
  it("buildSystemPrompt(Full) contains the EXACT multi-line plan-mode block (spec §1.10)", async () => {
    const prompts = await loadPrompts();
    const out = prompts.buildSystemPrompt({
      mode: prompts.PromptMode.Full,
      workspaceDir: "/tmp/g6-prompts",
      toolNames: ["read", "bash", "klayout_native_screenshot"],
      connectedServers: [],
      subagentConfig: undefined,
      skillsDirs: undefined,
    });
    expect(out).toContain(EXACT_PLAN_MODE_BLOCK);
  });

  it("### Plan Mode paragraph appears AFTER the tooling/tools section header (ordering anchor)", async () => {
    const prompts = await loadPrompts();
    const out = prompts.buildSystemPrompt({
      mode: prompts.PromptMode.Full,
      workspaceDir: "/tmp/g6-prompts-order",
      toolNames: ["read", "bash"],
      connectedServers: [],
      subagentConfig: undefined,
      skillsDirs: undefined,
    });
    const idxPlanMode = out.indexOf("### Plan Mode");
    expect(idxPlanMode).toBeGreaterThan(0);
    // Tooling section header is "## Available Tools" per
    // src/prompts/sections/tooling.ts:7. Plan-mode paragraph must follow it.
    const idxTools = out.indexOf("## Available Tools");
    // If the Executor renames the header, accept any earlier `##` section
    // header appearing before `### Plan Mode`. We require SOME top-level
    // heading precedes ### Plan Mode.
    const firstDoubleHash = out.indexOf("##");
    expect(firstDoubleHash).toBeGreaterThanOrEqual(0);
    expect(firstDoubleHash).toBeLessThan(idxPlanMode);
    // And if tooling section exists, it comes before ### Plan Mode.
    if (idxTools >= 0) {
      expect(idxTools).toBeLessThan(idxPlanMode);
    }
  });

  it("buildSystemPrompt(Sub) does NOT contain '### Plan Mode' (subagents skip plan tools)", async () => {
    const prompts = await loadPrompts();
    const out = prompts.buildSystemPrompt({
      mode: prompts.PromptMode.Sub,
      workspaceDir: "/tmp/g6-prompts-sub",
      toolNames: ["read"],
      connectedServers: [],
      subagentConfig: undefined,
      skillsDirs: undefined,
    });
    expect(out).not.toContain("### Plan Mode");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STEP 21 — perf-harness p95 correctness
// FIX (E): pin the exact formula `samples[Math.ceil(0.95 * N) - 1]` at 2
// additional N values with known expected outputs.
// ═════════════════════════════════════════════════════════════════════════════

describe("Group 6b · Step 21 · perf-harness computeP95 + runBenchWithP95", () => {
  it("computeP95([1..100]) === 95 (spec formula samples[ceil(0.95*100)-1] = samples[94] = 95)", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(computeP95(samples)).toBe(95);
  });

  it("computeP95([1..10]) === 10 (edge: ceil(9.5)-1 = 9 → samples[9] = 10)", () => {
    const samples = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(computeP95(samples)).toBe(10);
  });

  it("computeP95([1..20]) === 19 (ceil(19.0)-1 = 18 → sorted[18] = 19)", () => {
    // 20 samples: idx = Math.ceil(0.95 * 20) - 1 = Math.ceil(19) - 1 = 18.
    // sorted[18] = 19 (1-indexed: 19th element).
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(computeP95(samples)).toBe(19);
  });

  it("computeP95 handles unsorted input by sorting internally", () => {
    const samples = [50, 10, 90, 30, 70, 20, 80, 40, 60, 100];
    // 10 samples → idx = ceil(0.95*10) - 1 = 10 - 1 = 9 → sorted[9] = 100.
    expect(computeP95(samples)).toBe(100);
  });

  it("runBenchWithP95 returns {mean, p95, samples} with samples.length === iterations", async () => {
    const result = await runBenchWithP95(
      "noop",
      () => {
        /* noop */
      },
      { iterations: 100 },
    );
    expect(result.name).toBe("noop");
    expect(result.iterations).toBe(100);
    expect(result.samples.length).toBe(100);
    expect(typeof result.mean).toBe("number");
    expect(typeof result.p95).toBe("number");
    expect(Number.isFinite(result.p95)).toBe(true);
  });

  it("runBenchWithP95 supports async fns", async () => {
    const result = await runBenchWithP95(
      "async-noop",
      async () => {
        await new Promise((r) => setImmediate(r));
      },
      { iterations: 100 },
    );
    expect(result.samples.length).toBe(100);
    expect(result.p95).toBeGreaterThan(0);
  });

  it("runBenchWithP95 throws when p95 exceeds budgetMs", async () => {
    await expect(
      runBenchWithP95(
        "overshoot",
        async () => {
          await new Promise((r) => setTimeout(r, 2));
        },
        { iterations: 100, budgetMs: 0 },
      ),
    ).rejects.toThrow(/overshoot/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STEP 22 — Shell harness shape
// FIX (F): tests reflect the tightened .sh assertions.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Return the shell script with comment-only lines (lines whose first
 * non-whitespace char is `#`) stripped. Shebang `#!` is preserved as
 * it's executable metadata, but regular `# ...` lines are dropped so
 * assertions below cannot be spoofed by a comment like `# HOME=...`.
 *
 * NOTE: This does NOT strip trailing comments on lines that contain
 * executable code — the spoofable surface is full-line comments, which
 * awk'd `/^[^#]/` removes.
 */
function stripShellComments(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#!")) return true; // keep shebang
      if (trimmed.startsWith("#")) return false; // drop comment
      return true;
    })
    .join("\n");
}

describe("Group 6b · Step 22 · tests/test-plan-mode.sh shape", () => {
  const shellPath = resolve(REPO_ROOT, "tests/test-plan-mode.sh");

  it("file exists and is readable", () => {
    expect(existsSync(shellPath)).toBe(true);
    const raw = readFileSync(shellPath, "utf8");
    expect(raw.length).toBeGreaterThan(100);
  });

  it("starts with bash shebang", () => {
    const raw = readFileSync(shellPath, "utf8");
    expect(raw.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("contains ANTHROPIC_API_KEY skip guard (code, not comment)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toContain("ANTHROPIC_API_KEY");
    expect(code).toMatch(/SKIP.*ANTHROPIC_API_KEY|ANTHROPIC_API_KEY.*SKIP/);
  });

  // Fix (N option A): runtime skip-guard verification.
  // Actually EXECUTE the shell script with ANTHROPIC_API_KEY unset and
  // assert it exits 0 with "SKIP" in stdout. Proves the skip path works,
  // not just that the string appears in source.
  it("runtime: with ANTHROPIC_API_KEY unset, the harness exits 0 and prints SKIP", () => {
    // Use sync spawn; the skip path should return instantly.
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const result = spawnSync("bash", [shellPath], {
      env,
      timeout: 15_000,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    expect(out).toContain("SKIP");
    expect(out).toContain("ANTHROPIC_API_KEY");
  });

  it("sets QLAYBOT_WORKSPACE_DIR to a tmpdir AND redirects HOME to a tmpdir (code, not comment — Fix N)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toContain("QLAYBOT_WORKSPACE_DIR");
    expect(code).toMatch(/export\s+QLAYBOT_WORKSPACE_DIR/);
    // Fix (F3) + (N): HOME must be an EXECUTABLE redirection, not a
    // comment claiming redirection.
    expect(code).toMatch(/export\s+HOME=/);
  });

  it("invokes node dist/cli.js with --message + --model flags (code, not comment — Fix N)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toMatch(/node\s+["$'{}][^\s]*dist\/cli\.js|node\s+dist\/cli\.js/);
    expect(code).toContain("--message");
    expect(code).toContain("--model");
  });

  it("asserts plan body > 200 chars using wc -c / wc -m (code, not comment — Fix N)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toMatch(/wc\s+-[cm]/);
    // The literal `200` boundary must appear in EXECUTABLE code (either
    // as a comparison `-gt 200` / `-le 200` or inside a heredoc body).
    expect(code).toMatch(/200/);
    // Stronger: require a numeric comparison to 200.
    expect(code).toMatch(/-(gt|ge|lt|le)\s+200/);
  });

  it("asserts verbose-transcript contains plan_mode_entered + plan_mode_exited + user_prompt events (code, not comment — Fix N)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toContain("plan_mode_entered");
    expect(code).toContain("plan_mode_exited");
    expect(code).toContain("user_prompt");
  });

  it("forbidden tools (execute_script / auto_route / create_layout) checked between plan_mode events (code, not comment — Fix N)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toContain("execute_script");
    expect(code).toContain("auto_route");
    expect(code).toContain("create_layout");
  });

  it("contains qlaybot-transcripts presence+absence checks + --verbose invocation (code, not comment — Fix N)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toContain("qlaybot-transcripts");
    expect(code).toContain("--verbose");
  });

  it("uses `timeout 300` to bound execution (code, not comment — Fix N)", () => {
    const raw = readFileSync(shellPath, "utf8");
    const code = stripShellComments(raw);
    expect(code).toMatch(/timeout\s+300/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STEP 23 — Version bump + rpc.ts dynamic version + README + CHANGELOG
// FIX (G): require a dynamic-resolution pattern; no hardcoded "0.4.3"
// allowed.
// ═════════════════════════════════════════════════════════════════════════════

describe("Group 6b · Step 23 · release plumbing", () => {
  it("package.json version is 0.4.3", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    expect(pkg.version).toBe("0.4.3");
  });

  it('src/rpc.ts no longer hardcodes `version: "0.3.0"`', () => {
    const raw = readFileSync(resolve(REPO_ROOT, "src/rpc.ts"), "utf8");
    expect(raw).not.toContain('version: "0.3.0"');
    expect(raw).not.toContain("version: '0.3.0'");
  });

  // (Weak back-stop, kept per parent brief: static patterns. LOAD-BEARING
  // assertion is the runtime ready-event test below.)
  it("src/rpc.ts reads version dynamically (imports package.json OR reads via fs + parses — weak back-stop)", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "src/rpc.ts"), "utf8");
    const importPkg =
      /import\s+[^'"]+from\s+['"][^'"]*package\.json['"]/.test(raw);
    const requirePkg = /require\(\s*['"][^'"]*package\.json['"]\s*\)/.test(
      raw,
    );
    const readFsPkg =
      /readFileSync\([^)]*package\.json[^)]*\)/.test(raw) &&
      /JSON\.parse/.test(raw);
    expect(importPkg || requirePkg || readFsPkg).toBe(true);
    // Hard negative: a bare hardcoded `version: "0.4.3"` literal is NOT
    // acceptable.
    expect(raw).not.toMatch(/version\s*:\s*["']0\.4\.3["']/);
  });

  // FIX (L): runtime load-bearing assertion.
  // Spawn `node dist/cli.js --mode rpc`, read the FIRST line emitted on
  // stdout, parse it, and assert it is the `ready` event whose `version`
  // equals `JSON.parse(readFileSync("package.json")).version`. This makes
  // the static back-stop above truly a back-stop: a dead-code
  // `readFileSync("package.json")` that isn't actually wired to the ready
  // event fails this test.
  it("RUNTIME (Fix L): `node dist/cli.js --mode rpc` emits ready event whose version === package.json.version", async () => {
    const cliPath = resolve(REPO_ROOT, "dist/cli.js");
    if (!existsSync(cliPath)) {
      // dist/cli.js not yet built. This is a valid skip — TRD runs the
      // test after `npm run build` per the brief's execution notes, but
      // under `npm run test:unit` on a fresh checkout it may be absent.
      console.warn(
        "[Fix L] skipping: dist/cli.js missing (run `npm run build` first)",
      );
      return;
    }
    const pkgRaw = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
    const expectedVersion = (JSON.parse(pkgRaw) as { version: string }).version;

    // Use a tmp HOME so we don't read the user's real ~/.qlaybot.
    const tmpHome = mkdtempSync(join(tmpdir(), "qlaybot-g6-fixl-"));
    const child = spawn(process.execPath, [cliPath, "--mode", "rpc"], {
      env: {
        ...process.env,
        HOME: tmpHome,
        QLAYBOT_WORKSPACE_DIR: tmpHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      // Accumulate stdout until we see a newline (ready is emitted
      // synchronously at startup).
      let buf = "";
      const readyLine: string = await new Promise((res, rej) => {
        const onData = (chunk: Buffer): void => {
          buf += chunk.toString();
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            child.stdout?.off("data", onData);
            res(buf.slice(0, nl));
          }
        };
        child.stdout?.on("data", onData);
        // Hard cap to avoid hanging CI if the RPC server crashes at
        // startup.
        setTimeout(() => {
          child.stdout?.off("data", onData);
          rej(new Error(`timed out waiting for ready event; buf=${buf}`));
        }, 15_000);
      });

      const parsed = JSON.parse(readyLine) as {
        jsonrpc?: string;
        method?: string;
        params?: { version?: string };
      };
      // Event shape: {jsonrpc:"2.0", method:"ready", params:{version:...}}
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("ready");
      expect(
        parsed.params?.version,
        `ready event version must equal package.json.version (${expectedVersion}); got ${parsed.params?.version}`,
      ).toBe(expectedVersion);
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      // Give SIGTERM a moment, then force-kill.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
      }, 500);
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }, 30_000);

  it("README.md contains Plan Mode, --verbose, transcript/truncation, and image notes", () => {
    const path = resolve(REPO_ROOT, "README.md");
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    const lower = raw.toLowerCase();
    expect(lower).toContain("plan mode");
    expect(lower).toContain("--verbose");
    expect(/image|iterm/i.test(raw)).toBe(true);
    expect(/transcript|truncat/i.test(raw)).toBe(true);
  });

  it("CHANGELOG.md exists and top entry mentions 0.4.3", () => {
    const path = resolve(REPO_ROOT, "CHANGELOG.md");
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("0.4.3");
    const idx043 = raw.indexOf("0.4.3");
    const idx042 = raw.indexOf("0.4.2");
    if (idx042 !== -1) {
      expect(idx043).toBeLessThan(idx042);
    }
  });
});
