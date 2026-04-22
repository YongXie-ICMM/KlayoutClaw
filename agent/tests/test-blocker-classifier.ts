/**
 * Task 2.15 — Blocker Classifier tests (§4.5 normative classification table).
 *
 * These tests pin down the PUBLIC shape the Executor must implement:
 *
 *   import { classifyToolResult } from "../src/planning/blocker-classifier.js";
 *   classifyToolResult(
 *     toolName: string,
 *     result: AgentToolResult,
 *   ): "recoverable" | "unrecoverable" | "not-in-scope"
 *
 * where `AgentToolResult` is the MCP envelope:
 *   { content: [{ type: "text", text: <string> }], isError?: boolean, details?: {...} }
 *
 * Coverage matrix:
 *   - Every row of §4.5 classifier table for the 4 in-scope tools.
 *   - Out-of-scope tools (vc_*, get_layout_info, unknown) → "not-in-scope".
 *   - Edge cases for malformed payloads.
 *
 * Design decisions (documented here — Executor must follow):
 *   (a) Malformed JSON in content[0].text for an in-scope tool (success envelope,
 *       no isError) → "unrecoverable". Rationale: a plan-invalidating tool whose
 *       output cannot be parsed is treated as a failure; we'd rather replan than
 *       silently succeed. The alternative ("recoverable, let the agent cope") was
 *       rejected because the agent can't inspect a payload it never receives
 *       parsed.
 *   (b) Empty content array for an in-scope tool → "unrecoverable". Same rationale
 *       as (a) — no signal is worse than a clear failure signal.
 *   (c) auto_route payload with status:"partial" and an empty errors array →
 *       "recoverable". Rationale: the spec row says "partial with any non-auto-map
 *       error entry" is unrecoverable — the absence of any error entries fails
 *       that predicate, so it's recoverable.
 *   (d) evaluate_design boundary at overall == 0.30 → "recoverable" (spec text:
 *       "overall >= 0.30" is recoverable; only "< 0.30" is unrecoverable).
 */

import { describe, expect, it } from "vitest";

/** MCP envelope shape matching the AgentToolResult the harness actually sees. */
interface ToolResultEnvelope {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

function envelope(text: string, opts: { isError?: boolean } = {}): ToolResultEnvelope {
  return {
    content: [{ type: "text", text }],
    ...(opts.isError !== undefined ? { isError: opts.isError } : {}),
  };
}

function payloadEnvelope(payload: unknown, opts: { isError?: boolean } = {}): ToolResultEnvelope {
  return envelope(JSON.stringify(payload), opts);
}

const IN_SCOPE_TOOLS = [
  "klayout_native_auto_route",
  "klayout_native_evaluate_design",
  "klayout_native_execute_script",
  "klayout_native_save_layout",
] as const;

describe("blocker-classifier — §4.5 isError traceback rows", () => {
  it("classifies isError:true with traceback text as unrecoverable for every in-scope tool", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const traceback =
      "Tool 'auto_route' failed: RuntimeError\nTraceback (most recent call last):\n  File \"...\", line 12, in handler\n    raise RuntimeError('bad')";

    for (const tool of IN_SCOPE_TOOLS) {
      const result = envelope(traceback, { isError: true });
      expect(classifyToolResult(tool, result)).toBe("unrecoverable");
    }
  });

  it("classifies isError:true with 'Server busy:' text as recoverable for every in-scope tool", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const busyText = "Server busy: another tool call is already running";

    for (const tool of IN_SCOPE_TOOLS) {
      const result = envelope(busyText, { isError: true });
      expect(classifyToolResult(tool, result)).toBe("recoverable");
    }
  });

  it("treats 'Server busy:' prefix match (not substring-anywhere) as recoverable", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    // Spec pattern `/Server busy:/` — a plain match anywhere in the text is OK,
    // but the canonical form is the prefix emitted by klayoutclaw_server.lym:1673-1682.
    const result = envelope("Server busy: other handler holding the lock", {
      isError: true,
    });
    expect(classifyToolResult("klayout_native_execute_script", result)).toBe(
      "recoverable",
    );
  });
});

