#!/usr/bin/env python
"""Adversarial regression tests for the 2026-06-05 qb-opus48 feedback fixes.

Each test targets a CONFIRMED-OPEN feedback issue (see
agent/plans/qb-opus48-work/triage_verdicts.json). Tests are written
RED-first (they fail against the pre-fix code) and assert on real
behaviour — never on a hardcoded magic constant or a string literal that a
trivial implementation could satisfy.

Worker tests run tools/evaluate_worker.py as a subprocess via the shared
harness in test_phase1_worker.py.
"""

import os
import re
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_phase1_worker import (  # noqa: E402
    _run_worker,
    LAYER_MAP,
    WORKER_PATH,
    ANACONDA_PYTHON,
    test_gds,            # fixture
    anaconda_has_deps,   # fixture
)

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LYM_PATH = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")


# ===========================================================================
# Issue #2 — solidity detail string inverts the metric (labels 1-solidity
# as "solidity:"). Fix: _prim_solidity returns a dict whose detail/extra
# echo the RAW geometric solidity separately from the normalized score.
# ===========================================================================

class TestSolidityDetailNotInverted:
    def _run_solidity(self, test_gds, component, threshold, direction):
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{
                "name": "solidity",
                "args": {"component": component, "threshold": threshold,
                          "direction": direction},
                "weight": 1.0,
            }],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"worker failed: {stderr[:300]}"
        return result["checks"][0]

    def test_raw_solidity_exposed_for_below(self, test_gds, anaconda_has_deps):
        """The concave H-mesa: raw solidity must be reported, distinct from
        the normalized below-score (which is 1-solidity).

        Behavioural, non-hardcoded: ties score and raw_solidity by the known
        relationship score == 1 - raw_solidity for direction='below' with
        solidity < threshold. A lazy impl that reports (1-solidity) as the
        raw value (the bug) would make raw == score and fail.
        """
        chk = self._run_solidity(test_gds, "mesa", threshold=0.9, direction="below")
        raw = chk.get("raw_solidity")
        assert raw is not None, (
            "solidity check must expose raw_solidity (geometric area/hull); "
            "pre-fix code returns a bare float with no raw value -> inversion "
            "invisible. Got check keys: {}".format(sorted(chk.keys())))
        assert 0.0 < raw < 1.0, f"raw_solidity out of range: {raw}"
        score = chk["score"]
        # below-gate passed (concave mesa) -> normalized score is 1 - raw
        assert abs(score - (1.0 - raw)) < 1e-3, (
            f"score ({score}) must equal 1 - raw_solidity ({1.0 - raw}); "
            "if they diverge the raw value is mislabelled")
        # raw and score must be genuinely DIFFERENT numbers (catches an impl
        # that conflates the two — the exact inversion bug).
        assert abs(raw - score) > 0.02, (
            f"raw_solidity ({raw}) and score ({score}) are suspiciously equal "
            "— the metric is still conflated/inverted")

    def test_detail_echoes_raw_not_inverted(self, test_gds, anaconda_has_deps):
        """The human/agent-readable detail must contain the RAW solidity, and
        must NOT present (1-solidity) under a bare 'solidity: <n>' label."""
        chk = self._run_solidity(test_gds, "mesa", threshold=0.9, direction="below")
        raw = chk["raw_solidity"]
        detail = chk["detail"]
        # Parse the numeric token rendered after 'raw=' and assert it equals the
        # geometric raw_solidity — decoupled from the printf precision, so a
        # valid impl that prints a different number of decimals still passes,
        # but one that renders the INVERTED value (the bug) fails.
        m = re.search(r"raw=([0-9.]+)", detail)
        assert m, f"detail must render 'raw=<solidity>': {detail!r}"
        assert abs(float(m.group(1)) - raw) < 1e-3, (
            f"detail raw= ({m.group(1)}) must equal raw_solidity ({raw}), "
            "not the inverted (1-solidity) value")
        # the OLD buggy format printed exactly "solidity: <1-raw>" — assert
        # the inverted value is not presented as the bare solidity figure.
        inverted = 1.0 - raw
        assert "solidity: {:.4f}".format(inverted) not in detail, (
            f"detail still prints the inverted value as 'solidity:': {detail!r}")

    def test_above_direction_raw_matches_score(self, test_gds, anaconda_has_deps):
        """A solid convex rectangle (region_a) has solidity ~1.0; for
        direction='above' the score equals raw solidity (coincidentally
        correct label pre-fix) — raw must still be exposed and consistent."""
        chk = self._run_solidity(test_gds, "region_a", threshold=0.5, direction="above")
        raw = chk.get("raw_solidity")
        assert raw is not None, "raw_solidity must be exposed for direction=above too"
        assert raw > 0.95, f"solid rectangle should have solidity ~1.0, got {raw}"
        assert abs(chk["score"] - raw) < 1e-3, (
            f"above-direction score ({chk['score']}) should equal raw solidity ({raw})")


