"""Unit tests proving the de-overfit changes (Phase 1) hold.

Each test exercises a scoring primitive with a non-Hall-bar layer map. A
test failure here means overfit defaults snuck back in.
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
EVALUATE_WORKER = os.path.join(PROJECT_ROOT, "tools", "evaluate_worker.py")


# ---------------------------------------------------------------------------
# Helpers: build synthetic GDS files with non-Hall-bar layer numbers
# ---------------------------------------------------------------------------

@pytest.fixture
def alt_layer_gds(tmp_path):
    """Layout with NO graphene/graphite layers.

    - L30/0 (channel_body):  10x10 um square at origin
    - L31/0 (bulk_region):   8x8 um square (smaller, centered inside channel_body)
    - L32/0 (contact):       1x1 um square at (15, 15) — outside both above
    """
    if gdstk is None:
        pytest.skip("gdstk not installed")
    lib = gdstk.Library()
    top = lib.new_cell("TOP")
    top.add(gdstk.rectangle((-5, -5), (5, 5), layer=30, datatype=0))
    top.add(gdstk.rectangle((-4, -4), (4, 4), layer=31, datatype=0))
    top.add(gdstk.rectangle((14.5, 14.5), (15.5, 15.5), layer=32, datatype=0))
    p = tmp_path / "alt.gds"
    lib.write_gds(str(p))
    return str(p)


def _run_evaluate(gds_path: str, checks: list[dict], layer_map: dict) -> dict:
    """Spawn evaluate_worker.py as subprocess and return its parsed output.

    evaluate_worker.py's CLI contract: takes a single config JSON path as
    argv[1]. The config embeds both 'gds_path' and 'output_path'.
    """
    with tempfile.TemporaryDirectory() as td:
        out_path = os.path.join(td, "out.json")
        cfg = {
            "gds_path": gds_path,
            "layer_map": layer_map,
            "checks": checks,
            "output_path": out_path,
        }
        cfg_path = os.path.join(td, "config.json")
        with open(cfg_path, "w") as f:
            json.dump(cfg, f)
        subprocess.run(
            [sys.executable, EVALUATE_WORKER, cfg_path],
            check=True, capture_output=True, timeout=60,
        )
        with open(out_path) as f:
            return json.load(f)


# ---------------------------------------------------------------------------
# Task 1.1 — bulk_containment must not silently fall back to graphene/graphite
# ---------------------------------------------------------------------------

class TestBulkContainmentDefaults:
    """bulk_containment with no bulk_region + no materials list must raise
    or return a clear error — not silently score 0 because graphene /
    graphite don't exist in the layer_map."""

    def test_raises_without_bulk_region_or_materials(self, alt_layer_gds):
        """With neither bulk_region NOR materials passed, the primitive
        must error out or at minimum return a status that makes it visible
        — never silently score 0 using a phantom graphene/graphite."""
        result = _run_evaluate(
            alt_layer_gds,
            [{"name": "bulk_containment",
              "args": {"component": "channel_body"},
              "weight": 1.0}],
            {"channel_body": [30, 0]},
        )
        if result["status"] == "ok":
            check = result["checks"][0]
            detail = check.get("detail", "") + " ".join(result.get("warnings", []))
            assert ("bulk_region" in detail or "material" in detail), (
                "bulk_containment silently scored without a bulk region — "
                "overfit default likely still present. detail={!r}".format(detail))

    def test_accepts_explicit_bulk_region(self, alt_layer_gds):
        """Passing bulk_region explicitly must work on a non-Hall-bar layout."""
        result = _run_evaluate(
            alt_layer_gds,
            [{"name": "bulk_containment",
              "args": {"component": "channel_body", "bulk_region": "bulk_region"},
              "weight": 1.0}],
            {"channel_body": [30, 0], "bulk_region": [31, 0]},
        )
        assert result["status"] == "ok"
        score = result["checks"][0]["score"]
        # channel_body is 10x10=100 um^2; bulk_region is 8x8=64 um^2, contained.
        # score = channel_body ∩ bulk_region / channel_body area = 64/100 = 0.64.
        assert 0.60 <= score <= 0.68, f"expected ~0.64, got {score}"

    def test_accepts_materials_list(self, alt_layer_gds):
        """Passing materials=[...] instead of bulk_region must also work."""
        result = _run_evaluate(
            alt_layer_gds,
            [{"name": "bulk_containment",
              "args": {"component": "channel_body",
                       "materials": ["bulk_region"]},
              "weight": 1.0}],
            {"channel_body": [30, 0], "bulk_region": [31, 0]},
        )
        assert result["status"] == "ok"
        score = result["checks"][0]["score"]
        assert 0.60 <= score <= 0.68, f"expected ~0.64, got {score}"
