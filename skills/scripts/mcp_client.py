#!/usr/bin/env python
"""Shared MCP client for KlayoutClaw skills.

Provides helpers to call the KlayoutClaw MCP server at 127.0.0.1:8765.
"""

import json
import os
import sys
import urllib.request
import urllib.error

MCP_URL = "http://127.0.0.1:8765/mcp"
_DEFAULT_URL = "http://127.0.0.1:8765/mcp"
_req_id = 0
_session_id = None


def _script_dir():
    """Return the directory containing this script."""
    return os.path.dirname(os.path.abspath(__file__))


def load_mcp_config(config_path=None):
    """Load MCP server URL from a config file.

    Fallback order:
      1. config_path (explicit --mcp-config flag)
      2. .mcp.json in current working directory
      3. mcp_config.json in the KlayoutClaw project root
      4. klayout.json in the workspace and .qlaybot root directory.
      5. Default http://127.0.0.1:8765/mcp

    Returns the resolved URL and sets the module-level MCP_URL.
    """
    global MCP_URL

    if config_path is not None:
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"MCP config not found: {config_path}")
        with open(config_path) as f:
            cfg = json.load(f)
        url = cfg["mcpServers"]["klayoutclaw"]["url"]
        MCP_URL = url
        return url

    # Fallback 1: .mcp.json in current working directory
    cwd_cfg = os.path.join(os.getcwd(), ".mcp.json")
    if os.path.exists(cwd_cfg):
        with open(cwd_cfg) as f:
            cfg = json.load(f)
        url = cfg["mcpServers"]["klayoutclaw"]["url"]
        MCP_URL = url
        return url

    # Fallback 2: mcp_config.json in project root (two levels up from skills/scripts/)
    project_root = os.path.dirname(os.path.dirname(_script_dir()))
    root_cfg = os.path.join(project_root, "mcp_config.json")
    if os.path.exists(root_cfg):
        with open(root_cfg) as f:
            cfg = json.load(f)
        url = cfg["mcpServers"]["klayoutclaw"]["url"]
        MCP_URL = url
        return url
    
    #Fallback 3:klayout.json in the workspace and .qlaybot root directory
    cwd_cfg = os.path.join(os.getcwd(), "klayout.json")
    qlaybot_root_cfg = os.path.join('~/.qlaybot/config', "klayout.json")
    if os.path.exists(cwd_cfg):
        with open(cwd_cfg) as f:
            cfg = json.load(f)
        url = cfg["url"]
        MCP_URL = url
        return url
    if os.path.exists(qlaybot_root_cfg):
        with open(qlaybot_root_cfg) as f:
            cfg = json.load(f)
        url = cfg["url"]
        MCP_URL = url
        return url
    # Default
    MCP_URL = _DEFAULT_URL
    return _DEFAULT_URL


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
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as e:
        print(f"ERROR: Cannot connect to KLayout MCP server at {MCP_URL}", file=sys.stderr)
        print(f"  Make sure KLayout is running with KlayoutClaw plugin.", file=sys.stderr)
        sys.exit(1)
    _session_id = r.headers.get("Mcp-Session-Id", _session_id)
    data = json.loads(r.read().decode())
    if "error" in data:
        raise RuntimeError(f"MCP error: {data['error']}")
    return data


def tool_call(tool_name, timeout=300, **kwargs):
    """Call an MCP tool and return parsed JSON result."""
    result = mcp_call("tools/call", {"name": tool_name, "arguments": kwargs}, timeout=timeout)
    text = result["result"]["content"][0]["text"]
    return json.loads(text)


def execute_script(code):
    """Execute Python/pya code in KLayout via execute_script tool."""
    return tool_call("execute_script", code=code)


def init_session():
    """Initialize MCP session (call once at start)."""
    mcp_call("initialize", {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "klayoutclaw-skill", "version": "0.3"},
    })
