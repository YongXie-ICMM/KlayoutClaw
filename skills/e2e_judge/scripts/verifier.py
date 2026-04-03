#!/usr/bin/env python3
"""Independent MCP verification — checks layout state after agent runs.

Each verify_* function makes direct MCP calls to KLayout to confirm
the agent actually accomplished its task, independent of what the
agent claimed in its transcript.
"""

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# MCPClient (copied from tests/e2e_qiskit/conftest.py — self-contained)
# ---------------------------------------------------------------------------

KLAYOUT_URL = os.environ.get("KLAYOUT_MCP_URL", "http://127.0.0.1:8765/mcp")


class MCPClient:
    """Lightweight MCP JSON-RPC 2.0 client over HTTP."""

    def __init__(self, url: str = KLAYOUT_URL, client_name: str = "e2e-verifier"):
        self.url = url
        self.client_name = client_name
        self._req_id = 0
        self._session_id = None

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _request(self, method: str, params: dict | None = None,
                 timeout: int = 30) -> dict:
        payload = {"jsonrpc": "2.0", "id": self._next_id(), "method": method}
        if params is not None:
            payload["params"] = params
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        req = urllib.request.Request(
            self.url, data=json.dumps(payload).encode(),
            headers=headers, method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=timeout)
        sid = resp.headers.get("Mcp-Session-Id")
        if sid:
            self._session_id = sid
        body = resp.read().decode()
        ct = resp.headers.get("Content-Type", "")
        if "text/event-stream" in ct:
            for line in body.split("\n"):
                line = line.strip()
                if line.startswith("data: "):
                    return json.loads(line[6:])
            raise ValueError(f"No data: line in SSE response: {body[:200]}")
        return json.loads(body)

    def initialize(self) -> dict:
        data = self._request("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": self.client_name, "version": "1.0"},
        })
        return data.get("result", data)

    def call_tool(self, tool_name: str, timeout: int = 60, **kwargs) -> dict:
        data = self._request(
            "tools/call", {"name": tool_name, "arguments": kwargs}, timeout=timeout,
        )
        if "error" in data:
            raise RuntimeError(f"MCP error calling {tool_name}: {data['error']}")
        result = data.get("result", {})
        if result.get("isError", False):
            raise RuntimeError(f"Tool '{tool_name}' error: {result['content'][0]['text']}")
        text = result["content"][0]["text"]
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"_raw_text": text}

    def execute_script(self, code: str, timeout: int = 30) -> dict:
        return self.call_tool("execute_script", timeout=timeout, code=code)

    def is_available(self, timeout: int = 3) -> bool:
        try:
            self.initialize()
            return True
        except Exception:
            return False


# ---------------------------------------------------------------------------
# VerificationResult
# ---------------------------------------------------------------------------

@dataclass
class VerificationResult:
    checks: dict[str, Any] = field(default_factory=dict)
    passed: bool = True
    summary: str = ""


# ---------------------------------------------------------------------------
# Verification functions
# ---------------------------------------------------------------------------

def verify_no_op(client: MCPClient, **kwargs) -> VerificationResult:
    """No verification needed — transcript-only test."""
    return VerificationResult(
        checks={"type": "transcript_only"},
        passed=True,
        summary="No verification needed (transcript-only test)",
    )


def verify_layout_exists(client: MCPClient, **kwargs) -> VerificationResult:
    """Check that a layout with cells exists."""
    info = client.call_tool("get_layout_info")
    has_cells = info.get("num_cells", info.get("cells", 0))
    top = info.get("top_cell", info.get("top_cell_name", ""))
    return VerificationResult(
        checks={"top_cell": top, "num_cells": has_cells, "raw": info},
        passed=bool(has_cells and has_cells > 0),
        summary=f"Layout exists: top_cell={top}, {has_cells} cells",
    )


def verify_layout_info(client: MCPClient, expected_top_cell: str = None,
                       expected_dbu: float = None, **kwargs) -> VerificationResult:
    """Check that layout info matches expected values."""
    info = client.call_tool("get_layout_info")
    checks = {"raw": info}
    ok = True

    top = info.get("top_cell", info.get("top_cell_name", ""))
    checks["top_cell"] = top
    if expected_top_cell and top != expected_top_cell:
        ok = False
        checks["top_cell_match"] = False
    else:
        checks["top_cell_match"] = True

    dbu = info.get("dbu")
    checks["dbu"] = dbu
    if expected_dbu is not None and dbu != expected_dbu:
        ok = False
        checks["dbu_match"] = False
    else:
        checks["dbu_match"] = True

    return VerificationResult(
        checks=checks, passed=ok,
        summary=f"top_cell={top} ({'OK' if checks['top_cell_match'] else 'MISMATCH'}), "
                f"dbu={dbu} ({'OK' if checks['dbu_match'] else 'MISMATCH'})",
    )


