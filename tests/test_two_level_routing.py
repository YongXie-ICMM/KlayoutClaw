#!/usr/bin/env python
"""Unit tests for the pure two-level routing helpers (tools/two_level.py).

These are dependency-free (math only) so they run in-process under any Python —
no KLayout/skimage/gdstk needed. They pin the geometry + trigger logic for the
adaptive inner-fine/outer-coarse auto_route mode.
"""
import os
import sys

import pytest

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJECT_ROOT, "tools"))

from two_level import (  # noqa: E402
    detect_inner_outer,
    compute_boundary_point,
    should_two_level,
    coords_span,
)


# --- coords_span -----------------------------------------------------------

def test_coords_span_bbox_and_extent():
    bbox, span = coords_span([(0, 0), (100, 40), (-20, 10)])
    assert bbox == (-20, 0, 100, 40)
    assert span == 120  # max(width=120, height=40)


def test_coords_span_taller_than_wide():
    # height is the max extent here -> a width-only impl would fail
    _, span = coords_span([(0, 0), (40, 120)])
    assert span == 120


# --- detect_inner_outer ----------------------------------------------------

class TestDetectInnerOuter:
    def test_a_smaller_is_inner(self):
        a = [(0, 0), (10, 10), (-10, 5)]          # span ~20
        b = [(0, 0), (5000, 0), (0, 5000)]        # span 5000
        assert detect_inner_outer(a, b) == "a"

    def test_b_smaller_is_inner(self):
        a = [(0, 0), (5000, 0), (0, 5000)]
        b = [(0, 0), (10, 10)]
        assert detect_inner_outer(a, b) == "b"

    def test_empty_returns_none(self):
        assert detect_inner_outer([], [(0, 0)]) is None
        assert detect_inner_outer([(0, 0)], []) is None

    def test_equal_span_tiebreak_prefers_a(self):
        # equal spans -> documented tie-break is 'a' (span_a <= span_b)
        a = [(0, 0), (10, 0)]   # span 10
        b = [(0, 0), (0, 10)]   # span 10
        assert detect_inner_outer(a, b) == "a"


# --- compute_boundary_point ------------------------------------------------

class TestComputeBoundaryPoint:
    def test_axis_ray_hits_edge(self):
        # center origin, square half-extent 100; outer far on +x
        assert compute_boundary_point(0, 0, 100, 100, 1000, 0) == (100, 0)

    def test_diagonal_hits_corner_region(self):
        # equal half-extents, 45deg -> s = 100/1000 = 0.1 -> (100,100)
        assert compute_boundary_point(0, 0, 100, 100, 1000, 1000) == (100, 100)

    def test_rectangular_window_uses_min_scale(self):
        # Hx=100, Hy=50; outer (1000,1000): sx=0.1, sy=0.05 -> s=0.05 -> (50,50)
        assert compute_boundary_point(0, 0, 100, 50, 1000, 1000) == (50, 50)

    def test_nonorigin_center(self):
        # center (500,500), half 100; outer straight up at (500,2000)
        assert compute_boundary_point(500, 500, 100, 100, 500, 2000) == (500, 600)

    def test_pad_inside_window_returns_none(self):
        # outer (50,0) is inside Hx=100 -> s=2 >=1 -> None (route single-pass)
        assert compute_boundary_point(0, 0, 100, 100, 50, 0) is None

    def test_pad_exactly_on_edge_returns_none(self):
        # s == 1.0 exactly (pad on the window edge): >= vs > boundary
        assert compute_boundary_point(0, 0, 100, 100, 100, 0) is None

    def test_degenerate_pad_on_center_returns_none(self):
        assert compute_boundary_point(0, 0, 100, 100, 0, 0) is None

    def test_boundary_point_is_on_window_edge(self):
        # the returned point must lie ON the rectangle edge (|bx-cx|==Hx or |by-cy|==Hy)
        bx, by = compute_boundary_point(0, 0, 120, 80, 900, 300)
        assert abs(abs(bx) - 120) <= 1 or abs(abs(by) - 80) <= 1


