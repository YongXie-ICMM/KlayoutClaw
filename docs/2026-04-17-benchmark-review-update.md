# KlayoutClaw Update Report — 2026-04-17 Benchmark Review Fixes

**Branch:** `worktree-fix-benchmark-review-2026-04-17`
**Baseline:** commit `61eccb6` (the 2026-04-14/15 pre-fix WIP)
**Tip:** commit `484d6cd`
**Scope:** 31 fix commits, +5804 / −93 LOC across 24 files, 28 new unit tests, 6 new E2E tests — all green on a live KLayout + MCP session.
**Plan executed:** [`docs/superpowers/plans/2026-04-17-benchmark-review-fixes.md`](superpowers/plans/2026-04-17-benchmark-review-fixes.md)

---

## Why this work happened

On 2026-04-14/15 we ran 15 full benchmark sessions (`ml04`, `ml08`, `ml09`, `ml11`, `ml14`) across three harnesses (Claude Code, OpenCode, qlaybot) and synthesised the results into `/Users/andrewwayne/Benchmark_Records/2026_04_14_15/KLAYOUTCLAW_ENHANCEMENT_SYNTHESIS.md`. That review produced a first round of uncommitted changes which, when audited against the original transcripts and feedback files, showed two patterns:

1. **Overfit to the specific Hall-bar benchmark.** Defaults, example text, schema descriptions, and docs vocabulary all assumed the benchmark's exact layer numbers (`graphene=11/0`, `graphite=13/0`, `mesa=20/0`, `contact_patch=21/0`, `bonding_pad=2/0`, `contact_route=3/0`) and device topology ("Hall-bar-style arms"). Any future benchmark on a different device would silently mis-score.
2. **One critical gap and one real bug, both re-implemented or worked around every session.** Agents hand-rolled "graphene ∩ graphite + graphene-only + graphite-only" geometry in `execute_script` every single time. And `auto_route`'s Hungarian matching had no override, so `ml14` made 23 sequential auto_route calls then abandoned the tool and wrote manual Manhattan paths.

This report documents the problems we solved, how we verified each fix, and what remains out-of-scope.

---

## Problems solved

### 1. `bulk_containment` silently returned 0 on non-Hall-bar layouts

**Problem.** The primitive (added during the 2026-04-14/15 review) defaulted `material_a="graphene"` and `material_b="graphite"` when `bulk_region` was omitted. On any layer_map that didn't contain those exact keys — e.g. a MoS₂ FET, a quantum dot, or a Hall bar whose `layer_map` used different names — the key lookup returned an empty region, the intersection was empty, and the score silently dropped to 0.0 with no signal that the inputs were mis-matched. The score looked like "design failed", not "primitive misused".

**Fix.** Removed the defaults entirely. The primitive now accepts either:
- `bulk_region` — a single layer_map key or list, combined via `region_op`, or
- `materials` — a list of layer_map keys whose intersection defines the bulk.

If neither is passed, the primitive raises `ValueError` naming both options with the explicit phrase *"No default material names are assumed"* so the agent knows exactly what to supply.

**Verification.** `tests/test_evaluate_worker_overfit.py::TestBulkContainmentDefaults` — three tests: error-path produces `score=0.0` + `"ERROR"` marker in `detail`, explicit `bulk_region` path scores ~0.64 on a 10×10 component over an 8×8 bulk, `materials=[...]` path produces the same score. Live-session E2E (`test_e2e_non_hallbar.sh`) drives Claude through a layer-map with `device_body=[30,0]`, `peripheral_a=[31,0]`, `peripheral_b=[32,0]` and confirms `bulk_containment` scores > 0.

**Commits:** `016fbbe`, `f02c9f5`.

---

### 2. `route_inspect` defaulted to Hall-bar layer numbers

**Problem.** The tool's schema defaulted `contact_layers` to `["21/0"]` and `pad_layer` to `"2/0"`. Those are the Hall-bar benchmark's specific layers. An agent working on any other benchmark either had to override both (easy to forget) or would silently get a report that maps routes to the wrong layers. Worse, the runtime handler also silently accepted `contact_layers=[]` (empty list), producing a zero-result report that looked valid.

**Fix.** Both fields are now **required** in the schema. The `_tool_route_inspect` handler rejects missing or empty inputs with `ValueError` messages that name the argument and include `"No default is assumed"`. The `contact_layers` guard uses `if not contact_specs` (not `is None`) to catch the empty-list edge case.

