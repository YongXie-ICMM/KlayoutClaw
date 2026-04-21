/**
 * Phase 0 — Shared Marker Infrastructure tests.
 *
 * Covers tasks 0.1 (TranscriptMarkerEmitter), 0.2 (get/set registry helpers),
 * 0.4 (emitter construction + InteractionHistory subscriber) and 0.5
 * (VerboseTranscriptWriter direct subscriber) from
 * docs/superpowers/plans/2026-04-21-qlaybot-0.4.4.md.
 *
 * These are RED tests — the implementation modules (agent/src/events/*)
 * do not yet exist. Imports will fail until the Executor lands the
 * emitter class, the registry helpers, and wires them into
 * createDesignSession.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeTmpDir(prefix = "qlaybot-emitter-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

interface JsonlLine {
  timestamp?: string;
  type?: string;
  data?: Record<string, unknown> & {
    type?: string;
    ts?: string;
    source?: string;
    thought?: string;
  };
}

function readJsonl(path: string): JsonlLine[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JsonlLine);
}

function findTranscriptFiles(dir: string, filename: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(full);
      else if (entry === filename) results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Task 0.1 — TranscriptMarkerEmitter API + resilient dispatch
// ---------------------------------------------------------------------------

describe("TranscriptMarkerEmitter — Task 0.1 (event API)", () => {
  it("exposes emit/on/off methods", async () => {
    const { TranscriptMarkerEmitter } = await import("../src/events/marker-emitter.js");
    const e = new TranscriptMarkerEmitter();
    expect(typeof e.emit).toBe("function");
    expect(typeof e.on).toBe("function");
    expect(typeof e.off).toBe("function");
  });

  it("delivers the marker to a subscriber with object identity preserved", async () => {
    const { TranscriptMarkerEmitter } = await import("../src/events/marker-emitter.js");
    const e = new TranscriptMarkerEmitter();
    const received: unknown[] = [];
    e.on("marker", (m: unknown) => received.push(m));
    const marker = {
      type: "think_recorded" as const,
      source: "tool" as const,
      thought: "identity probe",
      ts: "2026-04-21T00:00:00.000Z",
    };
    e.emit("marker", marker);
    expect(received.length).toBe(1);
    // object identity, not just deep equality — no envelope wrapping
    expect(received[0]).toBe(marker);
  });

  it("delivers to multiple subscribers in registration order", async () => {
    const { TranscriptMarkerEmitter } = await import("../src/events/marker-emitter.js");
    const e = new TranscriptMarkerEmitter();
    const calls: string[] = [];
    e.on("marker", () => calls.push("A"));
    e.on("marker", () => calls.push("B"));
    e.on("marker", () => calls.push("C"));
    e.emit("marker", {
      type: "think_recorded",
      source: "tool",
      thought: "x",
      ts: "2026-04-21T00:00:00.000Z",
    });
    expect(calls).toEqual(["A", "B", "C"]);
  });

  it("resilient dispatch: a throwing subscriber does not prevent later ones from receiving the marker", async () => {
    const { TranscriptMarkerEmitter } = await import("../src/events/marker-emitter.js");
    const e = new TranscriptMarkerEmitter();
    const received: unknown[] = [];
    e.on("marker", () => {
      throw new Error("boom from first subscriber");
    });
    e.on("marker", (m: unknown) => received.push(m));
    const marker = {
      type: "think_recorded" as const,
      source: "tool" as const,
      thought: "survive",
      ts: "2026-04-21T00:00:01.000Z",
    };
    // emit must not re-throw the subscriber error
    expect(() => e.emit("marker", marker)).not.toThrow();
    expect(received.length).toBe(1);
    expect(received[0]).toBe(marker);
  });

  it("off(fn) un-subscribes that specific listener and leaves others intact", async () => {
    const { TranscriptMarkerEmitter } = await import("../src/events/marker-emitter.js");
    const e = new TranscriptMarkerEmitter();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const listenerA = (m: unknown): void => {
      a.push(m);
    };
    const listenerB = (m: unknown): void => {
      b.push(m);
    };
    e.on("marker", listenerA);
    e.on("marker", listenerB);

    const first = {
      type: "think_recorded" as const,
      source: "tool" as const,
      thought: "first",
      ts: "2026-04-21T00:00:02.000Z",
    };
    e.emit("marker", first);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);

    e.off("marker", listenerA);

    const second = {
      type: "think_recorded" as const,
      source: "tool" as const,
      thought: "second",
      ts: "2026-04-21T00:00:03.000Z",
    };
    e.emit("marker", second);
    expect(a.length).toBe(1); // unchanged
    expect(b.length).toBe(2); // still receiving
    expect(b[1]).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Task 0.2 — Per-session registry (getTranscriptMarkerEmitter / set…)
// ---------------------------------------------------------------------------

describe("Per-session emitter registry — Task 0.2 (get/set helpers)", () => {
  it("set/get round-trips: same session → same emitter instance", async () => {
    const {
      TranscriptMarkerEmitter,
      getTranscriptMarkerEmitter,
      setTranscriptMarkerEmitter,
    } = await import("../src/events/marker-emitter.js");
    const e = new TranscriptMarkerEmitter();
    const session = { id: "session-A" } as unknown as object;
    setTranscriptMarkerEmitter(session as never, e);
    const got = getTranscriptMarkerEmitter(session as never);
    expect(got).toBe(e); // identity check — not a new instance
  });

  it("get never auto-creates: unknown session returns undefined", async () => {
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const unknownSession = { id: "never-registered" } as unknown as object;
    const got = getTranscriptMarkerEmitter(unknownSession as never);
    expect(got).toBeUndefined();
  });

  it("distinct sessions get distinct emitters (no cross-talk via module singleton)", async () => {
    const {
      TranscriptMarkerEmitter,
      getTranscriptMarkerEmitter,
      setTranscriptMarkerEmitter,
    } = await import("../src/events/marker-emitter.js");
    const e1 = new TranscriptMarkerEmitter();
    const e2 = new TranscriptMarkerEmitter();
    const s1 = { id: 1 } as unknown as object;
    const s2 = { id: 2 } as unknown as object;
    setTranscriptMarkerEmitter(s1 as never, e1);
    setTranscriptMarkerEmitter(s2 as never, e2);
    expect(getTranscriptMarkerEmitter(s1 as never)).toBe(e1);
    expect(getTranscriptMarkerEmitter(s2 as never)).toBe(e2);
    expect(getTranscriptMarkerEmitter(s1 as never)).not.toBe(e2);
  });

  it("backing store is WeakMap-shaped: a primitive key cannot be registered", async () => {
    const { TranscriptMarkerEmitter, setTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const e = new TranscriptMarkerEmitter();
    // WeakMap keys must be objects. If the registry is a plain Map, a
    // primitive key would silently succeed — we want that to throw.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setTranscriptMarkerEmitter("string-key" as any, e),
    ).toThrow();
  });

  it("mapping is per-session-object (no aliasing): two structurally-equal objects do NOT share an emitter", async () => {
    const {
      TranscriptMarkerEmitter,
      getTranscriptMarkerEmitter,
      setTranscriptMarkerEmitter,
    } = await import("../src/events/marker-emitter.js");
    const e = new TranscriptMarkerEmitter();
    const s1 = { id: "same-shape" } as unknown as object;
    const s2 = { id: "same-shape" } as unknown as object;
    setTranscriptMarkerEmitter(s1 as never, e);
    expect(getTranscriptMarkerEmitter(s1 as never)).toBe(e);
    // WeakMap keys are by reference, so a different object with the same
    // shape must NOT resolve to the same emitter — this detects a regression
    // where someone swaps the WeakMap for a plain Map keyed by JSON.
    expect(getTranscriptMarkerEmitter(s2 as never)).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Compromise (per reviewer v2): deterministically testing WeakMap
  // garbage collection in JS requires `--expose-gc` and is flaky across
  // V8 versions. Instead we enforce the contract with three observable
  // assertions (primitive-key rejection above + reference-key semantics
  // above) PLUS a source-code sentinel: the registry module must
  // literally declare a `WeakMap<...>` backing store. Combined, these
  // four tests gate every behavioural consequence of WeakMap semantics
  // without depending on GC timing.
  //
  // If the Executor swaps to a plain `Map`, either (a) the primitive-
  // key test starts passing without throwing, or (b) the reference-key
  // test returns the emitter for s2, or (c) this source check fails.
  // ─────────────────────────────────────────────────────────────────────
  it("Task 0.2 WeakMap contract: src/events/marker-emitter.ts declares a WeakMap<...>-backed registry", () => {
    const src = readFileSync(
      join(__dirname, "..", "src", "events", "marker-emitter.ts"),
      "utf8",
    );
    // The backing store MUST be a WeakMap — regex anchors on the
    // `new WeakMap` or `: WeakMap<` TS-type form. A comment mentioning
    // the word is NOT enough; both the `new` and the `<` suffix must
    // appear (matches the canonical PM-12 PlanSlugCache pattern).
    const hasNewWeakMap = /new\s+WeakMap\s*(<|\()/.test(src);
    const hasWeakMapTypeAnnotation = /:\s*WeakMap\s*</.test(src);
    expect(
      hasNewWeakMap || hasWeakMapTypeAnnotation,
      "Task 0.2 requires the registry to be backed by a WeakMap. Neither a `new WeakMap<...>()` construction nor a `: WeakMap<...>` type annotation was found in src/events/marker-emitter.ts.",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 0.4 — end-to-end: createDesignSession wires emitter + history sink
// ---------------------------------------------------------------------------

describe("createDesignSession wires TranscriptMarkerEmitter — Task 0.4", () => {
  it("session has a registered emitter reachable via getTranscriptMarkerEmitter", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const bot = await createDesignSession({ ephemeral: true });
    try {
      const emitter = getTranscriptMarkerEmitter(bot.session);
      expect(emitter).toBeDefined();
      // must be able to emit without the session having been prompted
      expect(typeof emitter!.emit).toBe("function");
    } finally {
      await bot.dispose();
    }
  });

  it("emitting one marker writes exactly one transcript_marker entry to the session's history JSONL", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const bot = await createDesignSession({ ephemeral: true });
    try {
      const emitter = getTranscriptMarkerEmitter(bot.session)!;
      expect(emitter).toBeDefined();

      const ts = "2026-04-21T00:05:00.000Z";
      const marker = {
        type: "think_recorded" as const,
        source: "tool" as const,
        thought: "Phase 0 history wiring probe",
        ts,
      };
      emitter.emit("marker", marker);

      // Give the sync/appendFileSync path a tick to settle (should be sync,
      // but this is defensive).
      await new Promise((r) => setTimeout(r, 50));

      const sessionDir = bot.history.getSessionDir();
      const transcriptPath = join(sessionDir, "transcript.jsonl");
      const entries = readJsonl(transcriptPath);
      const markerEntries = entries.filter(
        (e) => e.type === "transcript_marker",
      );
      expect(markerEntries.length).toBe(1);

      const [entry] = markerEntries;
      // Envelope shape {timestamp, type, data}
      expect(entry.type).toBe("transcript_marker");
      expect(entry.timestamp).toBe(ts); // canonical ts copied to outer timestamp
      expect(entry.data).toBeDefined();
      expect(entry.data!.type).toBe("think_recorded");
      expect(entry.data!.source).toBe("tool");
      expect(entry.data!.thought).toBe("Phase 0 history wiring probe");
      expect(entry.data!.ts).toBe(ts);
    } finally {
      await bot.dispose();
    }
  });

  it("the emitter on the session is stable (same instance across repeated get calls)", async () => {
    const { createDesignSession } = await import("../src/agent.js");
    const { getTranscriptMarkerEmitter } = await import(
      "../src/events/marker-emitter.js"
    );
    const bot = await createDesignSession({ ephemeral: true });
    try {
      const e1 = getTranscriptMarkerEmitter(bot.session);
      const e2 = getTranscriptMarkerEmitter(bot.session);
      expect(e1).toBeDefined();
      expect(e1).toBe(e2); // no per-call construction
    } finally {
      await bot.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 0.5 — VerboseTranscriptWriter is a SEPARATE direct subscriber
// ---------------------------------------------------------------------------

describe("VerboseTranscriptWriter is independent subscriber — Task 0.5", () => {
  it("when verbose=true, one emit produces one line in BOTH history AND verbose JSONL with the same envelope", async () => {
    const originalCwd = process.cwd();
    const verboseCwd = makeTmpDir("qlaybot-verbose-");
    process.chdir(verboseCwd);
    try {
      const { createDesignSession } = await import("../src/agent.js");
      const { getTranscriptMarkerEmitter } = await import(
        "../src/events/marker-emitter.js"
      );
      const bot = await createDesignSession({ ephemeral: true, verbose: true });
      try {
        const emitter = getTranscriptMarkerEmitter(bot.session)!;
        expect(emitter).toBeDefined();

        const ts = "2026-04-21T00:06:00.000Z";
        const marker = {
          type: "think_recorded" as const,
          source: "tool" as const,
          thought: "independent-subscriber probe",
          ts,
        };
        emitter.emit("marker", marker);

        // Give the VerboseTranscriptWriter's async file stream a moment to
        // drain before reading.
        await new Promise((r) => setTimeout(r, 200));

        // 1) History JSONL must contain the envelope
        const historyPath = join(
          bot.history.getSessionDir(),
          "transcript.jsonl",
        );
        const historyEntries = readJsonl(historyPath);
        const historyMarkerEntries = historyEntries.filter(
          (e) => e.type === "transcript_marker",
        );
        expect(historyMarkerEntries.length).toBe(1);

        // 2) Verbose JSONL must also contain the envelope
        const verboseDir = join(verboseCwd, "qlaybot-transcripts");
        expect(existsSync(verboseDir)).toBe(true);
        const verboseFiles = readdirSync(verboseDir).filter((f) =>
          f.endsWith(".jsonl"),
        );
        expect(verboseFiles.length).toBeGreaterThanOrEqual(1);

        const verboseAllMarkers: JsonlLine[] = [];
        for (const f of verboseFiles) {
          const entries = readJsonl(join(verboseDir, f));
          for (const e of entries) {
            if (e.type === "transcript_marker") verboseAllMarkers.push(e);
          }
        }
        expect(verboseAllMarkers.length).toBe(1);

        // 3) Envelope parity — both sinks carry {timestamp: marker.ts, type, data: marker}
        const hEntry = historyMarkerEntries[0];
        const vEntry = verboseAllMarkers[0];
        expect(hEntry.timestamp).toBe(ts);
        expect(vEntry.timestamp).toBe(ts);
        expect(hEntry.type).toBe("transcript_marker");
        expect(vEntry.type).toBe("transcript_marker");
        expect(hEntry.data).toEqual(vEntry.data); // deep-equal, not byte-identical
        expect(hEntry.data!.ts).toBe(ts);
        expect(hEntry.data!.thought).toBe("independent-subscriber probe");

        // 4) Same envelope shape across sinks (semantic byte-equality of the
        //    marker payload — Phase 0 precursor to T43(b)).
        expect(hEntry.data).toEqual(vEntry.data);

        // 5) Exactly one marker line in each sink — no duplication or drops.
        expect(historyMarkerEntries.length).toBe(verboseAllMarkers.length);
      } finally {
        await bot.dispose();
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("byte-equal: the single transcript_marker JSONL line in history is BYTE-IDENTICAL to the matching line in the verbose file (§4.7 bullet 2 — T43(b) precursor)", async () => {
    // §4.7 invariant: both sinks wrap the marker in the SAME envelope
    //   {timestamp, type, data}
    // Task 0.5 Step 1 explicitly requires "byte-equal envelope line".
    // Checking only deep-equal parse trees misses cases where field
    // order, number formatting, or envelope wrapping diverges (e.g.
    // one sink serialises `{timestamp,type,data}` while the other
    // emits `{type,timestamp,data}`). JSON.stringify is order-
    // preserving for own-enumerable keys, so a divergent field order
    // is a real regression-class bug — this test catches it.
    const originalCwd = process.cwd();
    const verboseCwd = makeTmpDir("qlaybot-byte-equal-");
    process.chdir(verboseCwd);
    try {
      const { createDesignSession } = await import("../src/agent.js");
      const { getTranscriptMarkerEmitter } = await import(
        "../src/events/marker-emitter.js"
      );
      const bot = await createDesignSession({ ephemeral: true, verbose: true });
      try {
        const emitter = getTranscriptMarkerEmitter(bot.session)!;
        expect(emitter).toBeDefined();

        const ts = "2026-04-21T00:08:00.000Z";
        const marker = {
          type: "think_recorded" as const,
          source: "tool" as const,
          thought: "byte-equality probe",
          ts,
        };
        emitter.emit("marker", marker);

        // Wait for verbose writer's async stream to drain.
        await new Promise((r) => setTimeout(r, 300));

        // Read BOTH files RAW (no JSON.parse — we're checking bytes).
        const historyPath = join(
          bot.history.getSessionDir(),
          "transcript.jsonl",
        );
        const historyRaw = readFileSync(historyPath, "utf8");

        const verboseDir = join(verboseCwd, "qlaybot-transcripts");
        expect(existsSync(verboseDir)).toBe(true);
        const verboseFiles = readdirSync(verboseDir).filter((f) =>
          f.endsWith(".jsonl"),
        );
        expect(verboseFiles.length).toBeGreaterThanOrEqual(1);

        // Find the single transcript_marker line in each file by string
        // substring — NOT by parsing, because parsing normalises field
        // order and would mask the exact regression we're trying to catch.
        const findMarkerLine = (raw: string): string => {
          const lines = raw
            .split("\n")
            .filter((l) => l.trim().length > 0 && l.includes('"transcript_marker"'));
          expect(
            lines.length,
            "expected exactly one transcript_marker line per file",
          ).toBe(1);
          return lines[0];
        };
        const historyLine = findMarkerLine(historyRaw);
        let verboseLine: string | null = null;
        for (const f of verboseFiles) {
          const raw = readFileSync(join(verboseDir, f), "utf8");
          if (raw.includes('"transcript_marker"')) {
            verboseLine = findMarkerLine(raw);
            break;
          }
        }
        expect(verboseLine).not.toBeNull();

        // BYTE-EQUAL: the two raw JSONL lines must be identical character
        // for character, including field order. This is stronger than
        // `deep-equal after parse` and catches divergent envelope shapes.
        // §4.7: "same envelope across both sinks".
        expect(verboseLine).toBe(historyLine);

        // Also confirm the byte counts match (defensive — a trailing
        // whitespace difference would fail the toBe above but this gives
        // a clearer failure message).
        expect(Buffer.byteLength(verboseLine!, "utf8")).toBe(
          Buffer.byteLength(historyLine, "utf8"),
        );
      } finally {
        await bot.dispose();
      }
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("verbose writer receives markers independently of the history mirror tap (subscribes to emitter directly)", async () => {
    // The plan (Task 0.5 Step 3) requires VerboseTranscriptWriter to subscribe
    // DIRECTLY to the emitter, NOT mirrored via history.setMirror. Probe this
    // by clearing the history mirror tap right after session construction.
    // The verbose writer must still receive the next emitted marker.
    const originalCwd = process.cwd();
    const verboseCwd = makeTmpDir("qlaybot-verbose-indep-");
    process.chdir(verboseCwd);
    try {
      const { createDesignSession } = await import("../src/agent.js");
      const { getTranscriptMarkerEmitter } = await import(
        "../src/events/marker-emitter.js"
      );
      const bot = await createDesignSession({ ephemeral: true, verbose: true });
      try {
        // Disable the history mirror tap (tests independence). Any test that
        // depended on the mirror-based coupling will fail here — which is
        // exactly what Task 0.5 is forcing the Executor to fix.
        bot.history.setMirror(null);

        const emitter = getTranscriptMarkerEmitter(bot.session)!;
        const ts = "2026-04-21T00:07:00.000Z";
        const marker = {
          type: "think_recorded" as const,
          source: "tool" as const,
          thought: "direct-subscription probe",
          ts,
        };
        emitter.emit("marker", marker);

        await new Promise((r) => setTimeout(r, 200));

        const verboseDir = join(verboseCwd, "qlaybot-transcripts");
        expect(existsSync(verboseDir)).toBe(true);
        const verboseFiles = readdirSync(verboseDir).filter((f) =>
          f.endsWith(".jsonl"),
        );
        expect(verboseFiles.length).toBeGreaterThanOrEqual(1);

        let found = false;
        for (const f of verboseFiles) {
          const entries = readJsonl(join(verboseDir, f));
          for (const e of entries) {
            if (
              e.type === "transcript_marker" &&
              e.data?.thought === "direct-subscription probe"
            ) {
              found = true;
              expect(e.timestamp).toBe(ts);
              expect(e.data?.ts).toBe(ts);
              break;
            }
          }
          if (found) break;
        }
        expect(found).toBe(true);
      } finally {
        await bot.dispose();
      }
    } finally {
      process.chdir(originalCwd);
    }
  });
});
