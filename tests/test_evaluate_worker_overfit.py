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


# ---------------------------------------------------------------------------
# Task 1.4 — evaluate_design layer_map schema must not bake benchmark map
# ---------------------------------------------------------------------------

class TestLayerMapSchemaExample:
    """The inline layer_map example inside evaluate_design's schema
    description must not present the Hall-bar benchmark layer map as
    canonical. Agents copy schema examples verbatim."""

    def test_no_concrete_hallbar_example(self):
        import re
        lym_path = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")
        with open(lym_path) as f:
            src = f.read()
        # Locate the evaluate_design tool block by finding its "name" then
        # the next top-level tool boundary (bracket-aware scan is brittle in
        # a single regex; we cap the block at 4000 chars — sufficient for
        # the schema description but small enough to exclude later tools).
        m = re.search(r'"name":\s*"evaluate_design"', src)
        assert m, "evaluate_design block not found in plugin"
        block = src[m.start():m.start() + 6000]
        # The .lym stores schema descriptions as Python string literals, so
        # the Hall-bar bake appears as `\"mesa\": [20, 0]` (escaped-quote).
        # Also tolerate the raw form in case future refactors change the
        # embedding. Use a regex that's agnostic to quoting style.
        # Red flag: three specific Hall-bar mappings together in one place.
        # Both opening and closing quotes may be backslash-escaped in the
        # .lym Python string literal, so allow optional `\` on either side.
        patterns = [
            re.compile(r'\\?"mesa\\?"\s*:\s*\[\s*20\s*,\s*0\s*\]'),
            re.compile(r'\\?"contact_patch\\?"\s*:\s*\[\s*21\s*,\s*0\s*\]'),
            re.compile(r'\\?"bonding_pad\\?"\s*:\s*\[\s*2\s*,\s*0\s*\]'),
        ]
        hits = sum(1 for p in patterns if p.search(block))
        assert hits < 2, (
            "evaluate_design's layer_map example still bakes the Hall-bar "
            "benchmark layer map (mesa=20/0, contact_patch=21/0, "
            "bonding_pad=2/0 appearing together). Replace with a "
            "device-agnostic placeholder like "
            "{\"device_body\": [L, D], \"peripheral\": [L, D]}.")

    def test_layer_map_description_mentions_placeholder(self):
        """After sanitising, the description must still give SOME example
        shape so agents know what the value type looks like. The example
        should be clearly marked as illustrative."""
        import re
        lym_path = os.path.join(PROJECT_ROOT, "plugin", "klayoutclaw_server.lym")
        with open(lym_path) as f:
            src = f.read()
        m = re.search(r'"name":\s*"evaluate_design"', src)
        block = src[m.start():m.start() + 6000]
        # Must still mention benchmark dependency OR an abstract placeholder
        signals = ["illustrative", "placeholder", "benchmark instruction",
                   "device_body", "[L, D]", "[L,D]"]
        assert any(s in block for s in signals), (
            "layer_map description has been over-sanitised; it should still "
            "give an illustrative example so agents know the value shape.")


# ---------------------------------------------------------------------------
# Task 2.1 — material_overlap_report primitive
# ---------------------------------------------------------------------------

@pytest.fixture
def two_material_gds(tmp_path):
    """L11 (material_a) + L13 (material_b) with a known 4x4 um overlap."""
    if gdstk is None:
        pytest.skip("gdstk not installed")
    lib = gdstk.Library()
    top = lib.new_cell("TOP")
    # material_a is 10x10 at origin
    top.add(gdstk.rectangle((0, 0), (10, 10), layer=11, datatype=0))
    # material_b is 10x10 at (6, 6); overlap is 4x4 square at (6,6)-(10,10)
    top.add(gdstk.rectangle((6, 6), (16, 16), layer=13, datatype=0))
    p = tmp_path / "two_mat.gds"
    lib.write_gds(str(p))
    return str(p)