# ===========================================================================
# Issue #9 — bulk_containment core_bbox=True raises a cryptic
# 'object of type bool has no len()' TypeError. Fix: actionable validation.
# Also: valid core_bbox=[x1,y1,x2,y2] path has NO existing test.
# ===========================================================================

class TestBulkContainmentCoreBbox:
    def _run(self, test_gds, args):
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "bulk_containment", "args": args, "weight": 1.0}],
        }
        return _run_worker(config)

    def _run_core(self, test_gds, core_bbox, bulk_region="region_a"):
        return self._run(test_gds, {"component": "mesa", "bulk_region": bulk_region,
                                    "core_bbox": core_bbox})

    def test_core_bbox_true_actionable_error(self, test_gds, anaconda_has_deps):
        """core_bbox=True must surface an ACTIONABLE error naming core_bbox and
        its expected [x1,y1,x2,y2] shape — not the cryptic bool-len TypeError."""
        rc, result, stderr = self._run_core(test_gds, True)
        assert rc == 0 and result is not None, f"worker crashed: {stderr[:300]}"
        chk = result["checks"][0]
        assert chk.get("status") == "error", (
            "core_bbox=True must be flagged status=error (not a false 0.0)")
        msg = (chk.get("error", "") + " " + chk.get("detail", "")).lower()
        assert "has no len" not in msg, (
            f"cryptic bool-len TypeError still leaks to the agent: {msg!r}")
        # actionable: names core_bbox AND describes the 4-number form (both, so a
        # one-word echo cannot satisfy it).
        assert "core_bbox" in msg, f"error must name core_bbox; got: {msg!r}"
        assert any(tok in msg for tok in ("x1", "four", "[x1")), (
            f"error must describe the expected [x1,y1,x2,y2] form; got: {msg!r}")

    def test_core_bbox_malformed_list_actionable_error(self, test_gds, anaconda_has_deps):
        """A list of the wrong length or non-numeric entries must also raise an
        actionable error (not crash, not silently proceed)."""
        for bad in ([1, 2, 3], ["a", "b", "c", "d"]):
            rc, result, stderr = self._run_core(test_gds, bad)
            assert rc == 0 and result is not None, f"worker crashed on {bad}: {stderr[:200]}"
            chk = result["checks"][0]
            assert chk.get("status") == "error", f"core_bbox={bad} must error"
            msg = (chk.get("error", "") + " " + chk.get("detail", "")).lower()
            assert "core_bbox" in msg, f"error for {bad} must name core_bbox: {msg!r}"

    def test_valid_core_bbox_actually_clips(self, test_gds, anaconda_has_deps):
        """A valid core_bbox must CUT the component, changing the measured
        containment. Discriminator: bulk_region=region_b (x>=0,y>=0) only
        partially contains the mesa, so unclipped containment < 1.0; clipping
        the mesa to its in-region_b quadrant raises containment to ~1.0. If
        core_bbox were ignored, the two scores would be equal."""
        rc0, res0, err0 = self._run(test_gds, {"component": "mesa", "bulk_region": "region_b"})
        rc1, res1, err1 = self._run_core(test_gds, [0, 0, 40, 25], bulk_region="region_b")
        assert rc0 == 0 and rc1 == 0 and res0 and res1, f"worker failed: {err0[:150]}{err1[:150]}"
        c0, c1 = res0["checks"][0], res1["checks"][0]
        assert c0.get("status") != "error" and c1.get("status") != "error"
        unclipped, clipped = c0["score"], c1["score"]
        assert unclipped < 0.95, (
            f"mesa should only PARTIALLY sit in region_b unclipped; got {unclipped}")
        assert clipped > unclipped + 0.05, (
            f"clipping to the in-region_b quadrant must raise containment "
            f"(unclipped={unclipped}, clipped={clipped}); core_bbox appears ignored")
        assert clipped > 0.9, f"clipped mesa should be ~fully in region_b; got {clipped}"


