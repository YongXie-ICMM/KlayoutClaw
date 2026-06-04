"""Tests for auto_route's dense-fan-out rescue (rescue_unrouted_nets).

Live e2e runs (HM08) showed the connectivity hard-gate is the #1 score cap:
a tight 8-contact fan-out routes most nets, but the LAST route(s) fail
"No path found" because each contact ends up walled in by sibling-pin markers
plus the freeze halos of routes already laid — even though a legal,
non-crossing path to the pad still exists.

route_worker.py now retries any net that fails `find_path` with a two-tier
local/global relaxation that opens halo + sibling-pin-marker cells while
keeping real routed-path cells hard, so:
  1. previously-unroutable nets in a dense bundle now connect, and
  2. NO new route-route crossing is introduced (real path cells stay hard), and
  3. cases that already route fully are byte-for-byte unchanged (the rescue
     only ever runs after a net has already failed).

These tests drive a synthetic dense fan-out that reproduces the HM08 failure
under the OLD behaviour (rescue_unrouted_nets=False) and confirm the NEW default
(rescue on) connects every net without adding crossings.
"""
from __future__ import annotations
import json
import math
import os
import subprocess
import sys
import tempfile

import pytest

try:
    import gdstk
except ImportError:
    gdstk = None

try:
    import klayout.db as kdb
except ImportError:
    kdb = None

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUTE_WORKER = os.path.join(PROJECT_ROOT, "tools", "route_worker.py")


# ---------------------------------------------------------------------------
# Synthetic dense fan-out fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def dense_fanout_gds(tmp_path):
    """8 ohmic contacts along the top edge of a mesa (7 um pitch), fanning out
    to 8 bonding pads on a half-ring above. The pitch is tight enough that,
    with a 3 um path width + freeze halos, the default sequential router seals
    the corridor for the last route(s) — the HM08 "last route in a bundle"
    failure.

    Layers:
      mesa            L20/0
      contacts (pin A) L100/0
      pads     (pin B) L101/0
    """
    if gdstk is None:
        pytest.skip("gdstk not installed")
    lib = gdstk.Library()
    top = lib.new_cell("TOP")

    # Mesa bar; contacts sit on its top edge (y=0).
    top.add(gdstk.rectangle((-40, -30), (40, 0), layer=20, datatype=0))

    n = 8
    for i in range(n):
        px = -24.5 + i * 7.0
        top.add(gdstk.rectangle((px - 1.5, -1.0), (px + 1.5, 2.0),
                                layer=100, datatype=0))

    pad_R = 70.0
    for i in range(n):
        ang = math.pi * (0.15 + 0.7 * i / (n - 1))  # upper arc
        pxc = pad_R * math.cos(ang)
        pyc = 25 + pad_R * math.sin(ang)
        top.add(gdstk.rectangle((pxc - 8, pyc - 8), (pxc + 8, pyc + 8),
                                layer=101, datatype=0))

    p = tmp_path / "dense_fanout.gds"
    lib.write_gds(str(p))
    return str(p)


def _run_route_worker(gds: str, extra: dict) -> dict:
    """Call route_worker.py and return its parsed output dict."""
    with tempfile.TemporaryDirectory() as td:
        out_json = os.path.join(td, "out.json")
        cfg = {
            "gds_path": gds,
            "pin_layer_a": "100/0",
            "pin_layer_b": "101/0",
            "output_layer": "10/0",
            "obstacle_layers": ["20/0"],
            "path_width_um": 3.0,
            "obs_safe_distance_um": 2.0,
            "path_safe_distance_um": 3.0,
            "pin_safe_distance_a_um": 2.0,
            "pin_safe_distance_b_um": 2.0,
            "obs_hardness": 20.0,
            "path_hardness": 10.0,
            "sort_pairs": True,
            "obs_damping_step": 4,
            "map_resolution_um": 1.0,
            "output_path": out_json,
            **extra,
        }
        cfg_path = os.path.join(td, "config.json")
        with open(cfg_path, "w") as f:
            json.dump(cfg, f)
        result = subprocess.run(
            [sys.executable, ROUTE_WORKER, cfg_path],
            capture_output=True, timeout=180,
        )
        if os.path.exists(out_json):
            with open(out_json) as f:
                return json.load(f)
        raise RuntimeError(
            f"route_worker produced no output (rc={result.returncode}):\n"
            f"{result.stderr.decode()[:800]}")


