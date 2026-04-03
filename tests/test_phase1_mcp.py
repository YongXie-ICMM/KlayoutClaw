#!/usr/bin/env python
"""MCP integration tests for Phase 1: evaluate_design tool.

These tests connect to a running KLayout instance with the KlayoutClaw
MCP server plugin and exercise the evaluate_design tool over the wire.

Marked with @pytest.mark.mcp -- skip with: pytest -m "not mcp"
When KLayout is not running, all tests are auto-skipped.
"""

import json
import os
import urllib.request
import urllib.error

import pytest

# ---------------------------------------------------------------------------
# MCP Client Helpers (same pattern as test_phase0_mcp.py)
# ---------------------------------------------------------------------------

MCP_URL = "http://127.0.0.1:8765/mcp"
_req_id = 0
_session_id = None


def _mcp_available():
    """Check if the KLayout MCP server is reachable."""
    try:
        payload = json.dumps({"jsonrpc": "2.0", "id": 0, "method": "ping"}).encode()
        req = urllib.request.Request(
            MCP_URL, data=payload,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
        return True
    except (urllib.error.URLError, OSError):
        return False


def mcp_call(method, params=None, timeout=30):
    """Send a JSON-RPC 2.0 request to the MCP server."""
    global _req_id, _session_id
    _req_id += 1
    payload = {"jsonrpc": "2.0", "id": _req_id, "method": method}
    if params:
        payload["params"] = params
    headers = {"Content-Type": "application/json"}
    if _session_id:
        headers["Mcp-Session-Id"] = _session_id
    req = urllib.request.Request(
        MCP_URL, data=json.dumps(payload).encode(),
        headers=headers, method="POST",
    )
    r = urllib.request.urlopen(req, timeout=timeout)
    _session_id = r.headers.get("Mcp-Session-Id", _session_id)
    data = json.loads(r.read().decode())
    if "error" in data:
        raise RuntimeError(f"MCP error: {data['error']}")
    return data


def tool_call(tool_name, timeout=120, **kwargs):
    """Call an MCP tool and return parsed JSON result.

    Default timeout is 120s for evaluate_design subprocess calls.
    """
    result = mcp_call("tools/call", {"name": tool_name, "arguments": kwargs}, timeout=timeout)
    content = result["result"]["content"][0]
    text = content["text"]
    if result["result"].get("isError"):
        raise RuntimeError(f"MCP tool error: {text}")
    return json.loads(text)


def tool_call_raw(tool_name, timeout=120, **kwargs):
    """Call an MCP tool and return the raw text response (no JSON parse)."""
    result = mcp_call("tools/call", {"name": tool_name, "arguments": kwargs}, timeout=timeout)
    content = result["result"]["content"][0]
    text = content["text"]
    if result["result"].get("isError"):
        raise RuntimeError(f"MCP tool error: {text}")
    return text



def init_session():
    """Initialize the MCP session."""
    mcp_call("initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "test_phase1_mcp", "version": "0.1"},
    })


# ---------------------------------------------------------------------------
# Skip condition
# ---------------------------------------------------------------------------

_mcp_ok = _mcp_available()

pytestmark = [
    pytest.mark.mcp,
    pytest.mark.skipif(not _mcp_ok, reason="KLayout MCP server not reachable at 127.0.0.1:8765"),
]


# ---------------------------------------------------------------------------
# Session-scoped setup
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module", autouse=True)
def mcp_session():
    """Initialize MCP session once for all tests in this module."""
    init_session()
    yield


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STANDARD_LAYER_MAP = {
    "mesa": [20, 0],
    "contact_patch": [21, 0],
    "topgate": [22, 0],
    "contact_route": [23, 0],
    "bonding_pad": [24, 0],
}

REFERENCE_GDS_PATH = "/tmp/test_phase1_mcp_reference.gds"

# python_path override: the MCP server's conda activation path may be wrong
# (e.g. hardcoded miniforge3 when anaconda3 is installed). Use python_path
# to bypass conda activation and call the Python with gdstk/shapely directly.
ANACONDA_PYTHON = os.path.expanduser("~/anaconda3/bin/python3")
PYTHON_PATH = ANACONDA_PYTHON if os.path.isfile(ANACONDA_PYTHON) else None