class TestMaterialOverlapReport:
    """material_overlap_report returns structured areas + bboxes + centroids
    for each of {A-only, B-only, overlap} regions. Score is always 1.0; the
    information lives in the side-data ``report`` field promoted to the
    check result."""

    def test_report_has_expected_regions_and_areas(self, two_material_gds):
        result = _run_evaluate(
            two_material_gds,
            [{"name": "material_overlap_report",
              "args": {"materials": ["material_a", "material_b"]},
              "weight": 1.0}],
            {"material_a": [11, 0], "material_b": [13, 0]},
        )
        assert result["status"] == "ok", result
        check = result["checks"][0]
        report = check.get("report")
        assert report is not None, (
            "material_overlap_report must promote a 'report' dict into the "
            "check result")
        # Regions: each material's "_only" + the pair intersection
        expected_keys = {"material_a_only", "material_b_only",
                         "material_a_and_material_b"}
        assert set(report.keys()) >= expected_keys, (
            f"report missing keys; got {sorted(report.keys())}")
        # Areas: each is 10*10 - 4*4 = 84 um^2 for *_only; 4*4 = 16 for overlap
        assert 83 <= report["material_a_only"]["area_um2"] <= 85
        assert 83 <= report["material_b_only"]["area_um2"] <= 85
        assert 15 <= report["material_a_and_material_b"]["area_um2"] <= 17
        # Bboxes: list of 4 floats
        for key in expected_keys:
            bb = report[key]["bbox_um"]
            assert isinstance(bb, list) and len(bb) == 4, (
                f"{key} bbox wrong shape: {bb!r}")
        # Centroids: list of 2 floats
        for key in expected_keys:
            c = report[key]["centroid_um"]
            assert isinstance(c, list) and len(c) == 2, (
                f"{key} centroid wrong shape: {c!r}")
        # num_polygons: int
        for key in expected_keys:
            assert isinstance(report[key]["num_polygons"], int)

    def test_three_material_combinations(self, tmp_path):
        """With 3 materials the primitive emits pairwise + triple regions."""
        if gdstk is None:
            pytest.skip("gdstk not installed")
        lib = gdstk.Library()
        top = lib.new_cell("TOP")
        # Three 10x10 rectangles, each shifted so every pair and the triple
        # intersection is non-empty.
        top.add(gdstk.rectangle((0, 0), (10, 10), layer=11, datatype=0))   # A
        top.add(gdstk.rectangle((5, 0), (15, 10), layer=12, datatype=0))   # B
        top.add(gdstk.rectangle((0, 5), (15, 15), layer=13, datatype=0))   # C
        p = tmp_path / "three.gds"
        lib.write_gds(str(p))
        result = _run_evaluate(
            str(p),
            [{"name": "material_overlap_report",
              "args": {"materials": ["A", "B", "C"]},
              "weight": 1.0}],
            {"A": [11, 0], "B": [12, 0], "C": [13, 0]},
        )
        assert result["status"] == "ok", result
        report = result["checks"][0]["report"]
        # Expect all 7 combination keys: 3 singles + 3 pairs + 1 triple
        for key in ["A_only", "B_only", "C_only",
                    "A_and_B", "A_and_C", "B_and_C",
                    "A_and_B_and_C"]:
            assert key in report, (
                f"missing region {key!r}; got {sorted(report.keys())}")
        # A_and_B_and_C must have non-zero area in this geometry
        assert report["A_and_B_and_C"]["area_um2"] > 0

    def test_raises_on_empty_materials_list(self, two_material_gds):
        """The primitive must refuse an empty materials list, not silently
        return an empty report."""
        result = _run_evaluate(
            two_material_gds,
            [{"name": "material_overlap_report",
              "args": {"materials": []},
              "weight": 1.0}],
            {"material_a": [11, 0], "material_b": [13, 0]},
        )
        # First assert the primitive is registered (not "unknown primitive")
        assert result.get("status") != "error" or "unknown primitive" not in result.get(
            "error", ""), (
            "material_overlap_report is not yet registered as a primitive — "
            "implement it in Task 2.2 before validating input guards")
        # Either subprocess exit signals an error (status != ok) or the
        # check surfaces an error detail
        if result["status"] == "ok":
            check = result["checks"][0]
            # score 0.0 + ERROR marker OR explicit 'error' field
            assert (check.get("score") == 0.0
                    and "ERROR" in check.get("detail", "")), (
                f"Empty materials list must produce an error path. Got: {check!r}")

    def test_raises_on_single_material(self, two_material_gds):
        """A single material yields trivial intersections; the primitive
        should require at least 2 materials."""
        result = _run_evaluate(
            two_material_gds,
            [{"name": "material_overlap_report",
              "args": {"materials": ["material_a"]},
              "weight": 1.0}],
            {"material_a": [11, 0], "material_b": [13, 0]},
        )
        # First assert the primitive is registered (not "unknown primitive")
        assert result.get("status") != "error" or "unknown primitive" not in result.get(
            "error", ""), (
            "material_overlap_report is not yet registered as a primitive — "
            "implement it in Task 2.2 before validating input guards")
        if result["status"] == "ok":
            check = result["checks"][0]
            assert (check.get("score") == 0.0
                    and "ERROR" in check.get("detail", "")), (
                f"Single-element materials list must error. Got: {check!r}")


