"""Property tests for generality. AST + textual scans of detector source.

Each invariant has an explicit per-file allow-list of NAMED CONSTANTS at
module top — those declarations are legal; the rule is that no naked
numeric/substrate-name literal may appear inside flow-control code.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DETECT = REPO_ROOT / "skills" / "nanodevice_flakedetect_detect" / "scripts"

DETECTOR_FILES = [
    DETECT / "graphite.py",
    DETECT / "graphene.py",
    DETECT / "bottom_hbn.py",
    DETECT / "top_hbn.py",
    DETECT / "detectors" / "b1_classifier.py",
    DETECT / "detectors" / "b2_multik.py",
    DETECT / "detectors" / "b3_shapetemplate.py",
]

# --- Invariant 1: no substrate-name string in flow control --------------
FORBIDDEN_SUBSTRATE_TOKENS = ["PDMS", "SiO2", "Si02", "sio2", "pdms"]


@pytest.mark.parametrize("path", DETECTOR_FILES, ids=lambda p: p.name)
def test_no_substrate_branches(path: Path):
    src = path.read_text()
    tree = ast.parse(src)
    offenders: list[tuple[int, str]] = []

    class Visitor(ast.NodeVisitor):
        def visit_Compare(self, node):
            seg = ast.get_source_segment(src, node) or ""
            for tok in FORBIDDEN_SUBSTRATE_TOKENS:
                if tok in seg:
                    offenders.append((node.lineno, seg.strip()))
            self.generic_visit(node)

    Visitor().visit(tree)
    assert not offenders, (
        f"{path.name}: substrate-name flow-control detected:\n" +
        "\n".join(f"  L{ln}: {seg}" for ln, seg in offenders)
    )


# --- Invariant 2: no GT-fitted prior files referenced -------------------
FORBIDDEN_PRIOR_FILES = [
    "graphene_shape_priors.json",
    "graphite_priors.json",
    "b1_classifier_model.json",
    "b2_priors.json",
    "shape_priors.json",
]


@pytest.mark.parametrize("path", DETECTOR_FILES, ids=lambda p: p.name)
def test_no_gt_prior_files(path: Path):
    src = path.read_text()
    offenders = [name for name in FORBIDDEN_PRIOR_FILES if name in src]
    assert not offenders, (
        f"{path.name}: references GT-fitted prior file(s): {offenders}"
    )


# --- Invariant 3: numeric literals in flow control must be named --------
# Allow numeric literals only inside top-level `NAME = <number>` constants
# or function default-arg = <number> (so callers can override). Bare
# literals inside `if`, `while`, `compare` are flagged.


def _module_constants(tree: ast.Module) -> set[str]:
    out: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id.isupper():
                    out.add(tgt.id)
    return out


@pytest.mark.parametrize("path", DETECTOR_FILES, ids=lambda p: p.name)
def test_no_naked_numerics_in_comparisons(path: Path):
    src = path.read_text()
    tree = ast.parse(src)
    offenders: list[tuple[int, str]] = []

    class V(ast.NodeVisitor):
        def visit_Compare(self, node):
            for cmp_target in (node.left, *node.comparators):
                if isinstance(cmp_target, ast.Constant) and isinstance(cmp_target.value, (int, float)):
                    # -1, 0, 1, 255 are allowed (loop counters, sentinels, byte max)
                    if cmp_target.value in (-1, 0, 1, 255):
                        continue
                    seg = ast.get_source_segment(src, node) or ""
                    offenders.append((node.lineno, seg.strip()))
            self.generic_visit(node)

    V().visit(tree)
    assert not offenders, (
        f"{path.name}: naked numeric literal in comparison (use a named "
        f"adaptive threshold or named constant instead):\n" +
        "\n".join(f"  L{ln}: {seg}" for ln, seg in offenders[:30])
    )


# --- Invariant 4: pixel_size must reach every morphology call ----------
MORPH_FUNCTIONS = ("morph_clean", "morph_close", "morph_open",
                   "morphologyEx", "dilate", "erode")


@pytest.mark.parametrize("path", DETECTOR_FILES, ids=lambda p: p.name)
def test_morphology_uses_pixel_size(path: Path):
    """Whitelist: every function that calls a morphology op must either
    accept `pixel_size` (or `pixel_size_um_per_px`) as a parameter, or
    receive its kernel from a parameter (not a literal)."""
    src = path.read_text()
    tree = ast.parse(src)
    offenders: list[tuple[int, str, str]] = []

    for func in ast.walk(tree):
        if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        params = {a.arg for a in func.args.args}
        accepts_scale = bool(params & {"pixel_size", "pixel_size_um_per_px",
                                        "px_um", "px_size_um"})
        for call in ast.walk(func):
            if not isinstance(call, ast.Call):
                continue
            cname = getattr(call.func, "attr", getattr(call.func, "id", ""))
            if cname not in MORPH_FUNCTIONS:
                continue
            literal_kernel = any(
                isinstance(a, ast.Constant) and isinstance(a.value, int)
                for a in call.args
            )
            if literal_kernel and not accepts_scale:
                seg = ast.get_source_segment(src, call) or ""
                offenders.append((call.lineno, func.name, seg.strip()))

    assert not offenders, (
        f"{path.name}: morphology call uses literal kernel without "
        f"pixel_size in scope:\n" +
        "\n".join(f"  L{ln} in {fn}(): {seg}" for ln, fn, seg in offenders[:30])
    )