def verify_cell_exists(client: MCPClient, cell_name: str, **kwargs) -> VerificationResult:
    """Check a specific cell exists in the layout."""
    r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
result = {{"exists": cell is not None, "name": "{cell_name}"}}
''')
    exists = r.get("exists", False)
    return VerificationResult(
        checks={"cell_name": cell_name, "exists": exists},
        passed=exists,
        summary=f"Cell '{cell_name}': {'EXISTS' if exists else 'NOT FOUND'}",
    )


def verify_cell_count(client: MCPClient, min_cells: int = 1, **kwargs) -> VerificationResult:
    """Check that the layout has at least min_cells cells."""
    r = client.execute_script('''
result = {"cells": [c.name for c in _layout.each_cell()], "count": _layout.cells()}
''')
    count = r.get("count", 0)
    cells = r.get("cells", [])
    ok = count >= min_cells
    return VerificationResult(
        checks={"count": count, "cells": cells, "min_required": min_cells},
        passed=ok,
        summary=f"{count} cells ({', '.join(cells[:5])}): {'OK' if ok else f'NEED >= {min_cells}'}",
    )


def verify_layer_has_shapes(client: MCPClient, cell_name: str, layer: int,
                            datatype: int = 0, min_count: int = 1,
                            **kwargs) -> VerificationResult:
    """Check that a layer in a cell has at least min_count shapes."""
    r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"error": "cell not found", "count": 0}}
else:
    li = _layout.layer({layer}, {datatype})
    count = cell.shapes(li).size()
    result = {{"count": count, "layer": {layer}, "datatype": {datatype}}}
''')
    count = r.get("count", 0)
    ok = count >= min_count
    return VerificationResult(
        checks={"cell": cell_name, "layer": layer, "datatype": datatype,
                "shape_count": count, "min_required": min_count},
        passed=ok,
        summary=f"L{layer}/{datatype} in '{cell_name}': {count} shapes "
                f"({'OK' if ok else f'NEED >= {min_count}'})",
    )


def verify_shape_in_bbox(client: MCPClient, cell_name: str, layer: int,
                         datatype: int, x_min: float, x_max: float,
                         y_min: float, y_max: float, **kwargs) -> VerificationResult:
    """Check that shapes on a layer fall within expected bounding box."""
    r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"error": "cell not found"}}
else:
    li = _layout.layer({layer}, {datatype})
    region = pya.Region(cell.shapes(li))
    if region.is_empty():
        result = {{"error": "no shapes"}}
    else:
        bb = region.bbox()
        dbu = _layout.dbu
        result = {{"x_min": bb.left*dbu, "y_min": bb.bottom*dbu,
                   "x_max": bb.right*dbu, "y_max": bb.top*dbu}}
