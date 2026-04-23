# Early Exit Observation Report — qlaybot k2p6 (2026-04-23)

**Run:** `python run_local.py --agent qlaybot --model kimi-coding/k2p6 --archive-suffix qb-k2p6-apr23-run1`
**Archive:** `/Volumes/RandomData/harbour-workspace/qlaybot/archive_23_04_26_qb-k2p6-apr23-run1/`

## Summary

Two datasets (ml09, ml11) were marked `completed` by `run_local.py` — i.e. the qlaybot subprocess returned exit code 0 — but produced **no `result.gds`**. Neither timed out and neither hit a Python exception in the subprocess. The agent stopped generating events mid-workflow and the session ended cleanly. This reproduces the premature-termination pattern previously logged as Issue 23 (2026-04-14, qlaybot GPT 5.4 thinking=high on ml08), but on k2p6 with default effort.

## ml09 — 4.7 min, 4 transcript events

Transcript: `qlaybot/ml09/qlaybot-transcripts/session_1776927228802-20260423-065348.jsonl`
Window: `06:53:48.857Z → 06:57:30.116Z` (3m 42s of agent wall time)

Event sequence:

1. `user_prompt` — "Read the following instructions in .../ml09/output/instruction.md. Finish the task."
2. `agent_thinking` — "The user wants me to read an instruction file and then finish a task. Let me first read the file to understand what needs to be done."
3. `tool_call: read` — reads `instruction.md` (E2E Device Design — 8-Pin Hall Bar).
4. `agent_thinking` — breaks down the 7-step workflow: save copies, read SKILL.md, run flake detection pipeline, align, design mesa/contacts/topgate, route, evaluate + save. **Session ends here.**

No SKILL.md read, no `klayout_native_validate_pixel_size`, no bash calls, no tool invocations after step 3. Agent produced the plan and then the session terminated. Output dir contains only `instruction.md`, `instruction_copy.md`, and the `skills/` / `tools/` symlinks synced by `run_local.py` pre-launch — nothing the agent produced.

**Signature:** the agent stopped immediately after its initial plan-thinking, without dispatching even the first concrete action.

## ml11 — 22.9 min, 64 transcript events

Transcript: `qlaybot/ml11/qlaybot-transcripts/session_1776927505125-20260423-065825.jsonl`
Window: `06:58:25.220Z → 07:19:33.845Z` (21m 8s of agent wall time)

Progression (made real progress on the pipeline):
- Validated pixel size
- Ran align pipeline → wrote detections.json (1358 bytes)
- Read combine skill
- Ran `ecc_register.py` → dx=-62.9 px, dy=195.7 px, correlation 0.4808
- Ran `transform.py` → traces.json written, top_hBN/graphene/graphite/bottom_hBN regions extracted
- Ran `overlay.py` → raw + LUT + mask composite overlays written

Last 3 events:

```
[07:17:42.987Z] thinking   — "Transform done. Now run overlay.py and then commit to KLayout."
[07:17:47.411Z] tool_call  — bash: overlay.py OK
[07:19:33.845Z] thinking   — "Let me view the overlay to verify the materials are aligned correctly before committing to KLayout."
```

Session ends in the middle of that final thinking — the "view the overlay" tool call never fires. No KLayout commit, no mesa design, no routing, no `save_layout`. Total elapsed 22.9m.

**Signature:** agent was executing productively, emitted a planning-thinking for the next step ("let me view…"), and the session terminated before the corresponding tool call.

## Common characteristics

| | ml09 | ml11 |
|---|---|---|
| Wall-time to exit | 4.7m | 22.9m |
| `run_local.py` exit status | completed | completed |
| Transcript events | 4 | 64 |
| Final event type | `agent_thinking` | `agent_thinking` |
| Any Python error in transcript | none | none |
| KLayout MCP tool calls | 0 | 0 |
| `save_layout` calls | 0 | 0 |
| `result.gds` produced | no | no |

Both sessions **end on an `agent_thinking` event** — a narration that announces the next action, which never executes. The subprocess then exits 0, so the orchestrator marks the task "completed" and moves on. This is distinct from the ml08 / ml14 cases in the same run, which exited via an 80-minute timeout while still emitting tool calls.

## Likely cause

This matches the premature-termination pattern previously seen when qlaybot was driven with `effort=high` on GPT 5.4 (Issue 23). On k2p6 it occurred at default effort. The agent loop appears to treat a model response that contains only reasoning (no tool call and no final message) as a natural stop — qlaybot exits 0 and `run_local.py` has no way to distinguish that from a successful completion.

## Mitigations to consider

1. **Post-run guardrail:** have `run_local.py` grep the final transcript for a `save_layout` call (or the presence of `result.gds`) and mark the dataset `incomplete` rather than `completed` when missing. This would at least show up honestly in the summary table.
2. **Resume probe:** if the final event is `agent_thinking`, qlaybot could re-issue a continuation prompt ("continue where you left off") before exiting. Needs a qlaybot-side change.
3. **Model swap:** k2p6 + qlaybot is fragile. Until 1 or 2 land, prefer GPT 5.4 default effort on qlaybot.

## References

- `project_benchmark_results_2026_04_23.md` (aggregate scores)
- `project_benchmark_results_2026_04_14.md` (Issue 23 premature-termination precedent)
- `project_benchmark_results_2026_04_11.md` (Issue 23 first observation on ml08)
