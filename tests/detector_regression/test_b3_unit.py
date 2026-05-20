"""b3_shapetemplate.py phase-7 unit tests."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"


def _src() -> str:
    return (DETECT / "detectors" / "b3_shapetemplate.py").read_text()


def test_docstring_does_not_claim_gt_fit():
    src = _src()
    forbid = ["baked from offline GT", "GT fit", "fit_shape_priors"]
    found = [t for t in forbid if t in src]
    assert not found, (
        f"b3_shapetemplate.py still mentions GT-fit provenance: {found}"
    )


def test_no_25um_annulus_literal():
    src = _src()
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and n.value == 25:
            pytest.fail(f"L{n.lineno}: literal 25 (um annulus) still present")


def test_no_15x15_morphology_literal():
    src = _src()
    if "(15, 15)" in src or "15, 15)" in src:
        pytest.fail("b3 still uses naked (15,15) morphology kernel")


def test_contrast_polarity_inferred():
    src = _src()
    assert "polarity" in src.lower() or "signed_contrast" in src or "rel_L" in src, (
        "b3 must infer contrast polarity (bright/dark) per image"
    )


def test_no_hard_area_window():
    src = _src()
    # forbid `area < 200` or `area > 3000`-style gates without `host` context
    for line in src.splitlines():
        if (any(n in line for n in ["200", "3000", "5000"])
            and "area" in line.lower()
            and ("<" in line or ">" in line)
            and "host" not in line.lower()
            and "frac" not in line.lower()):
            pytest.fail(f"b3 still uses unscaled area gate: {line.strip()!r}")
