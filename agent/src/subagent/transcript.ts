/**
 * Transcript logger — writes markdown-format transcripts for subagent runs.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";

interface LogEntry {
  type: "thinking" | "text" | "tool_call" | "tool_result";
  content: string;
  extra?: string;
}

/**
 * Logs subagent activity and saves as a markdown transcript file.
 * Supports log rotation via maxFiles parameter.
 */
export class TranscriptLogger {
  private entries: LogEntry[] = [];
  private logDir: string;
  private role: string;
  private task: string;
  private maxFiles: number;

  constructor(logDir: string, role: string, task: string, maxFiles: number = 100) {
    this.logDir = logDir;
    this.role = role;
    this.task = task;
    this.maxFiles = maxFiles;
  }

  logThinking(text: string): void {
    this.entries.push({ type: "thinking", content: text });
  }

  logText(text: string): void {
    this.entries.push({ type: "text", content: text });
  }

  logToolCall(name: string, args: string): void {
    this.entries.push({ type: "tool_call", content: name, extra: args });
  }

  logToolResult(name: string, result: string): void {
    this.entries.push({ type: "tool_result", content: name, extra: result });
  }

  /**
   * Save the transcript to a markdown file. Returns the file path.
   * Performs log rotation if the number of files exceeds maxFiles.
   */
  save(): string {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }

    // Build markdown content
    const lines: string[] = [];
    lines.push(`# Subagent Transcript`);
    lines.push(`- **Role**: ${this.role}`);
    lines.push(`- **Task**: ${this.task}`);
    lines.push(`- **Timestamp**: ${new Date().toISOString()}`);
    lines.push("");

    for (const entry of this.entries) {
      switch (entry.type) {
        case "thinking":
          lines.push(`### Thinking`);
          lines.push(entry.content);
          lines.push("");
          break;
        case "text":
          lines.push(entry.content);
          lines.push("");
          break;
        case "tool_call":
          lines.push(`### Tool Call: ${entry.content}`);
          lines.push("```json");
          lines.push(entry.extra ?? "{}");
          lines.push("```");
          lines.push("");
          break;
        case "tool_result":
          lines.push(`### Tool Result: ${entry.content}`);
          lines.push(entry.extra ?? "");
          lines.push("");
          break;
      }
    }

    const sanitizedTask = this.task.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const timestamp = Date.now();
    const filename = `${this.role}-${sanitizedTask}-${timestamp}.md`;
    const filepath = join(this.logDir, filename);

    writeFileSync(filepath, lines.join("\n"), "utf-8");

    // Log rotation
    this.rotateOldLogs();

    return filepath;
  }

  private rotateOldLogs(): void {
    try {
      const files = readdirSync(this.logDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({
          name: f,
          mtime: statSync(join(this.logDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime); // newest first

      // Remove excess files (keep only maxFiles)
      while (files.length > this.maxFiles) {
        const oldest = files.pop()!;
        try {
          unlinkSync(join(this.logDir, oldest.name));
        } catch {
          // ignore deletion errors
        }
      }
    } catch {
      // ignore rotation errors
    }
  }
}
