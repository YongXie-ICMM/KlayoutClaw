/**
 * qlaybot v0.4.3 — Group 5 TRD tests (Test Overseer owned).
 *
 * Covers spec §3 (Transcript Truncate) + §5.1 (truncate unit tests) + §5.2 T22
 * + §9 step 14:
 *
 *   §3.1 — New `src/truncation.ts` module exporting:
 *     - interface `TruncationOptions { threshold, headChars, tailChars }`
 *     - constant `DEFAULT_TRANSCRIPT_TRUNCATION = { threshold: 2000,
 *       headChars: 1000, tailChars: 1000 }`
 *     - function `truncate(s, opts) -> string` that splits at head/tail with a
 *       `... (truncated N chars) ...` marker when `s.length > threshold`.
 *
 *   §3.2 — `InteractionHistory.recordToolCall` integration:
 *     - Result serialization: string → use directly; else
 *       JSON.stringify(result, null, 2) → run truncate.
 *     - Apply to BOTH transcript.jsonl AND per-tool JSON file (single source
 *       of truth — full result NOT preserved unless --verbose).
 *     - On actual truncation, add `truncated: true` and `original_length:
 *       number` fields to the toolLog object. When NOT truncated, no extra
 *       fields are added.
 *     - ONLY `tool_call` entries' `result` field is truncated. Prompts,
 *       responses, thinking, errors, AND ARGS are never truncated.
 *
 *   §3.3 — Verbose-bypass via constructor `truncationOpts`:
 *     - Passing `{threshold: Infinity, headChars: 0, tailChars: 0}` to the
 *       constructor MUST result in NO truncation. This is the Group 6
 *       contract: a single constructor-stored opts that recordToolCall reads,
 *       not a separate verbose code path.
 *
 * ---------------------------------------------------------------------------
 * Constructor-shape assumption (documented per parent brief):
 *   The Executor will add a 3rd positional constructor arg
 *     `truncationOpts?: TruncationOptions | null`
 *   keeping backward compat with existing call sites
 *   `new InteractionHistory(sessionId, configSnapshot)` in src/agent.ts.
 *   Tests below instantiate as
 *     `new InteractionHistory(sessionId, undefined, opts?)`.
 *   If the Executor picks a different but equivalent shape (e.g. an opts
 *   bag), the verbose-bypass test (test 14) and constructor tests (test 15)
 *   will fail and surface the mismatch in Stage 4.
 *
 * ---------------------------------------------------------------------------
 * HOME isolation (Finding 1 fix — round 2):
 *   `src/history.ts:10` computes `const HISTORY_DIR = join(homedir(),
 *   ".qlaybot", "history")` at MODULE-IMPORT time. A static top-level import
 *   of `InteractionHistory` would bake the real `~/.qlaybot/history` path
 *   into HISTORY_DIR before any `beforeEach` runs, polluting the user's home
 *   on every test invocation.
 *
 *   Fix (codex Finding 1, option A): keep `InteractionHistory` out of the
 *   top-level imports; in `beforeEach` set `process.env.HOME` to a tmpdir,
 *   call `vi.resetModules()` to wipe the module-graph cache, then re-import
 *   `../src/history.js` so its top-level `homedir()` call sees the redirected
 *   $HOME and computes HISTORY_DIR pointing into the tmpdir.
 *
 *   Pollution-proof: each test instantiates the freshly-imported class, every
 *   write lands in the test's own tmpHome, and `afterEach` rmSync's the
 *   tmpHome wholesale. A `find ~/.qlaybot/history -name 'g5-*'` after the
 *   suite must return zero results.
 *
 * ---------------------------------------------------------------------------
 * Expected state BEFORE the Executor runs Group 5:
 *   - Group A (truncate unit tests): FAIL with `Cannot find module
 *     "../src/truncation.js"` — the module does not exist yet.
 *   - Group B (history integration tests): FAIL because today's
 *     `recordToolCall` (src/history.ts:106-129) writes the result verbatim
 *     and never adds `truncated` / `original_length` fields. The 50KB
 *     truncated-content assertions and the verbose-bypass constructor option
 *     will both fail.
 *   - Negative-invariant tests (11, 13a, 13b, 14, 16) PASS pre-impl as TRD
 *     over-implementation guards. They lock in invariants the Executor must
 *     NOT break.
 *
 * That is the intended TRD shape: most tests fail on missing-impl and turn
 * green as the Executor lands the truncation module + history wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Type-only + runtime imports from the not-yet-existing truncation module. A
// dynamic loader keeps this test file parseable at vitest collect time even
// if `src/truncation.ts` is absent — individual tests will fail loudly on the
// awaited import.
import type { TruncationOptions as _TruncationOptions } from "../src/truncation.js";

async function loadTruncation(): Promise<{
  TruncationOptions: never; // type-only, exported as part of module
  DEFAULT_TRANSCRIPT_TRUNCATION: { threshold: number; headChars: number; tailChars: number };
  truncate: (s: string, opts: { threshold: number; headChars: number; tailChars: number }) => string;
}> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — module may not exist yet; the await rejects loudly if so.
  return await import("../src/truncation.js");
}

// ─────────────────────────────────────────────────────────────────────────────
// HOME-redirection scaffolding — Finding 1 fix (codex round 2)
//
// `src/history.ts:10` computes HISTORY_DIR at MODULE import time. We must:
//   1. Set $HOME to a tmpdir BEFORE any import of history.ts.
//   2. `vi.resetModules()` to evict any cached version of history.ts.
//   3. Dynamically re-import history.ts so its top-level `homedir()` call
//      reads the redirected $HOME.
//
// Module-level `InteractionHistory` is rebound per-test, kept as `let` so
// test bodies can refer to a single name. Re-import per test is the right
// granularity: cheap (small module) and guarantees no cross-test bleed.
// ─────────────────────────────────────────────────────────────────────────────

// Type alias only — the actual constructor reference is rebound in beforeEach.
type InteractionHistoryClass =
  typeof import("../src/history.js").InteractionHistory;

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let tmpHome: string;
let InteractionHistory: InteractionHistoryClass;

beforeEach(async () => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  tmpHome = mkdtempSync(join(tmpdir(), "qlaybot-history-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // paranoia for any future Win-style branch
  // Wipe module cache so the next import of history.ts re-runs its
  // top-level `homedir()` against the redirected $HOME. Without this, a
  // previously-imported (real-home) HISTORY_DIR sticks for the rest of the
  // suite.
  vi.resetModules();
  ({ InteractionHistory } = await import("../src/history.js"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** Generate a unique sessionId to keep tests isolated even within the same tmpHome. */
