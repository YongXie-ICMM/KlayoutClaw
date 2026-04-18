/**
 * qlaybot v0.4.3 — Group 6 TRD tests (Test Overseer owned).
 *
 * Covers spec §4 (--verbose) + §5.3 (shell harness) + §5.4 (perf budgets) +
 * §6 (Version & Release) + §9 steps 15-23.
 *
 * Cross-review round 2 fixes (codex + subagent findings):
 *   (A) Step 17: replace source-grep with live App.tsx render + unique
 *       assembledSystemPrompt marker.
 *   (B) Step 18: fire synthetic agent_start/agent_end events through the
 *       mock session's subscribe bridge and assert a `[turn N: ...ms]`
 *       SYSTEM_MESSAGE appears in the frame.
 *   (C) Step 19: dedicated backpressure test with a stream stub whose
 *       `write` returns false, vi.spyOn(process.stderr, "write") for the
 *       warning, explicit dropped-count > 0 assertion, post-close
 *       no-torn-line assertion.
 *   (D) Step 20: exact multi-line block match + ordering assertion.
 *   (E) Step 21: 2 new edge tests for the exact spec formula
 *       `samples[Math.ceil(0.95*N) - 1]`.
 *   (F) Step 22: shell harness toughening — 200-char plan body, events
 *       present in verbose-transcript, HOME redirection, matching Vitest
 *       shape checks.
 *   (G) Step 23: require a dynamic version resolution pattern OR live
 *       rpc.ts `ready` event with version === package.json.version. No
 *       hardcoded fallback allowed.
 *   (H) Step 15: tighten config contract — require hasOwn + typeof
 *       boolean + === false.
 *   (I) Step 4.5: new block — non-TUI verbose routes prompt / per-turn
 *       stats to STDERR (unit-test the helper + black-box spawn when
 *       ANTHROPIC_API_KEY is set).
 *
 * ---------------------------------------------------------------------------
 * HOME redirection: `src/history.ts` computes HISTORY_DIR at MODULE-import
 * time. Group 6 tests that touch `InteractionHistory` redirect $HOME and
 * `vi.resetModules()` before re-importing.
 *
 * ---------------------------------------------------------------------------
 * Expected pre-impl state:
 *   - All Step 15/16/17/18/19/20/23 plumbing tests: FAIL (impl absent).
 *   - Step 21 perf-harness math tests: PASS (pure math, harness owned by
 *     Overseer).
 *   - Step 22 shell tests: PASS (harness owned by Overseer).
 *   - §4.5 non-TUI helper tests: FAIL (helper absent).
 *   - §4.5 spawn tests: SKIP when ANTHROPIC_API_KEY unset.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import React from "react";
import { render, cleanup } from "ink-testing-library";

// ESM-safe fs spying: vi.mock("fs", { spy: true }) replaces the module with
// a spy-proxy so vi.spyOn(fs, "createWriteStream") works at runtime.
vi.mock("fs", { spy: true });

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

// Vitest + TS may not provide __dirname at runtime (ESM). Derive it.
const __filename_g6 = fileURLToPath(import.meta.url);
const __dirname_g6 = dirname(__filename_g6);
const REPO_ROOT = resolve(__dirname_g6, "..");

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

async function loadVerboseTranscript(): Promise<{
  VerboseTranscriptWriter: new (
    workspaceDir: string,
    sessionId: string,
    opts?: unknown,
  ) => {
    write: (event: unknown) => void;
    close: () => Promise<void>;
    getFilePath?: () => string | null;
    // Backpressure probes — may or may not exist. Tests defensively
    // access them.
    queueLength?: () => number;
    droppedCount?: () => number;
  };
}> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — step 19 module may not exist yet
  return await import("../src/verbose-transcript.js");
}

async function loadCli(): Promise<{
  parseArgs: (argv: string[]) => Record<string, unknown>;
}> {
  return await import("../src/cli.js");
}

async function loadConfigModule(): Promise<typeof import("../src/config.js")> {
  return await import("../src/config.js");
}

// ═════════════════════════════════════════════════════════════════════════════
// Minimal App.tsx fake-session bundle — mirrors the pattern established in
// tests/test-plan-mode-v043-group3.ts::makeFakeSession but extended with
// verbose + assembledSystemPrompt + a programmable event emitter so we can
// drive agent_start / agent_end for the Step 18 per-turn tests.
// ═════════════════════════════════════════════════════════════════════════════

interface FakeSessionOpts {
  verbose?: boolean;
  assembledSystemPrompt?: string;
  workspaceDir?: string;
}

function makeFakeSession(opts: FakeSessionOpts = {}) {
  const verbose = opts.verbose ?? false;
  const assembledSystemPrompt = opts.assembledSystemPrompt ?? "";
  const promptSpy = vi.fn(async (_t: string) => undefined);
  const abortSpy = vi.fn();
  const compactSpy = vi.fn(async () => undefined);
  const disposeSpy = vi.fn(async () => undefined);
  const recordPromptSpy = vi.fn();
  const recordErrorSpy = vi.fn();
  const listeners: Array<(ev: unknown) => void> = [];
  const sessionSubscribe = vi.fn((listener: (ev: unknown) => void) => {
    listeners.push(listener);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  });

  const commandRegistry = {
    execute: vi.fn(async () => ({ output: "", stateChange: null })),
    has: vi.fn(() => false),
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    register: vi.fn(),
  };
  const mcpManager = {
    allTools: () => [],
    getServerKeys: () => [],
    isConnected: () => false,
  };

  const botSession = {
    session: {
      prompt: promptSpy,
      abort: abortSpy,
      subscribe: sessionSubscribe,
      isCompacting: false,
      pendingMessageCount: 0,
    },
    sessionManager: {},
    config: {
      agent: { defaultModel: "test-model", thinkingLevel: "medium" },
      tui: { contextPollMs: 999_999 },
      klayout: { url: "", required: false, disabledTools: [] },
      mcp: {},
      verbose, // Group 6 Step 15: the verbose plumbing surface.
    },
    mcpManager,
    memoryManager: {},
    subagentRunner: null,
    history: {
      recordPrompt: recordPromptSpy,
      recordError: recordErrorSpy,
    },
    commandRegistry,
    planManager: null,
    backgroundTaskManager: null,
    compactionConfig: {
      enabled: false,
      autoThreshold: 90,
      warningThreshold: 70,
      toolResultPruning: { enabled: false, perToolBudgetChars: 0 },
    },
    assembledSystemPrompt,
    verbose, // mirror on the root so Executor-level plumbing is free to
    //      pick either config.verbose OR botSession.verbose.
    compact: compactSpy,
    getContextUsage: () => undefined,
    dispose: disposeSpy,
  };

  function fire(ev: unknown): void {
    for (const l of [...listeners]) l(ev);
  }

  return {
    botSession: botSession as unknown as import("../src/agent.js").QlayBotSession,
    fire,
    spies: {
      promptSpy,
      abortSpy,
      compactSpy,
      recordPromptSpy,
      recordErrorSpy,
    },
  };
}

async function renderApp(opts: FakeSessionOpts = {}) {
  const { App } = await import("../src/tui/components/App.js");
  const bundle = makeFakeSession(opts);
  const inst = render(
    React.createElement(App, { botSession: bundle.botSession as never }),
  );
  // Give React + ink-testing-library a tick to flush post-init effects.
  await new Promise((r) => setTimeout(r, 20));
  return { ...bundle, inst };
}

function lastFrameStripped(inst: {
  lastFrame: () => string | undefined;
}): string {
  return stripAnsi(inst.lastFrame() ?? "");
}

// ═════════════════════════════════════════════════════════════════════════════
// STEP 15 — CLI + config plumbing
// ═════════════════════════════════════════════════════════════════════════════

describe("Group 6a · Step 15 · CLI --verbose + QlayBotConfig.verbose plumbing", () => {
  it("parseArgs(['node','qlaybot','--verbose']) returns verbose=true", async () => {
    const { parseArgs } = await loadCli();
    const out = parseArgs(["node", "qlaybot", "--verbose"]);
    expect(out.verbose).toBe(true);
  });

  it("parseArgs(['node','qlaybot']) returns verbose===false (strict boolean default, §4.1)", async () => {
    const { parseArgs } = await loadCli();
    const out = parseArgs(["node", "qlaybot"]);
    // Spec §4.1: the default MUST be the boolean `false`, not `undefined`.
    // A bare `--verbose` flag is a boolean switch, and the absent case is
    // its boolean complement — callers downstream rely on
    // `typeof verbose === "boolean"` to fork on the flag.
    expect(typeof out.verbose).toBe("boolean");
    expect(out.verbose).toBe(false);
  });

  it("parseArgs([]) (no argv tail) also returns verbose===false (boolean)", async () => {
    const { parseArgs } = await loadCli();
    // Some CLIs strip node + script before calling parseArgs; ensure the
    // empty-argv default is still a strict `false` boolean, not undefined.
    const out = parseArgs([]);
    expect(typeof out.verbose).toBe("boolean");
    expect(out.verbose).toBe(false);
  });

  it("--verbose composes with --mode json + -m 'hi' (flag order-independent)", async () => {
    const { parseArgs } = await loadCli();
    const out = parseArgs([
      "node",
      "qlaybot",
      "--verbose",
      "--mode",
      "json",
      "-m",
      "hi",
    ]);
    expect(out.verbose).toBe(true);
    expect(out.mode).toBe("json");
    expect(out.message).toBe("hi");
  });

  // Fix (H): tightened contract — hasOwn + typeof boolean + === false.
  it("loadConfig() default has verbose declared as own boolean === false", async () => {
    const savedHome = process.env.HOME;
    const savedUser = process.env.USERPROFILE;
    const tmp = mkdtempSync(join(tmpdir(), "qlaybot-g6-config-"));
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    vi.resetModules();
    try {
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig() as Record<string, unknown>;
      // (H1) field must be own-declared (not just inherited/undefined).
      expect(Object.prototype.hasOwnProperty.call(cfg, "verbose")).toBe(true);
      // (H2) typed as boolean.
      expect(typeof cfg.verbose).toBe("boolean");
      // (H3) default value is exactly false.
      expect(cfg.verbose).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUser === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUser;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("saveSettingsConfig() does NOT serialize verbose into settings.json (runtime-ephemeral, §4.4)", async () => {
    const { loadConfig, saveSettingsConfig } = await loadConfigModule();
    const tmp = mkdtempSync(join(tmpdir(), "qlaybot-g6-settings-"));
    try {
      const cfg = loadConfig() as Record<string, unknown>;
      (cfg as Record<string, unknown>).verbose = true;
      saveSettingsConfig(cfg as never, tmp);

      const settingsPath = join(tmp, "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const raw = readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.verbose).toBeUndefined();
      expect(raw).not.toMatch(/"verbose"\s*:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STEP 16 — Disable TUI + transcript truncation when verbose=true
// ═════════════════════════════════════════════════════════════════════════════

describe("Group 6a · Step 16 · verbose disables truncation", () => {
  let savedHome: string | undefined;
  let savedUser: string | undefined;
  let tmpHome: string;
  let InteractionHistory: typeof import("../src/history.js").InteractionHistory;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    savedUser = process.env.USERPROFILE;
    tmpHome = mkdtempSync(join(tmpdir(), "qlaybot-g6-history-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    ({ InteractionHistory } = await import("../src/history.js"));
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUser;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("InteractionHistory with {threshold:Infinity,headChars:0,tailChars:0} preserves full 5000-char result (no truncation metadata)", () => {
    const history = new InteractionHistory("g6-verbose-trunc-off", undefined, {
      threshold: Infinity,
      headChars: 0,
      tailChars: 0,
    });
    const sessionDir = history.getSessionDir();
    const big = "x".repeat(5000);
    history.recordToolCall("test_tool", {}, big, 10);

    const transcript = readFileSync(
      join(sessionDir, "transcript.jsonl"),
      "utf8",
    );
    const lines = transcript.trim().split("\n").filter((l) => l.length > 0);
    const toolEntry = lines
      .map((l) => JSON.parse(l))
      .find((e: { type: string }) => e.type === "tool_call");
    expect(toolEntry).toBeDefined();
    const data = toolEntry.data as Record<string, unknown>;
    expect(data.result).toBe(big);
    expect((data.result as string).length).toBe(5000);
    expect(data.truncated).toBeUndefined();
    expect(data.original_length).toBeUndefined();
  });

  it("Default InteractionHistory (no verbose opts) still truncates long results (Group 5 regression guard)", () => {
    const history = new InteractionHistory("g6-regress-default");
    const sessionDir = history.getSessionDir();
    const big = "x".repeat(5000);
    history.recordToolCall("test_tool", {}, big, 10);

    const transcript = readFileSync(
      join(sessionDir, "transcript.jsonl"),
      "utf8",
    );
    const toolEntry = transcript
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .find((e: { type: string }) => e.type === "tool_call");
    expect(toolEntry).toBeDefined();
    const data = toolEntry.data as Record<string, unknown>;
    expect(data.truncated).toBe(true);
    expect(data.original_length).toBe(5000);
    expect((data.result as string).length).toBeLessThanOrEqual(2100);
  });

  it("ToolPanel with verbose=true skips the 8-head/8-tail formatResult marker", async () => {
    const { ToolPanel } = await import("../src/tui/components/ToolPanel.js");
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`LINE_${String(i).padStart(2, "0")}_uniqueMiddleToken_${i}`);
    }
    const longResult = lines.join("\n");

    const tool = {
      id: "tool-g6-verbose-on",
      toolName: "bash",
      args: { command: "long_output" },
      status: "completed" as const,
      startTime: Date.now() - 100,
      endTime: Date.now(),
      result: longResult,
    };

    const r = render(
      React.createElement(
        ToolPanel as unknown as React.ComponentType<{
          tool: typeof tool;
          expanded: boolean;
          verbose: boolean;
        }>,
        { tool, expanded: true, verbose: true },
      ),
    );
    const frame = stripAnsi(r.lastFrame() ?? "");
    expect(frame).not.toContain("lines hidden");
    expect(frame).toContain("LINE_20_uniqueMiddleToken_20");
    cleanup();
  });

  it("ToolPanel with verbose=false DOES show the 'lines hidden' marker on long result (regression guard)", async () => {
    const { ToolPanel } = await import("../src/tui/components/ToolPanel.js");
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(`LINE_${String(i).padStart(2, "0")}`);
    const longResult = lines.join("\n");

    const tool = {
      id: "tool-g6-verbose-off",
      toolName: "bash",
      args: { command: "long" },
      status: "completed" as const,
      startTime: Date.now() - 100,
      endTime: Date.now(),
      result: longResult,
    };
    const r = render(
      React.createElement(
        ToolPanel as unknown as React.ComponentType<{
          tool: typeof tool;
          expanded: boolean;
          verbose?: boolean;
        }>,
        { tool, expanded: true, verbose: false },
      ),
    );
    const frame = stripAnsi(r.lastFrame() ?? "");
    expect(frame).toContain("lines hidden");
    cleanup();
  });

  it("ToolPanel with verbose=true + short result is just the short result (no marker)", async () => {
    const { ToolPanel } = await import("../src/tui/components/ToolPanel.js");
    const tool = {
      id: "tool-g6-short",
      toolName: "bash",
      args: { command: "short" },
      status: "completed" as const,
      startTime: Date.now() - 5,
      endTime: Date.now(),
      result: "tiny-output-unique-xyz",
    };
    const r = render(
      React.createElement(
        ToolPanel as unknown as React.ComponentType<{
          tool: typeof tool;
          expanded: boolean;
          verbose?: boolean;
        }>,
        { tool, expanded: true, verbose: true },
      ),
    );
    const frame = stripAnsi(r.lastFrame() ?? "");
    expect(frame).toContain("tiny-output-unique-xyz");
    expect(frame).not.toContain("lines hidden");
    cleanup();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STEP 17 — Print assembled system prompt on startup when verbose
// FIX (A): live render with a unique marker — no source-grep.
// ═════════════════════════════════════════════════════════════════════════════

describe("Group 6a · Step 17 · print assembled system prompt when verbose (live render)", () => {
  afterEach(() => cleanup());

  it("live App render with verbose=true — FIRST SYSTEM_MESSAGE contains the leading 100 chars of assembledSystemPrompt (T25)", async () => {
    // Spec T25: the FIRST SYSTEM_MESSAGE dispatched post-init must carry
    // (at minimum) the first ~100 chars of the assembled prompt. We assert
    // the literal leading substring is present in the rendered frame so
    // the Executor can't pass by dispatching a terse banner like
    // "[verbose] system prompt loaded" ahead of the real prompt.
    const LEADING = "You are qlaybot, a domain-specialist device-design agent embedded in KLayout. Your role is to";
    // Sanity: the leading substring is ≥ 80 chars so the assertion is load-bearing.
    expect(LEADING.length).toBeGreaterThanOrEqual(80);
    const TAIL_MARKER = "TAIL_MARKER_ZZZ_887";
    const prompt = `${LEADING} build device layouts… ${TAIL_MARKER}`;
    const { inst } = await renderApp({
      verbose: true,
      assembledSystemPrompt: prompt,
    });
    const frame = lastFrameStripped(inst);
    // Load-bearing: first 100 chars of the prompt are in the frame.
    const leading100 = prompt.slice(0, 100);
    expect(frame).toContain(leading100);
    // Ordering regression: the prompt body must render BEFORE any trailing
    // UI chrome that also happens to contain the word "qlaybot" (e.g. a
    // StatusBar banner). The tail marker proves we're matching the actual
    // prompt body, not a coincidental substring elsewhere.
    expect(frame).toContain(TAIL_MARKER);
    const leadingIdx = frame.indexOf(leading100);
    const tailIdx = frame.indexOf(TAIL_MARKER);
    expect(leadingIdx).toBeGreaterThanOrEqual(0);
    expect(tailIdx).toBeGreaterThan(leadingIdx);
  });

  it("live App render with verbose=false does NOT emit the assembled prompt into the frame", async () => {
    const MARKER = "UNIQUE_PROMPT_MARKER_OFF_7Q";
    const prompt = `You are qlaybot. ${MARKER} (test prompt)`;
    const { inst } = await renderApp({
      verbose: false,
      assembledSystemPrompt: prompt,
    });
    const frame = lastFrameStripped(inst);
    expect(frame).not.toContain(MARKER);
  });

  it("QlayBotSession interface declares assembledSystemPrompt as non-optional string (type-shape regression)", () => {
    // Back-stop: if the Executor (re)moves the field, TypeScript compilation
    // of tests that reference `botSession.assembledSystemPrompt` will break.
    // This is the only surviving source-text guard and it is NOT the
    // load-bearing assertion for step 17 — the live tests above are.
    const src = readFileSync(resolve(REPO_ROOT, "src/agent.ts"), "utf8");
    expect(src).toMatch(/assembledSystemPrompt\s*:\s*string/);
    expect(src).toMatch(/assembledSystemPrompt\s*:\s*systemPrompt/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STEP 18 — Per-turn timing + token usage SYSTEM_MESSAGE (live events)
// FIX (J): measure REAL wall-clock elapsed ms between agent_start and
// agent_end, parse the turn-ms number out of the frame, and assert it lies
// in a tolerant [0.5×N, 3×N] range. Canned literal `[turn 1: 123ms]` fails
// the range at N ∈ {50, 300} since 123 is outside [150, 900] for N=300 and
// [25, 150] rules out most canned fixed values too. Token fields become
// MANDATORY when usage IS supplied (cannot be silently dropped).
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Extract the most recent `[turn N: Mms, ...]` match from a stripped
 * frame. Returns `{turn, ms, in, out}` with `undefined` for optional
 * fields when absent. Returns null when no match is found.
 */