def _eval_kwargs(**extra):
    """Build common kwargs for evaluate_design calls, including python_path if available."""
    kw = {"layer_map": STANDARD_LAYER_MAP}
    if PYTHON_PATH:
        kw["python_path"] = PYTHON_PATH
    kw.update(extra)
    return kw

DRC_CHECK_NAMES = [
    "topgate",
    "contact_isolation",
    "connectivity",
    "route_endpoints",
    "contact_mesa_adjacency",
    "mesa_probes",
]

SCORE_CHECK_NAMES = [
    "mesa_on_overlap",
    "contacts_in_regions",
    "topgate",
    "contact_isolation",
    "connectivity",
    "route_endpoints",
    "contact_mesa_adjacency",
    "mesa_probes",
]

# pya code to create a Hall bar device with all required layers
HALLBAR_DEVICE_PYA = """
import pya

lv, ly, tc = _get_or_create_view()

# --- Layer indices ---
li_mesa = ly.layer(20, 0)
li_contact = ly.layer(21, 0)
li_topgate = ly.layer(22, 0)
li_route = ly.layer(23, 0)
li_pad = ly.layer(24, 0)

# --- Mesa: H-bar shape ---
# Central channel: 60 x 10 um (centered at origin)
tc.shapes(li_mesa).insert(pya.Box(-30000, -5000, 30000, 5000))
# Left top probe: 10 x 30 um
tc.shapes(li_mesa).insert(pya.Box(-35000, 5000, -25000, 35000))
# Left bottom probe: 10 x 30 um
tc.shapes(li_mesa).insert(pya.Box(-35000, -35000, -25000, -5000))
# Right top probe: 10 x 30 um
tc.shapes(li_mesa).insert(pya.Box(25000, 5000, 35000, 35000))
# Right bottom probe: 10 x 30 um
tc.shapes(li_mesa).insert(pya.Box(25000, -35000, 35000, -5000))

# --- Contact patches: 15 x 15 um at probe ends ---
tc.shapes(li_contact).insert(pya.Box(-37500, 20000, -22500, 35000))   # left top
tc.shapes(li_contact).insert(pya.Box(-37500, -35000, -22500, -20000)) # left bottom
tc.shapes(li_contact).insert(pya.Box(22500, 20000, 37500, 35000))     # right top
tc.shapes(li_contact).insert(pya.Box(22500, -35000, 37500, -20000))   # right bottom

# --- Topgate: 40 x 8 um over channel center ---
tc.shapes(li_topgate).insert(pya.Box(-20000, -4000, 20000, 4000))

# --- Contact routes: paths from patches outward ---
tc.shapes(li_route).insert(pya.Box(-37500, 35000, -22500, 60000))   # left top up
tc.shapes(li_route).insert(pya.Box(-37500, -60000, -22500, -35000)) # left bottom down
tc.shapes(li_route).insert(pya.Box(22500, 35000, 37500, 60000))     # right top up
tc.shapes(li_route).insert(pya.Box(22500, -60000, 37500, -35000))   # right bottom down

# --- Bonding pads: 80 x 80 um at route ends ---
tc.shapes(li_pad).insert(pya.Box(-70000, 60000, 10000, 140000))     # left top
tc.shapes(li_pad).insert(pya.Box(-70000, -140000, 10000, -60000))   # left bottom
tc.shapes(li_pad).insert(pya.Box(-10000, 60000, 70000, 140000))     # right top
tc.shapes(li_pad).insert(pya.Box(-10000, -140000, 70000, -60000))   # right bottom

_refresh_view()
result = "hallbar device created"
"""

