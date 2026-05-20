"""b1_classifier.py phase-5 unit tests."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"


def _src() -> str:
    return (DETECT / "detectors" / "b1_classifier.py").read_text()


def test_no_stored_logistic_coefficients():
    src = _src()
    forbidden = ["LOGISTIC_MEAN", "LOGISTIC_STD", "LOGISTIC_COEF",
                 "model_mean", "model_std", "model_coef",
                 "b1_model.json", "classifier_model.json",
                 "_load_classifier", "_predict_proba"]
    found = [t for t in forbidden if t in src]
    assert not found, f"stored logistic coefficients detected: {found}"


def test_bg_sigma_scales_with_pixel_size():
    src = _src()
    tree = ast.parse(src)
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and n.value == 80:
            pytest.fail(
                f"L{n.lineno}: bg_sigma literal 80 still present — derive "
                f"from image size or pixel_size"
            )


def test_probability_thresholds_calibrated():
    src = _src()
    tree = ast.parse(src)
    forbidden_thresholds = {0.15, 0.05}
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and n.value in forbidden_thresholds:
            pytest.fail(
                f"L{n.lineno}: hardcoded probability threshold {n.value} — "
                f"use a calibrated FDR target or Otsu on the probability map"
            )


def test_morphology_kernels_scale():
    src = _src()
    # the historic 7/3 kernels and 5-px dilation must be parameterized
    forbidden_in_call = []
    tree = ast.parse(src)
    for call in ast.walk(tree):
        if not isinstance(call, ast.Call):
            continue
        if getattr(call.func, "attr", "") == "dilate":
            for a in call.args:
                if isinstance(a, ast.Constant) and a.value == 5:
                    forbidden_in_call.append(call.lineno)
    assert not forbidden_in_call, (
        f"dilate(..., 5) literal at lines {forbidden_in_call}"
    )
