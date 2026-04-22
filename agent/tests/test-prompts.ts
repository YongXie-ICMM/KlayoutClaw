/**
 * Task 1.4 / T44 — system prompt §3.4 thinking guidance snapshot test.
 *
 * Source of truth:
 *  - docs/superpowers/specs/2026-04-19-qlaybot-0.4.4-design.md §3.4
 *    (lines 171-181) — 6 bullets of guidance.
 *  - docs/superpowers/plans/2026-04-21-qlaybot-0.4.4.md Task 1.4, T44.
 *
 * These are RED tests until the Executor lands Task 1.4 Step 3
 * (prompt-guidance block added to agent/src/prompts/).
 *
 * Interpretation choice (documented per overseer instruction):
 *  - The §3.4 guidance appears in BOTH PromptMode.Full and PromptMode.Sub.
 *    Rationale: subagents also call `thinking` and benefit from the same
 *    advisory text; there is no spec line restricting it to Full. The plan
 *    Task 1.4 Step 3 does not gate on mode. If the Executor interprets the
 *    spec narrowly and limits guidance to Full-mode, the Sub-mode assertion
 *    below fails and the review loop catches it.
 *  - If the team decides guidance should be Full-only, weaken the Sub-mode
 *    assertion to `.toEqual(expect.any(String))`-style in a follow-up.
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, PromptMode } from "../src/prompts/index.js";

// The full list of tool names that a v0.4.4 session exposes — include
// `thinking` so the tooling section renders it, plus the destructive MCP
// tools the §3.4 guidance names explicitly so the prompt has the context
// the spec-required bullets reference.
const TOOL_NAMES_WITH_THINKING = [
  "read",
  "bash",
  "edit",
  "write",
  "memory_save",
  "memory_search",
  "thinking",
  "klayout_native_save_layout",
  "klayout_native_auto_route",
  "klayout_native_execute_script",
  "klayout_native_vc_checkpoint",
  "klayout_native_vc_checkout",
];

function buildFull(): string {
  return buildSystemPrompt({
    mode: PromptMode.Full,
    workspaceDir: `${process.cwd()}/workspace`,
    toolNames: TOOL_NAMES_WITH_THINKING,
    connectedServers: ["klayout"],
  });
}

function buildSub(): string {
  return buildSystemPrompt({
    mode: PromptMode.Sub,
    workspaceDir: `${process.cwd()}/workspace`,
    toolNames: TOOL_NAMES_WITH_THINKING,
    connectedServers: ["klayout"],
  });
}

describe("Task 1.4 / T44 — §3.4 thinking prompt guidance (Full mode)", () => {
  it("mentions the tool name 'thinking' (no prefix)", () => {
    const prompt = buildFull();
    expect(prompt).toContain("thinking");
  });

  it("contains a positive clause: 'destructive' AND ('ambiguity' OR 'choosing between approaches')", () => {
    const prompt = buildFull();
    expect(prompt).toContain("destructive");
    const hasAmbiguity = prompt.includes("ambiguity");
    const hasChoosing = prompt.includes("choosing between approaches");
    expect(
      hasAmbiguity || hasChoosing,
      "§3.4 bullet 2 requires one of 'ambiguity' or 'choosing between approaches' — neither found in the assembled prompt",
    ).toBe(true);
  });

  it("contains a negative clause: 'trivial' OR 'not required'", () => {
    const prompt = buildFull();
    const hasTrivial = prompt.includes("trivial");
    const hasNotRequired = prompt.includes("not required");
    expect(
      hasTrivial || hasNotRequired,
      "§3.4 bullet 3 requires a 'do not call for trivial…' style negative clause — neither 'trivial' nor 'not required' found",
    ).toBe(true);
  });

  it("names the 5 destructive MCP tools from §3.4 bullet 1", () => {
    const prompt = buildFull();
    // Every MCP tool name listed in §3.4 bullet 1 must appear verbatim —
    // so the agent can string-match the call site to the guidance.
    expect(prompt).toContain("klayout_native_save_layout");
    expect(prompt).toContain("klayout_native_auto_route");
    expect(prompt).toContain("klayout_native_execute_script");
    expect(prompt).toContain("klayout_native_vc_checkpoint");
    expect(prompt).toContain("klayout_native_vc_checkout");
  });

  it("contains the exact phrase 'One thought per call' (§3.4 bullet 4)", () => {
    const prompt = buildFull();
    expect(prompt).toContain("One thought per call");
  });

  it("contains the exact phrase 'Do not paste raw tool output' (§3.4 bullet 6)", () => {
    const prompt = buildFull();
    expect(prompt).toContain("Do not paste raw tool output");
  });

  it("contains §3.4 bullet 5: plan_executing VC-branch/checkpoint guidance (review item #6)", () => {
    // Spec §3.4 bullet 5 (verbatim):
    //   "During `plan_executing`, reference the active VC branch / checkpoint
    //    when it is load-bearing for the decision (see §6 cross-track
    //    integration)."
    const prompt = buildFull();
    expect(prompt).toContain("plan_executing");
    // Accept `VC branch` or `checkpoint` — both variants satisfy the
    // cross-track integration anchor; the bullet mentions them together.
    expect(prompt).toMatch(/VC branch|checkpoint/);
  });

  it("the thinking-guidance block is a contiguous span of at least 300 chars covering all 6 bullets (drift guard)", () => {
    // Anchor on the canonical "destructive" clause (bullet 1) and scan
    // forward for the block terminator. The block must be coherent — all
    // six required anchors within one section of the prompt, not sprinkled
    // across unrelated sections.
    const prompt = buildFull();
    const anchorIdx = prompt.indexOf("destructive");
    expect(
      anchorIdx,
      "§3.4 anchor 'destructive' not found in Full-mode prompt",
    ).toBeGreaterThanOrEqual(0);

    // Search window: from the anchor to the end of the nearest section
    // break (`\n\n---\n\n`) or the end of the prompt.
    const sectionEnd = prompt.indexOf("\n\n---\n\n", anchorIdx);
    const end = sectionEnd === -1 ? prompt.length : sectionEnd;
    const block = prompt.slice(Math.max(0, anchorIdx - 100), end);

    // Snapshot guard: minimum size so a stub one-liner cannot satisfy the
    // individual substring tests above.
    expect(block.length).toBeGreaterThanOrEqual(300);

    // All six §3.4 bullets' canonical markers must coexist within this
    // single block — future drift that splits them across sections fails.
    expect(block).toContain("destructive"); // bullet 1
    expect(block).toContain("thinking"); // tool name reference
    const hasAmbiguityOrChoosing =
      block.includes("ambiguity") ||
      block.includes("choosing between approaches"); // bullet 2
    expect(hasAmbiguityOrChoosing).toBe(true);
    const hasTrivialOrNotRequired =
      block.includes("trivial") || block.includes("not required"); // bullet 3
    expect(hasTrivialOrNotRequired).toBe(true);
    expect(block).toContain("One thought per call"); // bullet 4
    // Bullet 5 — plan_executing + VC branch/checkpoint (review item #6).
    expect(block).toContain("plan_executing");
    expect(block).toMatch(/VC branch|checkpoint/);
    expect(block).toContain("Do not paste raw tool output"); // bullet 6
  });
});

describe("Task 1.4 / T44 — §3.4 thinking prompt guidance (Sub mode, interpretation: present)", () => {
  // See module header: we interpret §3.4 as appearing in BOTH modes because
  // subagents also call `thinking`. If the Executor disagrees, this block
  // goes RED and the review loop resolves the ambiguity.
  it("subagent-mode prompt also mentions the 'thinking' tool and its guidance anchors", () => {
    const prompt = buildSub();
    expect(prompt).toContain("thinking");
    expect(prompt).toContain("destructive");
    expect(prompt).toContain("One thought per call");
  });

  it("subagent-mode prompt includes the trivial-call negative clause", () => {
    const prompt = buildSub();
    const hasTrivial = prompt.includes("trivial");
    const hasNotRequired = prompt.includes("not required");
    expect(hasTrivial || hasNotRequired).toBe(true);
  });
});