# pya code to add reference layers (graphene L11/0, graphite L13/0) and save GDS
REFERENCE_LAYERS_PYA = """
import pya

lv, ly, tc = _get_or_create_view()

# --- Reference layers for score mode ---
# Graphene L11/0: large rectangle covering entire mesa area
li_graphene = ly.layer(11, 0)
tc.shapes(li_graphene).insert(pya.Box(-50000, -50000, 50000, 50000))

# Graphite L13/0: overlapping graphene
li_graphite = ly.layer(13, 0)
tc.shapes(li_graphite).insert(pya.Box(-40000, -40000, 40000, 40000))

_refresh_view()

# Save layout as reference GDS
save_opts = pya.SaveLayoutOptions()
save_opts.format = "GDS2"
ly.write("{ref_path}", save_opts)

result = "reference layers added and GDS saved"
""".replace("{ref_path}", REFERENCE_GDS_PATH)


# ---------------------------------------------------------------------------
# Test Class: Tool Listing
# ---------------------------------------------------------------------------

class TestEvaluateDesignToolListing:
    """Verify evaluate_design appears in tools/list with correct schema."""

    def test_evaluate_design_in_tools_list(self):
        """tools/list must include evaluate_design."""
        result = mcp_call("tools/list")
        tools = result["result"]["tools"]
        tool_names = [t["name"] for t in tools]
        assert "evaluate_design" in tool_names, (
            f"evaluate_design not in tools/list. Found: {tool_names}"
        )

    def test_layer_map_is_required(self):
        """layer_map must be listed as required in the tool schema."""
        result = mcp_call("tools/list")
        tools = result["result"]["tools"]
        tool = next(t for t in tools if t["name"] == "evaluate_design")
        required = tool["inputSchema"].get("required", [])
        assert "layer_map" in required, (
            f"layer_map must be required. Required fields: {required}"
        )

    def test_mode_has_enum_score_drc(self):
        """mode parameter must have enum values ['score', 'drc']."""
        result = mcp_call("tools/list")
        tools = result["result"]["tools"]
        tool = next(t for t in tools if t["name"] == "evaluate_design")
        mode_prop = tool["inputSchema"]["properties"]["mode"]
        assert set(mode_prop.get("enum", [])) == {"score", "drc"}, (
            f"mode enum must be {{'score', 'drc'}}, got {mode_prop.get('enum')}"
        )

    def test_reference_gds_is_optional(self):
        """reference_gds must be present but NOT in required list."""
        result = mcp_call("tools/list")
        tools = result["result"]["tools"]
        tool = next(t for t in tools if t["name"] == "evaluate_design")
        props = tool["inputSchema"]["properties"]
        assert "reference_gds" in props, "reference_gds must be in inputSchema properties"
        required = tool["inputSchema"].get("required", [])
        assert "reference_gds" not in required, (
            "reference_gds must NOT be required (it is optional for DRC mode)"
        )


# ---------------------------------------------------------------------------
# Test Class: DRC Mode
# ---------------------------------------------------------------------------

