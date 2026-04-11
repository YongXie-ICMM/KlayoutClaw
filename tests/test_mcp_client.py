#!/usr/bin/env python
"""Unit tests for mcp_client._extract_mcp_url.

Regression tests for the qlaybot commit_gds.py bug: the shared MCP client
used to hardcode the lookup ``cfg["mcpServers"]["klayoutclaw"]["url"]``,
which raised ``KeyError`` whenever the config file labeled the server
anything else (qlaybot canonically uses ``"klayout"``).

These tests pin the contract of ``_extract_mcp_url``: it must accept any
of the known label names, fall back to a single-entry config, handle
qlaybot's flat ``klayout.json`` shape, and raise a useful ``KeyError``
when no entry can be resolved. No network access, no KLayout needed.
"""
import os
import sys

import pytest

_SKILLS_SCRIPTS = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "skills", "scripts")
)
if _SKILLS_SCRIPTS not in sys.path:
    sys.path.insert(0, _SKILLS_SCRIPTS)

from mcp_client import _extract_mcp_url  # noqa: E402


# ---------------------------------------------------------------------------
# Known label resolution
# ---------------------------------------------------------------------------

def test_resolves_legacy_klayoutclaw_label():
    """The plugin's own mcp_config.json shape must still work."""
    cfg = {"mcpServers": {"klayoutclaw": {"url": "http://127.0.0.1:8765/mcp"}}}
    assert _extract_mcp_url(cfg, "legacy.json") == "http://127.0.0.1:8765/mcp"


def test_resolves_qlaybot_klayout_label():
    """Regression: qlaybot writes its server under the 'klayout' key."""
    cfg = {"mcpServers": {"klayout": {"url": "http://127.0.0.1:8765/mcp"}}}
    assert _extract_mcp_url(cfg, "qlaybot.json") == "http://127.0.0.1:8765/mcp"


def test_resolves_klayout_mcp_label():
    """Migration path from qlaybot's defaultConfig().mcp.klayout_mcp."""
    cfg = {"mcpServers": {"klayout_mcp": {"url": "http://127.0.0.1:8765/mcp"}}}
    assert _extract_mcp_url(cfg, "migration.json") == "http://127.0.0.1:8765/mcp"


def test_klayoutclaw_wins_over_klayout_when_both_present():
    """Priority order: the preferred label resolves first."""
    cfg = {
        "mcpServers": {
            "klayout": {"url": "http://OTHER:8765/mcp"},
            "klayoutclaw": {"url": "http://WIN:8765/mcp"},
        }
    }
    assert _extract_mcp_url(cfg, "both.json") == "http://WIN:8765/mcp"


# ---------------------------------------------------------------------------
# Single-entry fallback
# ---------------------------------------------------------------------------

def test_single_unknown_labeled_entry_is_used():
    """A user's personal .mcp.json with a custom label still works."""
    cfg = {"mcpServers": {"my-dev-klayout": {"url": "http://127.0.0.1:8765/mcp"}}}
    assert _extract_mcp_url(cfg, "custom.json") == "http://127.0.0.1:8765/mcp"


# ---------------------------------------------------------------------------
# Flat qlaybot klayout.json shape
# ---------------------------------------------------------------------------

def test_flat_klayout_config_shape():
    """qlaybot's ~/.qlaybot/config/klayout.json has no 'mcpServers' wrapper."""
    cfg = {"url": "http://127.0.0.1:8765/mcp", "required": True}
    assert _extract_mcp_url(cfg, "klayout.json") == "http://127.0.0.1:8765/mcp"


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------

def test_multi_entry_with_no_known_label_and_no_url_hint_raises():
    """Ambiguous config with nothing resembling klayout should fail loudly."""
    cfg = {
        "mcpServers": {
            "some-other-mcp": {"url": "http://example.com/mcp"},
            "another-mcp": {"url": "https://api.example.org/v1"},
        }
    }
    with pytest.raises(KeyError) as excinfo:
        _extract_mcp_url(cfg, "ambiguous.json")
    # Error message should list present keys so operators can fix it fast.
    msg = str(excinfo.value)
    assert "some-other-mcp" in msg
    assert "another-mcp" in msg


def test_empty_mcp_servers_with_no_top_level_url_raises():
    """Empty config can't silently resolve to anything."""
    cfg = {"mcpServers": {}}
    with pytest.raises(KeyError):
        _extract_mcp_url(cfg, "empty.json")


def test_url_heuristic_resolves_klayout_named_url():
    """Multi-entry config with one URL whose host/path mentions klayout."""
    cfg = {
        "mcpServers": {
            "other-mcp": {"url": "http://example.com/api"},
            "weird-name": {"url": "http://127.0.0.1:8765/mcp"},
        }
    }
    # The heuristic picks the entry with :8765/mcp.
    assert _extract_mcp_url(cfg, "heur.json") == "http://127.0.0.1:8765/mcp"


# ---------------------------------------------------------------------------
# End-to-end: load_mcp_config through a qlaybot-shape file
# ---------------------------------------------------------------------------

def test_load_mcp_config_accepts_qlaybot_klayout_label(tmp_path, monkeypatch):
    """Regression for commit_gds.py: qlaybot writes "klayout" as the label."""
    from mcp_client import load_mcp_config  # re-import for isolation
    import json as _json

    # Pre-condition: clear KLAYOUT_MCP_URL so file lookup is actually used.
    monkeypatch.delenv("KLAYOUT_MCP_URL", raising=False)

    cfg_path = tmp_path / "qlaybot_style.json"
    cfg_path.write_text(_json.dumps({
        "mcpServers": {
            "klayout": {"type": "http", "url": "http://127.0.0.1:8765/mcp"}
        }
    }))

    url = load_mcp_config(str(cfg_path))
    assert url == "http://127.0.0.1:8765/mcp"
