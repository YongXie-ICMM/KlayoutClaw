/**
 * v0.4.4 §3 — `thinking` tool (Track 1).
 *
 * Side-effect-free scratchpad the agent uses to externalise reasoning.
 * Spec TH-1..TH-14. See docs/superpowers/specs/2026-04-19-qlaybot-0.4.4-design.md §3.
 *
 * Invariants the tests bind on:
 *   - name === "thinking" (bare, no prefix — TH-1)
 *   - schema: Type.Object({ thought: Type.String({minLength:1}) }) with
 *     additionalProperties:false and required:["thought"] — TH-2/TH-14
 *   - description contains "side-effect-free" and "scratchpad" — §3.3
 *   - execute() on valid input:
 *       1) emits exactly ONE {type:"think_recorded", source:"tool",
 *          thought, ts} marker via emitter.emit("marker", ...);
 *       2) returns {content:[{type:"text", text: JSON.stringify({
 *          ok:true, thought})}], details:{}} — TH-3 echo contract.
 *   - execute() on invalid input (empty thought, missing thought,
 *     additional properties): reports a validation error via
 *     {content:[{type:"text", text: JSON.stringify({ok:false, error})}],
 *     details:{error:"..."}} AND emits ZERO markers — spec §3.7 edge
 *     cases + T29(c) runtime test.
 *   - no side effects beyond the single emit: no fs, no MCP, no
 *     subagent spawn, no session-state mutation — TH-3.
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TranscriptMarkerEmitter } from "../events/marker-emitter.js";

const ThinkingParams = Type.Object(
  {
    thought: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type ThinkingParamsT = Static<typeof ThinkingParams>;

/**
 * v0.4.4 §3.3 description — MUST contain both anchor substrings
 * "side-effect-free" and "scratchpad" (see test-unit.ts).
 */
const THINKING_DESCRIPTION =
  "Record a reasoning step. A side-effect-free scratchpad. Does not run " +
  "code, does not call other tools, does not change layout state. Use " +
  "to externalise what you've verified and what you're about to try.";

export function createThinkingTool(
  emitter: TranscriptMarkerEmitter,
): AgentTool<typeof ThinkingParams> {
  return {
    name: "thinking",
    label: "Thinking",
    description: THINKING_DESCRIPTION,
    parameters: ThinkingParams,
    async execute(
      _toolCallId: string,
      params: ThinkingParamsT,
    ): Promise<AgentToolResult<unknown>> {
      // ── Runtime validation (spec §3.7 / T29(c) runtime) ──────────────
      // Even though TypeBox already surfaces the schema the SDK validates
      // against on its way in, the tests probe `execute()` directly with
      // invalid inputs. We MUST:
      //   (a) report an error via ok:false + details.error, AND
      //   (b) emit ZERO markers for invalid input.
      if (!Value.Check(ThinkingParams, params)) {
        const errorMsg = "thinking: invalid input (schema validation failed)";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: errorMsg }),
            },
          ],
          details: { error: errorMsg },
        };
      }

      // ── Happy path: emit one marker, return the echo ────────────────
      const ts = new Date().toISOString();
      emitter.emit("marker", {
        type: "think_recorded",
        source: "tool",
        thought: params.thought,
        ts,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, thought: params.thought }),
          },
        ],
        details: {},
      };
    },
  };
}
