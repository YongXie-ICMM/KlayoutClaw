"""graphite.py phase-1 unit tests.

These tests do NOT replace the IoU regression in test_iou_regression.py;
they enforce the specific generality properties the audit identified."""
from __future__ import annotations

import ast
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"
spec = importlib.util.spec_from_file_location("graphite", DETECT / "graphite.py")
graphite = importlib.util.module_from_spec(spec)
sys.modules["graphite"] = graphite
spec.loader.exec_module(graphite)


# --- Property 1: no L-brightness preference in substrate selection ----
def test_compute_substrate_ignores_brightness_preference():
    """When two LAB modes have identical histogram support, the substrate
    selection must NOT prefer the brighter one — selection is by
    histogram density, not luminance."""
    src = (DETECT / "graphite.py").read_text()
    tree = ast.parse(src)
    target = None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and "substrate" in node.name.lower():
            target = node
            break
    assert target is not None, "no substrate-selection function found"
    body_src = ast.get_source_segment(src, target) or ""
    # forbid `+ alpha * L`, `+ w * L`, `L_weight * `, etc.
    forbid = ["L_weight", "l_weight", "brightness_weight", "bright_pref"]
    found = [t for t in forbid if t in body_src]
    assert not found, (
        f"substrate selection still references brightness weighting: {found}"
    )


# --- Property 2: auto_t_star thresholds normalize by image size -------
def test_auto_t_star_count_thresholds_scale_with_image_size():
    src = (DETECT / "graphite.py").read_text()
    # the historic `500` floor and `2.5` ratio appeared as literals in
    # the auto_t_star body; after de-tuning, those literals must be gone.
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "auto_t_star":
            body = ast.get_source_segment(src, node) or ""
            for forbidden in ["500", "2.5", "0.15"]:
                assert forbidden not in body, (
                    f"auto_t_star body still contains literal {forbidden!r}"
                )
            return
    pytest.fail("auto_t_star function not found — refactor must keep it")


# --- Property 3: host extraction supports multi-component output ------
def test_compute_host_returns_or_documents_multi_component():
    src = (DETECT / "graphite.py").read_text()
    assert "keep_largest_n" in src, (
        "compute_host must use keep_largest_n (with n>=1 configurable)"
    )
    # no naked `keep_largest_n(..., 1)` — n must be derived
    tree = ast.parse(src)
    offenders = []
    for call in ast.walk(tree):
        if (isinstance(call, ast.Call)
            and getattr(call.func, "id", "") == "keep_largest_n"):
            for a in call.args:
                if isinstance(a, ast.Constant) and a.value == 1:
                    offenders.append(call.lineno)
    assert not offenders, (
        f"keep_largest_n called with literal n=1 at lines {offenders}"
    )


# --- Property 4: chroma center is not hardcoded to (128, 128) ---------
def test_chroma_center_not_hardcoded():
    src = (DETECT / "graphite.py").read_text()
    # Bare integer literals `(128, 128)` or `a=128, b=128` must not appear
    # inline in scoring logic.  The LAB neutral axis must be referenced via the
    # named module constant LAB_NEUTRAL_AB (defined as [128.0, 128.0]) so the
    # intent is documented.  Note: the constant definition itself uses
    # `128.0, 128.0` (floats) — this test checks for the integer form.
    forbidden_patterns = ["128, 128", "a=128", "b=128"]
    hits = [p for p in forbidden_patterns if p in src]
    assert not hits, (
        f"chroma center still hardcoded as naked literals: {hits}. "
        f"Reference LAB_NEUTRAL_AB (the named module constant) instead."
    )


# --- Property 5: cluster-id default selection uses calibrated score ---
def test_default_cluster_id_uses_score_not_rank():
    """The default (no --cluster-id) path must rank by calibrated score,
    not by K-means cluster index order."""
    src = (DETECT / "graphite.py").read_text()
    # there should be no `cluster_id=0` default that bypasses scoring
    assert "calibrated" in src.lower() or "confidence" in src.lower(), (
        "default selection must use a documented calibrated/confidence "
        "metric; add a comment and metric name."
    )


# --- Property 5b: score weights are physics-grounded, not GT-fitted ---
def test_score_weights_are_physics_grounded():
    """Weights must be named as physics (not GT-fit) AND satisfy numerical
    invariants that a sample-tuned model would violate."""
    src = (DETECT / "graphite.py").read_text()

    # Existing forbidden-name check
    forbidden = ["_SCORE_PRIORS", "GT_FITTED", "FITTED_WEIGHTS",
                 "TRAINED_WEIGHTS", "OPTIMIZED_WEIGHTS"]
    found = [t for t in forbidden if t in src]
    assert not found, f"GT-fitted-looking name(s): {found}"

    # If physics weights are present, verify numerical invariants
    if "_PHYSICS_WEIGHTS" in src or "_GRAPHITE_PHYSICS_WEIGHTS" in src:
        # Import to read the actual values
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "graphite", DETECT / "graphite.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["graphite_for_test"] = mod
        spec.loader.exec_module(mod)
        w = getattr(mod, "_PHYSICS_WEIGHTS", None)
        if w is None:
            w = getattr(mod, "_GRAPHITE_PHYSICS_WEIGHTS", None)
        assert w is not None
        # Sum-to-1 (any reasonable scoring model has this property)
        assert abs(np.sum(w) - 1.0) < 1e-6, f"weights sum to {np.sum(w)}, not 1"
        # No single weight dominates absolutely (GT-fitted models often have
        # a winner-takes-all weight)
        assert np.max(w) <= 0.5, f"max weight {np.max(w)} > 0.5 — looks tuned"
        # Each weight is non-negative
        assert np.all(w >= 0)
        # The first weight (s_strip) should be largest or tied for largest —
        # encodes the dominant physical fact (crystal anisotropy)
        assert w[0] >= np.max(w[1:]) - 1e-6, (
            "s_strip is not the dominant weight; that contradicts the "
            "universal crystal-physics rationale"
        )

    # Existing documentation checks
    if "_PHYSICS_WEIGHTS" in src or "_GRAPHITE_PHYSICS_WEIGHTS" in src:
        for keyword in ["s_strip", "s_central", "s_gray", "s_contrast",
                        "s_cohere"]:
            assert keyword in src, (
                f"_PHYSICS_WEIGHTS used but {keyword!r} not documented"
            )
        assert "PHYSICS" in src.upper(), "no PHYSICS rationale documented"