# --- should_two_level ------------------------------------------------------

# Helper: realistic dbu numbers (1 um = 1000 dbu). Inner contacts ~80um span,
# pads on a 60mm field. fine_res 7.5um, coarse 2um.
def _kw(**over):
    base = dict(
        n_inner=6, n_outer=6,
        inner_span_dbu=80_000, outer_span_dbu=60_000_000,
        full_w_dbu=60_000_000, full_h_dbu=60_000_000,
        inner_w_dbu=120_000, inner_h_dbu=120_000,
        fine_res_dbu=7_500, coarse_res_dbu=2_000,
    )
    base.update(over)
    return base


class TestShouldTwoLevel:
    def test_fires_on_large_field_fine_contacts(self):
        ok, reason = should_two_level(**_kw())
        assert ok is True, reason

    def test_no_fire_when_single_fine_grid_fits(self):
        # small full field: fine grid over it is well under the cap
        ok, reason = should_two_level(**_kw(
            outer_span_dbu=1_900_000, full_w_dbu=1_900_000, full_h_dbu=1_900_000))
        assert ok is False
        assert "fit" in reason.lower() or "single" in reason.lower()

    def test_no_fire_without_size_separation(self):
        ok, reason = should_two_level(**_kw(
            inner_span_dbu=25_000_000))  # 60M < 3*25M=75M -> no 3x separation
        assert ok is False
        assert "separation" in reason.lower() or "span" in reason.lower()

    def test_no_fire_too_few_pins(self):
        ok, reason = should_two_level(**_kw(n_inner=2))
        assert ok is False
        assert "pin" in reason.lower()

    def test_separation_boundary_exactly_3x(self):
        # outer_span == sep_ratio * inner_span -> the '< sep' check must NOT
        # reject (pins exactly at the 3x threshold still separated enough).
        ok_at, _ = should_two_level(**_kw(inner_span_dbu=20_000_000,
                                          outer_span_dbu=60_000_000))  # exactly 3x
        ok_under, r_under = should_two_level(**_kw(inner_span_dbu=20_000_001,
                                                   outer_span_dbu=60_000_000))  # just under 3x
        assert ok_at is True
        assert ok_under is False and "separation" in r_under.lower()

    def test_no_fire_when_split_still_too_big(self):
        # inner window itself too big at fine res (would still OOM)
        ok, reason = should_two_level(**_kw(
            inner_w_dbu=60_000_000, inner_h_dbu=60_000_000))
        assert ok is False
        assert "fit" in reason.lower() or "cap" in reason.lower() or "split" in reason.lower()


# ===========================================================================
# End-to-end orchestration (route_two_level via the worker subprocess).
# ===========================================================================

import math as _math      # noqa: E402
import subprocess as _sp  # noqa: E402
import tempfile as _tf    # noqa: E402
import json as _json      # noqa: E402

ANACONDA_PYTHON = os.path.expanduser("~/anaconda3/bin/python3")
ROUTE_WORKER = os.path.join(PROJECT_ROOT, "tools", "route_worker.py")


def _have_deps():
    if not os.path.isfile(ANACONDA_PYTHON):
        return False
    p = _sp.run([ANACONDA_PYTHON, "-c",
                 "import gdstk, numpy, skimage, klayout.db"],
                capture_output=True, text=True, timeout=30)
    return p.returncode == 0


_DEPS = _have_deps()
pytestmark = pytest.mark.skipif(not _DEPS, reason="needs gdstk/skimage/klayout in anaconda python")


