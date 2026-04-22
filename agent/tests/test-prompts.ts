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

/**
 * Task 7.1 / T44 — §6 cross-track integration prompt guidance.
 *
 * Source of truth:
 *  - docs/superpowers/specs/2026-04-19-qlaybot-0.4.4-design.md §6
 *    (three prose blocks — checkpoint discipline, recovery on blocker,
 *    reasoning discipline).
 *  - docs/superpowers/plans/2026-04-21-qlaybot-0.4.4.md Task 7.1 Step 1.
 *
 * §6 blocks verbatim:
 *  1. "Checkpoint discipline during plan execution. Before any destructive
 *      MCP call during `plan_executing` (`klayout_native_save_layout`,
 *      `klayout_native_auto_route`, `klayout_native_execute_script` that
 *      mutates geometry), consider calling `klayout_native_vc_checkpoint`
 *      with a short message so the user can roll back. If
 *      `klayout_native_vc_status` returns `vc not initialized`, skip this
 *      guidance silently."
 *  2. "Recovery on blocker. If a `plan_executing` step fails unrecoverably,
 *      consider `klayout_native_vc_checkout` to the last good checkpoint
 *      before re-drafting. Record the decision via `thinking`."
 *  3. "Reasoning discipline. Use `thinking` before destructive MCP calls,
 *      when resolving ambiguity, and when choosing between approaches.
 *      Reference the active VC branch/checkpoint when it's load-bearing."
 *
 * Mode coverage (per overseer instruction):
 *  - §6 applies to Full mode (subagents don't plan; plan_executing is a
 *    PlanManager-owned state).
 *  - We assert the §6 block is PRESENT in Full mode.
 *  - We are NEUTRAL about Sub mode — do not assert presence or absence.
 *
 * These are RED tests until the Executor lands Task 7.1 Step 2
 * (§6 block added to agent/src/prompts/).
 */
