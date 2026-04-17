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
        assert result["status"] == "ok"
        check = result["checks"][0]
        # Error path: score MUST be 0.0 and detail MUST contain an ERROR marker.
        assert check["score"] == 0.0, (
            "bulk_containment returned non-zero score ({!r}) with neither "
            "bulk_region nor materials passed. Did a default sneak back in?".format(
                check["score"]))
        detail = check.get("detail", "") + " ".join(result.get("warnings", []))
        assert "ERROR" in detail, (
            "Error path must surface 'ERROR' in detail so agents can distinguish "
            "from genuine 0 overlap. Got: {!r}".format(detail))
        # And the message must name both allowed arg names.
        assert "bulk_region" in detail and ("material" in detail), (
            "Error message must name both 'bulk_region' and 'materials'. "
            "Got: {!r}".format(detail))

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


# ---------------------------------------------------------------------------
# Task 1.2 — route_inspect must not default to 21/0 + 2/0
# ---------------------------------------------------------------------------

class TestRouteInspectSchema:
    """The route_inspect tool schema in klayoutclaw_server.lym must not
    default contact_layers to ['21/0'] or pad_layer to '2/0'. Those are the
    Hall-bar benchmark layer numbers, not general-purpose defaults."""

    def test_contact_layers_has_no_overfit_default(self):
        import re
        lym_path = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")
        with open(lym_path) as f:
            src = f.read()
        # Locate the route_inspect tool block
        block_match = re.search(
            r'"name":\s*"route_inspect".*?"required":\s*\[.*?\]',
            src, flags=re.DOTALL)
        assert block_match, "route_inspect tool block not found"
        block = block_match.group(0)
        # Must not have a default value of ["21/0"] for contact_layers
        assert re.search(r'"contact_layers".*?"default":\s*\["21/0"\]',
                         block, re.DOTALL) is None, (
            "contact_layers still defaults to ['21/0'] — overfit default")
        # contact_layers MUST be in the required list
        req_match = re.search(r'"required":\s*\[(.*?)\]', block, re.DOTALL)
        assert req_match, "required[] not found in route_inspect"
        required = req_match.group(1)
        assert '"contact_layers"' in required, (
            "contact_layers should be required now (was defaulted to ['21/0']).")

    def test_pad_layer_has_no_overfit_default(self):
        import re
        lym_path = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")
        with open(lym_path) as f:
            src = f.read()
        block_match = re.search(
            r'"name":\s*"route_inspect".*?"required":\s*\[.*?\]',
            src, flags=re.DOTALL)
        assert block_match, "route_inspect tool block not found"
        block = block_match.group(0)
        assert re.search(r'"pad_layer".*?"default":\s*"2/0"',
                         block, re.DOTALL) is None, (
            "pad_layer still defaults to '2/0' — overfit default")
        req_match = re.search(r'"required":\s*\[(.*?)\]', block, re.DOTALL)
        required = req_match.group(1)
        assert '"pad_layer"' in required, (
            "pad_layer should be required now (was defaulted to '2/0').")

    def test_runtime_raises_when_contact_layers_missing(self):
        """The _tool_route_inspect function must raise ValueError naming
        'contact_layers' when the argument is absent. Static analysis: find
        the function in the .lym source and verify the explicit error path
        is present (since we can't invoke it without a live MCP session)."""
        lym_path = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")
        with open(lym_path) as f:
            src = f.read()
        # Find _tool_route_inspect body (from def to next def)
        import re
        m = re.search(
            r'def\s+_tool_route_inspect\s*\([^)]*\)\s*:(.*?)(?=\ndef\s+_tool_|\nclass\s+|\Z)',
            src, flags=re.DOTALL)
        assert m, "_tool_route_inspect function not found"
        body = m.group(1)
        # Explicit check for contact_layers required
        assert re.search(r'contact_layers.*?is\s+None', body, re.DOTALL) or \
               re.search(r'if\s+not\s+contact_layers', body), (
            "_tool_route_inspect must explicitly reject missing contact_layers")
        assert "is required" in body.lower() or "required" in body.lower(), (
            "_tool_route_inspect must raise with a 'required' message")
        # Guard must also catch empty list, not only None
        assert re.search(r'if\s+not\s+contact_(specs|layers)', body), (
            "_tool_route_inspect must reject empty contact_layers list too, "
            "not only None. Use `if not contact_specs:` rather than `is None`.")

    def test_runtime_raises_when_pad_layer_missing(self):
        lym_path = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")
        with open(lym_path) as f:
            src = f.read()
        import re
        m = re.search(
            r'def\s+_tool_route_inspect\s*\([^)]*\)\s*:(.*?)(?=\ndef\s+_tool_|\nclass\s+|\Z)',
            src, flags=re.DOTALL)
        body = m.group(1)
        # Accepts: `if not pad_spec`, `if pad_spec is None`, `if pad_layer is None`, etc.
        assert re.search(r'if\s+not\s+pad_(spec|layer)|pad_(spec|layer)\s+is\s+None',
                         body), (
            "_tool_route_inspect must explicitly reject missing pad_layer")


