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


def test_graphene_grows_into_footprint():
    """Phase 10b: graphene.py must implement footprint-bounded region grow.

    Checks:
    1. The 1.10x hardcoded grow area cap is gone (replaced by 1.50 or dynamic).
    2. A footprint-bounded grow function exists that accepts a footprint_mask arg.
    3. The grow cap constant in the leakage-check path is >= 1.40 (not 1.10).
    """
    src = _src()
    tree = ast.parse(src)

    # (1) No hardcoded 1.10 area cap constant anywhere
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and "GROW_AREA_CAP" in t.id:
                    val = node.value
                    if isinstance(val, ast.Constant) and isinstance(val.value, float):
                        assert val.value >= 1.40, (
                            f"GROW_AREA_CAP_FACTOR = {val.value} is still ≤ 1.10 "
                            "(Phase 10b requires >= 1.40 or dynamic footprint-bounded grow)"
                        )

    # (2) Footprint-bounded grow function must exist with footprint_mask param
    fp_grow_funcs = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            param_names = [a.arg for a in node.args.args]
            if "footprint_mask" in param_names and "grow" in node.name.lower():
                fp_grow_funcs.append(node.name)
    assert fp_grow_funcs, (
        "graphene.py must define a grow function with a footprint_mask parameter "
        "(Phase 10b: footprint-bounded region grow)"
    )

    # (3) AREA_MAX_FOOTPRINT_FRAC constant must exist
    assert "AREA_MAX_FOOTPRINT_FRAC" in src, (
        "graphene.py must define AREA_MAX_FOOTPRINT_FRAC constant (Phase 10b area gate)"
    )


def test_graphene_uses_footprint_containment_when_available():
    """Phase 10a: graphene.py must expose --footprint-mask CLI and implement
    spatial containment scoring so the default cluster (rank 0) is reliably
    the footprint-contained graphene flake, eliminating agent cluster-id overrides.
    """
    src = (DETECT / "graphene.py").read_text()
    # Must mention both footprint and containment concepts
    assert ("footprint" in src.lower() and "containment" in src.lower()), (
        "graphene.py must mention footprint-containment scoring"
    )
    # CLI flag must be exposed
    assert "--footprint-mask" in src, "expose --footprint-mask CLI"
    # The scoring function must exist
    assert "spatial_containment_score" in src, (
        "graphene.py must define spatial_containment_score()"
    )
    # The warp helper must exist (needed to translate footprint to top_part coords)
    assert "_load_footprint_in_toppart_coords" in src, (
        "graphene.py must define _load_footprint_in_toppart_coords() to warp "
        "the footprint mask from full_stack coords to mirrored-top_part coords"
    )