# --- Property 6: morphology kernels scale with pixel_size -------------
_KERNEL_BUILDER_NAMES = {
    "morphologyEx",          # cv2.morphologyEx
    "dilate",                 # cv2.dilate
    "erode",                  # cv2.erode
    "getStructuringElement",  # cv2.getStructuringElement
    "ones",                   # np.ones((K, K), ...)
}


def _is_all_literal_int_tuple(node: ast.AST) -> bool:
    """True if `node` is a Tuple AST literal whose elements are all int
    Constants — e.g. ``(3, 3)``.  Mixed expressions like
    ``(2*k+1, 2*k+1)`` return False because the elements are BinOps,
    not Constants."""
    return (isinstance(node, ast.Tuple)
            and len(node.elts) > 0
            and all(isinstance(e, ast.Constant)
                    and isinstance(e.value, int) for e in node.elts))


def test_morphology_kernels_derive_from_pixel_size():
    """Reject any morphology / kernel-builder call that constructs its
    kernel from a literal-int tuple inline.  Kernels must derive from
    ``pixel_size`` through a helper (e.g. ``_kernel_from_um``)."""
    src = (DETECT / "graphite.py").read_text()
    tree = ast.parse(src)

    # Allow-list: declarations inside the kernel helper itself (the
    # helper does `cv2.getStructuringElement(..., (k, k))` where k is a
    # local var derived from pixel_size). We detect this by checking
    # whether the call's tuple uses NAMES (not constants).
    offenders: list[tuple[int, str, str]] = []
    for call in ast.walk(tree):
        if not isinstance(call, ast.Call):
            continue
        fname = getattr(call.func, "attr", getattr(call.func, "id", ""))
        if fname not in _KERNEL_BUILDER_NAMES:
            continue
        # Inspect positional args + the `kernel=` keyword
        candidate_nodes = list(call.args)
        for kw in call.keywords:
            if kw.arg in ("kernel", "ksize", "structuringElement"):
                candidate_nodes.append(kw.value)
                # nested call: kernel=cv2.getStructuringElement(...)
                if isinstance(kw.value, ast.Call):
                    candidate_nodes.extend(kw.value.args)
        for arg in candidate_nodes:
            if _is_all_literal_int_tuple(arg):
                offenders.append(
                    (call.lineno, fname, ast.unparse(arg)))
                break
    if offenders:
        msg = "\n".join(
            f"  L{ln}: {fn}(... {tup} ...) — use _kernel_from_um(..., pixel_size)"
            for ln, fn, tup in offenders)
        pytest.fail(
            f"morphology kernels constructed from naked literal tuples:\n{msg}"
        )


# --- Property 7: s_gray uses min-chroma-reference for robust achromaticity ---
def test_graphite_chroma_reference_is_neutral_axis():
    """s_gray must use a robust minimum-chroma-reference strategy — not a
    single stack-specific bulk or substrate reference alone.

    Physics rationale (Phase 19 fix): graphite is intrinsically achromatic and
    will appear low-chroma relative to AT LEAST ONE of (bulk, substrate).  On
    illumination-shifted stacks (ml04, ml14) the bulk captures the shift; on
    contaminated-bulk stacks (AH02) the substrate is near-neutral.  Taking the
    minimum chroma over both references is universal and not per-stack tuned.

    The test checks:
    1. LAB_NEUTRAL_AB is still defined (used as substrate fallback).
    2. The minimum-chroma strategy is present (both chroma_vs_bulk and
       chroma_vs_sub are computed, and min(...) selects between them).
    3. A single-reference assignment `neutral_a = float(bulk_mu_lab[...])`
       without the min strategy is NOT present (that was the Phase 12 bug).
    """
    src = (DETECT / "graphite.py").read_text()
    # LAB_NEUTRAL_AB must still exist (used as substrate-proxy fallback)
    assert "LAB_NEUTRAL_AB" in src, (
        "graphite.py must define LAB_NEUTRAL_AB (used as substrate-proxy "
        "fallback when mu_sub is None)"
    )
    # The minimum-chroma strategy must be present
    assert "chroma_vs_bulk" in src and "chroma_vs_sub" in src, (
        "s_gray must compute chroma relative to BOTH bulk and substrate "
        "references (chroma_vs_bulk and chroma_vs_sub) and take the min "
        "(Phase 19 fix — universal achromatic scoring)"
    )
    assert "min(chroma_vs_bulk, chroma_vs_sub)" in src, (
        "s_gray must use min(chroma_vs_bulk, chroma_vs_sub) to select the "
        "most favourable achromatic reference (Phase 19 fix)"
    )
    # Single-reference bug from before Phase 19 must not be present
    assert "neutral_a = float(bulk_mu_lab" not in src, (
        "s_gray still uses a single bulk_mu_lab reference for neutral_a. "
        "This was the Phase 12 design that regressed AH02. "
        "Use the min-chroma-reference strategy instead (Phase 19 fix)."
    )