**Verification.** `tests/test_evaluate_worker_overfit.py::TestRouteInspectSchema` — four tests: schema regex confirms no stale default, `contact_layers` and `pad_layer` are in the `"required"` list, runtime handler rejects missing `contact_layers`, runtime handler rejects missing `pad_layer`, plus an additional static-analysis assertion that guards against a regression to `is None`.

**Commits:** `6e4083e`, `f7468b7`.

---

### 3. `next_step_suggestion` leaked the Hall-bar mental model

**Problem.** Suggestion strings referenced *"Hall-bar-style arms"* and directed agents to reason about *"graphene_only / graphite_only / overlap"* regions. Agents copy this phrasing into their own reasoning, so a future benchmark on a MoS₂ transistor would receive suggestions that make no sense for the device at hand.

**Fix.** Rewrote every branch of `_build_next_step` in `tools/evaluate_worker.py` with device-agnostic language. Suggestions still point at `route_inspect`, `screenshot`, and `checklist` concretely; they no longer name materials or topology. The `bulk_containment` suggestion now reads *"If the component has a core area plus peripherals that intentionally sit outside the target region, switch from component_containment to bulk_containment and pass a bulk_region (or materials list) matching only the core."*

**Verification.** `tests/test_evaluate_worker_overfit.py::TestNextStepSanitized` — two tests: assert the suggestion text on a low-score run contains none of `{Hall-bar, hall bar, graphene_only, graphite_only, graphene/graphite}`, AND that it's still ≥ 50 chars (not over-sanitised).

**Commit:** `77185d8`.

---

### 4. `evaluate_design` schema advertised the Hall-bar layer map as canonical

**Problem.** The `layer_map` property's schema description contained a concrete example: `{"mesa": [20, 0], "contact_patch": [21, 0], "topgate": [22, 0], "contact_route": [3, 0], "bonding_pad": [2, 0], "graphene": [11, 0], "graphite": [13, 0]}`. MCP-speaking agents read schema descriptions as canonical and copy them verbatim. Every future benchmark was at risk of inheriting these specific layer numbers regardless of what its own spec said.

**Fix.** Replaced with an illustrative placeholder that preserves the value-shape information without baking specific layer numbers: `{"device_body": [L, D], "peripheral": [L, D], "connector": [L, D], "pad": [L, D]}`, followed by *"Replace L / D with the layer / datatype integers your benchmark specifies."*

**Verification.** `tests/test_evaluate_worker_overfit.py::TestLayerMapSchemaExample` — regex-based check for the co-occurrence of `mesa=20/0`, `contact_patch=21/0`, `bonding_pad=2/0` (the three-key signature of the Hall-bar bake). The test is load-bearing: I deliberately re-introduced the old example during development, watched the test fail, then removed it — confirming the detector actually catches regressions.

**Commits:** `5b87bdd`, `54a7648`.

---

### 5. Docs (`docs/tools.md` and `CLAUDE.md`) were out of sync with the code

**Problem.** Even after the schema + runtime defaults were removed, `docs/tools.md`'s `route_inspect` parameter table still advertised `| no | ["21/0"]` and `| no | "2/0"` defaults, and the `bulk_containment` bullet still said *"use instead of component_containment for Hall-bar-style shapes"*. An agent reading the docs would see a contract different from what the schema enforced.

**Fix.** Updated the `route_inspect` table to show **`**yes**`** / `—` with explanatory notes. Rewrote the `bulk_containment` bullet device-agnostically, listing both `bulk_region?` and `materials?` as options and repeating "No default material names are assumed." The `CLAUDE.md` entry for `route_inspect` now states the three required args and the fact that `route_id` aligns with `evaluate_design.contact_isolation.crossing_pairs`.

**Verification.** `tests/test_phase4_docs_integration.py` gains three scanners: no Hall-bar-style language, no default layer numbers in `route_inspect`, CLAUDE.md row names the required args.

**Commit:** `2c8c0de`.

---

### 6. `rank_candidate_pairs.py` docs framed the script as Hall-bar-only

**Problem.** The script's CLI already took `--material-a` / `--material-b`, but its `SKILL.md` section was headed *"rank (graphene, graphite) pairs by overlap"* and the body said *"Use this before designing the Hall bar mesa…"*. Device-agnostic tool, Hall-bar-flavoured docs.