class TestEvaluateDesignDrcMode:
    """Test evaluate_design in DRC mode with a Hall bar device fixture."""

    @pytest.fixture(autouse=True)
    def setup_hallbar(self):
        """Create a fresh layout with Hall bar device geometry."""
        tool_call("create_layout", name="TEST_EVALUATE_DRC", dbu=0.001)
        tool_call_raw("execute_script", code=HALLBAR_DEVICE_PYA)
        yield

    def test_drc_returns_status_ok(self):
        """DRC mode must return status 'ok' for a valid device."""
        result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        assert result["status"] == "ok", (
            f"Expected status 'ok', got '{result.get('status')}'. "
            f"Full result: {json.dumps(result, indent=2)[:500]}"
        )

    def test_drc_returns_6_checks(self):
        """DRC mode must return exactly 6 checks."""
        result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        checks = result["checks"]
        assert len(checks) == 6, (
            f"Expected 6 DRC checks, got {len(checks)}. "
            f"Check names: {[c['name'] for c in checks]}"
        )

    def test_drc_check_names_are_correct(self):
        """DRC mode check names must match the expected 6 DRC checks."""
        result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        check_names = [c["name"] for c in result["checks"]]
        assert set(check_names) == set(DRC_CHECK_NAMES), (
            f"DRC check names mismatch. Expected: {sorted(DRC_CHECK_NAMES)}, "
            f"got: {sorted(check_names)}"
        )

    def test_drc_overall_in_valid_range(self):
        """DRC overall score must be between 0.0 and 1.0 inclusive."""
        result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        overall = result["overall"]
        assert isinstance(overall, (int, float)), (
            f"overall must be numeric, got {type(overall).__name__}"
        )
        assert 0.0 <= overall <= 1.0, (
            f"overall must be in [0.0, 1.0], got {overall}"
        )

    def test_drc_mode_field_is_drc(self):
        """Result mode field must be 'drc' when called with mode='drc'."""
        result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        assert result["mode"] == "drc", (
            f"Expected mode='drc', got '{result.get('mode')}'"
        )

    def test_drc_check_object_shape(self):
        """Each DRC check must have keys: name, score, weight, detail."""
        result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        expected_keys = {"name", "score", "weight", "detail"}
        for check in result["checks"]:
            actual_keys = set(check.keys())
            assert actual_keys == expected_keys, (
                f"Check '{check.get('name', '?')}' has keys {actual_keys}, "
                f"expected {expected_keys}"
            )

    def test_drc_valid_device_has_positive_scores(self):
        """A valid Hall bar must produce scores > 0 for geometry-aware checks.

        This guards against a stub that returns fixed zero-score JSON.
        topgate and contact_mesa_adjacency must be > 0 for the test device.
        """
        result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        checks_by_name = {c["name"]: c["score"] for c in result["checks"]}
        # The test device has a topgate overlapping mesa -> topgate score > 0
        assert checks_by_name["topgate"] > 0, (
            f"topgate score must be > 0 for valid device, got {checks_by_name['topgate']}"
        )
        # Contact patches are adjacent to mesa -> contact_mesa_adjacency > 0
        assert checks_by_name["contact_mesa_adjacency"] > 0, (
            f"contact_mesa_adjacency must be > 0 for valid device, "
            f"got {checks_by_name['contact_mesa_adjacency']}"
        )

    def test_drc_empty_layout_scores_differ_from_valid_device(self):
        """An empty layout (no geometry) must produce meaningfully different scores.

        This counterexample proves the tool actually analyzes geometry rather
        than returning canned/fixed results. With no mesa, contacts, routes,
        or pads, connectivity and contact_mesa_adjacency must score 0.0
        (no geometry to evaluate), and overall must be strictly lower than
        the valid device overall (tested above in test_drc_overall_in_valid_range).
        """
        # First, capture the valid device overall for comparison
        valid_result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        valid_overall = valid_result["overall"]
        # Create a fresh empty layout — overrides the autouse fixture's Hall bar
        tool_call("create_layout", name="TEST_EVALUATE_EMPTY", dbu=0.001)
        empty_result = tool_call("evaluate_design", **_eval_kwargs(mode="drc"))
        empty_checks = {c["name"]: c["score"] for c in empty_result["checks"]}

        # connectivity requires routes touching contacts — must be 0 with no geometry
        assert empty_checks["connectivity"] == 0.0, (
            f"Empty layout connectivity must be 0.0, got {empty_checks['connectivity']}"
        )
        # contact_mesa_adjacency requires contacts adjacent to mesa — must be 0
        assert empty_checks["contact_mesa_adjacency"] == 0.0, (
            f"Empty layout contact_mesa_adjacency must be 0.0, "
            f"got {empty_checks['contact_mesa_adjacency']}"
        )
        # Empty overall must be strictly less than valid device overall
        assert empty_result["overall"] < valid_overall, (
            f"Empty layout overall ({empty_result['overall']}) must be strictly less "
            f"than valid device overall ({valid_overall})"
        )


# ---------------------------------------------------------------------------
# Test Class: Score Mode
# ---------------------------------------------------------------------------

