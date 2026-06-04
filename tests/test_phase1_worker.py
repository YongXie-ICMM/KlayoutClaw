#!/usr/bin/env python
"""Tests for tools/evaluate_worker.py -- configurable device design evaluator.

Tests exercise the worker script by running it as a subprocess and
validating: config parsing, primitive execution, error handling, and
score computation.

Requirements:
- gdstk, shapely, numpy must be available (via anaconda3 python)
"""

import json
import os
import subprocess
import tempfile

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER_PATH = os.path.join(PROJECT_ROOT, "tools", "evaluate_worker.py")
ANACONDA_PYTHON = os.path.expanduser("~/anaconda3/bin/python3")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_worker(config_dict, python_path=None):
    """Run evaluate_worker.py with the given config dict."""
    tmp_dir = tempfile.mkdtemp(prefix="test_eval_worker_")
    config_path = os.path.join(tmp_dir, "config.json")
    output_path = os.path.join(tmp_dir, "output.json")

    config_dict["output_path"] = output_path
    with open(config_path, "w") as f:
        json.dump(config_dict, f)

    py = python_path or ANACONDA_PYTHON
    try:
        proc = subprocess.run(
            [py, WORKER_PATH, config_path],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return (-1, None, "timeout")

    output_dict = None
    if os.path.isfile(output_path):
        with open(output_path, "r") as f:
            output_dict = json.load(f)

    for p in [config_path, output_path]:
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp_dir)
    except OSError:
        pass

    return (proc.returncode, output_dict, proc.stderr)