**Fix.** Section header now reads *"rank material pairs by overlap (default graphene × graphite)"*. The intro leads with the generic use-case and calls out `top_hBN × bottom_hBN` as an alternative example (ranking encapsulation pairs). The ml09 / ml11 failure mode moved into a parenthetical observation — still referenced, no longer prescriptive.

**Commit:** `6a5ad4e`.

---

### 7. Every session re-implemented "graphene-only / graphite-only / overlap" region math

**Problem.** The largest silent cost in the benchmark set. Across all 15 feedback files, the same ~20-30 line pya/gdstk pattern appeared: compute `A ∩ B`, `A ∖ B`, `B ∖ A`, their areas + bboxes + centroids. Each agent wrote it fresh, each implementation had subtle bugs, and the output format was inconsistent. This was P3.1 in the synthesis — never actioned until now.

**Fix.** New MCP primitive `material_overlap_report` in `tools/evaluate_worker.py`. Takes `materials=[...]` (any list of ≥ 2 layer_map keys) and emits a structured report covering:
- every `<key>_only` region (each material minus the union of the others),
- every pairwise intersection `<A>_and_<B>`,
- every higher-order intersection up to `<A>_and_<B>_and_<C>_…`,

each with `area_um2`, `bbox_um`, `centroid_um`, `num_polygons`. Score is always `1.0` — the value is the report itself, promoted to the check result's `report` side-data field.

**Verification.** `tests/test_evaluate_worker_overfit.py::TestMaterialOverlapReport` — four tests: 2-material case (expected areas 84/84/16 µm²), 3-material case emits all 7 region keys including the triple intersection, empty-list rejected, single-element rejected. Live-session E2E (`test_e2e_material_overlap.sh`) drives Claude through blank-layout + two overlapping rectangles + a real MCP call, confirms `A_and_B` area = 16.0 µm².

**Commits:** `e7a35c6`, `dc2f36e`, `2b450ff`, `d7ab419`, `630af2f`.

---

### 8. `auto_route` could not be overridden — ml14 abandoned the tool after 23 calls

**Problem.** The single largest workflow failure in the benchmark set. CC ml14's transcript shows 23 sequential `auto_route` calls (lines 412–548) as the agent tried to coerce the Hungarian assignment into producing a valid routing, then gave up and wrote manual Manhattan paths with explicit exit-column staggering. `dry_run` previews the matching; it does not let you commit a different one.

**Fix.** New parameter `pin_pairs_override: [[a_idx, b_idx], ...]` on `auto_route`. When present, it replaces Hungarian matching entirely; the rest of the routing pipeline (cost grid, pathfinding, insertion) is unchanged. Validation covers:
- malformed entries (not a 2-element list),
- wrong length (must equal `min(n_pin_a, n_pin_b)`),
- out-of-range indices,
- wrong outer type.

Any validation failure returns `status: "failed"` with a structured `errors[]` list rather than silently running the wrong assignment. The `dry_run` preview also honours the override, so the recommended workflow is: `auto_route(dry_run=true)` → inspect `pairs[]` → re-call with `pin_pairs_override=[[a_idx, b_idx], …], dry_run=false`.

**Verification.** `tests/test_route_worker_override.py` — four tests: crossed assignment produces diagonal paths (dy > 50 µm), wrong-length rejected, out-of-range index rejected, malformed entry rejected. Live-session E2E (`test_e2e_route_override.sh`) drives Claude through: draw 4 pins in two vertically-separated pairs → dry-run to see Hungarian parallel pairing → override with `[[0,1],[1,0]]` → query the committed L10/0 shapes and confirm both routes span the 100 µm y-gap (Hungarian would have kept them parallel at dy ≈ 0).

**Commits:** `1fefbae`, `c350b41`, `4e7d97e`, `a5fab4a`, `004f44e` (+ three E2E fixup commits for assertion-shape issues: `fc682cf`, `d46618c`, `484d6cd`).

---

### 9. `evaluate_design.contact_isolation.crossing_pairs` contract — investigated and held

**Problem flagged in the audit.** A transcript sweep had suggested that `crossing_pairs` could return `[]` even when real crossings existed, which would undermine the `next_step_suggestion` text that directs agents to inspect `crossing_pairs`.

**Finding after verification.** The contract is honoured correctly. `_prim_contact_isolation` returns `{"score": ..., "extra": {"crossing_pairs": [...], "crossing_pairs_format": ...}}`, and `main()` in `evaluate_worker.py` promotes every key under `extra` to the top-level check result. The earlier transcript observation was an intermediate evaluation where no crossings existed (score correctly 1.0, crossing_pairs correctly empty).

