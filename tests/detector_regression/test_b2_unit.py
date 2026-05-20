"""b2_multik.py phase-6 unit tests."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"


def _src() -> str:
    return (DETECT / "detectors" / "b2_multik.py").read_text()


def test_no_gt_priors_loaded():
    src = _src()
    forbidden = ["priors.json", "GT-fitted", "gt_fitted", "fit_priors"]
    found = [t for t in forbidden if t.lower() in src.lower()]
    assert not found, f"b2 still loads GT priors: {found}"


def test_k_chosen_adaptively():
    src = _src()
    # forbid `K_CHOICES = [4, 6, 8]` style fixed K lists
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign):
            for tgt in n.targets:
                if isinstance(tgt, ast.Name) and "K" in tgt.id.upper():
                    if isinstance(n.value, ast.List):
                        pytest.fail(
                            f"L{n.lineno}: fixed K list {ast.unparse(n.value)}"
                        )
    # the file must use silhouette_score or a BIC-like selector
    assert "silhouette" in src or "bic" in src.lower(), (
        "b2 must use silhouette or BIC for K selection"
    )


def test_no_fixed_50um_annulus():
    src = _src()
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and n.value == 50:
            pytest.fail(
                f"L{n.lineno}: literal 50 (um annulus) still present"
            )


def test_mahalanobis_threshold_not_fixed():
    src = _src()
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and n.value == 3.0:
            pytest.fail(
                f"L{n.lineno}: hardcoded Mahalanobis cap 3.0 still present"
            )


def test_no_area_multiplier_priors():
    src = _src()
    for line in src.splitlines():
        if "prior_area" in line.lower() and ("*" in line or "<" in line or ">" in line):
            pytest.fail(
                f"b2 still gates on prior_area: {line.strip()!r}"
            )
