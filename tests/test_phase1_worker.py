#!/usr/bin/env python
"""Tests for Phase 1: tools/evaluate_worker.py — the subprocess evaluator.

These tests exercise the actual worker script by running it as a subprocess
(or importing it) and validating its output JSON structure, scoring logic,
mode behavior, and error handling.

Requirements:
- gdstk, shapely, numpy must be available (via anaconda3 python)
- Test fixtures must exist at the paths referenced below
"""

import json
import os
import subprocess
import sys
import tempfile

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER_PATH = os.path.join(PROJECT_ROOT, "tools", "evaluate_worker.py")

# Test fixtures
REFERENCE_GDS = os.path.expanduser(
    "~/agenthle-base/tasks/chip_design/e2e_device_design/datasets/ml14/reference/Aligned_Stack.gds"
)
NEGATIVE_GDS = os.path.expanduser(
    "~/agenthle-base/tasks/chip_design/e2e_device_design/datasets/ml14/output_test_neg/result.gds"
)

# The Python with gdstk/shapely/numpy installed
ANACONDA_PYTHON = os.path.expanduser("~/anaconda3/bin/python3")

# Standard layer_map that matches the composite_evaluator's expected structure
# Maps component names to (layer, datatype) tuples
STANDARD_LAYER_MAP = {
    "mesa": [1, 0],
    "contact_patch": [2, 0],
    "topgate": [3, 0],
    "contact_route": [10, 0],
    "bonding_pad": [4, 0],
}

# Weights from the spec — per-check mapping for individual verification
SCORE_MODE_WEIGHT_MAP = {
    "mesa_on_overlap": 0.15,
    "contacts_in_regions": 0.15,
    "topgate": 0.10,
    "contact_isolation": 0.10,
    "connectivity": 0.10,
    "route_endpoints": 0.10,
    "contact_mesa_adjacency": 0.15,
    "mesa_probes": 0.15,
}
DRC_MODE_WEIGHT_MAP = {
    "topgate": 0.10,
    "contact_isolation": 0.10,
    "connectivity": 0.10,
    "route_endpoints": 0.10,
    "contact_mesa_adjacency": 0.15,
    "mesa_probes": 0.15,
}

# Ordered weight lists (kept for backward compat with sum tests)
SCORE_MODE_WEIGHTS = list(SCORE_MODE_WEIGHT_MAP.values())
DRC_MODE_WEIGHTS = list(DRC_MODE_WEIGHT_MAP.values())  # checks 3-8 only

