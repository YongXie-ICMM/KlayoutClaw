#!/usr/bin/env python
"""qlaybot v0.4.4 Phase 5 Task 5.10 (plugin-side half) — tools/list regression.

Verifies that the KLayout MCP server (``plugin/klayoutclaw_server.lym``),
after the Executor registers the 9 Phase 5 VC handlers, exposes them in
its ``tools/list`` response.

Auto-skips when the MCP server is not reachable (same pattern as
``tests/test_phase4_mcp.py``).  Run under the project's root pytest.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

import pytest


MCP_URL = "http://127.0.0.1:8765/mcp"

_EXPECTED_VC_BARE_NAMES = [
    "vc_init",
    "vc_checkpoint",
    "vc_history",
    "vc_checkout",
    "vc_diff",
    "vc_branch",
    "vc_tag",
    "vc_export",
    "vc_status",
]


def _mcp_available() -> bool:
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


pytestmark = [
    pytest.mark.mcp,
    pytest.mark.skipif(
        not _mcp_available(),
        reason="KLayout MCP server not reachable at 127.0.0.1:8765",
    ),
]


_session_id = None
_req_id = 0


def _mcp_call(method: str, params=None, timeout: int = 30):
    global _req_id, _session_id
    _req_id += 1
    body = {"jsonrpc": "2.0", "id": _req_id, "method": method}
    if params is not None:
        body["params"] = params
    headers = {"Content-Type": "application/json"}
    if _session_id:
        headers["Mcp-Session-Id"] = _session_id
    req = urllib.request.Request(
        MCP_URL, data=json.dumps(body).encode(),
        headers=headers, method="POST",
    )
    r = urllib.request.urlopen(req, timeout=timeout)
    _session_id = r.headers.get("Mcp-Session-Id", _session_id)
    data = json.loads(r.read().decode())
    if "error" in data:
        raise RuntimeError(f"MCP error: {data['error']}")
    return data


@pytest.fixture(scope="module", autouse=True)
def _mcp_init_session():
    _mcp_call("initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "test_phase5_vc_tools_list", "version": "0.1"},
    })
    yield


def _get_tool_names():
    resp = _mcp_call("tools/list")
    tools = resp["result"]["tools"]
    assert isinstance(tools, list) and len(tools) > 0, (
        f"tools/list returned empty/malformed tools array: {resp!r}"
    )
    return [t["name"] for t in tools]


class TestPhase5VcToolsRegistered:
    def test_all_9_vc_tools_in_tools_list(self):
        """Plugin must register all 9 vc_* handlers in the MCP dispatch map."""
        names = _get_tool_names()
        missing = [n for n in _EXPECTED_VC_BARE_NAMES if n not in names]
        assert not missing, (
            f"The following vc_* tools are missing from MCP tools/list: "
            f"{missing}. Full tool list: {sorted(names)}"
        )

    def test_each_vc_tool_has_valid_schema(self):
        """Each vc_* tool must have a valid JSON-Schema 'inputSchema' object."""
        resp = _mcp_call("tools/list")
        tools = {t["name"]: t for t in resp["result"]["tools"]}
        for bare in _EXPECTED_VC_BARE_NAMES:
            assert bare in tools, (
                f"vc_* tool {bare!r} missing from tools/list"
            )
            tool = tools[bare]
            schema = tool.get("inputSchema")
            assert isinstance(schema, dict) and schema.get("type") == "object", (
                f"tool {bare!r} must have inputSchema type=object, got {schema!r}"
            )

    def test_vc_init_requires_gds_path(self):
        """vc_init inputSchema must mark ``gds_path`` as required."""
        resp = _mcp_call("tools/list")
        tools = {t["name"]: t for t in resp["result"]["tools"]}
        init_tool = tools.get("vc_init")
        assert init_tool is not None, "vc_init missing from tools/list"
        schema = init_tool["inputSchema"]
        required = schema.get("required", [])
        assert "gds_path" in required, (
            f"vc_init must require gds_path, got required={required!r}"
        )