describe("blocker-classifier — auto_route payload rows", () => {
  it("status:'failed' → unrecoverable", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({
      status: "failed",
      routed_pairs: 0,
      errors: ["routing path blocked"],
    });
    expect(classifyToolResult("klayout_native_auto_route", result)).toBe(
      "unrecoverable",
    );
  });

  it("status:'partial' with only auto_map_resolution notes → recoverable", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({
      status: "partial",
      routed_pairs: 3,
      errors: [
        "auto_map_resolution: derived 0.4 um from smallest pin bbox",
        "auto_map_resolution: second informational note",
      ],
    });
    expect(classifyToolResult("klayout_native_auto_route", result)).toBe(
      "recoverable",
    );
  });

  it("status:'partial' with at least one non-auto_map_resolution error → unrecoverable", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({
      status: "partial",
      routed_pairs: 2,
      errors: [
        "routing path blocked for pair [1, 3]",
        "auto_map_resolution: derived 0.4 um from smallest pin bbox",
      ],
    });
    expect(classifyToolResult("klayout_native_auto_route", result)).toBe(
      "unrecoverable",
    );
  });

  it("status:'partial' with an empty errors array → recoverable", async () => {
    // Design decision (c): no error entries means the 'any non-auto-map entry'
    // predicate cannot fire, so we fall to the recoverable branch.
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({
      status: "partial",
      routed_pairs: 5,
      errors: [],
    });
    expect(classifyToolResult("klayout_native_auto_route", result)).toBe(
      "recoverable",
    );
  });

  it("status:'success' → recoverable", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({
      status: "success",
      routed_pairs: 4,
    });
    expect(classifyToolResult("klayout_native_auto_route", result)).toBe(
      "recoverable",
    );
  });

  it("status:'dry_run' → recoverable (preview, not a failure signal)", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({
      status: "dry_run",
      routed_pairs: 0,
      pairs: [[0, 1, 12.3]],
    });
    expect(classifyToolResult("klayout_native_auto_route", result)).toBe(
      "recoverable",
    );
  });
});

describe("blocker-classifier — evaluate_design payload rows", () => {
  it("overall < 0.30 → unrecoverable (below threshold)", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({ overall: 0.15, scores: {} });
    expect(classifyToolResult("klayout_native_evaluate_design", result)).toBe(
      "unrecoverable",
    );
  });

  it("overall == 0.30 → recoverable (boundary — spec text: '>= 0.30')", async () => {
    // Design decision (d): 0.30 is the inclusive lower boundary of the recoverable
    // band. Anything strictly < 0.30 is unrecoverable.
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({ overall: 0.3, scores: {} });
    expect(classifyToolResult("klayout_native_evaluate_design", result)).toBe(
      "recoverable",
    );
  });

  it("overall well above threshold (0.80) → recoverable", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({
      overall: 0.8,
      scores: {},
      next_step_suggestion: "Re-read the task instruction...",
    });
    expect(classifyToolResult("klayout_native_evaluate_design", result)).toBe(
      "recoverable",
    );
  });
});

describe("blocker-classifier — out-of-scope tools (spec §4.5, 'Tools outside the classifier table')", () => {
  it("klayout_native_get_layout_info with isError:true → not-in-scope", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = envelope("Tool 'get_layout_info' failed: boom", {
      isError: true,
    });
    expect(classifyToolResult("klayout_native_get_layout_info", result)).toBe(
      "not-in-scope",
    );
  });

  it("klayout_native_vc_checkpoint with error payload → not-in-scope", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({ status: "error", error: "tag collision" });
    expect(classifyToolResult("klayout_native_vc_checkpoint", result)).toBe(
      "not-in-scope",
    );
  });

  it("unknown tool name → not-in-scope", async () => {
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = envelope("irrelevant", { isError: true });
    expect(classifyToolResult("definitely_not_a_real_tool", result)).toBe(
      "not-in-scope",
    );
    expect(classifyToolResult("klayout_geometry_add_rect", result)).toBe(
      "not-in-scope",
    );
  });
});

describe("blocker-classifier — edge cases", () => {
  it("malformed JSON in content[0].text for an in-scope tool → unrecoverable", async () => {
    // Design decision (a): unparseable payload from a plan-invalidating tool is
    // conservatively classified as unrecoverable.
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = envelope("this is not { valid json ::: at all");
    expect(classifyToolResult("klayout_native_auto_route", result)).toBe(
      "unrecoverable",
    );
  });

  it("empty content array for an in-scope tool → unrecoverable", async () => {
    // Design decision (b): no content is no signal — conservative unrecoverable.
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result: ToolResultEnvelope = { content: [] };
    expect(classifyToolResult("klayout_native_evaluate_design", result)).toBe(
      "unrecoverable",
    );
  });

  it("evaluate_design payload without an `overall` field → unrecoverable", async () => {
    // Defensive row: the classifier is inspecting `payload.overall`; absence of
    // the expected shape cannot be treated as recoverable silence.
    const { classifyToolResult } = await import(
      "../src/planning/blocker-classifier.js"
    );
    const result = payloadEnvelope({ scores: {} }); // no overall key
    expect(classifyToolResult("klayout_native_evaluate_design", result)).toBe(
      "unrecoverable",
    );
  });
});