function parseLastTurnMessage(frame: string): null | {
  turn: number;
  ms: number;
  inTokens?: number;
  outTokens?: number;
} {
  // Use a greedy "last match" strategy: find all matches, take the last.
  const matches = [
    ...frame.matchAll(
      /\[turn\s+(\d+):\s+(\d+)ms(?:,\s*in=(\d+),\s*out=(\d+)(?:,\s*thinking=\d+)?)?\]/g,
    ),
  ];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  return {
    turn: Number(m[1]),
    ms: Number(m[2]),
    inTokens: m[3] !== undefined ? Number(m[3]) : undefined,
    outTokens: m[4] !== undefined ? Number(m[4]) : undefined,
  };
}

describe("Group 6a · Step 18 · per-turn timing SYSTEM_MESSAGE (live events)", () => {
  afterEach(() => cleanup());

  // Fix (J) — N=50ms run: captured ms must be in [25, 150].
  it("verbose=true → REAL wall-clock elapsed (~50ms) is captured within [0.5x, 3x] tolerance + exact token values", async () => {
    const { inst, fire } = await renderApp({
      verbose: true,
      assembledSystemPrompt: "prompt-50",
    });

    const N = 50;
    // Input / output tokens must appear VERBATIM in the frame.
    const INPUT = 1234;
    const OUTPUT = 567;

    const t0 = Date.now();
    fire({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, N));
    fire({
      type: "agent_end",
      usage: {
        input: INPUT,
        output: OUTPUT,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: INPUT + OUTPUT,
        // Also provide SDK-style alternates so the Executor can pick
        // whichever field is actually exposed on `agent_end`.
        inputTokens: INPUT,
        outputTokens: OUTPUT,
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    const wallElapsed = Date.now() - t0;

    const frame = lastFrameStripped(inst);
    const parsed = parseLastTurnMessage(frame);
    expect(
      parsed,
      `expected a [turn N: Mms, ...] SYSTEM_MESSAGE in the frame, got:\n${frame.slice(
        0,
        400,
      )}`,
    ).not.toBeNull();
    // Tolerant range around the actual wall-clock elapsed (captures
    // scheduler jitter). N is the nominal sleep; wallElapsed is the
    // real elapsed including the setImmediate round-trips.
    const lo = N * 0.5;
    const hi = Math.max(wallElapsed, N) * 3;
    expect(
      parsed!.ms,
      `captured ms ${parsed!.ms} outside tolerant range [${lo}, ${hi}] (wall=${wallElapsed})`,
    ).toBeGreaterThanOrEqual(lo);
    expect(parsed!.ms).toBeLessThanOrEqual(hi);

    // When usage IS supplied, token fields are MANDATORY and exact.
    expect(
      parsed!.inTokens,
      `expected in=${INPUT} in the frame; parsed=${JSON.stringify(parsed)}`,
    ).toBe(INPUT);
    expect(parsed!.outTokens).toBe(OUTPUT);
    // Double-check via substring match — defends against a future
    // regex-parser bug.
    expect(frame).toContain(`in=${INPUT}`);
    expect(frame).toContain(`out=${OUTPUT}`);
  });

  // Fix (J) — N=300ms run: captured ms must be in [150, 900]. Pairs with
  // the 50ms test above to catch a canned literal (no single hardcoded ms
  // value satisfies BOTH [25, 150] and [150, 900]).
  it("verbose=true → REAL wall-clock elapsed (~300ms) also falls in tolerant range", async () => {
    const { inst, fire } = await renderApp({
      verbose: true,
      assembledSystemPrompt: "prompt-300",
    });
    const N = 300;
    const t0 = Date.now();
    fire({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, N));
    fire({
      type: "agent_end",
      usage: {
        input: 7,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
        inputTokens: 7,
        outputTokens: 3,
      },
    });
    await new Promise((r) => setTimeout(r, 60));
    const wallElapsed = Date.now() - t0;

    const frame = lastFrameStripped(inst);
    const parsed = parseLastTurnMessage(frame);
    expect(parsed).not.toBeNull();
    const lo = N * 0.5;
    const hi = Math.max(wallElapsed, N) * 3;
    expect(parsed!.ms).toBeGreaterThanOrEqual(lo);
    expect(parsed!.ms).toBeLessThanOrEqual(hi);
  });

  // No-usage variant: when the agent_end event carries no `usage`, impl
  // must emit timing-only `[turn N: Xms]` with NO `in=`/`out=` fields.
  it("verbose=true + NO usage on agent_end → timing-only `[turn N: Xms]`, no token fields", async () => {
    const { inst, fire } = await renderApp({
      verbose: true,
      assembledSystemPrompt: "prompt-nousage",
    });
    fire({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, 60));
    // Explicitly omit usage.
    fire({ type: "agent_end" });
    await new Promise((r) => setTimeout(r, 60));

    const frame = lastFrameStripped(inst);
    const parsed = parseLastTurnMessage(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.ms).toBeGreaterThan(0);
    // Token fields MUST be absent.
    expect(parsed!.inTokens).toBeUndefined();
    expect(parsed!.outTokens).toBeUndefined();
    expect(frame).not.toMatch(/in=\d+/);
    expect(frame).not.toMatch(/out=\d+/);
  });

  it("verbose=false → agent_end does NOT dispatch a per-turn SYSTEM_MESSAGE", async () => {
    const { inst, fire } = await renderApp({
      verbose: false,
      assembledSystemPrompt: "prompt",
    });

    fire({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, 40));
    fire({
      type: "agent_end",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
    });
    await new Promise((r) => setTimeout(r, 40));

    const frame = lastFrameStripped(inst);
    expect(frame).not.toMatch(/\[turn\s+\d+:\s+\d+ms/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STEP 19 — VerboseTranscriptWriter
// FIX (C): true backpressure test with a stub stream + stderr spy + dropped
// count > 0 + no-torn-line assertion after close().
// ═════════════════════════════════════════════════════════════════════════════

describe("Group 6a · Step 19 · VerboseTranscriptWriter", () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = mkdtempSync(join(tmpdir(), "qlaybot-g6-vt-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpWorkspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    vi.restoreAllMocks();
  });

  function listTranscriptFiles(workspace: string): string[] {
    const dir = join(workspace, "qlaybot-transcripts");
    if (!existsSync(dir)) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    return fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => join(dir, f));
  }

  it("writes JSONL event to ${workspaceDir}/qlaybot-transcripts/{sessionId}-{YYYYMMDD-HHMMSS}.jsonl", async () => {
    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "session-abc");
    w.write({ type: "user_prompt", text: "hello" });
    await new Promise((r) => setTimeout(r, 80));

    const files = listTranscriptFiles(tmpWorkspace);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const body = readFileSync(files[0], "utf8");
    expect(body.length).toBeGreaterThan(0);
    const firstLine = body.split("\n").filter((l) => l.length > 0)[0];
    const parsed = JSON.parse(firstLine);
    expect(parsed.type).toBe("user_prompt");
    expect(parsed.text).toBe("hello");
    await w.close();
  });

  it("filename matches /^{sessionId}-\\d{8}-\\d{6}\\.jsonl$/", async () => {
    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "sess-XYZ");
    w.write({ type: "any" });
    await new Promise((r) => setTimeout(r, 80));
    const files = listTranscriptFiles(tmpWorkspace);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const basename = files[0].split("/").pop() ?? "";
    expect(basename).toMatch(/^sess-XYZ-\d{8}-\d{6}\.jsonl$/);
    await w.close();
  });

  it("qlaybot-transcripts directory is created on first write", async () => {
    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const dir = join(tmpWorkspace, "qlaybot-transcripts");
    expect(existsSync(dir)).toBe(false);
    const w = new VerboseTranscriptWriter(tmpWorkspace, "session-mkdir");
    w.write({ event: "anything" });
    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    await w.close();
  });

  it("multiple write() calls append newline-separated lines, each a valid JSON event", async () => {
    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "session-multi");
    for (let i = 0; i < 5; i++) w.write({ type: "tick", n: i });
    await new Promise((r) => setTimeout(r, 120));
    await w.close();

    const files = listTranscriptFiles(tmpWorkspace);
    const raw = readFileSync(files[0], "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed.type).toBe("tick");
      expect(parsed.n).toBe(i);
    }
  });

  it("50KB event payload survives UNTRUNCATED (verbose-transcript never truncates)", async () => {
    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "session-big");
    const huge = "Y".repeat(50_000);
    w.write({ type: "tool_result", toolName: "bash", result: huge });
    await new Promise((r) => setTimeout(r, 200));
    await w.close();

    const files = listTranscriptFiles(tmpWorkspace);
    const raw = readFileSync(files[0], "utf8");
    const line = raw.split("\n").filter((l) => l.length > 0)[0];
    const parsed = JSON.parse(line);
    expect(typeof parsed.result).toBe("string");
    expect(parsed.result.length).toBe(50_000);
    expect(parsed.result).not.toContain("... (truncated");
  });

  it("quiet failure — unwritable workspace logs ONE stderr warning, subsequent writes are silent no-ops (§4.3 effect 5)", async () => {
    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const fakeRoot = join(tmpWorkspace, "notadir");
    writeFileSync(fakeRoot, "not a dir");

    // Spy BEFORE instantiation — the open-failure warning may be emitted
    // synchronously from the constructor OR on first write.
    const stderrCalls: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Buffer): boolean => {
        stderrCalls.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      }) as never);

    try {
      const w = new VerboseTranscriptWriter(fakeRoot, "session-readonly");
      // (a) None of the write() calls may throw.
      expect(() => w.write({ type: "first" })).not.toThrow();
      expect(() => w.write({ type: "second" })).not.toThrow();
      expect(() => w.write({ type: "third" })).not.toThrow();
      expect(() => w.write({ type: "fourth" })).not.toThrow();
      // Give any queued microtasks a chance to flush the warning.
      await new Promise((r) => setTimeout(r, 60));
      await w.close();
      // (b) No additional writes even on post-close.
      expect(() => w.write({ type: "post-close" })).not.toThrow();
      await new Promise((r) => setTimeout(r, 30));

      // The file must remain untouched — quiet failure means the dir
      // creation error did NOT cascade into a bogus overwrite.
      expect(readFileSync(fakeRoot, "utf8")).toBe("not a dir");

      // (c) Count stderr warnings matching the open/write failure class.
      const joined = stderrCalls.join("");
      const failureMatches = joined.match(
        /verbose[- ]transcript|qlaybot-transcripts|transcript.*(?:fail|error|disable|skip)|(?:fail|error|disable|skip).*transcript/gi,
      );
      const failureCount = failureMatches?.length ?? 0;
      // Spec §4.3 effect 5: log an error ONCE to stderr. Not zero (must be
      // observable), not many (must not spam N per write()).
      expect(
        failureCount,
        `expected exactly 1 verbose-transcript failure warning on stderr; saw ${failureCount}. stderr (first 400 chars):\n${joined.slice(
          0,
          400,
        )}`,
      ).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("close() awaits finish; post-close write() does not throw", async () => {
    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "session-close");
    w.write({ type: "only-event" });
    await new Promise((r) => setTimeout(r, 40));
    await expect(w.close()).resolves.toBeUndefined();
    expect(() => w.write({ type: "post-close" })).not.toThrow();
  });

  // ── FIX (K): hardened backpressure suite — 3 focused sub-tests ──────────
  //
  // Spec contract additions tested here (Executor must implement):
  //   - Public readonly field `droppedCount: number` (starts at 0, bumps
  //     each time the queue eviction fires).
  //   - Public readonly field / method exposing current queue depth, so
  //     the cap can be observed externally. Accepted names (any ONE):
  //       writer.pendingCount        (readonly number field)
  //       writer.queueLength()       (fn → number)
  //       writer._queueLength()      (fn → number; underscore = debug API)
  //   - Drop-OLDEST semantics: when queue > 1000, FIFO drop until
  //     queue ≤ 1000.
  //   - At least one stderr warning matching /backpressure|queue|drop/i
  //     is emitted when the first drop fires.
  //
  // Strategy: spy on fs.createWriteStream; return a controlled stub that
  // (a) refuses all writes until we manually fire drain, (b) captures every
  // chunk, and (c) signals backpressure via return value `false`.

  /** Build the controlled backpressure stub stream used by the three sub-tests. */
  function makeStubStream(): {
    stream: Record<string, unknown>;
    writtenChunks: string[];
    drainListeners: Array<() => void>;
    finishListeners: Array<() => void>;
    fireDrain: () => void;
  } {
    const writtenChunks: string[] = [];
    const drainListeners: Array<() => void> = [];
    const finishListeners: Array<() => void> = [];
    const stream: Record<string, unknown> = {
      write(chunk: string | Buffer): boolean {
        writtenChunks.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return false; // ALWAYS backpressured until fireDrain() called
      },
      end(cb?: () => void): void {
        setImmediate(() => {
          for (const l of finishListeners) l();
          if (cb) cb();
        });
      },
      on(event: string, listener: () => void): void {
        if (event === "drain") drainListeners.push(listener);
        else if (event === "finish" || event === "close") {
          finishListeners.push(listener);
        }
      },
      once(event: string, listener: () => void): void {
        this.on(event, listener);
      },
      removeListener(): void {
        /* noop */
      },
      emit(): boolean {
        return false;
      },
      writable: true,
    };
    function fireDrain(): void {
      for (const l of [...drainListeners]) l();
    }
    return { stream, writtenChunks, drainListeners, finishListeners, fireDrain };
  }

  /** Read writer.droppedCount via any of the accepted accessor shapes. */
  function readDroppedCount(w: unknown): number | undefined {
    const obj = w as Record<string, unknown>;
    if (typeof obj.droppedCount === "number") return obj.droppedCount as number;
    if (typeof obj.droppedCount === "function") {
      return (obj.droppedCount as () => number)();
    }
    if (typeof obj.getDroppedCount === "function") {
      return (obj.getDroppedCount as () => number)();
    }
    if (typeof obj._droppedCount === "number") return obj._droppedCount as number;
    return undefined;
  }

  /** Read writer.queueLength / pendingCount via any accepted shape. */
  function readQueueLength(w: unknown): number | undefined {
    const obj = w as Record<string, unknown>;
    if (typeof obj.pendingCount === "number") return obj.pendingCount as number;
    if (typeof obj.queueLength === "function") {
      return (obj.queueLength as () => number)();
    }
    if (typeof obj._queueLength === "function") {
      return (obj._queueLength as () => number)();
    }
    if (typeof obj.queueLength === "number") return obj.queueLength as number;
    return undefined;
  }

  // Fix (K1): public droppedCount must be > 0 AND < 1500 (bounded drop).
  it("backpressure K1 — writer.droppedCount is a public readonly; after a 1500-burst 0 < droppedCount < 1500", async () => {
    const fs = await import("fs");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    void stderrSpy;
    const stub = makeStubStream();
    vi.spyOn(fs, "createWriteStream").mockImplementation(
      () =>
        stub.stream as unknown as ReturnType<typeof fs.createWriteStream>,
    );

    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "bp-k1");

    const N = 1500;
    for (let i = 0; i < N; i++) {
      w.write({ type: "burst", seq: i });
    }

    const dropped = readDroppedCount(w);
    expect(
      dropped,
      "VerboseTranscriptWriter must expose a public droppedCount accessor (field, method, or getDroppedCount) so the backpressure cap is observable",
    ).toBeDefined();
    expect(dropped!).toBeGreaterThan(0);
    // Hard upper bound: dropping ALL 1500 is a bug — some writes must have
    // reached the stream. The cap is 1000 → when we burst 1500 we drop
    // ~500 oldest, not all 1500.
    expect(dropped!).toBeLessThan(N);

    // Drain + close for cleanup.
    stub.fireDrain();
    await new Promise((r) => setImmediate(r));
    await w.close();
  });

  // Fix (K2): drop-OLDEST semantics — no event with seq < droppedCount
  // reaches the file, but events with seq >= droppedCount survive. Also
  // asserts post-close ZERO torn lines.
  it("backpressure K2 — drop-OLDEST FIFO: no seq < droppedCount survives; mid/late events present; post-close file has 0 torn lines", async () => {
    const fs = await import("fs");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stub = makeStubStream();
    vi.spyOn(fs, "createWriteStream").mockImplementation(
      () =>
        stub.stream as unknown as ReturnType<typeof fs.createWriteStream>,
    );

    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "bp-k2");

    const N = 1500;
    for (let i = 0; i < N; i++) {
      w.write({ type: "burst", seq: i });
    }

    const dropped = readDroppedCount(w) ?? 0;
    // Drain everything and close.
    stub.fireDrain();
    await new Promise((r) => setImmediate(r));
    await w.close();

    // Parse every written chunk; no torn lines allowed after close().
    const fullText = stub.writtenChunks.join("");
    const lines = fullText.split("\n").filter((l) => l.length > 0);
    let tornLines = 0;
    const seqs = new Set<number>();
    for (const l of lines) {
      try {
        const obj = JSON.parse(l) as { seq?: number };
        if (typeof obj.seq === "number") seqs.add(obj.seq);
      } catch {
        tornLines++;
      }
    }
    expect(
      tornLines,
      `expected 0 torn lines after close(); got ${tornLines} torn out of ${lines.length}`,
    ).toBe(0);
    expect(seqs.size).toBeGreaterThan(0);

    // (K2) Drop-OLDEST: no event whose seq < droppedCount should be in the
    // output set. Because drops happen strictly FIFO, seqs 0..(dropped-1)
    // are lost; seqs dropped..(N-1) should survive.
    if (dropped > 0) {
      for (let i = 0; i < dropped; i++) {
        expect(
          seqs.has(i),
          `seq ${i} should have been dropped (oldest FIFO), but is in the output`,
        ).toBe(false);
      }
    }
    // At least one MID-to-late event must survive (seq >= 500 is a safe
    // mid-burst lower bound given N=1500 and cap=1000).
    const hasLate = [...seqs].some((s) => s >= 500);
    expect(
      hasLate,
      `expected some seq >= 500 to survive; got seqs: ${[...seqs]
        .sort((a, b) => a - b)
        .slice(0, 10)
        .join(",")}...`,
    ).toBe(true);
  });

  // Fix (K3): hard queue cap — during the stubbed-false-write phase, the
  // pending queue length NEVER exceeds 1000 at any observation point.
  // ALSO: at least one stderr warning matching /backpressure|queue|drop/i.
  it("backpressure K3 — queue length never exceeds 1000 at any observation; stderr warning emitted", async () => {
    const fs = await import("fs");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stub = makeStubStream();
    vi.spyOn(fs, "createWriteStream").mockImplementation(
      () =>
        stub.stream as unknown as ReturnType<typeof fs.createWriteStream>,
    );

    const { VerboseTranscriptWriter } = await loadVerboseTranscript();
    const w = new VerboseTranscriptWriter(tmpWorkspace, "bp-k3");

    const qLenAtStart = readQueueLength(w);
    expect(
      qLenAtStart,
      "VerboseTranscriptWriter must expose queueLength (fn or number) or pendingCount for backpressure observation",
    ).toBeDefined();

    const N = 1500;
    const observations: number[] = [];
    for (let i = 0; i < N; i++) {
      w.write({ type: "burst", seq: i, pad: "p".repeat(8) });
      // Observe every ~50 writes to keep overhead low while catching
      // spikes. Cap at 32 observations.
      if (i % 50 === 0) {
        const q = readQueueLength(w);
        if (q !== undefined) observations.push(q);
      }
    }
    // Final observation after the last write.
    const qEnd = readQueueLength(w);
    if (qEnd !== undefined) observations.push(qEnd);

    // Queue must never exceed 1000 at any observation point.
    for (const q of observations) {
      expect(
        q,
        `observed queue length ${q} exceeded hard cap 1000`,
      ).toBeLessThanOrEqual(1000);
    }

    // Stderr warning must have been emitted at least once.
    const stderrCalls = stderrSpy.mock.calls.flatMap((c) =>
      typeof c[0] === "string"
        ? [c[0]]
        : c[0] instanceof Buffer
          ? [c[0].toString()]
          : [],
    );
    const warning = stderrCalls.find((s) =>
      /backpressure|queue|drop/i.test(s),
    );
    expect(
      warning,
      `expected stderr warning matching /backpressure|queue|drop/i; stderr was: ${stderrCalls
        .slice(0, 3)
        .join(" | ")}`,
    ).toBeDefined();

    // Clean up.
    stub.fireDrain();
    await new Promise((r) => setImmediate(r));
    await w.close();
  });

  // ── T34: SIGKILL child-process lifecycle — disk invariant ───────────────
  //
  // Spec row T34: on abrupt process termination (SIGKILL), every line that
  // made it to disk must be a complete, parseable JSON record. A torn
  // final line (killed mid-flush) is tolerated, but no prior line may be
  // truncated.
  //
  // Fallback strategy (per parent brief, ≤60 LOC): simulate SIGKILL by
  // writing a few events with real fs.createWriteStream (no stub), waiting
  // for the first flush to hit disk, then calling stream.destroy() on the
  // underlying writer — this mimics the kernel yanking the fd out from
  // under the process. We then read the file from disk and assert every
  // non-empty line parses as JSON (tolerating a torn final line).
  //
  // Skipped on Windows where fs semantics + path handling differ enough
  // that a bespoke test would be needed.
  it.skipIf(process.platform === "win32")(
    "T34 · SIGKILL simulation — every completed line on disk parses as JSON (torn final line tolerated)",
    async () => {
      const { VerboseTranscriptWriter } = await loadVerboseTranscript();
      const w = new VerboseTranscriptWriter(tmpWorkspace, "session-sigkill");

      // Push N events; force scheduling ticks so at least the first
      // flush lands on disk before we "SIGKILL".
      const N = 20;
      for (let i = 0; i < N; i++) {
        w.write({ type: "event", seq: i, pad: "Q".repeat(64) });
      }
      // One event loop tick is enough for the first buffered write() to
      // hit the kernel on most platforms; give 80ms for safety.
      await new Promise((r) => setTimeout(r, 80));

      // Reach into the writer and destroy the underlying stream to
      // simulate kernel-level fd yank. Accepted surface: either a field
      // `stream`, `writeStream`, `_stream`, or `fileStream`.
      const anyW = w as unknown as Record<string, { destroy?: () => void }>;
      const underlying =
        anyW.stream ?? anyW.writeStream ?? anyW._stream ?? anyW.fileStream;
      expect(
        underlying,
        "VerboseTranscriptWriter must expose its underlying write stream as `stream` / `writeStream` / `_stream` / `fileStream` so T34 SIGKILL lifecycle can be exercised",
      ).toBeDefined();
      expect(typeof underlying.destroy).toBe("function");
      underlying.destroy!();

      // Do NOT call w.close() — that would be a graceful shutdown path.
      // SIGKILL == no cleanup. Give the kernel a moment to settle.
      await new Promise((r) => setTimeout(r, 50));

      const files = listTranscriptFiles(tmpWorkspace);
      expect(files.length).toBe(1);
      const raw = readFileSync(files[0], "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // All lines except possibly the last must parse. The last line is
      // allowed to be torn (killed mid-flush).
      for (let i = 0; i < lines.length - 1; i++) {
        expect(
          () => JSON.parse(lines[i]),
          `line ${i} of ${lines.length - 1} (non-final) must parse as JSON; got: ${lines[i].slice(0, 120)}`,
        ).not.toThrow();
      }
      // Final line: allowed to fail; if it parses, even better.
      try {
        JSON.parse(lines[lines.length - 1]);
      } catch {
        /* torn final line — tolerated per T34 */
      }
    },
  );
});


// ═════════════════════════════════════════════════════════════════════════════
// NEW (FIX I) — Spec §4.5 non-TUI verbose routing
// System prompt + per-turn stats go to STDERR (never stdout — would corrupt
// JSON protocol output). Transcript truncation off + verbose-transcript
// written (same as TUI).
// ═════════════════════════════════════════════════════════════════════════════

describe("Group 6a · §4.5 · non-TUI verbose routes to stderr, not stdout", () => {
  // Fix (M part 3): no weak source-grep fallback. If the helper isn't
  // exported, the test fails loudly — that's the correct TRD signal.
  it("CLI helper `printVerboseStartup` (or equivalent) writes to the provided stream, not process.stdout", async () => {
    // Signature expected (minimal):
    //   export function printVerboseStartup(
    //     stream: NodeJS.WritableStream,
    //     info: { assembledSystemPrompt: string }
    //   ): void;
    //
    // Accepted alternate names: writeVerboseStartup, emitVerboseStartup.
    let mod: Record<string, unknown>;
    try {
      mod = await import("../src/cli.js");
    } catch {
      mod = {};
    }
    const helper =
      (mod as { printVerboseStartup?: unknown }).printVerboseStartup ??
      (mod as { writeVerboseStartup?: unknown }).writeVerboseStartup ??
      (mod as { emitVerboseStartup?: unknown }).emitVerboseStartup;
    expect(
      typeof helper === "function",
      "expected src/cli.ts to export a stream-injectable printVerboseStartup (or writeVerboseStartup/emitVerboseStartup) helper for §4.5",
    ).toBe(true);

    const received: string[] = [];
    const collector = {
      write(chunk: string | Buffer): boolean {
        received.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((() => true) as any);

    try {
      (helper as (stream: unknown, info: unknown) => void)(collector, {
        assembledSystemPrompt: "STDERR_ROUTE_MARKER_42",
      });
      const joined = received.join("");
      expect(joined).toContain("STDERR_ROUTE_MARKER_42");
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // Fix (M part 3): no fallback-to-source-grep. The formatter helper must
  // exist; if it doesn't, the test fails. This is a strict contract on
  // the Executor.
  it("runJSON / RPC path — formatTurnMessage helper produces `[turn N: Mms, in=X, out=Y]` shape", async () => {
    let mod: Record<string, unknown>;
    try {
      mod = await import("../src/cli.js");
    } catch {
      mod = {};
    }
    const formatter =
      (mod as { formatTurnMessage?: unknown }).formatTurnMessage ??
      (mod as { buildTurnMessage?: unknown }).buildTurnMessage;
    expect(
      typeof formatter === "function",
      "expected src/cli.ts to export formatTurnMessage (or buildTurnMessage) for §4.5 non-TUI per-turn stats — needed so stderr/stdout routing can be unit-tested",
    ).toBe(true);

    // With usage provided, output must include exact in= / out= values.
    const withUsage = (
      formatter as (
        turn: number,
        elapsedMs: number,
        usage?: { input: number; output: number },
      ) => string
    )(3, 123, { input: 50, output: 25 });
    expect(withUsage).toMatch(/\[turn\s+3:\s+123ms/);
    expect(withUsage).toContain("in=50");
    expect(withUsage).toContain("out=25");

    // Without usage, timing-only.
    const noUsage = (
      formatter as (turn: number, elapsedMs: number, usage?: unknown) => string
    )(7, 42, undefined);
    expect(noUsage).toMatch(/\[turn\s+7:\s+42ms/);
    expect(noUsage).not.toMatch(/in=\d+/);
    expect(noUsage).not.toMatch(/out=\d+/);
  });

  // Fix (M part 1+2) + skipIf idiom: load-bearing spawn test.
  // With --verbose, stderr MUST contain one of the known prompt markers
  // AND stdout MUST be parseable JSON with a string `response` field.
  //
  // Uses `it.skipIf(...)` so vitest reports the test as SKIPPED (not
  // passed) when env is missing — visible in the run summary.
  it.skipIf(
    !process.env.ANTHROPIC_API_KEY ||
      !existsSync(resolve(REPO_ROOT, "dist/cli.js")),
  )(
    "spawn `node dist/cli.js --mode json --verbose -m hi` → stdout parseable JSON with response:string, stderr contains plan-mode prompt marker",
    async () => {
      const cliPath = resolve(REPO_ROOT, "dist/cli.js");
      const tmpHome = mkdtempSync(join(tmpdir(), "qlaybot-g6-spawn-home-"));
      try {
        const child = spawn(
          process.execPath,
          [cliPath, "--mode", "json", "--verbose", "-m", "hi"],
          {
            env: {
              ...process.env,
              HOME: tmpHome,
              QLAYBOT_WORKSPACE_DIR: tmpHome,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
        child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

        const exit: number = await new Promise((res) => {
          child.on("close", (code) => res(code ?? -1));
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* noop */
            }
            res(-2);
          }, 90_000);
        });
        expect([0, 1, -1, -2]).toContain(exit);

        // (M1) stdout contains NO per-turn stat line (would corrupt JSON).
        expect(stdout).not.toContain("[turn ");

        // (M2) stdout must be parseable JSON with a string `response`
        // field. On a happy path, runJSON emits the whole result object as
        // pretty-printed JSON to stdout.
        if (exit === 0 && stdout.trim().length > 0) {
          // Find the LAST `{...}` object in stdout — runJSON's final
          // output.
          const lastBrace = stdout.lastIndexOf("{");
          const lastClose = stdout.lastIndexOf("}");
          expect(lastBrace).toBeGreaterThanOrEqual(0);
          expect(lastClose).toBeGreaterThan(lastBrace);
          const candidate = stdout.slice(lastBrace, lastClose + 1);
          const parsed = JSON.parse(candidate) as {
            status?: string;
            response?: unknown;
          };
          expect(typeof parsed.response).toBe("string");
        }

        // (M1) stderr MUST contain a known plan-mode prompt marker. The
        // assembled prompt includes the `### Plan Mode` header and
        // `enter_plan_mode` identifier (both per Group 6 step 20). Accept
        // EITHER marker.
        const hasPlanModeHeader = stderr.includes("### Plan Mode");
        const hasEnterPlanMode = stderr.includes("enter_plan_mode");
        expect(
          hasPlanModeHeader || hasEnterPlanMode,
          `expected stderr to carry a plan-mode prompt marker ('### Plan Mode' or 'enter_plan_mode') — confirms system prompt went to stderr, not stdout. stderr (first 400 chars):\n${stderr.slice(
            0,
            400,
          )}`,
        ).toBe(true);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it.skipIf(
    !process.env.ANTHROPIC_API_KEY ||
      !existsSync(resolve(REPO_ROOT, "dist/cli.js")),
  )(
    "spawn without --verbose → stderr has NO plan-mode prompt marker AND no [turn ...] lines",
    async () => {
      const cliPath = resolve(REPO_ROOT, "dist/cli.js");
      const tmpHome = mkdtempSync(join(tmpdir(), "qlaybot-g6-spawn-novb-"));
      try {
        const child = spawn(
          process.execPath,
          [cliPath, "--mode", "json", "-m", "hi"],
          {
            env: {
              ...process.env,
              HOME: tmpHome,
              QLAYBOT_WORKSPACE_DIR: tmpHome,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
        child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

        await new Promise<number>((res) => {
          child.on("close", (code) => res(code ?? -1));
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* noop */
            }
            res(-2);
          }, 90_000);
        });

        // Without --verbose, stderr must NOT carry the plan-mode markers
        // or per-turn stats.
        expect(stderr).not.toContain("### Plan Mode");
        expect(stderr).not.toContain("enter_plan_mode");
        expect(stderr).not.toMatch(/\[turn\s+\d+:/);
        void stdout;
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // ── Codex final-gate Test 1 — RPC per-turn stats go to stderr ──────────
  //
  // Spec §4.5: in `--mode rpc`, per-turn `[turn N: Xms, in=..., out=...]`
  // stats MUST go to stderr, NEVER stdout (stdout is the JSON-RPC wire).
  //
  // Contract the Executor must satisfy: export from src/rpc.ts a helper
  // `subscribePerTurnStats(session, stream)` that wires agent_start →
  // agent_end → `formatTurnMessage` → `stream.write(line + "\n")`. This
  // test invokes that helper directly so it is unit-level (no spawn).
  //
  // If `subscribePerTurnStats` is absent, the test fails with a clear
  // "expected stderr to contain [turn ...] but received nothing" signal.
  it("Test 1 — RPC path subscribePerTurnStats writes to stderr, NEVER stdout", async () => {
    let rpcMod: Record<string, unknown>;
    try {
      rpcMod = (await import("../src/rpc.js")) as Record<string, unknown>;
    } catch {
      rpcMod = {};
    }
    const subscribe =
      (rpcMod as { subscribePerTurnStats?: unknown }).subscribePerTurnStats;
    expect(
      typeof subscribe === "function",
      "expected src/rpc.ts to export subscribePerTurnStats(session, stream) so the RPC per-turn stats bridge can be unit-tested — §4.5 requires RPC verbose routing to stderr",
    ).toBe(true);

    const bundle = makeFakeSession({ verbose: true });
    const stderrChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as never);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Buffer): boolean => {
        stderrChunks.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      }) as never);

    try {
      const unsub = (
        subscribe as (
          session: unknown,
          stream: NodeJS.WritableStream,
        ) => () => void
      )(bundle.botSession.session, process.stderr);
      bundle.fire({ type: "agent_start" });
      await new Promise((r) => setTimeout(r, 5));
      bundle.fire({
        type: "agent_end",
        usage: { input_tokens: 40, output_tokens: 20 },
      });
      await new Promise((r) => setTimeout(r, 10));
      unsub();

      const joined = stderrChunks.join("");
      const matches = joined.match(/\[turn \d+: \d+ms(?:, in=\d+, out=\d+)?\]/g);
      expect(
        matches,
        `expected stderr to contain exactly one [turn N: Xms, ...] line; stderr was: ${joined.slice(0, 200)}`,
      ).not.toBeNull();
      expect(matches!.length).toBe(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  // ── Codex final-gate Test 2 — --plain / non-TTY interactive mode ───────
  //
  // Spec §4.5: non-TUI verbose surfaces are stdout-hostile. `--plain` (and
  // non-TTY interactive fallback) is a non-TUI path where verbose is
  // currently a silent no-op per src/cli.ts::runInteractivePlain.
  //
  // Contract the Executor must satisfy: export from src/cli.ts a helper
  // `wireVerbosePlain(session, startupStream, perTurnStream, assembledSystemPrompt)`
  // that:
  //   1. calls printVerboseStartup(startupStream, {assembledSystemPrompt})
  //      when verbose is engaged, and
  //   2. subscribes agent_start/agent_end and writes formatTurnMessage
  //      output to perTurnStream.
  // `runInteractivePlain` must invoke this helper with process.stderr for
  // both streams when args.verbose is true.
  //
  // This test injects a stream stub so the helper is unit-testable without
  // touching real process.stderr; it also verifies process.stdout is never
  // written to.
  it("Test 2 — plain-mode wireVerbosePlain writes startup + per-turn lines to the injected stream (NOT stdout)", async () => {
    let cliMod: Record<string, unknown>;
    try {
      cliMod = (await import("../src/cli.js")) as Record<string, unknown>;
    } catch {
      cliMod = {};
    }
    const wire = (cliMod as { wireVerbosePlain?: unknown }).wireVerbosePlain;
    expect(
      typeof wire === "function",
      "expected src/cli.ts to export wireVerbosePlain(session, startupStream, perTurnStream, assembledSystemPrompt) and runInteractivePlain to invoke it when args.verbose — §4.5 requires --plain / non-TTY verbose routing",
    ).toBe(true);

    const bundle = makeFakeSession({
      verbose: true,
      assembledSystemPrompt: "PLAIN_MODE_PROMPT_MARKER_77 You are qlaybot.",
    });
    const captured: string[] = [];
    const stubStream = {
      write(chunk: string | Buffer): boolean {
        captured.push(
          typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
        );
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as never);

    try {
      const unsub = (
        wire as (
          session: unknown,
          startupStream: NodeJS.WritableStream,
          perTurnStream: NodeJS.WritableStream,
          assembledSystemPrompt: string,
        ) => () => void
      )(
        bundle.botSession.session,
        stubStream,
        stubStream,
        "PLAIN_MODE_PROMPT_MARKER_77 You are qlaybot.",
      );
      // Fire synthetic turn lifecycle.
      bundle.fire({ type: "agent_start" });
      await new Promise((r) => setTimeout(r, 5));
      bundle.fire({
        type: "agent_end",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      await new Promise((r) => setTimeout(r, 10));
      unsub();

      const joined = captured.join("");
      // (1) startup: assembled prompt marker must appear in the stream.
      expect(joined).toContain("PLAIN_MODE_PROMPT_MARKER_77");
      // (2) per-turn: exactly one [turn ...] line, timing-at-minimum.
      const turnMatches = joined.match(
        /\[turn \d+: \d+ms(?:, in=\d+, out=\d+)?\]/g,
      );
      expect(
        turnMatches,
        `expected one per-turn line in injected stream; got: ${joined.slice(0, 200)}`,
      ).not.toBeNull();
      expect(turnMatches!.length).toBe(1);
      // (3) stdout never touched.
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  // ── Codex final-gate — RPC re-initialize cleanup regression ────────────
  //
  // src/rpc.ts::initialize previously overwrote closure-local `botSession`
  // and `verbosePerTurnUnsub` WITHOUT disposing/unsubscribing the prior
  // values → listener + session leak when initialize is called twice in
  // the same server (e.g. a client that reconnects without shutdown).
  //
  // `verbosePerTurnUnsub` is a function-local closure inside
  // `startRPCServer`, so it cannot be inspected at runtime from a test.
  // Use a source-regex regression check: within the `case "initialize":`
  // block, BOTH the prior-unsub call AND the prior-session dispose MUST
  // appear BEFORE the `botSession = await createDesignSession(...)`
  // re-assignment.
  it("Test 3 — initialize disposes prior session + calls prior verbosePerTurnUnsub BEFORE re-assignment (regression)", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "src/rpc.ts"), "utf8");

    // Extract the body of the initialize case via a brace-balance scan
    // starting from `case "initialize"`.
    const caseIdx = raw.indexOf('case "initialize"');
    expect(
      caseIdx,
      'src/rpc.ts missing `case "initialize"` handler',
    ).toBeGreaterThan(0);
    const openIdx = raw.indexOf("{", caseIdx);
    expect(openIdx).toBeGreaterThan(caseIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    expect(closeIdx, "unbalanced braces inside initialize case").toBeGreaterThan(openIdx);
    const body = raw.slice(openIdx, closeIdx + 1);

    // Ordering anchor: the `botSession = await createDesignSession(` line
    // marks the re-assignment. Cleanup of prior state MUST appear before it.
    const reassignIdx = body.search(/botSession\s*=\s*await\s+createDesignSession\s*\(/);
    expect(
      reassignIdx,
      "initialize handler must reassign botSession via createDesignSession; if the shape changed, update this regression test",
    ).toBeGreaterThanOrEqual(0);
    const pre = body.slice(0, reassignIdx);

    // (a) prior verbosePerTurnUnsub must be invoked before re-assignment.
    const hasPriorUnsub =
      /verbosePerTurnUnsub\s*\?\.\(\)/.test(pre) ||
      /verbosePerTurnUnsub\s*\(\)/.test(pre);
    expect(
      hasPriorUnsub,
      "initialize handler must call the prior verbosePerTurnUnsub() BEFORE re-assigning botSession — listener leak on re-init. Expected one of: `verbosePerTurnUnsub?.();`, `verbosePerTurnUnsub();`, or `if (verbosePerTurnUnsub) { verbosePerTurnUnsub(); ... }` before `botSession = await createDesignSession(...)`",
    ).toBe(true);

    // (b) prior botSession must be disposed before re-assignment.
    const hasPriorDispose =
      /await\s+botSession\s*\?\.\s*dispose\s*\(\)/.test(pre) ||
      /await\s+botSession\.dispose\s*\(\)/.test(pre);
    expect(
      hasPriorDispose,
      "initialize handler must `await botSession?.dispose()` on the prior session BEFORE re-assigning — session leak on re-init",
    ).toBe(true);
  });

  // ── Codex final-gate — RPC concurrent initialize serialization ─────────
  //
  // Test 3 fixes the sequential re-init leak (dispose prior + unsub prior
  // before re-assigning). But if two `initialize` requests arrive
  // concurrently, both await `createDesignSession(...)` in parallel before
  // either dispose runs → the prior-cleanup logic in Test 3 sees `null`
  // and two fresh sessions still race. Need an in-flight serialization
  // gate at the TOP of the handler.
  //
  // Same source-regex fallback strategy as Test 3 — `startRPCServer` is
  // closure-local with no runtime hooks for a concurrency probe, and
  // spawning the real server hijacks stdin.
  it("Test 4 — initialize handler serializes concurrent calls via an in-flight guard (regression)", () => {
    const raw = readFileSync(resolve(REPO_ROOT, "src/rpc.ts"), "utf8");

    // Scope: the guard can live either inside `case "initialize"` or at
    // module/closure scope in startRPCServer before the switch. Accept
    // both by searching the full startRPCServer body.
    const startIdx = raw.indexOf("startRPCServer");
    expect(
      startIdx,
      "src/rpc.ts missing `startRPCServer` — if the export was renamed, update this regression test",
    ).toBeGreaterThan(0);
    // Slice from the function header to EOF — covers both scopes.
    const source = raw.slice(startIdx);

    // Accept any of 4 serialization idioms:
    //  (1) `initializing` in a ternary/&&/|| guard position
    //  (2) `if (initializing) ...` explicit guard
    //  (3) `await initializing` chain-off-in-flight
    //  (4) named mutex vars: initMutex / initLock / initInProgress
    const patterns: Array<{ label: string; re: RegExp }> = [
      {
        label: "usage guard (ternary / && / ||)",
        re: /initializing\s*(?:\?\.)?\s*(?:\(\s*\))?\s*(?:\?\s*[^:;]*\s*:|&&|\|\|)/,
      },
      { label: "explicit if-guard", re: /if\s*\(\s*initializing\s*\)/ },
      { label: "await chain", re: /await\s+initializing/ },
      {
        label: "named mutex (initMutex / initLock / initInProgress)",
        re: /initMutex|initLock|initInProgress/i,
      },
    ];
    const matched = patterns.filter((p) => p.re.test(source));
    expect(
      matched.length,
      "RPC initialize handler must serialize concurrent calls (e.g., `if (initializing) await initializing; initializing = (async () => { ... })(); ...`) — two parallel initializes can leak sessions. None of the accepted idioms (usage-guard / if-guard / await-chain / named-mutex) were found in startRPCServer.",
    ).toBeGreaterThan(0);
  });
});