function freshSessionId(label: string): string {
  return `g5-${label}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Read every line of a session's transcript.jsonl, return the parsed entries.
 * Throws if the file is missing — tests should always have at least one entry
 * by the time they call this.
 */
function readTranscriptEntries(sessionDir: string): Array<{
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}> {
  const path = join(sessionDir, "transcript.jsonl");
  expect(
    existsSync(path),
    `transcript.jsonl missing at ${path}`,
  ).toBe(true);
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

/** Read the most recent tool_call entry from transcript.jsonl. */
function readLastToolCallEntry(sessionDir: string): {
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
} {
  const entries = readTranscriptEntries(sessionDir);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "tool_call") return entries[i];
  }
  throw new Error("no tool_call entry found in transcript.jsonl");
}

/** Read a per-tool JSON file from `${sessionDir}/tool_calls/NNN_{name}.json`. */
function readPerToolJson(
  sessionDir: string,
  counter: number,
  toolName: string,
): Record<string, unknown> {
  const padded = String(counter).padStart(3, "0");
  const path = join(sessionDir, "tool_calls", `${padded}_${toolName}.json`);
  expect(existsSync(path), `per-tool JSON missing at ${path}`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Group A — `truncate()` unit tests (spec §3.1)
// ─────────────────────────────────────────────────────────────────────────────

describe("Group 5 · §3.1 · truncate() unit tests", () => {
  it("test 1: below-threshold passthrough — s.length < threshold returns s unchanged", async () => {
    const m = await loadTruncation();
    const s = "x".repeat(1500); // 1500 < 2000 default threshold
    const out = m.truncate(s, m.DEFAULT_TRANSCRIPT_TRUNCATION);
    expect(out).toBe(s);
    expect(out.length).toBe(1500);
  });

  it("test 2: equal-to-threshold passthrough — s.length === threshold returns s unchanged (boundary)", async () => {
    const m = await loadTruncation();
    const s = "y".repeat(2000); // exactly at threshold
    const out = m.truncate(s, m.DEFAULT_TRANSCRIPT_TRUNCATION);
    expect(out).toBe(s);
    expect(out.length).toBe(2000);
  });

  it("test 2b (Finding 5): threshold+1 boundary — s.length === threshold+1 truncates (pins strict <= predicate)", async () => {
    const m = await loadTruncation();
    // 2001 chars with default opts (threshold 2000) — must trigger truncation.
    // Pins the spec's `if (s.length <= opts.threshold) return s` predicate as
    // strict `<=`; an off-by-one to `<` would leave 2001 untouched and this
    // test catches it. Conversely, an off-by-one to `>=` would also fire on
    // length 2000 — caught by test 2 above. Together tests 2 and 2b lock in
    // the exact `<=` predicate.
    const s = "z".repeat(2001);
    const out = m.truncate(s, m.DEFAULT_TRANSCRIPT_TRUNCATION);
    // Truncation triggered ⇒ output is shaped as head + marker + tail.
    expect(out).not.toBe(s);
    expect(out).toContain("... (truncated 1 chars) ..."); // 2001 - 1000 - 1000 = 1
    expect(out.startsWith("z".repeat(1000))).toBe(true);
    expect(out.endsWith("z".repeat(1000))).toBe(true);
  });

  it("test 3: above-threshold split correctness — head + marker + tail shape", async () => {
    const m = await loadTruncation();
    // Build a 2500-char string with distinguishable head and tail so we can
    // verify the slice points are correct (head from start, tail from end).
    const head = "H".repeat(1000);
    const middle = "M".repeat(500);
    const tail = "T".repeat(1000);
    const s = head + middle + tail; // length 2500 > 2000
    const out = m.truncate(s, m.DEFAULT_TRANSCRIPT_TRUNCATION);

    // Expected: `${head}\n... (truncated 500 chars) ...\n${tail}`
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain("... (truncated 500 chars) ...");
    // Marker must be sandwiched between newlines per spec template.
    expect(out).toContain("\n... (truncated 500 chars) ...\n");
    // The middle "M" payload must be GONE from output (the entire purpose of
    // truncation — head + tail only).
    expect(out).not.toContain("M".repeat(500));
  });

  it("test 4: hidden-count arithmetic — for s.length=2500, h=1000, t=1000 marker reads 'truncated 500 chars'", async () => {
    const m = await loadTruncation();
    const s = "z".repeat(2500);
    const out = m.truncate(s, { threshold: 2000, headChars: 1000, tailChars: 1000 });
    // hidden = 2500 - 1000 - 1000 = 500
    expect(out).toContain("truncated 500 chars");
  });

  it("test 5: zero-char input — truncate('', default) returns '' unchanged", async () => {
    const m = await loadTruncation();
    const out = m.truncate("", m.DEFAULT_TRANSCRIPT_TRUNCATION);
    expect(out).toBe("");
    expect(out.length).toBe(0);
  });

  it("test 6: threshold=0 always truncates — truncate('abc',{0,0,0}) marker reads 'hidden=3'", async () => {
    const m = await loadTruncation();
    const out = m.truncate("abc", { threshold: 0, headChars: 0, tailChars: 0 });
    // Length 3 > threshold 0 ⇒ truncate. hidden = 3 - 0 - 0 = 3.
    // head = "" (slice(0,0)), tail = "" (slice(3,3)).
    // Expected exact: "\n... (truncated 3 chars) ...\n"
    expect(out).toBe("\n... (truncated 3 chars) ...\n");
    expect(out).toContain("truncated 3 chars");
  });

  it("test 7: GROUP 6 CONTRACT — threshold=Infinity, headChars=0, tailChars=0 returns input unchanged (verbose-bypass)", async () => {
    const m = await loadTruncation();
    const huge = "v".repeat(50_000); // 50KB — well above default threshold
    const out = m.truncate(huge, { threshold: Infinity, headChars: 0, tailChars: 0 });
    // Verbose-bypass: even a 50KB string passes through untouched.
    expect(out).toBe(huge);
    expect(out.length).toBe(50_000);
    // No marker text leaked when not truncating.
    expect(out).not.toContain("... (truncated");
  });

  it("test 8: DEFAULT_TRANSCRIPT_TRUNCATION constant has exact spec shape", async () => {
    const m = await loadTruncation();
    expect(m.DEFAULT_TRANSCRIPT_TRUNCATION).toEqual({
      threshold: 2000,
      headChars: 1000,
      tailChars: 1000,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group B — `InteractionHistory.recordToolCall` integration tests (spec §3.2)
// ─────────────────────────────────────────────────────────────────────────────

describe("Group 5 · §3.2 · InteractionHistory.recordToolCall truncation", () => {
  it("test 9 (T22): 50KB tool result truncated in transcript.jsonl with truncated/original_length fields", () => {
    const sessionId = freshSessionId("t22-jsonl");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    // Pollution self-check: the session dir must be inside our tmpHome.
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const big = "x".repeat(50_000);
    history.recordToolCall("test_tool", {}, big, 100);

    const entry = readLastToolCallEntry(sessionDir);
    expect(entry.type).toBe("tool_call");
    const data = entry.data as Record<string, unknown>;

    // Truncation metadata must be present and correct.
    expect(data.truncated).toBe(true);
    expect(data.original_length).toBe(50_000);

    // Truncated result must be a string (not an object) and well within the
    // expected size budget: head(1000) + "\n... (truncated 48000 chars) ...\n"
    // (~32 chars) + tail(1000) ≈ 2032. Cap at 2100 for a small tolerance.
    expect(typeof data.result).toBe("string");
    const result = data.result as string;
    expect(result.length).toBeLessThanOrEqual(2100);

    // Head: first 1000 chars are the original head.
    expect(result.startsWith("x".repeat(1000))).toBe(true);
    // Tail: last 1000 chars are the original tail.
    expect(result.endsWith("x".repeat(1000))).toBe(true);
    // Marker: hidden = 50000 - 1000 - 1000 = 48000.
    expect(result).toContain("... (truncated 48000 chars) ...");
  });

  it("test 10: T22 also applies to the per-tool JSON file (single source of truth)", () => {
    const sessionId = freshSessionId("t22-pertool");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const big = "x".repeat(50_000);
    history.recordToolCall("test_tool", {}, big, 100);

    // First (and only) recorded tool call ⇒ counter = 1 ⇒ "001_test_tool.json".
    const json = readPerToolJson(sessionDir, 1, "test_tool");
    expect(json.truncated).toBe(true);
    expect(json.original_length).toBe(50_000);
    expect(typeof json.result).toBe("string");
    const result = json.result as string;
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result.startsWith("x".repeat(1000))).toBe(true);
    expect(result.endsWith("x".repeat(1000))).toBe(true);
    expect(result).toContain("... (truncated 48000 chars) ...");
  });

  it("test 10b (Finding 2): single source of truth — transcript.jsonl and per-tool JSON byte-identical for same call", () => {
    // Records ONE tool call, then asserts both sinks carry identical truncated
    // data with no extra full-result fields. This is the strongest possible
    // single-source-of-truth check: an Executor that writes the truncated
    // string to one sink and the FULL result to the other (e.g.
    // `result_full: original` on the per-tool file as a "debug aid") fails
    // here, even if both individual tests 9 and 10 pass.
    const sessionId = freshSessionId("sst");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const big = "x".repeat(50_000);
    history.recordToolCall("sst_tool", {}, big, 42);

    const entry = readLastToolCallEntry(sessionDir);
    const dataFromJsonl = entry.data as Record<string, unknown>;
    const dataFromFile = readPerToolJson(sessionDir, 1, "sst_tool");

    // Byte-identical truncated content + metadata.
    expect(dataFromFile.result).toBe(dataFromJsonl.result);
    expect(dataFromFile.truncated).toBe(dataFromJsonl.truncated);
    expect(dataFromFile.original_length).toBe(dataFromJsonl.original_length);
    expect(dataFromFile.toolName).toBe(dataFromJsonl.toolName);
    expect(dataFromFile.durationMs).toBe(dataFromJsonl.durationMs);

    // Schema check: per-tool JSON file must contain EXACTLY the spec'd keys —
    // no `result_full`, `result_raw`, `original`, `_debug`, etc. that would
    // expose the pre-truncation payload through a side channel.
    const expectedKeys = [
      "args",
      "durationMs",
      "original_length",
      "result",
      "timestamp",
      "toolName",
      "truncated",
    ];
    expect(Object.keys(dataFromFile).sort()).toEqual(expectedKeys);

    // Same schema check on the transcript-jsonl entry.data shape.
    expect(Object.keys(dataFromJsonl).sort()).toEqual(expectedKeys);

    // Final guard: search the entire per-tool JSON file's serialized form for
    // any contiguous run of 2000+ "x" — would catch a leak even if the field
    // name isn't on the blocklist above.
    const fileRaw = readFileSync(
      join(sessionDir, "tool_calls", "001_sst_tool.json"),
      "utf8",
    );
    expect(
      fileRaw,
      "per-tool JSON file leaked the full pre-truncation payload",
    ).not.toContain("x".repeat(2000));
    // And the transcript line.
    const jsonlRaw = readFileSync(
      join(sessionDir, "transcript.jsonl"),
      "utf8",
    );
    expect(
      jsonlRaw,
      "transcript.jsonl leaked the full pre-truncation payload",
    ).not.toContain("x".repeat(2000));
  });

  it("test 11: below-threshold result preserved verbatim with NO truncated/original_length fields", () => {
    const sessionId = freshSessionId("below-thresh");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const small = "x".repeat(100); // well under 2000 threshold
    history.recordToolCall("test_tool", {}, small, 50);

    const entry = readLastToolCallEntry(sessionDir);
    const data = entry.data as Record<string, unknown>;

    // Result preserved verbatim — note: small is a string, so even after
    // serialize-if-not-string it stays as the same string literal.
    expect(data.result).toBe(small);
    // No truncation metadata when no truncation actually happened. Fields
    // must be entirely absent (undefined), not e.g. set to false / null /
    // original_length === small.length.
    expect(data.truncated).toBeUndefined();
    expect(data.original_length).toBeUndefined();

    // Same for per-tool JSON file.
    const json = readPerToolJson(sessionDir, 1, "test_tool");
    expect(json.result).toBe(small);
    expect(json.truncated).toBeUndefined();
    expect(json.original_length).toBeUndefined();
  });

  it("test 12: structured (non-string) result is JSON.stringified with 2-space indent BEFORE truncation (BOTH sinks — Finding 4)", () => {
    const sessionId = freshSessionId("structured");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const obj = { key: "y".repeat(50_000) };
    history.recordToolCall("test_tool", {}, obj, 100);

    // Compute what JSON.stringify(obj, null, 2) produces — that's the input
    // to the truncate() call per spec §3.2.
    const serialized = JSON.stringify(obj, null, 2);
    expect(serialized.length).toBeGreaterThan(50_000); // sanity

    // ── transcript.jsonl ──
    const entry = readLastToolCallEntry(sessionDir);
    const data = entry.data as Record<string, unknown>;

    expect(data.truncated).toBe(true);
    expect(data.original_length).toBe(serialized.length);

    // The truncated `result` field must now be a STRING (not an object),
    // because we serialized before truncating and the truncated head+marker+
    // tail concatenation can no longer be parsed as the original object.
    expect(typeof data.result).toBe("string");

    // The head of the truncated string starts with the pretty-printed JSON
    // header `'{\n  "key": "yyy...'` — proving the 2-space indent was used.
    const result = data.result as string;
    expect(result.startsWith('{\n  "key": "yyy')).toBe(true);

    // Codex round-3: prove truncation actually happened (the previous version
    // would pass against an Executor that JSON.stringify'd then wrote the
    // FULL string while faking truncated:true / original_length). Hardened
    // assertions below close the gap.

    // Truncation actually happened — bounded length within the default opts'
    // budget (1000 head + ~50 marker + 1000 tail).
    expect(result.length).toBeLessThanOrEqual(2100);
    // Strictly shorter than the pre-truncation serialized payload.
    expect(result.length).toBeLessThan(serialized.length);
    // Marker present with the EXACT hidden-count arithmetic (using default
    // opts: headChars + tailChars = 1000 + 1000).
    const expectedHidden = serialized.length - 1000 - 1000;
    expect(result).toContain(`... (truncated ${expectedHidden} chars) ...`);
    // Tail shape: the pretty-printed JSON ends with `"\n}` (closing quote of
    // the value, newline, closing brace). tailChars=1000 keeps the final 1000
    // chars verbatim, so the closing `}` must be at the very end.
    expect(result.endsWith('"\n}')).toBe(true);
    // No leak of the full y-payload anywhere — original was 50_000 y's; head
    // sees ≤1000 chars and tail sees ≤1000 chars (and the tail's last few
    // chars are JSON closers, not y's), so 2000 contiguous y's cannot appear.
    expect(result).not.toContain("y".repeat(2000));

    // ── per-tool JSON file (Finding 4) ──
    const fileData = readPerToolJson(sessionDir, 1, "test_tool");
    expect(fileData.truncated).toBe(true);
    expect(fileData.original_length).toBe(serialized.length);
    expect(typeof fileData.result).toBe("string");
    const fileResult = fileData.result as string;
    expect(fileResult.startsWith('{\n  "key": "yyy')).toBe(true);

    // Identical hardened assertions on the per-tool JSON file: an Executor
    // that truncates the transcript line correctly but writes the FULL
    // serialized payload into the per-tool file fails here.
    expect(fileResult.length).toBeLessThanOrEqual(2100);
    expect(fileResult.length).toBeLessThan(serialized.length);
    expect(fileResult).toContain(`... (truncated ${expectedHidden} chars) ...`);
    expect(fileResult.endsWith('"\n}')).toBe(true);
    expect(fileResult).not.toContain("y".repeat(2000));

    // Single source of truth: the per-tool file's truncated string must be
    // byte-identical to the transcript-jsonl version.
    expect(fileData.result).toBe(data.result);
  });

  it("test 13a: recordPrompt is NEVER truncated (50KB user prompt round-trips in full)", () => {
    const sessionId = freshSessionId("prompt-full");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const big = "u".repeat(50_000);
    history.recordPrompt(big);

    const entries = readTranscriptEntries(sessionDir);
    // Find the user_prompt entry (other entries may be metadata or none).
    const promptEntry = entries.find((e) => e.type === "user_prompt");
    expect(promptEntry, "user_prompt entry not found").toBeDefined();
    const data = promptEntry!.data as Record<string, unknown>;
    expect(data.message).toBe(big);
    // Truncation metadata fields must NOT be added to non-tool_call entries.
    expect(data.truncated).toBeUndefined();
    expect(data.original_length).toBeUndefined();
  });

  it("test 13b: recordResponse, recordThinking, recordError NEVER truncated (50KB each round-trips in full)", () => {
    const sessionId = freshSessionId("nontool-full");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const bigResp = "r".repeat(50_000);
    const bigThink = "t".repeat(50_000);
    const bigErr = "e".repeat(50_000);
    history.recordResponse(bigResp);
    history.recordThinking(bigThink);
    history.recordError(bigErr);

    const entries = readTranscriptEntries(sessionDir);

    const respEntry = entries.find((e) => e.type === "agent_response");
    expect(respEntry, "agent_response entry not found").toBeDefined();
    expect((respEntry!.data as Record<string, unknown>).text).toBe(bigResp);
    expect((respEntry!.data as Record<string, unknown>).truncated).toBeUndefined();

    const thinkEntry = entries.find((e) => e.type === "agent_thinking");
    expect(thinkEntry, "agent_thinking entry not found").toBeDefined();
    expect((thinkEntry!.data as Record<string, unknown>).text).toBe(bigThink);
    expect((thinkEntry!.data as Record<string, unknown>).truncated).toBeUndefined();

    const errEntry = entries.find((e) => e.type === "error");
    expect(errEntry, "error entry not found").toBeDefined();
    expect((errEntry!.data as Record<string, unknown>).error).toBe(bigErr);
    expect((errEntry!.data as Record<string, unknown>).truncated).toBeUndefined();
  });

  it("test 14: GROUP 6 CONTRACT — verbose-bypass via constructor opts {Infinity,0,0} preserves full result", () => {
    const sessionId = freshSessionId("verbose-bypass");
    // Constructor shape per parent brief: `(sessionId?, configSnapshot?,
    // truncationOpts?)`. Passing the explicit verbose-bypass opts disables
    // truncation entirely.
    const history = new InteractionHistory(sessionId, undefined, {
      threshold: Infinity,
      headChars: 0,
      tailChars: 0,
    });
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const big = "x".repeat(50_000);
    history.recordToolCall("test_tool", {}, big, 100);

    const entry = readLastToolCallEntry(sessionDir);
    const data = entry.data as Record<string, unknown>;

    // Full result preserved — 50KB, no marker, no metadata.
    expect(data.result).toBe(big);
    expect(typeof data.result).toBe("string");
    expect((data.result as string).length).toBe(50_000);
    expect(data.truncated).toBeUndefined();
    expect(data.original_length).toBeUndefined();

    // Same in the per-tool JSON file (single source of truth).
    const json = readPerToolJson(sessionDir, 1, "test_tool");
    expect(json.result).toBe(big);
    expect(json.truncated).toBeUndefined();
    expect(json.original_length).toBeUndefined();
  });

  it("test 15: default constructor (no opts) uses DEFAULT_TRANSCRIPT_TRUNCATION", () => {
    // Fresh instance without passing any truncationOpts ⇒ default behaviour
    // must apply, identical to test 9. Asserts the default-resolution path
    // independently from T22 so a future refactor that nukes the default in
    // one constructor branch is caught.
    const sessionId = freshSessionId("default-ctor");
    const history = new InteractionHistory(sessionId); // no 2nd or 3rd arg
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const big = "x".repeat(50_000);
    history.recordToolCall("default_tool", {}, big, 25);

    const entry = readLastToolCallEntry(sessionDir);
    const data = entry.data as Record<string, unknown>;
    expect(data.truncated).toBe(true);
    expect(data.original_length).toBe(50_000);
    expect(typeof data.result).toBe("string");
    const result = data.result as string;
    expect(result.length).toBeLessThanOrEqual(2100);
    expect(result.startsWith("x".repeat(1000))).toBe(true);
    expect(result.endsWith("x".repeat(1000))).toBe(true);
    expect(result).toContain("... (truncated 48000 chars) ...");
  });

  it("test 16 (Finding 3): args are NEVER truncated — 50KB args round-trip while small result has no truncation metadata", () => {
    // Spec §3.2: "Args are untruncated (bounded by model output)". An
    // Executor that runs `truncate` on `args` (e.g. by serializing the entire
    // toolLog object first then truncating, or by also calling `truncate` on
    // a stringified args) fails this test.
    const sessionId = freshSessionId("args-full");
    const history = new InteractionHistory(sessionId);
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    // 50KB args object, deeply distinguishable so we can assert round-trip.
    const bigArgs = {
      knob: "k".repeat(50_000),
      nested: { deep: "d".repeat(20_000) },
    };
    const small = "ok".repeat(20); // 40 chars — well under default threshold
    history.recordToolCall("args_tool", bigArgs, small, 7);

    // ── transcript.jsonl ──
    const entry = readLastToolCallEntry(sessionDir);
    const data = entry.data as Record<string, unknown>;

    // Args round-trip in full. Use deepEqual because args is a structured
    // object that JSON.parse round-trips back as a structurally-identical
    // object (not the same reference).
    expect(data.args).toEqual(bigArgs);

    // Result is untouched (below threshold) and NO truncation metadata is
    // present — this guards against an Executor that wrongly sets
    // `truncated:true` whenever EITHER args OR result exceeds threshold.
    expect(data.result).toBe(small);
    expect(data.truncated).toBeUndefined();
    expect(data.original_length).toBeUndefined();

    // ── per-tool JSON file (single source of truth) ──
    const fileData = readPerToolJson(sessionDir, 1, "args_tool");
    expect(fileData.args).toEqual(bigArgs);
    expect(fileData.result).toBe(small);
    expect(fileData.truncated).toBeUndefined();
    expect(fileData.original_length).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Test 17: BOUNDARY METADATA-FIRE REGRESSION
  //
  // Code-reviewer flagged a real bug in the Executor's commit af3c062 at
  // src/history.ts:143. The metadata-fire predicate used was
  // `truncated.length < serialized.length`. At the boundary
  // `serialized.length === threshold + 1` (e.g. 2001 chars with default opts:
  // threshold=2000, headChars=1000, tailChars=1000), truncate() builds a
  // payload of ~2029 chars (1000 head + 28 marker + 1000 tail) which is
  // LONGER than the 2001-char input. The buggy predicate then evaluates
  // `2029 < 2001 === false` and skips emitting the metadata, even though
  // truncate() actually rewrote the result.
  //
  // Spec §3.2 mandates that consumers can detect truncation via the
  // `truncated` + `original_length` fields. Missing the metadata at this
  // boundary violates that contract.
  //
  // Correct predicate per spec: `serialized.length > opts.threshold` (i.e.
  // gate on whether truncate() WOULD truncate, not on whether the OUTPUT
  // happens to be shorter than the input).
  //
  // An Executor that uses `truncatedResult.length < serialized.length` will
  // FAIL this test because `data.truncated` will be undefined at the 2001-
  // char boundary. An Executor that gates on the threshold predicate will
  // pass.
  // ───────────────────────────────────────────────────────────────────────────
  it("test 17 (boundary metadata-fire regression): result.length === threshold+1 must add truncated/original_length metadata", () => {
    const sessionId = freshSessionId("boundary-meta");
    const history = new InteractionHistory(sessionId); // default opts: threshold=2000
    const sessionDir = history.getSessionDir();
    expect(sessionDir.startsWith(tmpHome)).toBe(true);

    const big = "z".repeat(2001); // exactly threshold+1 with default opts
    history.recordToolCall("test_tool", {}, big, 50);

    // ── transcript.jsonl ──
    const entry = readLastToolCallEntry(sessionDir);
    const data = entry.data as Record<string, unknown>;

    // The bug-detecting assertion: at the boundary, the truncated output is
    // ~2029 chars (LONGER than the 2001 input). A predicate of
    // `truncated.length < input.length` evaluates false here and skips the
    // metadata. The correct predicate is `input.length > opts.threshold`.
    expect(data.truncated).toBe(true);
    expect(data.original_length).toBe(2001);
    expect(typeof data.result).toBe("string");

    const result = data.result as string;
    // Real truncation happened — marker present with the correct hidden
    // count (2001 - 1000 - 1000 = 1).
    expect(result).toContain("... (truncated 1 chars) ...");
    // Head and tail shape: 1000 z's at each end of the truncated payload.
    expect(result.startsWith("z".repeat(1000))).toBe(true);
    expect(result.endsWith("z".repeat(1000))).toBe(true);

    // ── per-tool JSON file ──
    const fileData = readPerToolJson(sessionDir, 1, "test_tool");
    expect(fileData.truncated).toBe(true);
    expect(fileData.original_length).toBe(2001);
    expect(typeof fileData.result).toBe("string");
    const fileResult = fileData.result as string;
    expect(fileResult).toContain("... (truncated 1 chars) ...");
    expect(fileResult.startsWith("z".repeat(1000))).toBe(true);
    expect(fileResult.endsWith("z".repeat(1000))).toBe(true);

    // Single source of truth: byte-identical between the two sinks.
    expect(fileData.result).toBe(data.result);
  });
});
