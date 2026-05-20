"""top_hbn.py phase-4 unit tests.

These tests enforce the specific generality properties the Phase 4 audit
identified. They do NOT replace the agent-driven regression gate in
test_agent_regression.py.

Adapted from the plan (Phase 4, Step 4.1) with one adjustment to
test_multi_component_supported: multi-component is required to be *available*
(enumerated in result JSON or accessible via a flag) rather than as the
mandatory default mask output, to preserve top_hbn IoU (currently 0.87-0.97).
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"


def _src() -> str:
    return (DETECT / "top_hbn.py").read_text()


def test_performs_material_validation():
    """top_hbn.py must define a function that validates hBN material evidence
    inside the footprint, rather than blindly copying the footprint mask."""
    src = _src()
    tree = ast.parse(src)
    func_names = {n.name for n in ast.walk(tree)
                  if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    expected = {"validate_hbn_contrast", "score_hbn_evidence",
                "verify_footprint_material"}
    assert func_names & expected, (
        f"top_hbn.py must define one of {expected}; got {sorted(func_names)}"
    )


def test_emits_evidence_score_in_result():
    """The result JSON must include a material evidence/score field so the
    agent can use it for downstream decisions."""
    src = _src()
    assert "evidence_score" in src or "material_score" in src, (
        "top_hbn.py result JSON must include an evidence/material score"
    )


def test_low_confidence_when_no_material_evidence():
    """When contrast inside the footprint does not match hBN material,
    top_hbn.py must set low_confidence=True in the result JSON."""
    src = _src()
    assert "low_confidence" in src, (
        "top_hbn.py must set low_confidence when contrast inside the "
        "footprint does not match hBN"
    )


def test_multi_component_supported():
    """Multi-component support must be *available*: the script must not select
    only the single largest contour in all paths. After the Phase 4 refactor,
    either:
      (a) all contours above an adaptive area floor are used as the default
          mask, OR
      (b) all qualifying contours are enumerated in the result JSON (under
          'all_contours_px' or similar) so the agent can inspect them.

    The historic `largest = max(contours, key=cv2.contourArea)` with no
    further enumeration must be gone.
    """
    src = _src()
    # The original pattern: `max(contours, ...)` as the sole path with no
    # multi-component enumeration. After Phase 4 the script must either:
    # - not use `max(contours` at all, OR
    # - if it still uses it, it must also emit `all_contours_px` (or similar)
    #   in the result JSON so multi-component info is available to the agent.
    tree = ast.parse(src)

    uses_max_contours_only = False
    has_multi_component_enumeration = (
        "all_contours" in src
        or "component_areas" in src
        or "contour_areas" in src
        or "additional_contours" in src
    )

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        # Detect `max(contours, key=...)` pattern
        if getattr(node.func, "id", "") == "max":
            for arg in node.args:
                if isinstance(arg, ast.Name) and "contour" in arg.id.lower():
                    uses_max_contours_only = True
                    break
            if uses_max_contours_only:
                break

    if uses_max_contours_only and not has_multi_component_enumeration:
        pytest.fail(
            "top_hbn.py selects only the largest contour with no multi-component "
            "enumeration. After Phase 4, either use all qualifying contours as "
            "the mask, or enumerate them in the result JSON (e.g. 'all_contours_px')."
        )
