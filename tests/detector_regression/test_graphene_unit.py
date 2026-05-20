"""graphene.py phase-2 unit tests."""
from __future__ import annotations

import ast
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"


def _src() -> str:
    return (DETECT / "graphene.py").read_text()


def test_no_offline_priors_referenced():
    src = _src()
    forbid = ["graphene_shape_priors", "shape_priors.json",
              "graphene_priors", "fit_shape_priors"]
    found = [t for t in forbid if t in src]
    assert not found, f"graphene.py still references offline priors: {found}"


def test_no_pdms_branch():
    src = _src()
    assert "PDMS" not in src and "pdms" not in src, (
        "graphene.py still has PDMS-named flow control"
    )


def test_no_center_placeholder():
    """The 5x5 center placeholder fallback must be replaced with an empty
    mask + low_confidence=True."""
    src = _src()
    # Forbid the recognized placeholder pattern
    forbidden = ["center_placeholder", "5x5 placeholder",
                 "5, 5", "(5, 5)"]
    tree = ast.parse(src)
    # also flag any function that writes a non-empty mask in a no-candidate path
    bad = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and "fallback" in node.name.lower():
            seg = ast.get_source_segment(src, node) or ""
            if "np.ones" in seg or "np.zeros" not in seg:
                bad.append(node.name)
    assert not bad, f"no-candidate fallback writes non-empty mask: {bad}"


def test_low_confidence_flag_emitted():
    """When no candidate survives, the result JSON must carry
    'low_confidence': true."""
    src = _src()
    assert '"low_confidence"' in src or "'low_confidence'" in src, (
        "graphene.py must emit low_confidence in its result JSON"
    )


def test_contrast_polarity_inferred():
    """The brighter-than-host assumption must be replaced with signed
    contrast inference."""
    src = _src()
    assert "rel_L" in src
    # forbid the original 15..80 sweep range
    tree = ast.parse(src)
    for call in ast.walk(tree):
        if not isinstance(call, ast.Call):
            continue
        if getattr(call.func, "attr", "") == "linspace" or getattr(call.func, "id", "") == "range":
            args = [a for a in call.args if isinstance(a, ast.Constant)]
            vals = [a.value for a in args]
            if vals == [15, 80] or vals == [15, 80, 5]:
                pytest.fail(
                    f"L{call.lineno}: hardcoded rel_L sweep 15..80 still present"
                )


def test_area_gate_scaled_by_host():
    """`100..5000 um²` must be replaced with host-fraction based bounds."""
    src = _src()
    for lit in ["100", "5000"]:
        # only flag if appearing in a comparison context
        # heuristic: `< 5000` or `> 100` near `area`
        for line in src.splitlines():
            if (lit in line and "area" in line.lower()
                and ("<" in line or ">" in line)
                and "host" not in line.lower()):
                pytest.fail(
                    f"area gate appears unscaled by host: {line.strip()!r}"
                )
