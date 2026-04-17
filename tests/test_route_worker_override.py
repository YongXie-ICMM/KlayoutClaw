"""Tests for auto_route's pin_pairs_override parameter.

pin_pairs_override lets the caller bypass Hungarian matching and commit
a specific [a_idx, b_idx] pairing. Addresses the ml14 benchmark case
where the agent made 23 sequential auto_route calls trying to work
around the default matching, eventually abandoning the tool entirely.
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
import tempfile
import pytest

try:
    import gdstk
except ImportError:
    gdstk = None

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUTE_WORKER = os.path.join(PROJECT_ROOT, "tools", "route_worker.py")


@pytest.fixture
def two_pair_gds(tmp_path):
    """Four pin shapes arranged so Hungarian would choose (A0,B0) + (A1,B1)
    (straight lines) but an override can force (A0,B1) + (A1,B0) (crossed).

    Layout:
        A0 = L100/0 square at (0-2, 0-2)      — bottom-left
        A1 = L100/0 square at (0-2, 100-102)  — top-left
        B0 = L101/0 square at (50-52, 0-2)    — bottom-right
        B1 = L101/0 square at (50-52, 100-102) — top-right
    """
    if gdstk is None:
        pytest.skip("gdstk not installed")
    lib = gdstk.Library()
    top = lib.new_cell("TOP")
    top.add(gdstk.rectangle((0, 0), (2, 2), layer=100, datatype=0))
    top.add(gdstk.rectangle((0, 100), (2, 102), layer=100, datatype=0))
    top.add(gdstk.rectangle((50, 0), (52, 2), layer=101, datatype=0))
    top.add(gdstk.rectangle((50, 100), (52, 102), layer=101, datatype=0))
    p = tmp_path / "pairs.gds"
    lib.write_gds(str(p))
    return str(p)


def _run_route_worker(gds: str, override_config: dict) -> dict:
    """Call route_worker.py with a config that includes the override test
    fields, and return its parsed output dict.

    route_worker.py CLI contract (from main()):
      - argv[1]: path to config JSON
      - result written to config["output_path"] if set; else printed to stdout
    Config keys used by route():
      gds_path, cell_name, dbu, pin_layer_a, pin_layer_b, obstacle_layers,
      path_width_um, obs_safe_distance_um, path_safe_distance_um,
      map_resolution_um, obs_hardness, obs_damping_step,
      pin_safe_distance_a_um, pin_safe_distance_b_um, path_hardness,
      sort_pairs, dry_run, auto_map_resolution, per_pair_obstacle_layers
    """
    with tempfile.TemporaryDirectory() as td:
        out_json = os.path.join(td, "out.json")
        full_cfg = {
            "gds_path": gds,
            "pin_layer_a": "100/0",
            "pin_layer_b": "101/0",
            "output_layer": "10/0",
            "obstacle_layers": [],
            "path_width_um": 2.0,
            "map_resolution_um": 2.0,
            "obs_safe_distance_um": 2.0,
            "path_safe_distance_um": 2.0,
            "pin_safe_distance_a_um": 2.0,
            "pin_safe_distance_b_um": 2.0,
            "obs_hardness": 20.0,
            "path_hardness": 10.0,
            "sort_pairs": False,
            "obs_damping_step": 4,
            "output_path": out_json,
            **override_config,
        }
        cfg_path = os.path.join(td, "config.json")
        with open(cfg_path, "w") as f:
            json.dump(full_cfg, f)
        result = subprocess.run(
            [sys.executable, ROUTE_WORKER, cfg_path],
            capture_output=True, timeout=120,
        )
        if os.path.exists(out_json):
            with open(out_json) as f:
                return json.load(f)
        # Fallback: parse stdout if output_path was not written
        if result.returncode != 0 and not result.stdout.strip():
            raise RuntimeError(
                f"route_worker failed (rc={result.returncode}):\n"
                f"stderr: {result.stderr.decode()}")
        return json.loads(result.stdout.decode())


class TestPinPairsOverride:
    """pin_pairs_override replaces Hungarian matching with explicit pair
    indices. Length must equal the expected pair count; indices must be
    valid for each pin layer's shape count."""

    def test_override_runs_with_valid_assignments(self, two_pair_gds):
        """Forcing a crossed assignment (A0->B1, A1->B0) must produce two
        routed pairs whose endpoints are diagonally opposite — NOT parallel
        to the x-axis (which would be the straight Hungarian pairing)."""
        result = _run_route_worker(two_pair_gds, {
            "pin_pairs_override": [[0, 1], [1, 0]],
        })
        assert result["status"] in ("success", "partial"), result
        assert result["routed_pairs"] == 2, result
        paths = result.get("paths", [])
        assert len(paths) == 2, paths
        # Each path's endpoints must have a y-delta > 50 um (the crossed
        # pairing forces routes to span the 0..100 um y-separation);
        # Hungarian parallel pairing would have y-delta ~ 0.
        dbu = 0.001  # default
        for p in paths:
            pts_dbu = p.get("points_dbu") or []
            assert pts_dbu, f"path missing points_dbu: {p}"
            dy_um = abs(pts_dbu[-1][1] - pts_dbu[0][1]) * dbu
            assert dy_um > 50, (
                f"override did not produce crossed pairing; dy_um={dy_um} "
                f"suggests straight Hungarian paths. path={p!r}")

    def test_override_wrong_length_rejected(self, two_pair_gds):
        """If pin_pairs_override has length != min(n_a, n_b), the worker
        must refuse or emit a structured error. Silently running fewer
        routes is a disallowed failure mode."""
        result = _run_route_worker(two_pair_gds, {
            "pin_pairs_override": [[0, 0]],   # only 1 pair, 2 expected
        })
        errors_str = " ".join(result.get("errors", []))
        assert (result["status"] not in ("success", "partial")
                or "pin_pairs_override" in errors_str), (
            f"Wrong-length override must error; got: status={result['status']!r} "
            f"errors={errors_str!r}")

    def test_override_out_of_range_index_rejected(self, two_pair_gds):
        """An out-of-range b_idx (5 for a 2-pin layer) must be rejected."""
        result = _run_route_worker(two_pair_gds, {
            "pin_pairs_override": [[0, 5], [1, 0]],
        })
        errors_str = " ".join(result.get("errors", []))
        assert (result["status"] not in ("success", "partial")
                or "pin_pairs_override" in errors_str
                or "out of range" in errors_str.lower()), (
            f"Out-of-range override must error; got: status={result['status']!r} "
            f"errors={errors_str!r}")

    def test_override_malformed_entry_rejected(self, two_pair_gds):
        """A non-2-element entry must be rejected."""
        result = _run_route_worker(two_pair_gds, {
            "pin_pairs_override": [[0], [1, 0]],
        })
        errors_str = " ".join(result.get("errors", []))
        assert (result["status"] not in ("success", "partial")
                or "pin_pairs_override" in errors_str), (
            f"Malformed override entry must error; got: status={result['status']!r} "
            f"errors={errors_str!r}")