# ---------------------------------------------------------------------------
# Task 4.1 — contact_isolation.crossing_pairs must populate on real crossings
# ---------------------------------------------------------------------------

@pytest.fixture
def crossing_routes_gds(tmp_path):
    """Two mid-body route rectangles on L3/0 that cross at their centres,
    plus two pads on L2/0 placed far from the crossing so the junction
    filter does not suppress the mid-body overlap."""
    if gdstk is None:
        pytest.skip("gdstk not installed")
    lib = gdstk.Library()
    top = lib.new_cell("TOP")
    # Route A: horizontal wire from (0,50) to (100,50), width 2
    top.add(gdstk.rectangle((0, 49), (100, 51), layer=3, datatype=0))
    # Route B: vertical wire from (50,0) to (50,100), width 2 — crosses A at centre
    top.add(gdstk.rectangle((49, 0), (51, 100), layer=3, datatype=0))
    # Pads placed far from the crossing so junction filter doesn't apply
    top.add(gdstk.rectangle((200, 200), (210, 210), layer=2, datatype=0))
    top.add(gdstk.rectangle((300, 300), (310, 310), layer=2, datatype=0))
    p = tmp_path / "x.gds"
    lib.write_gds(str(p))
    return str(p)


class TestCrossingPairsContract:
    """contact_isolation must populate crossing_pairs side-data on real
    mid-body crossings. Without this, agents see a low score but have no
    way to identify which routes collide — forcing reverse-engineering
    from bbox order (ml11 + ml14 pain point)."""

    def test_crossing_pairs_populated_when_crossings_exist(self, crossing_routes_gds):
        result = _run_evaluate(
            crossing_routes_gds,
            [{"name": "contact_isolation",
              "args": {"component": "contact_route"},
              "weight": 1.0}],
            {"contact_route": [3, 0], "bonding_pad": [2, 0]},
        )
        assert result["status"] == "ok", result
        check = result["checks"][0]
        # Score must drop because of the crossing
        assert check["score"] < 1.0, (
            "contact_isolation scored 1.0 despite obvious mid-body crossing; "
            "detection broken")
        cp = check.get("crossing_pairs")
        assert cp is not None, (
            "crossing_pairs field missing — evaluate_worker main() failed "
            "to promote the dict-return side-data onto the check result")
        assert len(cp) > 0, (
            "crossing_pairs is EMPTY despite low score — agents can see "
            "the penalty but not which routes are guilty. Fix main()'s "
            "side-data forwarding or _prim_contact_isolation's detection.")
        for tup in cp:
            assert isinstance(tup, (list, tuple)) and len(tup) == 3, (
                f"crossing_pairs entries must be [i, j, area_um2] tuples; "
                f"got {tup!r}")
            assert tup[0] != tup[1], tup
            assert tup[2] > 0, tup
        # crossing_pairs_format should document the schema
        assert check.get("crossing_pairs_format"), (
            "crossing_pairs_format legend missing from check result")