''')
    if "error" in r:
        return VerificationResult(
            checks=r, passed=False, summary=f"bbox check failed: {r['error']}",
        )
    ok = (r["x_min"] >= x_min and r["x_max"] <= x_max and
          r["y_min"] >= y_min and r["y_max"] <= y_max)
    return VerificationResult(
        checks={"actual": r, "expected": {"x_min": x_min, "x_max": x_max,
                                           "y_min": y_min, "y_max": y_max}},
        passed=ok,
        summary=f"bbox [{r['x_min']:.0f},{r['y_min']:.0f}]-[{r['x_max']:.0f},{r['y_max']:.0f}] "
                f"{'within' if ok else 'OUTSIDE'} expected",
    )


def verify_multi_layer(client: MCPClient, expected_layers: list,
                       cell_name: str = None, **kwargs) -> VerificationResult:
    """Check that all expected (layer, datatype) pairs have shapes."""
    # Auto-detect top cell if not given
    if not cell_name:
        info = client.call_tool("get_layout_info")
        cell_name = info.get("top_cell", info.get("top_cell_name", "TOP"))

    checks = {}
    all_ok = True
    for ld in expected_layers:
        layer, dt = ld[0], ld[1]
        sub = verify_layer_has_shapes(client, cell_name, layer, dt)
        checks[f"L{layer}/{dt}"] = sub.checks.get("shape_count", 0)
        if not sub.passed:
            all_ok = False

    return VerificationResult(
        checks={"cell": cell_name, "layers": checks},
        passed=all_ok,
        summary=f"Multi-layer check on '{cell_name}': "
                + ", ".join(f"L{k}={v}" for k, v in checks.items())
                + f" ({'ALL OK' if all_ok else 'MISSING SHAPES'})",
    )


def verify_file_exists(client: MCPClient, filepath: str,
                       min_size: int = 100, **kwargs) -> VerificationResult:
    """Check that a file exists on disk with minimum size."""
    exists = os.path.exists(filepath)
    size = os.path.getsize(filepath) if exists else 0
    ok = exists and size >= min_size
    return VerificationResult(
        checks={"filepath": filepath, "exists": exists, "size": size,
                "min_size": min_size},
        passed=ok,
        summary=f"{'EXISTS' if exists else 'MISSING'} {filepath} ({size} bytes)"
                + (f" {'OK' if ok else f'NEED >= {min_size}'}" if exists else ""),
    )


def verify_screenshot_exists(client: MCPClient, filepath: str,
                             **kwargs) -> VerificationResult:
    """Check PNG file exists with valid magic bytes."""
    exists = os.path.exists(filepath)
    if not exists:
        return VerificationResult(
            checks={"filepath": filepath, "exists": False},
            passed=False, summary=f"MISSING {filepath}",
        )
    size = os.path.getsize(filepath)
    # Check PNG magic bytes
    with open(filepath, "rb") as f:
        magic = f.read(8)
    is_png = magic[:4] == b"\x89PNG"
    ok = size > 1000 and is_png
    return VerificationResult(
        checks={"filepath": filepath, "size": size, "is_png": is_png},
        passed=ok,
        summary=f"PNG {filepath}: {size} bytes, valid={'YES' if is_png else 'NO'}",
    )


def verify_device_structure(client: MCPClient, expected_layers: list,
                            min_shapes_per_layer: dict = None,
                            **kwargs) -> VerificationResult:
    """Composite check: multiple layers + bounding box + shape counts."""
    info = client.call_tool("get_layout_info")
    cell_name = info.get("top_cell", info.get("top_cell_name", "TOP"))

    checks = {"top_cell": cell_name}
    all_ok = True

    for ld in expected_layers:
        layer, dt = ld[0], ld[1]
        min_count = 1
        if min_shapes_per_layer and layer in min_shapes_per_layer:
            min_count = min_shapes_per_layer[layer]
        sub = verify_layer_has_shapes(client, cell_name, layer, dt, min_count)
        key = f"L{layer}/{dt}"
        checks[key] = sub.checks.get("shape_count", 0)
        if not sub.passed:
            all_ok = False

    return VerificationResult(
        checks=checks, passed=all_ok,
        summary=f"Device '{cell_name}': "
                + ", ".join(f"{k}={v}" for k, v in checks.items() if k != "top_cell")
                + f" ({'ALL OK' if all_ok else 'INCOMPLETE'})",
    )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

_REGISTRY = {
    "verify_no_op": verify_no_op,
    "verify_layout_exists": verify_layout_exists,
    "verify_layout_info": verify_layout_info,
    "verify_cell_exists": verify_cell_exists,
    "verify_cell_count": verify_cell_count,
    "verify_layer_has_shapes": verify_layer_has_shapes,
    "verify_shape_in_bbox": verify_shape_in_bbox,
    "verify_multi_layer": verify_multi_layer,
    "verify_file_exists": verify_file_exists,
    "verify_screenshot_exists": verify_screenshot_exists,
    "verify_device_structure": verify_device_structure,
}


def run_verification(fn_name: str, client: MCPClient, **kwargs) -> VerificationResult:
    """Dispatch a verification function by name, catching exceptions."""
    fn = _REGISTRY.get(fn_name)
    if fn is None:
        return VerificationResult(
            checks={"error": f"unknown function: {fn_name}"},
            passed=False, summary=f"Unknown verification: {fn_name}",
        )
    try:
        return fn(client, **kwargs)
    except Exception as e:
        return VerificationResult(
            checks={"error": str(e)},
            passed=False, summary=f"Verification error: {e}",
        )
