/**
 * Interaction history auto-save.
 * Persists all interactions to ~/.qlaybot/history/YYYY-MM-DD/ for debugging and replay.
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync, symlinkSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  DEFAULT_TRANSCRIPT_TRUNCATION,
  truncate,
  type TruncationOptions,
} from "./truncation.js";

const HISTORY_DIR = join(homedir(), ".qlaybot", "history");

export interface HistoryEntry {
  timestamp: string;
  type:
    | "user_prompt"
    | "agent_response"
    | "agent_thinking"
    | "tool_call"
    | "tool_result"
    | "error"
    // v0.4.4 §4.7 Persistence bullet 1 — transcript markers emitted through
    // TranscriptMarkerEmitter land in the same history.jsonl stream wrapped
    // in the canonical {timestamp, type, data} envelope. Outer `timestamp`
    // copies the marker's canonical `ts` verbatim (§4.7 canonical timestamp).
    | "transcript_marker";
  data: unknown;
}

export class InteractionHistory {
  private sessionDir: string;
  private sessionId: string;
  private toolCallCounter = 0;
  private truncationOpts: TruncationOptions;
  /** Optional tap that receives every entry appended to transcript.jsonl.
   *  Used by the --verbose writer to produce a workspace-local transcript
   *  that is line-for-line identical to ~/.qlaybot/history/…/transcript.jsonl. */
  private mirror: ((entry: HistoryEntry) => void) | null = null;

  constructor(
    sessionId?: string,
    configSnapshot?: Record<string, unknown>,
    truncationOpts?: TruncationOptions | null,
  ) {
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    this.truncationOpts =
      truncationOpts == null ? DEFAULT_TRANSCRIPT_TRUNCATION : truncationOpts;
    const dateDir = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    this.sessionDir = join(HISTORY_DIR, dateDir, this.sessionId);
    this.ensureDirs();
    this.saveMetadata(configSnapshot);
    this.updateLatestSymlink();
  }

  /** Attach a tap that receives every appended HistoryEntry. Used by the
   *  verbose writer so the workspace-local transcript matches the on-disk
   *  history transcript exactly. */
  setMirror(mirror: ((entry: HistoryEntry) => void) | null): void {
    this.mirror = mirror;
  }

  private ensureDirs(): void {
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(join(this.sessionDir, "tool_calls"), { recursive: true });
  }

  private saveMetadata(configSnapshot?: Record<string, unknown>): void {
    const metadata = {
      sessionId: this.sessionId,
      startTime: new Date().toISOString(),
      pid: process.pid,
      ...(configSnapshot ? { config: configSnapshot } : {}),
    };
    writeFileSync(
      join(this.sessionDir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );
  }

  private updateLatestSymlink(): void {
    const latestPath = join(HISTORY_DIR, "latest");
    try {
      if (existsSync(latestPath)) {
        unlinkSync(latestPath);
      }
      symlinkSync(this.sessionDir, latestPath);
    } catch {
      // Symlink may fail on some systems
    }
  }

  /**
   * Append an entry to the transcript JSONL file.
   */
  appendTranscript(entry: HistoryEntry): void {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(join(this.sessionDir, "transcript.jsonl"), line);
    if (this.mirror) {
      try {
        this.mirror(entry);
      } catch {
        /* mirror is best-effort — don't let it break history writes */
      }
    }
  }

  /**
   * Record a user prompt.
   */
  recordPrompt(message: string): void {
    this.appendTranscript({
      timestamp: new Date().toISOString(),
      type: "user_prompt",
      data: { message },
    });
  }

  /**
   * Record an agent response.
   */
  recordResponse(text: string): void {
    this.appendTranscript({
      timestamp: new Date().toISOString(),
      type: "agent_response",
      data: { text },
    });
  }

  /**
   * Record agent thinking / chain-of-thought.
   */
  recordThinking(text: string): void {
    this.appendTranscript({
      timestamp: new Date().toISOString(),
      type: "agent_thinking",
      data: { text },
    });
  }

  /**
   * Record a tool call.
   *
   * The `result` field is serialized (string passthrough; otherwise
   * JSON.stringify with 2-space indent) and run through the configured
   * truncation. When truncation actually fires, `truncated: true` and
   * `original_length: number` metadata fields are appended so consumers can
   * detect truncation. Args are NEVER truncated. The same toolLog is written
   * to BOTH transcript.jsonl AND the per-tool JSON file (single source of
   * truth — the full result is not preserved on disk unless verbose-bypass
   * opts {threshold: Infinity, ...} were passed to the constructor).
   */
  recordToolCall(toolName: string, args: unknown, result: unknown, durationMs: number): void {
    this.toolCallCounter++;
    const padded = String(this.toolCallCounter).padStart(3, "0");

    const serialized =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    const original_length = serialized.length;
    const truncated = truncate(serialized, this.truncationOpts);

    const toolLog: Record<string, unknown> = {
      toolName,
      args,
      result: truncated,
      durationMs,
      timestamp: new Date().toISOString(),
    };
    if (serialized.length > this.truncationOpts.threshold) {
      toolLog.truncated = true;
      toolLog.original_length = original_length;
    }

    // Write individual tool call log
    writeFileSync(
      join(this.sessionDir, "tool_calls", `${padded}_${toolName}.json`),
      JSON.stringify(toolLog, null, 2),
    );

    // Also append to transcript
    this.appendTranscript({
      timestamp: new Date().toISOString(),
      type: "tool_call",
      data: toolLog,
    });
  }

  /**
   * Record an error.
   */
  recordError(error: string): void {
    this.appendTranscript({
      timestamp: new Date().toISOString(),
      type: "error",
      data: { error },
    });
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