def _run_worker(gds, cfg):
    with _tf.TemporaryDirectory() as td:
        out = os.path.join(td, "out.json")
        full = {
            "gds_path": gds, "pin_layer_a": "100/0", "pin_layer_b": "101/0",
            "output_layer": "10/0", "obstacle_layers": [],
            "path_width_um": 1.0, "map_resolution_um": 20.0, "output_path": out,
        }
        full.update(cfg)
        cfgp = os.path.join(td, "cfg.json")
        with open(cfgp, "w") as f:
            _json.dump(full, f)
        proc = _sp.run([ANACONDA_PYTHON, ROUTE_WORKER, cfgp],
                       capture_output=True, text=True, timeout=300)
        res = _json.load(open(out)) if os.path.isfile(out) else None
        return res, proc


def _build_gds(path, contacts, pads, c_size=2.0, p_size=50.0):
    """contacts/pads: list of (cx,cy) um centres. Markers on 100/0 and 101/0."""
    import gdstk
    lib = gdstk.Library()
    top = lib.new_cell("TOP")
    for (x, y) in contacts:
        top.add(gdstk.rectangle((x - c_size / 2, y - c_size / 2),
                                (x + c_size / 2, y + c_size / 2), layer=100, datatype=0))
    for (x, y) in pads:
        top.add(gdstk.rectangle((x - p_size / 2, y - p_size / 2),
                                (x + p_size / 2, y + p_size / 2), layer=101, datatype=0))
    lib.write_gds(path)


def _ring(n, radius):
    return [(round(radius * _math.cos(2 * _math.pi * i / n), 1),
             round(radius * _math.sin(2 * _math.pi * i / n), 1)) for i in range(n)]