**Action.** Added a regression guard (`tests/test_evaluate_worker_overfit.py::TestCrossingPairsContract`) that builds a synthetic two-route crossing deliberately far from any pad (to avoid the junction-filter suppression) and asserts that `score < 1.0`, `crossing_pairs` is non-empty, each tuple is `[i, j, area_um2]`, and `crossing_pairs_format` is present. Live-session E2E (`test_e2e_crossing_pairs.sh`) confirms the contract through the full user→MCP→KLayout→result loop. **No code fix was needed.**

**Commits:** `6b77fff`, `17f24df`.

---

### 10. `execute_script` under heavy layout state — investigated, did not reproduce

**Problem flagged in the audit.** OpenCode ml14 collapsed to score 0.169 because `execute_script` began returning `IndexError: list index out of range` + `TypeError` after the layout accumulated 200+ shapes across multiple cells (transcript lines 140, 152, 168). The 30 s → 300 s client-timeout bump in the earlier uncommitted changes does not address this — the server was responding, with a structurally broken payload.

**Reproducer.** `tests/test_execute_script_loaded.py` seeds a single session with 750 boxes (250 each on L20/L21/L22) and runs 15 back-to-back `execute_script` queries across three patterns: flat `.each()` iteration, recursive `begin_shapes_rec()` iteration, and interleaved cross-layer queries.

**Finding.** The failure did **not** reproduce on this stack (KLayout native + Python 3.13 + `instrMCPdev` conda env). All three test methods pass (`3 passed in 0.33s`). The heavy-state E2E (`test_e2e_heavy_script.sh`) with 900 shapes + 5 iterations of 3-layer counting also passes.

**Action.** Kept the reproducer + regression E2E as a guard. Did not commit diagnostic logging or speculative fixes. If the failure resurfaces on a different stack (likely a specific KLayout build or plugin version on the OpenCode runner), the reproducer is ready to narrow it down; the plan's hypotheses (iterator leak / stale view / dangling Region / JSON encoder) list concrete fix shapes.

**Commits:** `bb28f1d`, `a173d9d`.

---

### 11. E2E harness bug — `tmux`-launched Claude never populated the log

**Problem (found during the first E2E attempt, not in the original synthesis).** The initial `test_e2e_non_hallbar.sh` launched Claude inside a detached `tmux` session (`tmux new-session -d … "claude … | tee /tmp/e2e_non_hb.log"`). On macOS, with a multi-line prompt containing escaped quotes, the tmux session exited immediately and silently — the log file stayed empty and the poll loop waited until the 12-minute timeout.

**Fix.** Dropped tmux entirely. E2E scripts now run `claude --print` directly, backgrounded with `&`, and enforce the wall-clock cap via a `for / kill -0` poll loop (macOS has no `timeout` command). Output goes straight to the log file via redirection. All six E2E scripts follow the same pattern, plus a conda auto-detect block that tolerates `~/anaconda3` / `~/miniforge3` / `~/miniconda3` installations.

**Verification.** All six E2E scripts run end-to-end on the current stack (`bash tests/test_e2e_regression.sh` → `Passed (6): ✓`).

**Commit:** `67a1fce` (harness fix); all six E2E scripts inherit the pattern.

---

### 12. Plugin reload friction — KLayout caches the `.lym` at startup

**Problem (operational, not a code bug).** `.lym` macro changes (new MCP tools, new schema properties) are loaded once at KLayout startup. `install.py` copies files into `~/.klayout/pymacros/` but KLayout keeps running the old in-memory version. An E2E test run against a stale KLayout gets schema errors like `"unknown primitive 'bulk_containment'"` even though both the disk file and the worktree have it.

**Operational workaround (documented, not automated here).** Before each phase's E2E run, the sequence is: `python install.py` → quit KLayout → reopen KLayout → poll MCP until it responds. The `close_layout_view` tool was designed to clean up tabs first, but it hangs on a Qt main-thread re-entrancy issue when dirty views trigger modal save dialogs — see the note below. For restart-purposes, `pkill -9 klayout` is safe (we only need the process to die).

