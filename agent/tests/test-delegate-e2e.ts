/**
 * E2E test for the redesigned delegate tool (issue #23).
 *
 * Exercises the full path that was silently broken: parent agent → delegate
 * tool → general-purpose subagent → submit_result. Before the fix, this call
 * returned `{ status: "error", errorMessage: "Cannot read properties of
 * undefined (reading 'startsWith')" }` (ml14 transcript, session
 * session_1776928889652-20260423-072129).
 *
 * Auto-skips when ANTHROPIC_API_KEY or built dist/cli.js is missing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "child_process";
import { createInterface, Interface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "..", "dist", "cli.js");

function canRunE2E(): boolean {
  if (process.env.QLAYBOT_E2E === "0") return false;
  if (!process.env.ANTHROPIC_API_KEY) return false;
  if (!existsSync(CLI_PATH)) return false;
  return true;
}

const E2E_ENABLED = canRunE2E();
if (!E2E_ENABLED) {
  const reasons: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) reasons.push("ANTHROPIC_API_KEY not set");
  if (!existsSync(CLI_PATH)) reasons.push("dist/cli.js not built");
  if (process.env.QLAYBOT_E2E === "0") reasons.push("QLAYBOT_E2E=0");
  console.log(`delegate-e2e skipped: ${reasons.join(", ")}`);
}

const describeE2E = E2E_ENABLED ? describe : describe.skip;

interface RPCClient {
  proc: ChildProcess;
  rl: Interface;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
}

async function createRPCClient(): Promise<RPCClient> {
  const proc = spawn("node", [CLI_PATH, "--mode", "rpc"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  const rl = createInterface({ input: proc.stdout!, terminal: false });
  let requestId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  rl.on("line", (line: string) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    } catch { /* non-JSON line */ }
  });

  await new Promise<void>((resolve) => {
    const waitForReady = (line: string) => {
      try {
        if (JSON.parse(line).method === "ready") resolve();
      } catch { /* */ }
    };
    rl.on("line", waitForReady);
    setTimeout(resolve, 5000);
  });

  function send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 420000);
    });
  }

  async function close(): Promise<void> {
    try { await send("shutdown"); } catch { /* */ }
    proc.kill();
    rl.close();
  }

  return { proc, rl, send, close };
}

describeE2E("delegate tool E2E (issue #23)", () => {
  let client: RPCClient;
  beforeAll(async () => {
    client = await createRPCClient();
    await client.send("initialize", { ephemeral: true });
  });
  afterAll(async () => { await client.close(); });

  it("delegates a trivial research task to general-purpose and returns findings", async () => {
    // Ask the parent agent to delegate a 1-step task. The subagent should
    // read a file via the inherited tools and submit_result with the content.
    // Pre-fix, this returned { status: "error", errorMessage: "...startsWith" }
    // from the runner's session.prompt() no-args crash.
    const result = await client.send("prompt", {
      message:
        "Use the delegate tool with subagent_type 'general-purpose' to read the first line of the agent's package.json and report it back. Brief the subagent clearly — include the absolute path.",
    }) as Record<string, unknown>;

    expect(result.status).toBe("completed");
    const response = (result.response as string ?? "").toLowerCase();
    expect(response.length).toBeGreaterThan(0);
    // The response should NOT contain the symptom that broke ml14.
    expect(response).not.toContain("startswith");
    expect(response).not.toContain("cannot read properties");
  }, 300000);
});
