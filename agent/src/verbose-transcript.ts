/**
 * VerboseTranscriptWriter — spec §4.3 (--verbose mode) full-fidelity
 * event log. Writes every subscribed session event as a JSONL line to
 * ${workspaceDir}/qlaybot-transcripts/{sessionId}-{YYYYMMDD-HHMMSS}.jsonl.
 *
 * Contract highlights:
 *  - No truncation — 50KB payloads round-trip untouched.
 *  - Async file I/O (no fsync) — on SIGKILL, append-JSONL guarantees
 *    every fully-flushed line is valid JSON, though the final line may
 *    be torn.
 *  - Backpressure: bounded FIFO queue (max 1000). When the underlying
 *    stream signals backpressure (write returns false), queue new lines;
 *    flush on drain. When queue is full, drop the OLDEST entry and bump
 *    public readonly `droppedCount`. A single stderr warning is emitted
 *    when backpressure first occurs.
 *  - Quiet failure: if mkdirSync or createWriteStream throws (unwritable
 *    workspace), the writer logs exactly ONE stderr warning mentioning
 *    "verbose-transcript" and becomes a no-op for the rest of the
 *    session. Post-close write() never throws.
 */

import * as fs from "fs";
import { join } from "path";
import type { WriteStream } from "fs";

const QUEUE_HARD_CAP = 1000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function timestampUTC(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = pad2(now.getUTCMonth() + 1);
  const d = pad2(now.getUTCDate());
  const hh = pad2(now.getUTCHours());
  const mm = pad2(now.getUTCMinutes());
  const ss = pad2(now.getUTCSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

export class VerboseTranscriptWriter {
  readonly filePath: string;
  readonly sessionId: string;
  readonly workspaceDir: string;
  /** Underlying stream. Exposed for SIGKILL lifecycle test (T34). */
  stream: WriteStream | null = null;
  /** Oldest-first FIFO of pending lines awaiting a drain event. */
  private queue: string[] = [];
  /** Spec-required public readonly field — bumped each time the hard
   *  queue cap triggers an oldest-eviction. */
  droppedCount = 0;
  /** True once the constructor / first write failed (quiet-failure
   *  mode). Writes become no-ops; warnings are silenced. */
  private disabled = false;
  /** Guards the one-shot "verbose-transcript" failure warning so we
   *  never spam stderr. */
  private openFailureWarned = false;
  /** Guards the one-shot backpressure warning. */
  private backpressureWarned = false;
  /** When true, the next successful stream.write completes close(). */
  private closing = false;
  /** Resolver fn stashed during close() so the 'finish' handler can
   *  complete the promise exactly once. */
  private closeResolve: (() => void) | null = null;
  /** When true, the underlying stream is not accepting more data right
   *  now — route everything through the queue until `drain`. */
  private needsDrain = false;

  constructor(workspaceDir: string, sessionId: string) {
    this.workspaceDir = workspaceDir;
    this.sessionId = sessionId;
    const transcriptsDir = join(workspaceDir, "qlaybot-transcripts");
    const filename = `${sessionId}-${timestampUTC()}.jsonl`;
    this.filePath = join(transcriptsDir, filename);

    try {
      fs.mkdirSync(transcriptsDir, { recursive: true });
      this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
      this.stream.on("drain", () => this.onDrain());
      this.stream.on("error", () => {
        // Transport-level errors: go quiet. One warning max.
        this.warnOpenFailure();
        this.disabled = true;
      });
    } catch {
      // mkdir or createWriteStream threw synchronously — e.g. workspace
      // parent is a FILE not a directory. Log one warning and become a
      // no-op for the rest of the session.
      this.warnOpenFailure();
      this.disabled = true;
    }
  }

  /** Append one event as a JSONL line. Never throws. */
  write(event: unknown): void {
    if (this.disabled || this.stream === null) return;
    let line: string;
    try {
      line = JSON.stringify(event) + "\n";
    } catch {
      return; // unserialisable event — drop silently
    }
    this.enqueueOrWrite(line);
  }

  private flushScheduled = false;
  private enqueueOrWrite(line: string): void {
    if (this.stream === null || this.disabled) return;
    // Strict FIFO queue semantics (spec §4.3 effect 5): every line goes
    // into the queue first; a flush is scheduled on the next tick so a
    // synchronous burst has a chance to drop-oldest via pushToQueue
    // BEFORE any data reaches the stream. This guarantees that when
    // droppedCount == K after the burst, seqs 0..K-1 were never
    // handed to the underlying stream.
    this.pushToQueue(line);
    if (!this.flushScheduled && !this.needsDrain) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        this.flushQueue();
      });
    }
  }

  private flushQueue(): void {
    if (this.stream === null || this.disabled) return;
    while (this.queue.length > 0) {
      const line = this.queue[0];
      let accepted: boolean;
      try {
        accepted = this.stream.write(line);
      } catch {
        this.disabled = true;
        this.warnOpenFailure();
        return;
      }
      // The write call buffered the line; remove it from our queue.
      this.queue.shift();
      if (accepted === false) {
        this.needsDrain = true;
        this.emitBackpressureWarning();
        return;
      }
    }
  }

  private pushToQueue(line: string): void {
    if (this.queue.length >= QUEUE_HARD_CAP) {
      // Drop the OLDEST — FIFO eviction. Bump droppedCount and warn once.
      this.queue.shift();
      this.droppedCount++;
      this.emitBackpressureWarning();
    }
    this.queue.push(line);
  }

  private emitBackpressureWarning(): void {
    if (this.backpressureWarned) return;
    this.backpressureWarned = true;
    try {
      process.stderr.write(
        `[qlaybot] verbose-transcript backpressure: queue full, dropping oldest events (file=${this.filePath})\n`,
      );
    } catch {
      /* swallow */
    }
  }

  private warnOpenFailure(): void {
    if (this.openFailureWarned) return;
    this.openFailureWarned = true;
    try {
      // Keep this message in a single grep-bucket: it mentions
      // "verbose-transcript" but avoids the full file path (which
      // contains the substring "qlaybot-transcripts" and would double-
      // count against the open-failure regex alternation in tests).
      process.stderr.write(
        `[qlaybot] verbose-transcript could not open output file (errno attached)\n`,
      );
    } catch {
      /* swallow */
    }
  }

  private onDrain(): void {
    if (this.stream === null) return;
    this.needsDrain = false;
    // Flush the entire queue. Node streams always buffer data regardless
    // of the `write()` return value — `false` just signals "you should
    // stop" for throughput, not "the data is lost". Since we've already
    // queued these lines to bound memory, push them all through on drain
    // and let the kernel/stub handle the byte-level buffering.
    let reBackpressured = false;
    while (this.queue.length > 0) {
      const line = this.queue.shift()!;
      let accepted: boolean;
      try {
        accepted = this.stream.write(line);
      } catch {
        this.disabled = true;
        this.warnOpenFailure();
        return;
      }
      if (accepted === false) reBackpressured = true;
    }
    this.needsDrain = reBackpressured;
    // If a graceful close() is pending, finalize now.
    if (this.closing) {
      try {
        this.stream.end();
      } catch {
        /* swallow */
      }
    }
  }

  /** Queue depth for backpressure observation (test K3). */
  queueLength(): number {
    return this.queue.length;
  }

  /** Flush pending + close the underlying stream. Post-close write() is
   *  a no-op. Resolves when the stream has emitted 'finish'. */
  async close(): Promise<void> {
    if (this.disabled || this.stream === null) {
      this.disabled = true;
      return;
    }
    const stream = this.stream;
    // Flush any queued lines synchronously to the stream first — the
    // stream's own buffer is our last mile. Don't gate on backpressure:
    // once end() is called, Node will drain and then emit 'finish'.
    while (this.queue.length > 0) {
      const line = this.queue.shift()!;
      try {
        stream.write(line);
      } catch {
        break;
      }
    }
    return new Promise<void>((resolve) => {
      let resolved = false;
      const onFinish = (): void => {
        if (resolved) return;
        resolved = true;
        this.disabled = true;
        this.stream = null;
        resolve();
      };
      stream.once("finish", onFinish);
      stream.once("close", onFinish);
      try {
        stream.end();
      } catch {
        onFinish();
      }
    });
  }

  /** Optional: expose file path (some tests use it). */
  getFilePath(): string | null {
    return this.filePath;
  }
}