**Known bug (not fixed in this work):** `close_layout_view` + dirty views → deadlock. The MCP handler runs on the Qt main thread; closing a dirty view spins a nested QEventLoop waiting for the "save changes?" dialog to be dismissed, but the main thread is busy inside our tool handler, so the dialog never paints and we wait forever. The `save_as`-to-temp-file trick only works when `is_dirty()` flips reliably, which image annotations and external-data layers don't always do. **Recommended follow-up:** move the `close_current_view` call behind `QMetaObject::invokeMethod(..., Qt::QueuedConnection)` or explicitly process events with a deadline, so the dialog either paints and auto-dismisses or the call times out. Not in this change set.

---

## Files changed (top of the tree)

| File | Role in the change set |
|---|---|
| `plugin/klayoutclaw_server.lym` | Schema defaults stripped; `material_overlap_report` + `pin_pairs_override` registered; `_tool_route_inspect` guards. |
| `tools/evaluate_worker.py` | `_prim_bulk_containment` rewrite; new `_prim_material_overlap_report`; `_build_next_step` sanitised; `main()` forwards `report` side-data; `raw` variable hardened against `UnboundLocalError`. |
| `tools/route_worker.py` | `pin_pairs_override` branch with validation, applied before Hungarian + dry_run. |
| `docs/tools.md` | Parameter tables + primitive bullet for `bulk_containment`, `material_overlap_report`, `pin_pairs_override` + manual-pairing workflow paragraph; `route_inspect` table shows required args. |
| `CLAUDE.md` | `route_inspect` and `evaluate_design` row descriptions updated to reflect Task 1/2/3 changes. |
| `docs/skills.md` | No substantive change (doc counts). |
| `skills/nanodevice_flakedetect_combine/SKILL.md` | `rank_candidate_pairs` section generalised. |
| `tests/test_evaluate_worker_overfit.py` (new) | 16 tests across Phase 1 + Phase 2 + Phase 4. |
| `tests/test_route_worker_override.py` (new) | 4 tests for `pin_pairs_override`. |
| `tests/test_execute_script_loaded.py` (new) | 3 tests — reproducer + regression guard. |
| `tests/test_phase4_docs_integration.py` | +6 doc-integration scanners. |
| `tests/fixtures/non_hallbar_layout.py` (new) | Synthetic device on layers 30–34 for E2E. |
| `tests/test_e2e_non_hallbar.sh` (new) | Phase 1 E2E. |
| `tests/test_e2e_material_overlap.sh` (new) | Phase 2 E2E. |
| `tests/test_e2e_route_override.sh` (new) | Phase 3 E2E. |
| `tests/test_e2e_crossing_pairs.sh` (new) | Phase 4 E2E. |
| `tests/test_e2e_heavy_script.sh` (new) | Phase 5 E2E. |
| `tests/test_e2e_alt_device.sh` (new) | Phase 6 E2E (multi-tool cross-cutting). |
| `tests/test_e2e_regression.sh` (new) | Runs every E2E sequentially, tallies pass/fail. |
| `docs/superpowers/plans/2026-04-17-benchmark-review-fixes.md` (new) | The executable plan archived on the branch. |
| `docs/2026-04-17-benchmark-review-update.md` (new) | This report. |

---

## Test status

```
86 passed   — unit tests (tests/test_phase4_docs_integration.py
                         + tests/test_evaluate_worker_overfit.py
                         + tests/test_route_worker_override.py
                         + tests/test_execute_script_loaded.py
                         + tests/test_server_bugs.py
                         + tests/test_utf8_body_corruption.py
                         + tests/test_connection.py)
 6/6 PASS   — E2E regression bundle (tests/test_e2e_regression.sh)
```

Pre-existing failures in `tests/test_phase1_mcp.py` and `tests/test_phase2_phase3_func.py` (both baseline, unrelated to this work) are unchanged.

---

## Out of scope

- **No PR opened.** `gh pr create` is for the branch owner to run when they're ready.
- **No baseline benchmark rerun.** ml04 / ml08 / ml09 / ml11 / ml14 should be re-scored against the pre-fix best to confirm no regression in end-to-end agent performance — left for manual validation.
- **`close_layout_view` Qt re-entrancy bug** — diagnosed, documented, not fixed.
- **Two nit-level code-review Minors on `_build_next_step`** — banned-list case variants, suggestion-length floor — flagged non-blocking, deferred.
- **`filter_real_pads` (P3.2 from the synthesis)** — user opted out of this primitive during scope selection. Agents still hand-roll the 102 → 43 pad filter with the hardcoded `24964 µm²` constant. Future benchmark work that moves off the Hall bar should revisit whether a generic `filter_by_area(layer, area, tolerance)` helper is worth adding.