def _make_test_gds():
    """Create a synthetic GDS with geometry for testing primitives."""
    tmp = tempfile.mktemp(suffix=".gds", prefix="test_eval_")
    script = f'''
import gdstk

lib = gdstk.Library()
cell = lib.new_cell("TOP")

# Region A (layer 10/0): large square
cell.add(gdstk.rectangle((-50, -50), (50, 50), layer=10, datatype=0))

# Region B (layer 11/0): overlapping square
cell.add(gdstk.rectangle((0, 0), (100, 100), layer=11, datatype=0))

# Component C (layer 20/0): H-shaped mesa within region A
channel = gdstk.rectangle((-30, -5), (30, 5), layer=20, datatype=0)
probe_l = gdstk.rectangle((-15, -20), (-10, 20), layer=20, datatype=0)
probe_r = gdstk.rectangle((10, -20), (15, 20), layer=20, datatype=0)
cell.add(channel, probe_l, probe_r)

# Contact patches (layer 21/0): at probe tips
cp1 = gdstk.rectangle((-17, 18), (-8, 25), layer=21, datatype=0)
cp2 = gdstk.rectangle((-17, -25), (-8, -18), layer=21, datatype=0)
cp3 = gdstk.rectangle((8, 18), (17, 25), layer=21, datatype=0)
cp4 = gdstk.rectangle((8, -25), (17, -18), layer=21, datatype=0)
cell.add(cp1, cp2, cp3, cp4)

# Routes (layer 30/0): connecting patches to pads
r1 = gdstk.FlexPath([(-12, 25), (-12, 80)], 2, layer=30, datatype=0)
r2 = gdstk.FlexPath([(-12, -25), (-12, -80)], 2, layer=30, datatype=0)
r3 = gdstk.FlexPath([(12, 25), (12, 80)], 2, layer=30, datatype=0)
r4 = gdstk.FlexPath([(12, -25), (12, -80)], 2, layer=30, datatype=0)
cell.add(r1, r2, r3, r4)

# Bonding pads (layer 40/0)
bp1 = gdstk.rectangle((-22, 80), (-2, 100), layer=40, datatype=0)
bp2 = gdstk.rectangle((-22, -100), (-2, -80), layer=40, datatype=0)
bp3 = gdstk.rectangle((2, 80), (22, 100), layer=40, datatype=0)
bp4 = gdstk.rectangle((2, -100), (22, -80), layer=40, datatype=0)
cell.add(bp1, bp2, bp3, bp4)

lib.write_gds("{tmp}")
print("OK")
'''
    proc = subprocess.run(
        [ANACONDA_PYTHON, "-c", script],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode == 0 and os.path.isfile(tmp):
        return tmp
    return None


LAYER_MAP = {
    "region_a": [10, 0],
    "region_b": [11, 0],
    "mesa": [20, 0],
    "contact_patch": [21, 0],
    "contact_route": [30, 0],
    "bonding_pad": [40, 0],
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def anaconda_has_deps():
    if not os.path.isfile(ANACONDA_PYTHON):
        pytest.skip(f"Anaconda python not found at {ANACONDA_PYTHON}")
    proc = subprocess.run(
        [ANACONDA_PYTHON, "-c", "import gdstk; import shapely; import numpy; print('OK')"],
        capture_output=True, text=True, timeout=15,
    )
    if proc.returncode != 0:
        pytest.skip(f"Missing dependencies: {proc.stderr.strip()}")
    return True


@pytest.fixture(scope="session")
def test_gds(anaconda_has_deps):
    path = _make_test_gds()
    if path is None:
        pytest.skip("Could not create test GDS")
    yield path
    try:
        os.remove(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Test: Worker Script Basics
# ---------------------------------------------------------------------------

class TestWorkerExists:
    def test_worker_script_exists(self):
        assert os.path.isfile(WORKER_PATH)

    def test_worker_compiles(self):
        proc = subprocess.run(
            [ANACONDA_PYTHON, "-c",
             f"import py_compile; py_compile.compile('{WORKER_PATH}', doraise=True)"],
            capture_output=True, text=True, timeout=15,
        )
        assert proc.returncode == 0, f"Syntax errors: {proc.stderr}"


# ---------------------------------------------------------------------------
# Test: Config Validation
# ---------------------------------------------------------------------------

class TestConfigValidation:
    def test_missing_checks_errors(self, test_gds, anaconda_has_deps):
        """Config without 'checks' must produce error status."""
        config = {"gds_path": test_gds, "layer_map": LAYER_MAP}
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"
        assert "checks" in result.get("error", "").lower()

    def test_empty_checks_errors(self, test_gds, anaconda_has_deps):
        """Empty checks list must produce error status."""
        config = {"gds_path": test_gds, "layer_map": LAYER_MAP, "checks": []}
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"

    def test_unknown_primitive_errors(self, test_gds, anaconda_has_deps):
        """Unknown check name must produce error status."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "nonexistent_check", "weight": 1.0}],
        }
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"
        assert "nonexistent_check" in result.get("error", "")

    def test_nonexistent_gds_errors(self, anaconda_has_deps):
        """Non-existent GDS must produce error status."""
        config = {
            "gds_path": "/tmp/nonexistent_12345.gds",
            "layer_map": LAYER_MAP,
            "checks": [{"name": "solidity", "args": {"component": "mesa"}, "weight": 1.0}],
        }
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"

    def test_no_config_arg_exits_nonzero(self, anaconda_has_deps):
        """Worker must exit non-zero without config argument."""
        proc = subprocess.run(
            [ANACONDA_PYTHON, WORKER_PATH],
            capture_output=True, text=True, timeout=15,
        )
        assert proc.returncode != 0


# ---------------------------------------------------------------------------
# Test: Primitives
# ---------------------------------------------------------------------------

class TestPrimitives:
    def test_component_overlap(self, test_gds, anaconda_has_deps):
        """Mesa overlaps region_a -- score should be > 0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "component_overlap",
                         "args": {"component": "mesa", "region": "region_a"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["status"] == "ok"
        assert result["checks"][0]["score"] > 0.0

    def test_component_containment(self, test_gds, anaconda_has_deps):
        """Mesa is mostly within region_a -- containment score should be > 0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "component_containment",
                         "args": {"component": "mesa", "region": "region_a"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_region_op_intersection(self, test_gds, anaconda_has_deps):
        """Containment with intersection of two regions."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "component_containment",
                         "args": {"component": "mesa",
                                  "region": ["region_a", "region_b"],
                                  "region_op": "intersection"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        # intersection of A and B is smaller, so containment should be lower
        assert 0.0 <= result["checks"][0]["score"] <= 1.0

    def test_contact_isolation(self, test_gds, anaconda_has_deps):
        """Routes should not cross -- isolation score should be 1.0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "contact_isolation",
                         "args": {"component": "contact_route"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] == 1.0

    def test_connectivity(self, test_gds, anaconda_has_deps):
        """All contacts should reach pads -- connectivity > 0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "connectivity",
                         "args": {"contact_component": "contact_patch",
                                  "pad_component": "bonding_pad",
                                  "route_component": "contact_route"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_adjacency(self, test_gds, anaconda_has_deps):
        """Contact patches should be near mesa."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "adjacency",
                         "args": {"component_a": "contact_patch",
                                  "component_b": "mesa",
                                  "tolerance": 5.0},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_solidity_below(self, test_gds, anaconda_has_deps):
        """H-shaped mesa should have solidity < 0.5."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "solidity",
                         "args": {"component": "mesa", "threshold": 0.5, "direction": "below"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_spacing(self, test_gds, anaconda_has_deps):
        """Contact patches should be spaced apart."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "spacing",
                         "args": {"component_a": "contact_patch",
                                  "component_b": "contact_patch",
                                  "min_distance": 1.0},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0


# ---------------------------------------------------------------------------
# Test: arm_material_class accepts all reasonable `classes` forms
#
# Regression for the 2026-06-03 harness bug: the primitive only handled the
# dict form {name, region, region_op} and crashed with
#   "list indices must be integers or slices, not str"
# on the nested-list form [["graphene"], ["graphite"]] that agents actually
# use. A crashing check is then scored 0.0 at full weight (false zero).
# ---------------------------------------------------------------------------

class TestArmMaterialClass:
    def _run(self, test_gds, classes):
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "arm_material_class",
                         "args": {"component": "contact_patch",
                                  "classes": classes,
                                  "containment_threshold": 0.8},
                         "weight": 1.0}],
        }
        return _run_worker(config)

    def test_nested_list_form_does_not_crash(self, test_gds, anaconda_has_deps):
        """[['region_a'], ['region_b']] must return a real score, not ERROR."""
        rc, result, stderr = self._run(test_gds, [["region_a"], ["region_b"]])
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        chk = result["checks"][0]
        assert "ERROR" not in chk["detail"], chk["detail"]
        assert 0.0 <= chk["score"] <= 1.0

    def test_bare_string_form(self, test_gds, anaconda_has_deps):
        """['region_a', 'region_b'] (list of bare keys) must work."""
        rc, result, stderr = self._run(test_gds, ["region_a", "region_b"])
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert "ERROR" not in result["checks"][0]["detail"]

    def test_dict_form_still_works(self, test_gds, anaconda_has_deps):
        """The documented dict form must keep working (regression guard)."""
        rc, result, stderr = self._run(
            test_gds,
            [{"name": "a", "region": "region_a"}, {"name": "b", "region": "region_b"}],
        )
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert "ERROR" not in result["checks"][0]["detail"]

    def test_all_forms_agree(self, test_gds, anaconda_has_deps):
        """Nested-list, bare-string, and dict forms are equivalent → same score."""
        s = []
        for classes in (
            [["region_a"], ["region_b"]],
            ["region_a", "region_b"],
            [{"region": "region_a"}, {"region": "region_b"}],
        ):
            rc, result, _ = self._run(test_gds, classes)
            assert rc == 0 and result is not None
            s.append(result["checks"][0]["score"])
        assert max(s) - min(s) < 1e-6, f"forms disagree: {s}"

    def test_malformed_class_gives_actionable_error(self, test_gds, anaconda_has_deps):
        """A genuinely invalid class entry yields a clear message naming the
        accepted forms — not a cryptic TypeError."""
        rc, result, stderr = self._run(test_gds, [42])
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        detail = result["checks"][0]["detail"]
        assert "arm_material_class" in detail
        # Must mention how to fix it (a key, a list of keys, or a dict).
        assert "list of keys" in detail or "layer_map key" in detail or "dict" in detail


# ---------------------------------------------------------------------------
# Test: route_material_compat — ohmic routes must stay off the opposing flake
#
# Mirrors composite_evaluator._check_route_material_compat (Metric 10 / Bug #8).
# A live HM11 e2e run scored 0.74 capped by route_material_compat=0.125 (two
# ohmic routes crossing graphite) precisely because the agent had NO self-check
# primitive for this. This class drives both the clean case (no short) and the
# shorted case (route sweeps the opposing flake → violating_routes populated).
# ---------------------------------------------------------------------------

# Layers: graphene L11, graphite L13 (mirrors the official scorer's
# REF_GRAPHENE=(11,0) / REF_GRAPHITE=(13,0)). Two disjoint flakes side by side.
RMC_LAYER_MAP = {
    "graphene": [11, 0],
    "graphite": [13, 0],
    "contact_patch": [21, 0],
    "contact_route": [30, 0],
}


def _make_route_material_gds(crossing):
    """Build a synthetic GDS for route_material_compat.

    Geometry (all µm):
      - graphene flake L11: x in [-60, -10], y in [-40, 40]  (left)
      - graphite flake L13: x in [ 10,  60], y in [-40, 40]  (right)
      - one graphene_only ohmic contact patch sitting well inside graphene
        at x in [-45, -35], y in [-5, 5]
      - one route attached to that patch.

    crossing=False: the route runs LEFT, away from the graphite flake → it
        sweeps 0 µm² of graphite → contact passes → score 1.0.
    crossing=True: the route runs RIGHT from the patch straight through the
        graphite flake (a fabricated short) → it sweeps a large graphite area
        → contact violates → score < 1.0, violating_routes non-empty with
        crossed_material == "graphite".
    """
    tmp = tempfile.mktemp(suffix=".gds", prefix="test_rmc_")
    if crossing:
        # Route from the patch (x=-40) rightward to x=40, at y=0, width 6 →
        # sweeps graphite x in [10,43], y in [-3,3] ≈ 33*6 = ~198 µm² ≫ 0.5.
        route_pts = "[(-40, 0), (40, 0)]"
    else:
        # Route from the patch leftward, out the side of the graphene flake →
        # never touches graphite.
        route_pts = "[(-40, 0), (-90, 0)]"
    script = f'''
import gdstk

lib = gdstk.Library()
cell = lib.new_cell("TOP")

# graphene flake (L11) — left
cell.add(gdstk.rectangle((-60, -40), (-10, 40), layer=11, datatype=0))
# graphite flake (L13) — right
cell.add(gdstk.rectangle((10, -40), (60, 40), layer=13, datatype=0))

# graphene_only ohmic contact patch (L21), deep inside graphene
cell.add(gdstk.rectangle((-45, -5), (-35, 5), layer=21, datatype=0))

# the ohmic route (L30)
cell.add(gdstk.FlexPath({route_pts}, 6, layer=30, datatype=0))

lib.write_gds("{tmp}")
print("OK")
'''
    proc = subprocess.run(
        [ANACONDA_PYTHON, "-c", script],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode == 0 and os.path.isfile(tmp):
        return tmp
    return None


@pytest.fixture(scope="session")
def rmc_clean_gds(anaconda_has_deps):
    path = _make_route_material_gds(crossing=False)
    if path is None:
        pytest.skip("Could not create clean route_material GDS")
    yield path
    try:
        os.remove(path)
    except OSError:
        pass


@pytest.fixture(scope="session")
def rmc_crossing_gds(anaconda_has_deps):
    path = _make_route_material_gds(crossing=True)
    if path is None:
        pytest.skip("Could not create crossing route_material GDS")
    yield path
    try:
        os.remove(path)
    except OSError:
        pass


class TestRouteMaterialCompat:
    def test_registered(self, rmc_clean_gds, anaconda_has_deps):
        """The primitive must be a known check name (not an unknown-primitive
        error)."""
        config = {
            "gds_path": rmc_clean_gds,
            "layer_map": RMC_LAYER_MAP,
            "checks": [{"name": "route_material_compat", "args": {}, "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result.get("status") == "ok", result

    def test_clean_scores_one_no_violations(self, rmc_clean_gds, anaconda_has_deps):
        """A graphene-contact route that never touches graphite → 1.0, no
        violating_routes."""
        config = {
            "gds_path": rmc_clean_gds,
            "layer_map": RMC_LAYER_MAP,
            "checks": [{"name": "route_material_compat", "args": {}, "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        chk = result["checks"][0]
        assert "ERROR" not in chk["detail"], chk["detail"]
        assert chk["score"] == 1.0, chk
        assert chk.get("violating_routes") == [], chk

    def test_missing_material_layers_errors_not_false_zero(self, rmc_clean_gds, anaconda_has_deps):
        """When layer_map omits the flake material layers, the check must raise an
        actionable ERROR (excluded from overall) — NOT a misleading 0.0 with an
        empty violating_routes list. Regression for the QH06 live-run bug where
        the benchmark result.json schema (no graphene/graphite) made the agent's
        evaluate_design call return a false route_material_compat=0.0."""
        lm = {k: v for k, v in RMC_LAYER_MAP.items() if k not in ("graphene", "graphite")}
        config = {
            "gds_path": rmc_clean_gds,
            "layer_map": lm,
            "checks": [{"name": "route_material_compat", "args": {}, "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        chk = result["checks"][0]
        assert chk.get("status") == "error", f"expected errored check, got {chk}"
        assert "material" in chk["detail"].lower() and "layer_map" in chk["detail"]
        assert result.get("n_errored_checks", 0) >= 1

    def test_crossing_scores_below_one_with_violation(self, rmc_crossing_gds, anaconda_has_deps):
        """A graphene-contact route sweeping through graphite → score < 1.0 and
        violating_routes non-empty, naming graphite as the crossed material."""
        config = {
            "gds_path": rmc_crossing_gds,
            "layer_map": RMC_LAYER_MAP,
            "checks": [{"name": "route_material_compat", "args": {}, "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        chk = result["checks"][0]
        assert "ERROR" not in chk["detail"], chk["detail"]
        assert chk["score"] < 1.0, chk
        vrs = chk.get("violating_routes")
        assert vrs, f"expected non-empty violating_routes, got {vrs}"
        v = vrs[0]
        assert v["crossed_material"] == "graphite", v
        assert v["contact_kind"] == "graphene_only", v
        assert v["area_um2"] > 0.5, v

    def test_violating_routes_format_present(self, rmc_crossing_gds, anaconda_has_deps):
        """The actionable-format legend is surfaced like crossing_pairs_format."""
        config = {
            "gds_path": rmc_crossing_gds,
            "layer_map": RMC_LAYER_MAP,
            "checks": [{"name": "route_material_compat", "args": {}, "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        chk = result["checks"][0]
        assert "violating_routes_format" in chk, chk

    def test_matches_official_scorer(self, rmc_clean_gds, rmc_crossing_gds, anaconda_has_deps):
        """Worker primitive score must agree with the official
        composite_evaluator._check_route_material_compat on the same layouts."""
        official = os.path.expanduser(
            "~/KLayout_Harbour/shared/composite_evaluator.py")
        if not os.path.isfile(official):
            pytest.skip("composite_evaluator.py not available for cross-check")

        for gds in (rmc_clean_gds, rmc_crossing_gds):
            # Official score (in-process import of the scorer).
            cross_script = f'''
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ce", "{official}")
ce = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ce)
import gdstk
lib = gdstk.read_gds("{gds}")
# Official scorer reads ref material from REF_GRAPHENE=(11,0)/REF_GRAPHITE=(13,0)
# in the *reference* lib; here out_lib == ref_lib (single GDS holds both
# flakes and routes), exactly as the cross-check intends.
layer_map = {{
    "graphene": [(11, 0)],
    "graphite": [(13, 0)],
    "contact_patch": [(21, 0)],
    "contact_route": [(30, 0)],
    "mesa": [],
    "topgate": [],
}}
score = ce._check_route_material_compat(lib, lib, layer_map)
print(repr(round(float(score), 6)))
'''
            proc = subprocess.run(
                [ANACONDA_PYTHON, "-c", cross_script],
                capture_output=True, text=True, timeout=60,
            )
            assert proc.returncode == 0, f"official scorer failed: {proc.stderr[:500]}"
            official_score = float(proc.stdout.strip())

            # Worker score.
            config = {
                "gds_path": gds,
                "layer_map": RMC_LAYER_MAP,
                "checks": [{"name": "route_material_compat", "args": {}, "weight": 1.0}],
            }
            rc, result, stderr = _run_worker(config)
            assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
            worker_score = float(result["checks"][0]["score"])

            assert abs(worker_score - official_score) < 1e-6, (
                f"gds={gds}: worker={worker_score} official={official_score}")


# ---------------------------------------------------------------------------
# Test: Score Computation
# ---------------------------------------------------------------------------

class TestScoreComputation:
    def test_overall_is_normalized_weighted_sum(self, test_gds, anaconda_has_deps):
        """Overall must equal sum(score*weight) / sum(weight)."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [
                {"name": "solidity", "args": {"component": "mesa", "threshold": 0.5, "direction": "below"}, "weight": 0.3},
                {"name": "contact_isolation", "args": {"component": "contact_route"}, "weight": 0.7},
            ],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        checks = result["checks"]
        expected = sum(c["score"] * c["weight"] for c in checks) / sum(c["weight"] for c in checks)
        assert abs(result["overall"] - round(expected, 6)) < 1e-4

    def test_errored_check_excluded_from_overall(self, test_gds, anaconda_has_deps):
        """A check that ERRORS must be flagged status=error and EXCLUDED from
        the weighted overall — not folded in as a full-weight 0.0 (false zero).
        Regression for the 2026-06-03 finding."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [
                {"name": "solidity",
                 "args": {"component": "mesa", "threshold": 0.5, "direction": "below"},
                 "weight": 0.5},
                # invalid class entry -> primitive raises -> errored check
                {"name": "arm_material_class",
                 "args": {"component": "mesa", "classes": [42]},
                 "weight": 0.5},
            ],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        checks = {c["name"]: c for c in result["checks"]}
        amc = checks["arm_material_class"]
        assert amc.get("status") == "error", f"expected status=error, got {amc}"
        assert "error" in amc, amc
        # Overall must equal the solidity score alone — the errored check is
        # excluded from BOTH numerator and denominator.
        sol = checks["solidity"]["score"]
        assert abs(result["overall"] - sol) < 1e-6, (result["overall"], sol)
        # next_step must mention the errored check so the agent fixes the call.
        assert "arm_material_class" in result["next_step_suggestion"]

    def test_scores_in_valid_range(self, test_gds, anaconda_has_deps):
        """All scores must be in [0.0, 1.0]."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [
                {"name": "component_overlap", "args": {"component": "mesa", "region": "region_a"}, "weight": 0.5},
                {"name": "adjacency", "args": {"component_a": "contact_patch", "component_b": "mesa", "tolerance": 5.0}, "weight": 0.5},
            ],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        for check in result["checks"]:
            assert 0.0 <= check["score"] <= 1.0

    def test_output_structure(self, test_gds, anaconda_has_deps):
        """Output must have status, overall, checks fields."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "solidity", "args": {"component": "mesa"}, "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert "status" in result
        assert "overall" in result
        assert "checks" in result
        assert isinstance(result["checks"], list)
        for check in result["checks"]:
            assert all(k in check for k in ["name", "score", "weight", "detail"])

    def test_default_weight_when_omitted(self, test_gds, anaconda_has_deps):
        """When weight is omitted, should default to 1/N."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [
                {"name": "solidity", "args": {"component": "mesa"}},
                {"name": "contact_isolation", "args": {"component": "contact_route"}},
            ],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        for check in result["checks"]:
            assert abs(check["weight"] - 0.5) < 1e-6