class TestTwoLevelOrchestration:
    def test_fixtureA_fires_and_connects(self, tmp_path):
        """Centre contacts (tight cluster) + perimeter pads at 4 mm radius.
        fine-over-full > 25M forces two-level; outer routes at coarse 20um so
        the test stays fast."""
        gds = str(tmp_path / "A.gds")
        # 6 contacts at ~3um pitch clustered at origin; 6 pads on a 4mm ring
        contacts = [(-3, -3), (0, -3), (3, -3), (-3, 3), (0, 3), (3, 3)]
        pads = _ring(6, 4000.0)
        _build_gds(gds, contacts, pads)
        res, proc = _run_worker(gds, {"two_level": "auto", "map_resolution_um": 20.0})
        assert res is not None, f"worker crashed: {proc.stderr[:400]}"
        assert proc.returncode == 0
        assert res.get("two_level") is True, f"two-level did not fire: {res.get('errors')}"
        ig, og = res["inner_grid"], res["outer_grid"]
        assert ig and og
        assert ig["cells"] <= 25_000_000 and og["cells"] <= 25_000_000
        # inner finer than outer
        mr = res["map_resolution_um_used"]
        assert mr["inner"] < mr["outer"], f"inner not finer than outer: {mr}"
        # split is far cheaper than a single fine grid over the full field
        assert ig["cells"] + og["cells"] < 5_000_000
        # all 6 nets route through both passes on this clean ring
        assert res["routed_pairs"] == res["n_nets"] == 6, res.get("errors")
        innerp = {p["net_id"]: p for p in res["paths"][:res["inner_routed"]]}
        outerp = {p["net_id"]: p for p in res["paths"][res["inner_routed"]:]}
        shared = set(innerp) & set(outerp)
        assert shared, "no net routed through both passes"
        for nid in shared:
            assert innerp[nid]["points_dbu"][-1] == outerp[nid]["points_dbu"][0], (
                f"net {nid}: inner end != outer start (continuity gap)")
        # INVARIANT (orphan-drop): every emitted path belongs to a net routed in
        # BOTH passes, and there is exactly one patch per fully-routed net.
        assert set(innerp) == set(outerp) == shared, "orphan single-pass segment emitted"
        assert len(res["patches"]) == res["routed_pairs"], "dangling/missing patch"

    def test_fixtureD_force_on_small_layout(self, tmp_path):
        """two_level='on' fires even on a small layout that 'auto' would skip."""
        gds = str(tmp_path / "D.gds")
        contacts = [(-3, -3), (0, -3), (3, -3), (-3, 3)]
        pads = _ring(4, 120.0)
        _build_gds(gds, contacts, pads, p_size=20.0)
        # auto: should NOT fire (tiny field fits a single fine grid)
        res_auto, _ = _run_worker(gds, {"two_level": "auto"})
        assert res_auto is not None and res_auto.get("two_level") is not True
        # on: forces two-level
        res_on, proc = _run_worker(gds, {"two_level": "on"})
        assert res_on is not None, proc.stderr[:300]
        assert res_on.get("two_level") is True, f"forced two-level did not fire: {res_on.get('errors')}"
        assert res_on["routed_pairs"] >= 1

    def test_fixtureE_pad_inside_window_falls_back(self, tmp_path):
        """A pad sitting inside the auto-detected inner window must force a
        single-pass fallback (no two-level), even with two_level='on'."""
        gds = str(tmp_path / "E.gds")
        contacts = [(-3, -3), (0, -3), (3, -3), (-3, 3)]
        # one pad very close (inside the inner window), rest far
        pads = [(8, 0)] + _ring(3, 150.0)
        _build_gds(gds, contacts, pads, p_size=4.0)
        res, proc = _run_worker(gds, {"two_level": "on"})
        assert res is not None, proc.stderr[:300]
        assert res.get("two_level") is not True, "should have fallen back to single-pass"

    def test_off_disables_on_fixtureA(self, tmp_path):
        gds = str(tmp_path / "Aoff.gds")
        contacts = [(-3, -3), (0, -3), (3, -3), (-3, 3), (0, 3), (3, 3)]
        pads = _ring(6, 4000.0)
        _build_gds(gds, contacts, pads)
        res, proc = _run_worker(gds, {"two_level": "off", "map_resolution_um": 20.0})
        assert res is not None, proc.stderr[:300]
        assert res.get("two_level") is not True

    def test_off_equals_single_pass_on_small_layout(self, tmp_path):
        """Backward-compat: on a layout where two-level does NOT fire, two_level
        ='auto' must produce BYTE-IDENTICAL paths to two_level='off' (single
        pass) — proving the dispatch is a true no-op, not just 'did not fire'."""
        gds = str(tmp_path / "compat.gds")
        # small uniform layout: auto must not engage two-level
        contacts = [(-3, -3), (0, -3), (3, -3), (-3, 3)]
        pads = _ring(4, 120.0)
        _build_gds(gds, contacts, pads, p_size=20.0)
        auto, _ = _run_worker(gds, {"two_level": "auto", "map_resolution_um": 2.0})
        off, _ = _run_worker(gds, {"two_level": "off", "map_resolution_um": 2.0})
        assert auto is not None and off is not None
        assert auto.get("two_level") is not True and off.get("two_level") is not True
        assert off.get("status") == "success" and off.get("routed_pairs", 0) >= 1
        assert auto["paths"] == off["paths"], "auto dispatch perturbed single-pass output"
        assert auto["routed_pairs"] == off["routed_pairs"]

    def test_coincident_boundary_points_fall_back(self, tmp_path):
        """Two outer pads collinear with the window centre collapse to the SAME
        boundary point. The jk-injectivity guard must fall back to single-pass
        rather than silently wire net k's contact to net j's pad."""
        gds = str(tmp_path / "collide.gds")
        contacts = [(-3, -3), (0, -3), (3, -3), (-3, 3), (0, 3), (3, 3)]
        # two pads on the +x axis (same angle from origin) -> identical boundary
        pads = [(4000, 0), (8000, 0)] + _ring(4, 4000.0)[1:]
        _build_gds(gds, contacts, pads)
        res, proc = _run_worker(gds, {"two_level": "on", "map_resolution_um": 20.0})
        assert res is not None, proc.stderr[:300]
        assert res.get("two_level") is not True, (
            "coincident boundary points must force single-pass fallback, not a "
            "scrambled two-level wiring")

    def test_partial_drops_orphan_segments_and_patches(self, tmp_path):
        """Force an ASYMMETRIC partial: a very tight 8-contact cluster with
        rescue OFF makes the INNER pass fail most nets (siblings wall each
        other), while the OUTER pass (boundary->far pad) succeeds for all 8.
        Without orphan-drop the result would carry the surviving inner net + 8
        outer segments + 8 patches (7 of them dangling). The fix must keep ONLY
        nets routed in BOTH passes: inner net-set == outer net-set, and
        patches == routed_pairs (< n_nets). (Obstacles are soft/high-cost here,
        so a cage cannot block — the hard block is sibling pins.)"""
        import gdstk
        gds = str(tmp_path / "partial.gds")
        contacts = [(x, y) for x in (-1.0, 0.0, 1.0) for y in (-1.0, 0.0, 1.0)]
        contacts.remove((0.0, 0.0))   # 8 tightly-packed contacts, ~1um pitch
        pads = _ring(8, 4000.0)
        lib = gdstk.Library()
        top = lib.new_cell("TOP")
        for (x, y) in contacts:
            top.add(gdstk.rectangle((x - 0.5, y - 0.5), (x + 0.5, y + 0.5), layer=100, datatype=0))
        for (x, y) in pads:
            top.add(gdstk.rectangle((x - 25, y - 25), (x + 25, y + 25), layer=101, datatype=0))
        lib.write_gds(gds)
        res, proc = _run_worker(gds, {
            "two_level": "on", "map_resolution_um": 20.0, "path_width_um": 0.4,
            "rescue_unrouted_nets": False})
        assert res is not None, proc.stderr[:300]
        assert res.get("two_level") is True
        routed = res["routed_pairs"]
        assert 0 < routed < res["n_nets"], (
            f"expected a PARTIAL route to exercise orphan-drop; got {routed}/{res['n_nets']}")
        # invariant: no orphan paths, no dangling patches
        innerp = {p["net_id"] for p in res["paths"][:res["inner_routed"]]}
        outerp = {p["net_id"] for p in res["paths"][res["inner_routed"]:]}
        assert innerp == outerp, "orphan single-pass segment leaked into paths"
        assert len(innerp) == routed
        assert len(res["patches"]) == routed, "dangling patch for an unrouted net"

    def test_two_level_preserves_inner_precision_vs_single_pass(self, tmp_path):
        """The whole point: on a large field with fine inner contacts, single-pass
        (off) must COARSEN its one grid to avoid OOM — losing inner precision —
        while two-level (auto) keeps the inner pass fine. The inner-pass
        resolution must be strictly finer than the coarsened single-pass grid."""
        gds = str(tmp_path / "Acmp.gds")
        contacts = [(-3, -3), (0, -3), (3, -3), (-3, 3), (0, 3), (3, 3)]
        pads = _ring(6, 4000.0)
        _build_gds(gds, contacts, pads)
        # ask for a fine grid (0.5um); single-pass cannot honour it over the
        # whole field (it OOMs -> the 25M guard coarsens it). dry_run keeps it
        # fast: the cell-count guard runs before the dry_run early-exit, so the
        # coarsened/fine resolutions are still reported without heavy Dijkstra.
        off, _ = _run_worker(gds, {"two_level": "off", "map_resolution_um": 0.5, "dry_run": True})
        auto, _ = _run_worker(gds, {"two_level": "auto", "map_resolution_um": 20.0, "dry_run": True})
        assert off is not None and auto is not None
        assert auto.get("two_level") is True
        off_res = off["map_resolution_um_used"]            # scalar (coarsened)
        inner_res = auto["map_resolution_um_used"]["inner"]  # fine
        assert inner_res < off_res, (
            f"two-level inner res {inner_res} must be finer than the coarsened "
            f"single-pass res {off_res}")
        # and the single-pass grid really was forced coarser than requested
        assert off_res > 0.5, f"single-pass should have coarsened past 0.5um; got {off_res}"
