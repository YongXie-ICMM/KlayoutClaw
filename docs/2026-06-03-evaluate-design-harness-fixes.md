# evaluate_design harness fixes (2026-06-03)

Three harness bugs that made `evaluate_design` (the agent's self-evaluation tool)
unreliable across the entire qlaybot-opus48 KLayout-bench e2e run. Found while
investigating a bimodal score distribution (9 cases > 0.8, 9 cases < 0.4).

## Bug 1 — object-typed MCP params serialized as JSON strings

**Symptom:** every `evaluate_design` call in every transcript (passing AND
failing cases, 0/N succeeded) failed with
`'str' object has no attribute 'items'` at the server's `layer_map.items()`.

**Root cause:** qlaybot's `buildToolSchema` / `buildProxySchema`
(`agent/src/tools/index.ts`, `agent/src/subagent/tool-factory.ts`) convert an
MCP tool's `inputSchema` into a TypeBox schema for the model, but the
`switch (def.type)` had **no `case "object"`** — object-typed params fell to
`default → Type.Unknown()`, which compiles to the empty schema `{}`. With no
type hint, Opus serialized the nested `layer_map` object as a JSON **string**,
which reached the server unparsed. (`checks`, an `array`, survived — only
`layer_map`, the lone top-level `type:"object"` param, broke. That is why
`evaluate_design` was uniquely 100% broken.)

**Fix:**
- `buildToolSchema` / `buildProxySchema`: add `case "object"` →
  `Type.Object({}, { additionalProperties: true })` so the model emits a real object.
- `_tool_evaluate_design` (`plugin/klayoutclaw_server.lym`): defensive
  `str → json.loads` coercion for `layer_map` and `checks` (belt-and-suspenders
  against any client that stringifies).
- Regression test: `agent/tests/test-tier1-bugs.ts` "BUG 6".

## Bug 2 — arm_material_class crashed on the nested-list `classes` form

**Symptom:** `arm_material_class: ERROR — list indices must be integers or
slices, not str`, returning 0.0.

**Root cause:** `_prim_arm_material_class` (`tools/evaluate_worker.py`) only
handled the documented dict form `{name, region, region_op}` and indexed
`cls["region"]`; agents naturally pass the nested-list form
`[["graphene"], ["graphite"]]`, so `cls["region"]` indexed a list with a string.

**Fix:** accept three equivalent forms per class — a layer_map key
(`"graphene"`), a list of keys (`["graphene", "graphite"]`, unioned), or a dict —
and emit an actionable error naming the accepted forms on genuine mismatch.
Schema description + docstring updated. Tests: `TestArmMaterialClass` (5 cases).

## Bug 3 — errored checks scored 0.0 at full weight (false zero)

**Symptom:** a check that *raised* (e.g. Bug 2) was recorded as `score = 0.0`
with full weight in `overall`, so a tool/usage error masqueraded as a design
that genuinely failed that check — corrupting the agent's self-evaluation.

**Fix:** `evaluate_worker.py` main loop now flags errored checks
`status: "error"`, **excludes** them from the weighted `overall` (numerator and
denominator), reports `n_errored_checks`, and highlights them in
`next_step_suggestion`. Only affects the agent-facing self-eval tool — the
official benchmark scorer (`composite_evaluator.py`) is a separate file and is
unchanged. Test: `test_errored_check_excluded_from_overall`.

## Verification
- `agent`: `npm run build` clean; tier1 10/10; pre-existing failures only
  (version 0.4.3↔0.4.4, thinkingLevel, vc_* tools/list) confirmed unrelated.
- `tools/evaluate_worker.py`: `tests/test_phase1_worker.py` 25/25; all 11
  primitives smoke-tested OK after the fixes (arm_material_class was the last
  broken one).
- `plugin/klayoutclaw_server.lym`: XML well-formed + embedded Python compiles.

## Not deployed
Source-only. Requires `python install.py` + KLayout restart to take effect in a
live run, then a benchmark re-run to measure recovery.

## Wider diagnosis
The 9 low-scoring e2e cases were root-caused (per-metric breakdowns + transcripts)
to mostly **flake/device misregistration vs the ground-truth frame, invisible to
the agent's self-evaluation** (the agent validates against its own committed
flakes, which is correct — it must not see the reference). Stage breakdown:
gdsalign skipped/hand-rolled (HM08, QH06, AH06), wrong 90° branch (HM11,
`align_gds.py` disambiguation threshold floored to 0), design read image-frame
contours (QH07), combine warp offset (ml14); plus design-quality (ml11, AH07)
and a save/scoring-path + MCP-bridge-wedge anomaly (QH12, device was actually
0.93). These fixes (faithful self-eval) are a prerequisite, not the whole story;
full diagnosis archived under the harbour workspace `_diagnosis/`.