describe("Task 7.1 / T44 — §6 cross-track prompt guidance (Full mode)", () => {
  // --- (a) Checkpoint discipline ----------------------------------------

  it("names the checkpoint-discipline anchor: 'before any destructive MCP call during `plan_executing`'", () => {
    const prompt = buildFull();
    // Canonical phrase from §6 block 1 — the agent must recognise that
    // destructive MCP calls in plan_executing are the trigger condition.
    expect(prompt).toMatch(
      /before any destructive MCP call during `plan_executing`/i,
    );
  });

  // NOTE: a naive "names the three destructive tools verbatim" assertion
  // would pass transitively because those tool names also appear in the
  // tooling section (TOOL_NAMES_WITH_THINKING) and in §3.4 bullet 1. The
  // drift-guard test below covers this correctly by asserting the tool
  // names appear *inside* the §6 contiguous block, not merely somewhere
  // in the prompt.

  it("§6 checkpoint block recommends `klayout_native_vc_checkpoint` with a rollback rationale", () => {
    const prompt = buildFull();
    expect(prompt).toContain("klayout_native_vc_checkpoint");
    // Rollback rationale — spec says "so the user can roll back".
    expect(prompt).toMatch(/roll back/i);
  });

  it("§6 includes the fallback clause: `vc not initialized` → skip silently", () => {
    // Verbatim fallback from §6 block 1. Skipping silently is the agent's
    // escape hatch when VC was never initialised on this layout.
    const prompt = buildFull();
    expect(prompt).toContain("klayout_native_vc_status");
    expect(prompt).toContain("vc not initialized");
    // "skip" + "silently" — the spec phrases it "skip this guidance silently".
    expect(prompt).toMatch(/skip (this guidance )?silently/i);
  });

  // --- (b) Recovery on blocker ------------------------------------------

  it("§6 recovery block recommends `klayout_native_vc_checkout` to the last good checkpoint before re-drafting", () => {
    const prompt = buildFull();
    expect(prompt).toContain("klayout_native_vc_checkout");
    // "last good checkpoint before re-drafting" — verbatim anchor for
    // block 2. Accept either hyphenation ("re-drafting" / "redrafting").
    expect(prompt).toMatch(/last good checkpoint/i);
    expect(prompt).toMatch(/before re-?drafting/i);
  });

  it("§6 recovery block requires recording the decision via `thinking`", () => {
    const prompt = buildFull();
    // Verbatim from spec: "Record the decision via `thinking`".
    expect(prompt).toMatch(/record the decision via `?thinking`?/i);
  });

  it("§6 recovery block is triggered by an unrecoverable `plan_executing` step failure", () => {
    const prompt = buildFull();
    // Trigger condition for block 2: a plan_executing step that fails
    // unrecoverably. Both anchors must appear.
    expect(prompt).toContain("plan_executing");
    expect(prompt).toMatch(/unrecoverabl/i);
  });

  // --- (c) Reasoning discipline -----------------------------------------
  //
  // NOTE: intentionally no individual `it(...)` for reasoning-discipline
  // anchors. Every anchor the §6 reasoning-discipline bullet uses
  // (`thinking`, "destructive", "ambiguity", "VC branch"/"checkpoint",
  // "load-bearing") is ALREADY present in §3.4's thinking.ts block — so a
  // prompt-level substring test would pass transitively even without a §6
  // section. "choosing between approaches" is the one §6-unique phrase; it
  // is enforced inside the drift-guard test below, which requires the
  // phrase to appear inside the §6 contiguous block (anchored on the
  // §6-unique "before any destructive MCP call during `plan_executing`"
  // phrase) — not merely somewhere in the full prompt.

  // --- Drift guard: the three §6 bullets must be a contiguous block ------

  it("§6 block is a contiguous span of >=500 chars covering all three bullets (drift guard)", () => {
    const prompt = buildFull();

    // Anchor on the canonical §6-block-1 phrase. It is unique to §6 and
    // does not collide with §3.4 (which uses "before destructive MCP
    // calls" without the `plan_executing` qualifier).
    const anchorMatch = prompt.match(
      /before any destructive MCP call during `plan_executing`/i,
    );
    expect(
      anchorMatch,
      "§6 anchor 'before any destructive MCP call during `plan_executing`' not found in Full-mode prompt",
    ).not.toBeNull();
    const anchorIdx = anchorMatch ? (anchorMatch.index ?? -1) : -1;
    expect(anchorIdx).toBeGreaterThanOrEqual(0);

    // The block extends from some preamble-safe starting point up to the
    // nearest section break after the last §6 anchor. We search for a
    // `\n\n---\n\n` terminator; if absent, fall back to end-of-prompt.
    const sectionEnd = prompt.indexOf("\n\n---\n\n", anchorIdx);
    const end = sectionEnd === -1 ? prompt.length : sectionEnd;
    // Small preamble window to capture the §6 heading / lead-in phrase.
    const start = Math.max(0, anchorIdx - 200);
    const block = prompt.slice(start, end);

    // Minimum-size guard — three paragraphs of prose cannot fit in under
    // ~500 chars; a stub one-liner would fail here.
    expect(
      block.length,
      `§6 block only ${block.length} chars — expected >=500 for three bullets`,
    ).toBeGreaterThanOrEqual(500);

    // (a) Checkpoint discipline anchors all present in the same block.
    expect(block).toMatch(
      /before any destructive MCP call during `plan_executing`/i,
    );
    expect(block).toContain("klayout_native_save_layout");
    expect(block).toContain("klayout_native_auto_route");
    expect(block).toContain("klayout_native_execute_script");
    expect(block).toContain("klayout_native_vc_checkpoint");
    expect(block).toContain("klayout_native_vc_status");
    expect(block).toContain("vc not initialized");
    expect(block).toMatch(/skip (this guidance )?silently/i);

    // (b) Recovery-on-blocker anchors all in the same block.
    expect(block).toContain("klayout_native_vc_checkout");
    expect(block).toMatch(/last good checkpoint/i);
    expect(block).toMatch(/before re-?drafting/i);
    expect(block).toMatch(/record the decision via `?thinking`?/i);

    // (c) Reasoning-discipline anchors all in the same block.
    expect(block).toContain("ambiguity");
    expect(block).toContain("choosing between approaches");
    expect(block).toMatch(/VC branch|checkpoint/);
    expect(block).toMatch(/load-bearing/i);
  });
});