# ===========================================================================
# Issue #1 — route_material_compat (and every primitive) must be registered
# IDENTICALLY in the MCP server (.lym _known_primitives) and the worker
# (evaluate_worker.PRIMITIVES). The 2026-06-05 sweep failed because the .lym
# lagged the worker. Guard the two registries against future drift.
# ===========================================================================

def _worker_primitive_names():
    """Authoritative set of primitive names registered in the worker."""
    src = open(WORKER_PATH).read()
    # The PRIMITIVES dict maps "name": _prim_xxx,
    block = re.search(r"PRIMITIVES\s*=\s*\{(.*?)\}", src, re.DOTALL)
    assert block, "could not locate PRIMITIVES dict in evaluate_worker.py"
    names = set(re.findall(r'"([a-zA-Z0-9_]+)"\s*:\s*_prim_', block.group(1)))
    assert names, "parsed an EMPTY worker PRIMITIVES set (regex/format drift)"
    return names


def _lym_known_primitives():
    """The primitive allow-list baked into the MCP server macro."""
    src = open(LYM_PATH).read()
    m = re.search(r"_known_primitives\s*=\s*\[(.*?)\]", src, re.DOTALL)
    assert m, "could not locate _known_primitives list in klayoutclaw_server.lym"
    names = set(re.findall(r'"([a-zA-Z0-9_]+)"', m.group(1)))
    assert names, "parsed an EMPTY _known_primitives set (regex/format drift)"
    return names


def _lym_required_args_keys():
    """Keys of the .lym _required_args table (the THIRD co-located registry)."""
    src = open(LYM_PATH).read()
    m = re.search(r"_required_args\s*=\s*\{(.*?)\n    \}", src, re.DOTALL)
    assert m, "could not locate _required_args in klayoutclaw_server.lym"
    keys = set(re.findall(r'"([a-zA-Z0-9_]+)"\s*:', m.group(1)))
    assert keys, "parsed an EMPTY _required_args key set (regex/format drift)"
    return keys


# ===========================================================================
# Issue #3 — auto_route grids the ENTIRE cell bbox, not the pin sub-region.
# Fine map_resolution then OOM-kills / times out when pads sit on a far
# perimeter or unrelated geometry inflates cell.bbox(). Fix: crop the cost
# grid to the pin sub-region (+ slack), clamp to the cell, and guard the
# grid-cell count to auto-coarsen before numpy OOM.
# ===========================================================================

import subprocess as _sp  # noqa: E402
import tempfile as _tf    # noqa: E402

ROUTE_WORKER = os.path.join(PROJECT_ROOT, "tools", "route_worker.py")


def _run_route_worker(gds, cfg):
    with _tf.TemporaryDirectory() as td:
        out_json = os.path.join(td, "out.json")
        full = {
            "gds_path": gds, "pin_layer_a": "100/0", "pin_layer_b": "101/0",
            "output_layer": "10/0", "obstacle_layers": [],
            "path_width_um": 1.0, "map_resolution_um": 1.0,
            "output_path": out_json,
        }
        full.update(cfg)
        proc = _sp.run([ANACONDA_PYTHON, ROUTE_WORKER,
                        _write_cfg(td, full)], capture_output=True,
                       text=True, timeout=120)
        if os.path.isfile(out_json):
            import json as _j
            return _j.load(open(out_json)), proc
        return None, proc


def _write_cfg(td, cfg):
    import json as _j
    p = os.path.join(td, "cfg.json")
    _j.dump(cfg, open(p, "w"))
    return p


def _make_corner_cluster_gds(tmp_path, far_um=3000.0):
    """Pins clustered in a ~50um corner; a decorative shape far away inflates
    cell.bbox() to far_um. The routing window must follow the PINS, not the
    full cell."""
    import gdstk
    lib = gdstk.Library()
    top = lib.new_cell("TOP")
    # pin A column (layer 100), pin B column (layer 101) — span ~40x50 um
    top.add(gdstk.rectangle((0, 0), (2, 2), layer=100, datatype=0))
    top.add(gdstk.rectangle((0, 50), (2, 52), layer=100, datatype=0))
    top.add(gdstk.rectangle((40, 0), (42, 2), layer=101, datatype=0))
    top.add(gdstk.rectangle((40, 50), (42, 52), layer=101, datatype=0))
    # far-away decorative (non-pin, non-obstacle) shape inflates cell bbox
    top.add(gdstk.rectangle((far_um, far_um), (far_um + 2, far_um + 2),
                            layer=200, datatype=0))
    p = str(tmp_path / "corner.gds")
    lib.write_gds(p)
    return p


