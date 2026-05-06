"""Issue #25 — verify vc_* tools are stripped from MCP server.

Static smoke test: parse ``plugin/klayoutclaw_server.lym`` and assert that
neither the ``_TOOL_DISPATCH`` dict nor the ``TOOLS`` (tools/list payload)
list advertises any ``vc_*`` name.

Deterministic + fast — does not require a running KLayout MCP server.

Issue context: review session 2026-05-05 elected a server-side off-switch
for the version-control tools (``vc_init`` was the only confirmed hang
trigger) by stripping them from ``_TOOL_DISPATCH``. ``tools/list`` is
required to not advertise them either.
"""
from __future__ import annotations

import ast
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
LYM_PATH = REPO_ROOT / "plugin" / "klayoutclaw_server.lym"


def _load_python_source() -> str:
    """Extract the embedded Python from the .lym XML wrapper."""
    tree = ET.parse(LYM_PATH)
    root = tree.getroot()
    text_el = root.find("text")
    assert text_el is not None and text_el.text, (
        f"klayoutclaw_server.lym has no <text> element: {LYM_PATH}"
    )
    return text_el.text


@pytest.fixture(scope="module")
def server_source() -> str:
    return _load_python_source()


def test_server_source_is_valid_python(server_source: str):
    ast.parse(server_source)


def test_tool_dispatch_has_no_vc_keys(server_source: str):
    """``_TOOL_DISPATCH`` must not contain any ``vc_*`` key."""
    m = re.search(r"_TOOL_DISPATCH\s*=\s*\{(.*?)\n\}", server_source, re.S)
    assert m, "Could not locate _TOOL_DISPATCH = { ... } block in server source"
    block = m.group(1)
    # Match string keys in the dispatch dict, e.g. "vc_init":
    leaked = re.findall(r'"(vc_[A-Za-z_]+)"\s*:', block)
    assert not leaked, (
        f"_TOOL_DISPATCH still advertises vc_* tools: {leaked}. Issue #25 "
        f"requires these be stripped (server-side off-switch)."
    )


def test_tools_list_payload_has_no_vc_entries(server_source: str):
    """The ``TOOLS`` list (tools/list payload) must not advertise vc_*."""
    m = re.search(r"\nTOOLS\s*=\s*\[(.*?)\n\]\n", server_source, re.S)
    assert m, "Could not locate TOOLS = [ ... ] block in server source"
    block = m.group(1)
    leaked = re.findall(r'"name"\s*:\s*"(vc_[A-Za-z_]+)"', block)
    assert not leaked, (
        f"tools/list still advertises vc_* tools: {leaked}. Issue #25 "
        f"requires these be removed (no advertisement, no dispatch)."
    )