# ---------------------------------------------------------------------------
# Task 1.3 — next_step_suggestion must not reference Hall-bar vocabulary
# ---------------------------------------------------------------------------

class TestNextStepSanitized:
    """The evaluate_worker's next_step_suggestion string must not contain
    Hall-bar-specific vocabulary. An agent working on a different device
    should not be told to 'consider bulk_containment for Hall-bar-style arms'
    or to reason about 'graphene_only / graphite_only / overlap'."""

    def _eval_with_low_score(self, tmp_path):
        """Build a trivial layout that scores low on component_containment
        and return the evaluate_worker output."""
        if gdstk is None:
            pytest.skip("gdstk not installed")
        gds_path = str(tmp_path / "t.gds")
        lib = gdstk.Library()
        top = lib.new_cell("TOP")
        top.add(gdstk.rectangle((0, 0), (10, 10), layer=30, datatype=0))
        # L31 is tiny + far away, so containment will score low
        top.add(gdstk.rectangle((100, 100), (101, 101), layer=31, datatype=0))
        lib.write_gds(gds_path)
        return _run_evaluate(
            gds_path,
            [{"name": "component_containment",
              "args": {"component": "thing", "region": "bulk"},
              "weight": 0.5},
             {"name": "bulk_containment",
              "args": {"component": "thing", "bulk_region": "bulk"},
              "weight": 0.5}],
            {"thing": [30, 0], "bulk": [31, 0]},
        )

    def test_no_hallbar_vocab_in_next_step(self, tmp_path):
        result = self._eval_with_low_score(tmp_path)
        assert result["status"] == "ok"
        suggestion = result.get("next_step_suggestion", "")
        # banned substrings — each is a Hall-bar-specific term that locks
        # the agent's mental model to that one benchmark.
        banned = ["Hall-bar", "hall bar", "Hall bar", "graphene_only",
                  "graphite_only", "graphene/graphite"]
        lowered = suggestion.lower()
        for word in banned:
            assert word.lower() not in lowered, (
                f"next_step_suggestion contains overfit vocabulary {word!r}: "
                f"{suggestion!r}")
        # But suggestion must still mention SOME follow-up tool — not over-sanitized
        assert ("route_inspect" in suggestion
                or "screenshot" in suggestion
                or "checklist" in suggestion), (
            "next_step_suggestion has been over-sanitized; it should still "
            "point at a follow-up tool. Got: {!r}".format(suggestion))

    def test_suggestion_still_has_substance(self, tmp_path):
        """After sanitizing, the suggestion must still be non-empty and
        give actionable guidance when a check scores low."""
        result = self._eval_with_low_score(tmp_path)
        suggestion = result.get("next_step_suggestion", "")
        assert len(suggestion) >= 50, (
            f"next_step_suggestion too short: {suggestion!r}")