class TestAutoRoutePinBboxCrop:
    def test_grid_follows_pins_not_cell_bbox(self, tmp_path, anaconda_has_deps):
        """With pins in a 40x50um corner and a decorative shape 3000um away,
        the routing grid must be sized by the pin span (+ slack), NOT the
        ~3000um cell bbox. Pre-fix: grid spans the whole cell (~3000 cells/side
        at 1um) and the result carries no routing_grid info."""
        if not os.path.isfile(ANACONDA_PYTHON):
            pytest.skip("anaconda python missing")
        try:
            import gdstk  # noqa: F401
        except ImportError:
            pytest.skip("gdstk missing")
        gds = _make_corner_cluster_gds(tmp_path, far_um=3000.0)
        result, proc = _run_route_worker(gds, {"map_resolution_um": 1.0})
        assert result is not None, f"worker produced no output: {proc.stderr[:400]}"
        grid = result.get("routing_grid")
        assert grid is not None, (
            "auto_route must report routing_grid {rows,cols,window_um}; "
            "pre-fix code has no pin-bbox crop and reports nothing. "
            f"result keys: {sorted(result.keys())}")
        # pin span ~50um; even with generous slack the window is << 3000um.
        # Tighter than a full-cell grid (~3000 cells/side at 1um); post-fix ~92.
        assert grid["cols"] < 300 and grid["rows"] < 300, (
            f"routing grid {grid['rows']}x{grid['cols']} still spans the full "
            f"cell, not the pin sub-region")
        # crop magnitude is explicit: far below the full-cell cell count.
        assert grid["cells"] < 200_000, (
            f"routing grid has {grid['cells']} cells — not cropped to the pins")
        # the window must still COVER the pin span (0..42 x, 0..52 y) so routing
        # is not clipped away from the pins.
        win = grid["window_um"]
        assert win[0] <= 0 and win[1] <= 0 and win[2] >= 42 and win[3] >= 52, (
            f"routing window {win} does not contain the pin span [0,0,42,52]")
        # and routing still succeeds for both pairs
        assert result["status"] in ("success", "partial", "dry_run")
        assert result.get("routed_pairs", 0) >= 1, (
            f"routing should still connect the clustered pins: {result.get('errors')}")

    def test_cellcount_guard_coarsens_before_oom(self, tmp_path, anaconda_has_deps):
        """A genuinely large pin span at very fine resolution would allocate a
        billion-cell grid (OOM). The guard must auto-coarsen map_resolution to
        stay under the cell cap instead of getting SIGKILLed. Uses dry_run so
        no heavy Dijkstra runs."""
        if not os.path.isfile(ANACONDA_PYTHON):
            pytest.skip("anaconda python missing")
        try:
            import gdstk
        except ImportError:
            pytest.skip("gdstk missing")
        lib = gdstk.Library()
        top = lib.new_cell("TOP")
        # pins on a 2000x2000um diagonal -> genuinely large 2D window; at
        # 0.05um that is ~40000x40000 = 1.6e9 cells, far over the cap.
        top.add(gdstk.rectangle((0, 0), (2, 2), layer=100, datatype=0))
        top.add(gdstk.rectangle((2000, 2000), (2002, 2002), layer=101, datatype=0))
        gds = str(tmp_path / "wide.gds")
        lib.write_gds(gds)
        requested = 0.05
        result, proc = _run_route_worker(
            gds, {"map_resolution_um": requested, "dry_run": True})
        assert result is not None, f"worker crashed (OOM?): {proc.stderr[:400]}"
        used = result.get("map_resolution_um_used")
        assert used is not None and used > requested, (
            f"cell-count guard must coarsen map_resolution above {requested} "
            f"um to avoid OOM; got {used}")
        # the guard's actual job: the resulting grid must be under the cap.
        grid = result.get("routing_grid")
        assert grid is not None and grid["cells"] <= 25_000_000, (
            f"grid still over the 25M cap after coarsening: {grid}")