class TestEvaluateDesignScoreMode:
    """Test evaluate_design in score mode with device + reference GDS."""

    @pytest.fixture(autouse=True)
    def setup_hallbar_with_reference(self):
        """Create Hall bar device and save reference GDS with material layers."""
        tool_call("create_layout", name="TEST_EVALUATE_SCORE", dbu=0.001)
        tool_call_raw("execute_script", code=HALLBAR_DEVICE_PYA)
        tool_call_raw("execute_script", code=REFERENCE_LAYERS_PYA)
        yield

    def test_score_returns_8_checks(self):
        """Score mode must return exactly 8 checks."""
        result = tool_call("evaluate_design",
                           **_eval_kwargs(mode="score", reference_gds=REFERENCE_GDS_PATH))
        checks = result["checks"]
        assert len(checks) == 8, (
            f"Expected 8 score checks, got {len(checks)}. "
            f"Check names: {[c['name'] for c in checks]}"
        )

    def test_score_check_names_are_correct(self):
        """Score mode check names must match the expected 8 score checks."""
        result = tool_call("evaluate_design",
                           **_eval_kwargs(mode="score", reference_gds=REFERENCE_GDS_PATH))
        check_names = [c["name"] for c in result["checks"]]
        assert set(check_names) == set(SCORE_CHECK_NAMES), (
            f"Score check names mismatch. Expected: {sorted(SCORE_CHECK_NAMES)}, "
            f"got: {sorted(check_names)}"
        )

    def test_score_valid_device_has_positive_geometry_scores(self):
        """A valid device with reference must produce geometry-aware scores > 0.

        mesa_on_overlap must be > 0 because the mesa sits inside the
        graphene/graphite overlap region. topgate must be > 0 because the
        topgate overlaps the mesa.
        """
        result = tool_call("evaluate_design",
                           **_eval_kwargs(mode="score", reference_gds=REFERENCE_GDS_PATH))
        checks_by_name = {c["name"]: c["score"] for c in result["checks"]}
        assert checks_by_name["mesa_on_overlap"] > 0, (
            f"mesa_on_overlap must be > 0 (mesa is within graphene/graphite overlap), "
            f"got {checks_by_name['mesa_on_overlap']}"
        )
        assert checks_by_name["topgate"] > 0, (
            f"topgate must be > 0 for valid device, got {checks_by_name['topgate']}"
        )

    def test_score_overall_in_valid_range(self):
        """Score mode overall must be between 0.0 and 1.0 inclusive."""
        result = tool_call("evaluate_design",
                           **_eval_kwargs(mode="score", reference_gds=REFERENCE_GDS_PATH))
        overall = result["overall"]
        assert isinstance(overall, (int, float)), (
            f"overall must be numeric, got {type(overall).__name__}"
        )
        assert 0.0 <= overall <= 1.0, (
            f"overall must be in [0.0, 1.0], got {overall}"
        )


# ---------------------------------------------------------------------------
# Test Class: Error Handling
# ---------------------------------------------------------------------------

class TestEvaluateDesignErrorHandling:
    """Test evaluate_design error paths."""

    @pytest.fixture(autouse=True)
    def setup_layout(self):
        """Create a minimal layout so the tool has something to save."""
        tool_call("create_layout", name="TEST_EVALUATE_ERRORS", dbu=0.001)
        tool_call_raw("execute_script", code=HALLBAR_DEVICE_PYA)
        yield

    def test_score_mode_missing_reference_gds_errors(self):
        """Score mode without reference_gds must return an error mentioning reference_gds."""
        with pytest.raises(RuntimeError, match=r"^MCP tool error:.*mode='score' requires reference_gds"):
            tool_call("evaluate_design",
                      layer_map=STANDARD_LAYER_MAP,
                      mode="score")

    def test_invalid_layer_map_errors(self):
        """A layer_map missing required keys must return an error listing missing keys."""
        incomplete_map = {"mesa": [20, 0]}  # missing other required keys
        with pytest.raises(RuntimeError, match=r"^MCP tool error:.*layer_map missing required keys:.*contact_patch.*topgate.*contact_route.*bonding_pad"):
            tool_call("evaluate_design",
                      layer_map=incomplete_map,
                      mode="drc")
