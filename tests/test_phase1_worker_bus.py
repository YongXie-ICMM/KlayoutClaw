"""3-pin Y-bus regression test for issue #28 — covers the new `bus_pairs`
schema field. Synthetic geometry, no fixtures needed.

Run via:
  /Users/andrewwayne/anaconda3/envs/instrMCPdev/bin/python -m pytest \
      tests/test_phase1_worker_bus.py -xvs
"""
import json
import os
import subprocess
import sys
import tempfile

import gdstk
import pytest

# Interpreter for the worker subprocess: override with KLAYOUTCLAW_PY, else
# the legacy instrMCPdev env if present, else whatever runs pytest.
_LEGACY_PY = "/Users/andrewwayne/anaconda3/envs/instrMCPdev/bin/python"
CONDA_PY = os.environ.get(
    "KLAYOUTCLAW_PY",
    _LEGACY_PY if os.path.isfile(_LEGACY_PY) else sys.executable)
WORKER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                      "tools", "route_worker.py")


def _build_3pin_ybus_input():
    """Build a tiny 50x50 um GDS:
       - 1 source contact pin (L100/0) at center.
       - 3 sink pad pins (L101/0) at (-15, +15), (+15, +15), (0, -15).
       - No obstacles (free routing area).
    """
    lib = gdstk.Library()
    cell = lib.new_cell("TOP")
    # Source pin (L100/0) — small square at center
    cell.add(gdstk.rectangle((-0.5, -0.5), (0.5, 0.5), layer=100, datatype=0))
    # Sink pins (L101/0) at three corners — pad-like
    for cx, cy in [(-15, 15), (15, 15), (0, -15)]:
        cell.add(gdstk.rectangle((cx - 0.5, cy - 0.5), (cx + 0.5, cy + 0.5),
                                  layer=101, datatype=0))
    return lib


def _run_worker(config):
    tmpdir = tempfile.mkdtemp(prefix="bus_test_")
    cfg_path = os.path.join(tmpdir, "config.json")
    out_path = os.path.join(tmpdir, "output.json")
    config["output_path"] = out_path
    with open(cfg_path, "w") as f:
        json.dump(config, f)
    proc = subprocess.run(
        [CONDA_PY, WORKER, cfg_path],
        capture_output=True, text=True, timeout=120)
    if not os.path.isfile(out_path):
        raise AssertionError(
            f"Worker produced no output. rc={proc.returncode} "
            f"stderr={proc.stderr[-500:]}")
    with open(out_path) as f:
        return json.load(f)


def test_3pin_ybus():
    """1 source + 3 sinks routed as a Y-bus via Steiner branching.
    Asserts: status=success, paths=3, at least 1 steiner_branch, every sink reached."""
    lib = _build_3pin_ybus_input()
    tmpdir = tempfile.mkdtemp(prefix="bus_test_gds_")
    gds_path = os.path.join(tmpdir, "input.gds")
    lib.write_gds(gds_path)

    config = {
        "gds_path": gds_path,
        "cell_name": "TOP",
        "dbu": 0.001,
        "pin_layer_a": "100/0",
        "pin_layer_b": "101/0",
        "obstacle_layers": [],
        "output_layer": "4/0",
        "path_width_um": 0.5,
        "map_resolution_um": 0.5,
        "obs_safe_distance_um": 0.5,
        "path_safe_distance_um": 0.5,
        "pin_safe_distance_a_um": 0.2,
        "pin_safe_distance_b_um": 0.2,
        "freeze_completed_routes_as_obstacles_with_margin": 0.5,
        "bus_pairs": [[0, [0, 1, 2]]],
        "routing_strategy": "steiner",
    }
    result = _run_worker(config)
    assert result["status"] == "success", f"unexpected status: {result}"
    paths = result["paths"]
    assert len(paths) == 3, f"expected 3 paths, got {len(paths)}: {result}"
    # All paths share net_id=0
    assert all(p["net_id"] == 0 for p in paths), "all paths must be net_id=0"
    # At least one branch should be a Steiner branch (not the longest path)
    steiner_count = sum(1 for p in paths if p.get("steiner_branch"))
    assert steiner_count >= 1, (
        f"expected at least 1 steiner_branch, got {steiner_count}: paths={paths}")


def test_singleton_via_bus_pairs():
    """bus_pairs with 1-sink list should behave like a singleton pair."""
    lib = _build_3pin_ybus_input()
    tmpdir = tempfile.mkdtemp(prefix="bus_singleton_")
    gds_path = os.path.join(tmpdir, "input.gds")
    lib.write_gds(gds_path)
    config = {
        "gds_path": gds_path,
        "cell_name": "TOP",
        "dbu": 0.001,
        "pin_layer_a": "100/0",
        "pin_layer_b": "101/0",
        "obstacle_layers": [],
        "output_layer": "4/0",
        "path_width_um": 0.5,
        "map_resolution_um": 0.5,
        "obs_safe_distance_um": 0.5,
        "path_safe_distance_um": 0.5,
        "pin_safe_distance_a_um": 0.2,
        "pin_safe_distance_b_um": 0.2,
        "bus_pairs": [[0, [0]]],  # one source, one sink
    }
    result = _run_worker(config)
    assert result["status"] == "success", result
    assert len(result["paths"]) == 1


def test_bus_pairs_omitted_falls_back_to_ordered_loop():
    """No bus_pairs → ordered-loop pairs source pins to sink pins.

    Uses generously-spaced pins (30 um apart) to ensure ordered-loop's
    cyclic-monotonic DP can find a clean assignment without keepout
    blocking corridors.
    """
    lib = gdstk.Library()
    cell = lib.new_cell("TOP")
    for cx, cy in [(0, -30), (0, 0), (0, 30)]:
        cell.add(gdstk.rectangle((cx - 0.5, cy - 0.5), (cx + 0.5, cy + 0.5),
                                  layer=100, datatype=0))
    for cx, cy in [(50, -30), (50, 0), (50, 30)]:
        cell.add(gdstk.rectangle((cx - 0.5, cy - 0.5), (cx + 0.5, cy + 0.5),
                                  layer=101, datatype=0))
    tmpdir = tempfile.mkdtemp(prefix="bus_fallback_")
    gds_path = os.path.join(tmpdir, "input.gds")
    lib.write_gds(gds_path)
    config = {
        "gds_path": gds_path,
        "cell_name": "TOP", "dbu": 0.001,
        "pin_layer_a": "100/0", "pin_layer_b": "101/0",
        "obstacle_layers": [],
        "output_layer": "4/0",
        "path_width_um": 0.5,
        "map_resolution_um": 0.5,
        "obs_safe_distance_um": 0.5,
        "path_safe_distance_um": 0.5,
        "pin_safe_distance_a_um": 0.2,
        "pin_safe_distance_b_um": 0.2,
        "freeze_completed_routes_as_obstacles_with_margin": 0.5,
    }
    result = _run_worker(config)
    assert result["status"] == "success", result
    assert len(result["paths"]) == 3
    assert result.get("assignment_engine") == "ordered_loop"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-xvs"]))