# ===========================================================================
# Issue #7 — unknown arg keys silently ignored; check schema undiscoverable.
# Static guards on the .lym validation tables (the live-server behavioural
# test lives in the Phase-5 MCP suite). Issue #14 — route_inspect tolerance.
# ===========================================================================

def _lym_table(name):
    """Parse a `name = { ... }` dict-of-lists from the .lym (best-effort)."""
    src = open(LYM_PATH).read()
    m = re.search(name + r"\s*=\s*\{(.*?)\n    \}", src, re.DOTALL)
    if not m:
        m = re.search(name + r"\s*=\s*\{(.*?)\}", src, re.DOTALL)
    body = m.group(1)
    out = {}
    for km, lm in re.findall(r'"([a-z_]+)"\s*:\s*\[([^\]]*)\]', body):
        out[km] = set(re.findall(r'"([a-z_]+)"', lm))
    return out


class TestCheckArgValidation:
    def test_allowed_args_superset_of_worker_reads(self):
        """Every arg the worker actually reads must be in the .lym _allowed_args
        for that primitive — otherwise the new unknown-key rejection would wrongly
        reject a legitimate call. Cross-checks the two files (drift guard)."""
        allowed = _lym_table("_allowed_args")
        assert allowed, "could not parse _allowed_args from .lym"
        wsrc = open(WORKER_PATH).read()
        funcs = re.findall(
            r"def (_prim_\w+)\(out_lib[^)]*\):(.*?)(?=\ndef |\nPRIMITIVES|\Z)",
            wsrc, re.DOTALL)
        for fname, body in funcs:
            prim = fname.replace("_prim_", "")
            if prim not in allowed:
                continue
            reads = set(re.findall(r"args\[[\"'](\w+)[\"']\]", body)) | \
                set(re.findall(r"args\.get\([\"'](\w+)[\"']", body))
            missing = reads - allowed[prim]
            assert not missing, (
                f"{prim}: worker reads {sorted(missing)} but .lym _allowed_args "
                f"does not list them -> a valid call would be rejected")

    def test_describe_checks_branch_present(self):
        """The .lym must short-circuit on describe_checks and return the registry."""
        src = open(LYM_PATH).read()
        assert 'args.get("describe_checks")' in src
        assert '"describe_checks": {' in src

    def test_unknown_arg_rejected_in_lym(self):
        """The validation loop must reject unknown arg keys (not silently ignore)."""
        src = open(LYM_PATH).read()
        assert "has unknown arg" in src, (
            "unknown-arg rejection missing from evaluate_design validation")


class TestRouteInspectTolerance:
    def test_default_tolerance_matches_connectivity(self):
        """route_inspect default tolerance must be 15.0 to agree with
        evaluate_design connectivity/route_endpoints (which default 15.0)."""
        src = open(LYM_PATH).read()
        m = re.search(r'tolerance_um\s*=\s*float\(args\.get\("tolerance_um",\s*([0-9.]+)\)\)', src)
        assert m, "could not find route_inspect tolerance_um default"
        assert float(m.group(1)) == 15.0, (
            f"route_inspect tolerance default is {m.group(1)}, expected 15.0 "
            "to match connectivity/route_endpoints")


# ===========================================================================
# Issue #18 — skill SKILL.md files hardcoded `conda run -n instrMCPdev python`,
# which fails on hosts without that conda env (the docker image uses /opt/venv).
# Fix: every invocation goes through ${PYTHON_PATH:-conda run -n instrMCPdev
# python} so the harness can export PYTHON_PATH once and override uniformly.
# ===========================================================================