EXPECTED_CHECK_NAMES = [
    "mesa_on_overlap",
    "contacts_in_regions",
    "topgate",
    "contact_isolation",
    "connectivity",
    "route_endpoints",
    "contact_mesa_adjacency",
    "mesa_probes",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_worker(config_dict, python_path=None):
    """Run evaluate_worker.py with the given config dict. Returns (returncode, output_dict_or_none, stderr)."""
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
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return (-1, None, "timeout")

    output_dict = None
    if os.path.isfile(output_path):
        with open(output_path, "r") as f:
            output_dict = json.load(f)

    # Cleanup
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


def _make_positive_gds():
    """Create a synthetic GDS with geometry on all required layers + reference flake layers.

    This is needed because no real positive output GDS exists in the test fixtures.
    Creates a minimal device that has shapes on mesa, contact_patch, topgate,
    contact_route, bonding_pad layers, placed within the reference flake bounds.
    """
    try:
        sys.path.insert(0, os.path.dirname(ANACONDA_PYTHON))
        # Use subprocess to create GDS via anaconda python
        tmp = tempfile.mktemp(suffix=".gds", prefix="test_positive_")
        script = f'''
import gdstk
import numpy as np

lib = gdstk.Library()
cell = lib.new_cell("TOP")

# Reference flake layers (graphene=11/0, graphite=13/0)
# Create overlapping graphene and graphite regions
graphene = gdstk.rectangle((-50, -50), (50, 50), layer=11, datatype=0)
graphite = gdstk.rectangle((-40, -40), (60, 60), layer=13, datatype=0)
cell.add(graphene, graphite)

# Mesa: H-shaped (hallbar) within the overlap region
# Main channel
mesa_channel = gdstk.rectangle((-30, -5), (30, 5), layer=1, datatype=0)
# Probes (vertical arms)
probe_left = gdstk.rectangle((-15, -20), (-10, 20), layer=1, datatype=0)
probe_right = gdstk.rectangle((10, -20), (15, 20), layer=1, datatype=0)
cell.add(mesa_channel, probe_left, probe_right)

# Contact patches: at probe ends, in single-material regions
cp1 = gdstk.rectangle((-17, 18), (-8, 25), layer=2, datatype=0)
cp2 = gdstk.rectangle((-17, -25), (-8, -18), layer=2, datatype=0)
cp3 = gdstk.rectangle((8, 18), (17, 25), layer=2, datatype=0)
cp4 = gdstk.rectangle((8, -25), (17, -18), layer=2, datatype=0)
cell.add(cp1, cp2, cp3, cp4)

# Topgate: over the channel, not touching contacts
tg = gdstk.rectangle((-8, -3), (8, 3), layer=3, datatype=0)
cell.add(tg)

# Contact routes: connecting patches to pads
r1 = gdstk.FlexPath([(-12, 25), (-12, 80)], 2, layer=10, datatype=0)
r2 = gdstk.FlexPath([(-12, -25), (-12, -80)], 2, layer=10, datatype=0)
r3 = gdstk.FlexPath([(12, 25), (12, 80)], 2, layer=10, datatype=0)
r4 = gdstk.FlexPath([(12, -25), (12, -80)], 2, layer=10, datatype=0)
cell.add(r1, r2, r3, r4)

# Bonding pads: at route ends
bp1 = gdstk.rectangle((-22, 80), (-2, 100), layer=4, datatype=0)
bp2 = gdstk.rectangle((-22, -100), (-2, -80), layer=4, datatype=0)
bp3 = gdstk.rectangle((2, 80), (22, 100), layer=4, datatype=0)
bp4 = gdstk.rectangle((2, -100), (22, -80), layer=4, datatype=0)
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
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def anaconda_has_deps():
    """Verify anaconda python has gdstk, shapely, numpy."""
    if not os.path.isfile(ANACONDA_PYTHON):
        pytest.skip(f"Anaconda python not found at {ANACONDA_PYTHON}")
    proc = subprocess.run(
        [ANACONDA_PYTHON, "-c", "import gdstk; import shapely; import numpy; print('OK')"],
        capture_output=True, text=True, timeout=15,
    )
    if proc.returncode != 0:
        pytest.skip(f"Anaconda python missing dependencies: {proc.stderr.strip()}")
    return True


@pytest.fixture(scope="session")
def positive_gds(anaconda_has_deps):
    """Create and return path to a synthetic positive test GDS."""
    path = _make_positive_gds()
    if path is None:
        pytest.skip("Could not create synthetic positive GDS")
    yield path
    try:
        os.remove(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Test Class: Worker Script Basics
# ---------------------------------------------------------------------------

class TestWorkerExists:
    """Verify evaluate_worker.py exists and is structured correctly."""

    def test_worker_script_exists(self):
        """evaluate_worker.py must exist in tools/ directory."""
        assert os.path.isfile(WORKER_PATH), (
            f"evaluate_worker.py not found at {WORKER_PATH}"
        )

    def test_worker_is_executable_or_importable(self):
        """evaluate_worker.py must be runnable as 'python evaluate_worker.py config.json'."""
        assert os.path.isfile(WORKER_PATH), "Worker script not found"
        # Check it at least parses without syntax errors
        proc = subprocess.run(
            [ANACONDA_PYTHON, "-c", f"import py_compile; py_compile.compile('{WORKER_PATH}', doraise=True)"],
            capture_output=True, text=True, timeout=15,
        )
        assert proc.returncode == 0, (
            f"evaluate_worker.py has syntax errors: {proc.stderr}"
        )


# ---------------------------------------------------------------------------
# Test Class: Pre-flight Dependency Check
# ---------------------------------------------------------------------------

class TestWorkerPreflightCheck:
    """Verify worker exits cleanly when dependencies are missing."""

    def test_missing_deps_exits_with_code_1(self):
        """Worker must exit with code 1 and clear message if gdstk/shapely/numpy missing."""
        assert os.path.isfile(WORKER_PATH), "Worker script not found"
        # Run with a python that has no gdstk — use a venv or just mock the import
        # by prepending a script that removes the module from sys.path
        tmp_dir = tempfile.mkdtemp(prefix="test_eval_nodeps_")
        config_path = os.path.join(tmp_dir, "config.json")
        output_path = os.path.join(tmp_dir, "output.json")

        config = {
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
            "output_path": output_path,
        }
        with open(config_path, "w") as f:
            json.dump(config, f)

        # Create a wrapper that sabotages imports via sys.modules poisoning.
        # Setting sys.modules['x'] = None causes 'import x' to raise ImportError.
        # This is Python 3.13-compatible (the old find_module/load_module API is ignored).
        wrapper = os.path.join(tmp_dir, "run_no_deps.py")
        with open(wrapper, "w") as f:
            f.write(
                "import sys\n"
                "# Poison sys.modules so import gdstk/shapely/numpy raises ImportError\n"
                "sys.modules['gdstk'] = None\n"
                "sys.modules['shapely'] = None\n"
                "sys.modules['numpy'] = None\n"
                f"exec(open('{WORKER_PATH}').read())\n"
            )

        proc = subprocess.run(
            [ANACONDA_PYTHON, wrapper, config_path],
            capture_output=True, text=True, timeout=15,
        )

        # Cleanup
        for p in [config_path, output_path, wrapper]:
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.rmdir(tmp_dir)
        except OSError:
            pass

        assert proc.returncode == 1, (
            f"Worker must exit with code 1 when dependencies missing, got {proc.returncode}. "
            f"stderr: {proc.stderr[:500]}"
        )
        combined_output = proc.stdout + proc.stderr
        # Must mention the missing dependency
        assert "gdstk" in combined_output.lower() or "shapely" in combined_output.lower() or "numpy" in combined_output.lower(), (
            f"Worker must report which dependency is missing. Output: {combined_output[:500]}"
        )


# ---------------------------------------------------------------------------
# Test Class: Score Mode
# ---------------------------------------------------------------------------

class TestWorkerScoreMode:
    """Verify score mode evaluates all 8 checks against reference."""

    def test_score_mode_positive_fixture(self, positive_gds, anaconda_has_deps):
        """Score mode with synthetic positive GDS must produce overall > 0.0."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0, f"Worker failed with code {rc}: {stderr[:500]}"
        assert result is not None, "Worker produced no output JSON"
        assert result.get("status") != "error", (
            f"Worker returned error: {result.get('error', result.get('detail', 'unknown'))}"
        )
        overall = result.get("overall", 0.0)
        assert overall > 0.0, (
            f"Score mode with positive fixture must produce overall > 0.0, got {overall}"
        )

    def test_score_mode_negative_lower_than_positive(self, positive_gds, anaconda_has_deps):
        """Negative fixture must score lower than positive fixture."""
        # Score positive
        config_pos = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc_pos, result_pos, _ = _run_worker(config_pos)
        assert rc_pos == 0 and result_pos is not None
        score_pos = result_pos.get("overall", 0.0)

        # Score negative (empty GDS)
        config_neg = {
            "gds_path": NEGATIVE_GDS,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc_neg, result_neg, _ = _run_worker(config_neg)
        # Negative might error (empty GDS) or produce score=0
        score_neg = 0.0
        if rc_neg == 0 and result_neg is not None:
            score_neg = result_neg.get("overall", 0.0)

        assert score_neg < score_pos, (
            f"Negative fixture ({score_neg}) must score lower than positive ({score_pos})"
        )

    def test_score_mode_returns_8_checks(self, positive_gds, anaconda_has_deps):
        """Score mode must return exactly 8 checks."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        assert len(checks) == 8, (
            f"Score mode must return exactly 8 checks, got {len(checks)}"
        )

    def test_score_mode_check_names(self, positive_gds, anaconda_has_deps):
        """Score mode checks must have the correct names in order."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        check_names = [c["name"] for c in checks]
        assert check_names == EXPECTED_CHECK_NAMES, (
            f"Check names mismatch. Expected {EXPECTED_CHECK_NAMES}, got {check_names}"
        )

    def test_score_mode_weights_sum_to_1(self, positive_gds, anaconda_has_deps):
        """Score mode check weights must sum to 1.0."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        total_weight = sum(c["weight"] for c in checks)
        assert abs(total_weight - 1.0) < 1e-6, (
            f"Score mode weights must sum to 1.0, got {total_weight}"
        )

    def test_score_mode_per_check_weights(self, positive_gds, anaconda_has_deps):
        """Each score-mode check must have the EXACT weight from the spec."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        assert len(checks) == 8, f"Expected 8 checks, got {len(checks)}"
        for check in checks:
            name = check["name"]
            expected_weight = SCORE_MODE_WEIGHT_MAP.get(name)
            assert expected_weight is not None, (
                f"Unexpected check name '{name}' not in SCORE_MODE_WEIGHT_MAP"
            )
            assert abs(check["weight"] - expected_weight) < 1e-6, (
                f"Score mode check '{name}' weight must be {expected_weight}, "
                f"got {check['weight']}"
            )

    def test_score_mode_check_structure(self, positive_gds, anaconda_has_deps):
        """Each check must have {name, score, weight, detail} fields."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        assert len(checks) > 0, "Must have at least one check"
        for i, check in enumerate(checks):
            assert "name" in check, f"Check {i} missing 'name' field"
            assert "score" in check, f"Check {i} missing 'score' field"
            assert "weight" in check, f"Check {i} missing 'weight' field"
            assert "detail" in check, f"Check {i} missing 'detail' field"
            assert isinstance(check["score"], (int, float)), f"Check {i} score must be numeric"
            assert 0.0 <= check["score"] <= 1.0, f"Check {i} score must be in [0,1], got {check['score']}"
            assert isinstance(check["weight"], (int, float)), f"Check {i} weight must be numeric"

    def test_score_mode_without_reference_gds_errors(self, anaconda_has_deps):
        """Score mode without reference_gds must produce error status."""
        assert os.path.isfile(WORKER_PATH), "evaluate_worker.py must exist"
        config = {
            "gds_path": NEGATIVE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
            # No reference_gds!
        }
        rc, result, stderr = _run_worker(config)
        # Worker should either exit non-zero or produce error status
        if rc == 0 and result is not None:
            assert result.get("status") == "error", (
                f"Score mode without reference_gds must produce error status, got {result.get('status')}"
            )
        else:
            # Non-zero exit is also acceptable
            assert rc != 0, "Worker must fail when score mode lacks reference_gds"


# ---------------------------------------------------------------------------
# Test Class: DRC Mode
# ---------------------------------------------------------------------------

class TestWorkerDrcMode:
    """Verify DRC mode runs checks 3-8 only, without reference_gds."""

    def test_drc_mode_without_reference_gds_works(self, positive_gds, anaconda_has_deps):
        """DRC mode must work without reference_gds."""
        config = {
            "gds_path": positive_gds,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
            # No reference_gds — should be fine for DRC mode
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0, f"DRC mode failed with code {rc}: {stderr[:500]}"
        assert result is not None, "DRC mode produced no output JSON"
        assert result.get("status") != "error", (
            f"DRC mode returned error: {result.get('error', result.get('detail', 'unknown'))}"
        )

    def test_drc_mode_returns_6_checks(self, positive_gds, anaconda_has_deps):
        """DRC mode must return exactly 6 checks (checks 3-8)."""
        config = {
            "gds_path": positive_gds,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        assert len(checks) == 6, (
            f"DRC mode must return exactly 6 checks (3-8), got {len(checks)}"
        )

    def test_drc_mode_check_names(self, positive_gds, anaconda_has_deps):
        """DRC mode checks must be checks 3-8: topgate through mesa_probes."""
        config = {
            "gds_path": positive_gds,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        expected_drc_names = EXPECTED_CHECK_NAMES[2:]  # checks 3-8 (0-indexed 2-7)
        check_names = [c["name"] for c in checks]
        assert check_names == expected_drc_names, (
            f"DRC check names mismatch. Expected {expected_drc_names}, got {check_names}"
        )

    def test_drc_mode_weights_sum_to_070(self, positive_gds, anaconda_has_deps):
        """DRC mode raw weights must sum to 0.70."""
        config = {
            "gds_path": positive_gds,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        total_weight = sum(c["weight"] for c in checks)
        assert abs(total_weight - 0.70) < 1e-6, (
            f"DRC mode raw weights must sum to 0.70, got {total_weight}"
        )

    def test_drc_mode_per_check_weights(self, positive_gds, anaconda_has_deps):
        """Each DRC-mode check must have the EXACT weight from the spec."""
        config = {
            "gds_path": positive_gds,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        assert len(checks) == 6, f"Expected 6 DRC checks, got {len(checks)}"
        for check in checks:
            name = check["name"]
            expected_weight = DRC_MODE_WEIGHT_MAP.get(name)
            assert expected_weight is not None, (
                f"Unexpected DRC check name '{name}' not in DRC_MODE_WEIGHT_MAP"
            )
            assert abs(check["weight"] - expected_weight) < 1e-6, (
                f"DRC mode check '{name}' weight must be {expected_weight}, "
                f"got {check['weight']}"
            )

    def test_drc_mode_normalizes_overall(self, positive_gds, anaconda_has_deps):
        """DRC mode overall must be normalized: weighted_sum / 0.70.

        If all DRC checks score 1.0, overall must be 1.0 (not 0.70).
        """
        config = {
            "gds_path": positive_gds,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        overall = result.get("overall", 0.0)

        # Compute what the normalized score should be
        raw_weighted_sum = sum(c["score"] * c["weight"] for c in checks)
        expected_normalized = round(raw_weighted_sum / 0.70, 6)

        assert abs(overall - expected_normalized) < 1e-4, (
            f"DRC overall must be weighted_sum/0.70. "
            f"Expected {expected_normalized}, got {overall}. "
            f"Raw weighted sum: {raw_weighted_sum}"
        )

    def test_drc_mode_reports_mode_in_output(self, positive_gds, anaconda_has_deps):
        """Output JSON must include 'mode' field matching the requested mode."""
        config = {
            "gds_path": positive_gds,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "drc",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        assert result.get("mode") == "drc", (
            f"Output mode must be 'drc', got {result.get('mode')}"
        )


# ---------------------------------------------------------------------------
# Test Class: Output JSON Structure
# ---------------------------------------------------------------------------

class TestWorkerOutputStructure:
    """Verify output JSON has required top-level fields."""

    def test_output_has_status_field(self, positive_gds, anaconda_has_deps):
        """Output must have 'status' field."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        assert "status" in result, "Output must have 'status' field"

    def test_output_has_overall_field(self, positive_gds, anaconda_has_deps):
        """Output must have 'overall' field with numeric value."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        assert "overall" in result, "Output must have 'overall' field"
        assert isinstance(result["overall"], (int, float)), "overall must be numeric"

    def test_output_has_mode_field(self, positive_gds, anaconda_has_deps):
        """Output must have 'mode' field."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        assert result.get("mode") == "score", (
            f"Output mode must be 'score', got {result.get('mode')}"
        )

    def test_output_has_checks_list(self, positive_gds, anaconda_has_deps):
        """Output must have 'checks' field that is a list."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        assert "checks" in result, "Output must have 'checks' field"
        assert isinstance(result["checks"], list), "checks must be a list"


# ---------------------------------------------------------------------------
# Test Class: Error Handling
# ---------------------------------------------------------------------------

class TestWorkerErrorHandling:
    """Verify worker handles various error conditions gracefully."""

    def test_missing_layer_map_keys(self, anaconda_has_deps):
        """Worker must error when layer_map is missing required keys."""
        assert os.path.isfile(WORKER_PATH), "evaluate_worker.py must exist"
        config = {
            "gds_path": NEGATIVE_GDS,
            "reference_gds": REFERENCE_GDS,
            "layer_map": {"mesa": [1, 0]},  # Missing other required keys
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert result is not None, (
            f"Worker must produce output JSON even on error (graceful error handling required). "
            f"Exit code: {rc}, stderr: {stderr[:300]}"
        )
        assert result.get("status") == "error", (
            f"Missing layer_map keys must produce status='error', got {result.get('status')}"
        )

    def test_nonexistent_gds_path(self, anaconda_has_deps):
        """Worker must handle non-existent GDS file path with structured error."""
        assert os.path.isfile(WORKER_PATH), "evaluate_worker.py must exist"
        config = {
            "gds_path": "/tmp/nonexistent_test_file_12345.gds",
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert result is not None, (
            f"Worker must produce output JSON even on error (graceful error handling required). "
            f"Exit code: {rc}, stderr: {stderr[:300]}"
        )
        assert result.get("status") == "error", (
            f"Non-existent GDS must produce status='error', got {result.get('status')}"
        )

    def test_nonexistent_reference_gds(self, anaconda_has_deps):
        """Worker must handle non-existent reference GDS with structured error."""
        assert os.path.isfile(WORKER_PATH), "evaluate_worker.py must exist"
        config = {
            "gds_path": NEGATIVE_GDS,
            "reference_gds": "/tmp/nonexistent_reference_12345.gds",
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert result is not None, (
            f"Worker must produce output JSON even on error (graceful error handling required). "
            f"Exit code: {rc}, stderr: {stderr[:300]}"
        )
        assert result.get("status") == "error", (
            f"Non-existent reference GDS must produce status='error', got {result.get('status')}"
        )

    def test_no_config_arg_exits_nonzero(self, anaconda_has_deps):
        """Worker must exit non-zero when called without config argument."""
        assert os.path.isfile(WORKER_PATH), "Worker script not found"
        proc = subprocess.run(
            [ANACONDA_PYTHON, WORKER_PATH],
            capture_output=True, text=True, timeout=15,
        )
        assert proc.returncode != 0, (
            f"Worker must exit non-zero without config arg, got {proc.returncode}"
        )


# ---------------------------------------------------------------------------
# Test Class: Score Computation Correctness
# ---------------------------------------------------------------------------

class TestWorkerScoreComputation:
    """Verify the overall score is computed correctly from check weights."""

    def test_overall_equals_weighted_sum_score_mode(self, positive_gds, anaconda_has_deps):
        """In score mode, overall = sum(score * weight) for all 8 checks."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        checks = result.get("checks", [])
        overall = result.get("overall", -1.0)

        expected = round(sum(c["score"] * c["weight"] for c in checks), 6)
        assert abs(overall - expected) < 1e-4, (
            f"Score mode overall must be weighted sum. "
            f"Expected {expected}, got {overall}"
        )

    def test_individual_scores_in_valid_range(self, positive_gds, anaconda_has_deps):
        """All individual check scores must be in [0.0, 1.0]."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        for check in result.get("checks", []):
            score = check["score"]
            assert 0.0 <= score <= 1.0, (
                f"Check '{check['name']}' score {score} outside valid range [0,1]"
            )

    def test_overall_in_valid_range(self, positive_gds, anaconda_has_deps):
        """Overall score must be in [0.0, 1.0]."""
        config = {
            "gds_path": positive_gds,
            "reference_gds": REFERENCE_GDS,
            "layer_map": STANDARD_LAYER_MAP,
            "mode": "score",
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Worker failed: {stderr[:300]}"
        overall = result.get("overall", -1.0)
        assert 0.0 <= overall <= 1.0, (
            f"Overall score must be in [0,1], got {overall}"
        )