def _count_real_crossings(result: dict, path_width_um: float = 3.0,
                          dbu: float = 0.001, junction_tol_um: float = 4.0):
    """Count route-route overlaps, EXCLUDING junction overlaps (overlaps that
    sit near a shared endpoint — the contact cluster naturally produces these
    and the official contact_isolation metric filters them). Returns the count
    of genuine mid-body crossings."""
    if kdb is None:
        pytest.skip("klayout.db not installed")
    pwd = int(round(path_width_um / dbu))
    jtol = junction_tol_um / dbu
    entries = []  # (region, [ep_a, ep_b])
    for p in result.get("paths", []):
        pts_dbu = p.get("points_dbu") or []
        if len(pts_dbu) < 2:
            continue
        pts = [kdb.Point(int(round(x)), int(round(y))) for x, y in pts_dbu]
        region = kdb.Region(kdb.Path(pts, pwd))
        entries.append((region, (pts_dbu[0], pts_dbu[-1])))
    real = 0
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            ov = entries[i][0] & entries[j][0]
            if ov.is_empty():
                continue
            if ov.area() * dbu * dbu <= 0.01:
                continue
            # Junction test: overlap centroid near a shared endpoint of both.
            bb = ov.bbox()
            ox = (bb.left + bb.right) / 2.0
            oy = (bb.bottom + bb.top) / 2.0
            eps = list(entries[i][1]) + list(entries[j][1])
            near = any(math.hypot(ox - ex, oy - ey) <= jtol for ex, ey in eps)
            if not near:
                real += 1
    return real


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDenseFanoutRescue:
    def test_old_behavior_leaves_a_net_unrouted(self, dense_fanout_gds):
        """Baseline guard: with the rescue disabled, the dense fan-out leaves
        at least one net unrouted (reproduces the HM08 connectivity cap). If
        this ever stops being true the fixture no longer exercises the bug."""
        res = _run_route_worker(dense_fanout_gds, {"rescue_unrouted_nets": False})
        n = min(res["total_pins_a"], res["total_pins_b"])
        assert res["routed_pairs"] < n, (
            "fixture no longer reproduces the unrouted-net failure: "
            f"routed {res['routed_pairs']}/{n} with rescue OFF")
        assert any("No path found" in e for e in res.get("errors", []))

    def test_rescue_connects_all_nets(self, dense_fanout_gds):
        """With the rescue ON (the default), every net routes — the connectivity
        cap is lifted."""
        res = _run_route_worker(dense_fanout_gds, {})  # default: rescue on
        n = min(res["total_pins_a"], res["total_pins_b"])
        assert res["routed_pairs"] == n, (
            f"rescue failed to connect all nets: {res['routed_pairs']}/{n}; "
            f"errors={res.get('errors')}")
        assert res.get("rescued_nets", 0) >= 1, (
            "expected at least one net to be flagged as rescued")
        assert "rescue_note" in res

    def test_rescue_default_is_on(self, dense_fanout_gds):
        """Omitting rescue_unrouted_nets must behave as ON (default True)."""
        default = _run_route_worker(dense_fanout_gds, {})
        explicit = _run_route_worker(dense_fanout_gds, {"rescue_unrouted_nets": True})
        assert default["routed_pairs"] == explicit["routed_pairs"]

    def test_rescue_introduces_no_new_crossings(self, dense_fanout_gds):
        """The rescued routes must not add genuine (non-junction) route-route
        crossings vs the baseline. Real path cells stay hard during the rescue,
        so a rescued lead can never cut through a prior route."""
        off = _run_route_worker(dense_fanout_gds, {"rescue_unrouted_nets": False})
        on = _run_route_worker(dense_fanout_gds, {})
        cross_off = _count_real_crossings(off)
        cross_on = _count_real_crossings(on)
        assert cross_on <= cross_off, (
            f"rescue added crossings: baseline={cross_off} rescued={cross_on}")

    def test_rescue_is_noop_on_clean_case(self, dense_fanout_gds, tmp_path):
        """On a layout that already routes fully, rescue ON vs OFF must yield
        byte-identical paths and rescued_nets==0 — the rescue only ever fires
        after a net has already failed, so it cannot perturb clean cases
        (the QH06/HM11 non-regression guarantee)."""
        if gdstk is None:
            pytest.skip("gdstk not installed")
        # A roomy 4-contact fan-out that routes cleanly at any resolution.
        lib = gdstk.Library()
        top = lib.new_cell("TOP")
        top.add(gdstk.rectangle((-20, -15), (20, 0), layer=20, datatype=0))
        for i in range(4):
            px = -15 + i * 10.0
            top.add(gdstk.rectangle((px - 1.5, -1.0), (px + 1.5, 2.0),
                                    layer=100, datatype=0))
        pad_R = 90.0
        for i in range(4):
            ang = math.pi * (0.2 + 0.6 * i / 3)
            pxc = pad_R * math.cos(ang)
            pyc = 30 + pad_R * math.sin(ang)
            top.add(gdstk.rectangle((pxc - 10, pyc - 10), (pxc + 10, pyc + 10),
                                    layer=101, datatype=0))
        clean = tmp_path / "clean_fanout.gds"
        lib.write_gds(str(clean))

        on = _run_route_worker(str(clean), {})
        off = _run_route_worker(str(clean), {"rescue_unrouted_nets": False})
        n = min(on["total_pins_a"], on["total_pins_b"])
        assert on["routed_pairs"] == n and off["routed_pairs"] == n, (
            "clean fixture did not route fully; adjust geometry")
        assert on.get("rescued_nets", 0) == 0, (
            "rescue fired on a clean case — it must only run after a failure")
        on_paths = [p["points_dbu"] for p in on["paths"]]
        off_paths = [p["points_dbu"] for p in off["paths"]]
        assert on_paths == off_paths, (
            "rescue ON changed the routes on a clean case (must be a no-op)")