class TestSkillInterpreterIndirection:
    SKILLS = [
        "skills/nanodevice_flakedetect_align/SKILL.md",
        "skills/nanodevice_flakedetect_detect/SKILL.md",
        "skills/nanodevice_flakedetect_combine/SKILL.md",
        "skills/nanodevice_gdsalign/SKILL.md",
    ]

    def test_no_bare_conda_invocation(self):
        """No SKILL.md may invoke `conda run -n instrMCPdev python` without the
        ${PYTHON_PATH:-...} indirection in front of it."""
        bare = re.compile(r"(?<!PYTHON_PATH:-)conda run -n instrMCPdev python")
        offenders = []
        for rel in self.SKILLS:
            src = open(os.path.join(PROJECT_ROOT, rel)).read()
            for ln, line in enumerate(src.splitlines(), 1):
                # strip the wrapped form, then see if a bare one remains
                stripped = line.replace("${PYTHON_PATH:-conda run -n instrMCPdev python}", "")
                if "conda run -n instrMCPdev python" in stripped:
                    offenders.append(f"{rel}:{ln}: {line.strip()[:80]}")
        assert not offenders, "bare conda invocation(s) found:\n" + "\n".join(offenders)

    def test_indirection_actually_present(self):
        """Guard against a vacuous pass: each skill that runs scripts must
        actually use the ${PYTHON_PATH:-...} form at least once."""
        for rel in self.SKILLS:
            src = open(os.path.join(PROJECT_ROOT, rel)).read()
            assert "${PYTHON_PATH:-conda run -n instrMCPdev python}" in src, (
                f"{rel} has no PYTHON_PATH indirection")


# ===========================================================================
# Issue #8 — auto_route map_resolution too coarse for tight contact pitch.
# auto_map_resolution now floors the grid against pitch/2 (not just edge/3) so
# closely-spaced (large/overlapping) markers get a fine-enough grid.
# ===========================================================================

class TestAutoMapResolutionPitchFloor:
    def test_resolution_resolves_pitch(self, tmp_path, anaconda_has_deps):
        """Large 8um markers spaced 5um apart: edge/3 (~2.7) would under-resolve
        the 5um pitch; the pitch floor must pull map_resolution to <= pitch/2
        (2.5). Pre-fix (edge/3 only) yields ~2.7 and fails."""
        if not os.path.isfile(ANACONDA_PYTHON):
            pytest.skip("anaconda python missing")
        try:
            import gdstk
        except ImportError:
            pytest.skip("gdstk missing")
        lib = gdstk.Library()
        top = lib.new_cell("TOP")
        # 8um-wide markers, centres 5um apart in y -> pitch 5um, edge 8um
        for cy in (0, 5):
            top.add(gdstk.rectangle((-4, cy - 4), (4, cy + 4), layer=100, datatype=0))
            top.add(gdstk.rectangle((26, cy - 4), (34, cy + 4), layer=101, datatype=0))
        gds = str(tmp_path / "pitch.gds")
        lib.write_gds(gds)
        result, proc = _run_route_worker(
            gds, {"map_resolution_um": 5.0, "auto_map_resolution": True, "dry_run": True})
        assert result is not None, f"worker failed: {proc.stderr[:300]}"
        used = result["map_resolution_um_used"]
        pitch_half = 5.0 / 2.0
        assert used <= pitch_half + 0.05, (
            f"map_resolution {used} does not resolve the 5um pitch "
            f"(need <= {pitch_half}); pitch floor not applied")


class TestRegistrySync:
    def test_route_material_compat_in_both(self):
        worker = _worker_primitive_names()
        lym = _lym_known_primitives()
        assert len(worker) >= 12 and len(lym) >= 12  # guard against empty parse
        assert "route_material_compat" in worker
        assert "route_material_compat" in lym

    def test_registries_are_set_equal(self):
        """The .lym allow-list and the worker dispatch table must be identical.
        Any one-sided primitive add (the exact 2026-06-05 failure mode) fails
        here in CI instead of silently aborting an evaluate_design batch."""
        worker = _worker_primitive_names()
        lym = _lym_known_primitives()
        assert worker == lym, (
            "evaluate_design registries drifted.\n"
            f"  in worker only: {sorted(worker - lym)}\n"
            f"  in .lym only:   {sorted(lym - worker)}")
        assert len(worker) >= 12, f"expected >=12 primitives, got {len(worker)}"

    def test_required_args_registry_in_sync(self):
        """The THIRD co-located registry (_required_args) must cover exactly the
        same primitive set — a primitive added to _known_primitives + worker but
        forgotten in _required_args still breaks at runtime."""
        lym = _lym_known_primitives()
        req = _lym_required_args_keys()
        assert req == lym, (
            "_required_args keys drifted from _known_primitives.\n"
            f"  missing from _required_args: {sorted(lym - req)}\n"
            f"  extra in _required_args:     {sorted(req - lym)}")
