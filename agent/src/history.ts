/**
 * Interaction history auto-save.
 * Persists all interactions to ~/.qlaybot/history/YYYY-MM-DD/ for debugging and replay.
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync, symlinkSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HISTORY_DIR = join(homedir(), ".qlaybot", "history");

export interface HistoryEntry {
  timestamp: string;
  type: "user_prompt" | "agent_response" | "agent_thinking" | "tool_call" | "tool_result" | "error";
  data: unknown;
}

export class InteractionHistory {
  private sessionDir: string;
  private sessionId: string;
  private toolCallCounter = 0;

  constructor(sessionId?: string, configSnapshot?: Record<string, unknown>) {
    this.sessionId = sessionId ?? `session_${Date.now()}`;
    const dateDir = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    this.sessionDir = join(HISTORY_DIR, dateDir, this.sessionId);
    this.ensureDirs();
    this.saveMetadata(configSnapshot);
    this.updateLatestSymlink();
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
   */
  recordToolCall(toolName: string, args: unknown, result: unknown, durationMs: number): void {
    this.toolCallCounter++;
    const padded = String(this.toolCallCounter).padStart(3, "0");
    const toolLog = {
      toolName,
      args,
      result,
      durationMs,
      timestamp: new Date().toISOString(),
    };

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
