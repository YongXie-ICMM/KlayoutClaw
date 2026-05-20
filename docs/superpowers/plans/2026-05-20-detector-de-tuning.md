# Detector De-Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Each phase is a self-contained TRD group — drive it with `/trd <phase task>`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove sample-fitted priors, hardcoded thresholds, and substrate-name branches from all 7 per-material detection scripts so the flake-detect pipeline generalizes across arbitrary van der Waals stacks without per-stack retuning.

**Architecture:** Eight phases. Phase 0 builds a snapshot-based IoU regression harness from the current detector outputs on five `mlxx` fixtures. Phases 1-7 de-tune each detector under TRD (Overseer writes failing generality + regression tests; Executor refactors); each detector phase ends green on the regression harness + new generality tests. Phase 8 runs all detectors on 13 held-out `AH/HM/QH` fixtures and produces a manual-review panel — gains beyond the `mlxx` snapshot prove generality.

**Tech Stack:** Python 3 (conda env `instrMCPdev`), OpenCV, scikit-learn, scikit-image, NumPy. Tests: `pytest`. Snapshots stored as PNG masks under `tests_resources/detector_snapshots/<stack>/<material>_mask.png`. Fixtures live at `/Volumes/RandomData/harbour-workspace/qlaybot/detect/<stack>/input/`.

**Test invariants enforced by every phase:**

1. **Regression**: IoU(new_mask, snapshot_mask) ≥ 0.95 for every `(stack, material)` in the `mlxx` set.
2. **Generality property tests**: forbidden patterns in code (e.g. `if "PDMS"` branches, integer pixel thresholds outside named-constant declarations, references to `*_priors.json`).
3. **Pixel-size scaling**: all morphology kernels and area floors must be derived from `pixel_size_um_per_px`.

**Regression dataset (`mlxx` — frozen snapshots, gate every PR):**
`ml04`, `ml08`, `ml09`, `ml11`, `ml14` at `/Volumes/RandomData/harbour-workspace/qlaybot/detect/<stack>/input/`.

**Held-out dataset (Phase 8 only, manual review):**
`AH02`, `AH03`, `AH05`, `AH06`, `AH07`, `HM05`, `HM06`, `HM07`, `HM08`, `HM11`, `QH06`, `QH07`, `QH12`.

---

## File Structure

### New files
- `tests_resources/detector_snapshots/<stack>/<material>_mask.png` — frozen baseline masks (Phase 0).
- `tests_resources/detector_snapshots/<stack>/<material>_meta.json` — pixel_size, source image path, git SHA of detector code that produced the snapshot.
- `tests/detector_regression/conftest.py` — shared fixtures (stack list, paths, IoU helper).
- `tests/detector_regression/test_iou_regression.py` — IoU ≥ 0.95 per (stack, material).
- `tests/detector_regression/test_generality_invariants.py` — AST/grep property tests.
- `tests/detector_regression/snapshot_baseline.py` — one-shot baseline generator (run once at Phase 0; not run in CI).
- `tests/detector_regression/run_detector.py` — common runner that invokes one detector on one stack and returns the mask path.
- `tests/detector_regression/held_out_panel.py` — renders 13-stack montage for Phase 8 manual review.

### Modified files (per phase)
- Phase 1: `skills/nanodevice_flakedetect_detect/scripts/graphite.py`
- Phase 2: `skills/nanodevice_flakedetect_detect/scripts/graphene.py`
- Phase 3: `skills/nanodevice_flakedetect_detect/scripts/bottom_hbn.py`
- Phase 4: `skills/nanodevice_flakedetect_detect/scripts/top_hbn.py`
- Phase 5: `skills/nanodevice_flakedetect_detect/scripts/detectors/b1_classifier.py`
- Phase 6: `skills/nanodevice_flakedetect_detect/scripts/detectors/b2_multik.py`
- Phase 7: `skills/nanodevice_flakedetect_detect/scripts/detectors/b3_shapetemplate.py`

### Read-only shared module (may be added to)
- `skills/nanodevice_flakedetect/scripts/core.py` — add adaptive helpers (`otsu_in_host`, `gmm_threshold`, `scale_kernel`, `percentile_threshold`) if needed; do not duplicate logic across detectors.

---

## Phase 0: Regression Harness

**TRD task:** *Build snapshot-based IoU regression test for the 5 mlxx fixtures across all four detectors, plus generality property test scaffolding.*

**Files:**
- Create: `tests/detector_regression/conftest.py`
- Create: `tests/detector_regression/run_detector.py`
- Create: `tests/detector_regression/snapshot_baseline.py`
- Create: `tests/detector_regression/test_iou_regression.py`
- Create: `tests/detector_regression/test_generality_invariants.py`
- Create: `tests_resources/detector_snapshots/` (will be populated by baseline script)

### Phase 0 Tasks

- [ ] **Step 0.1: Verify fixture path is mounted**

Run:
```bash
ls /Volumes/RandomData/harbour-workspace/qlaybot/detect/ml04/input/bottom_part.jpg \
   /Volumes/RandomData/harbour-workspace/qlaybot/detect/ml08/input/bottom_part.jpg \
   /Volumes/RandomData/harbour-workspace/qlaybot/detect/ml09/input/bottom_part.jpg \
   /Volumes/RandomData/harbour-workspace/qlaybot/detect/ml11/input/bottom_part.jpg \
   /Volumes/RandomData/harbour-workspace/qlaybot/detect/ml14/input/bottom_part.jpg
```
Expected: all 5 files listed; halt if the volume isn't mounted.

- [ ] **Step 0.2: Create `tests/detector_regression/conftest.py`**

```python
"""Shared fixtures for detector regression tests."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = Path("/Volumes/RandomData/harbour-workspace/qlaybot/detect")
SNAPSHOT_ROOT = REPO_ROOT / "tests_resources" / "detector_snapshots"

REGRESSION_STACKS = ["ml04", "ml08", "ml09", "ml11", "ml14"]
HELD_OUT_STACKS = [
    "AH02", "AH03", "AH05", "AH06", "AH07",
    "HM05", "HM06", "HM07", "HM08", "HM11",
    "QH06", "QH07", "QH12",
]
MATERIALS = ["graphite", "graphene", "bottom_hbn", "top_hbn"]

IOU_THRESHOLD = 0.95  # regression gate per (stack, material)


def _read_mask(path: Path) -> np.ndarray:
    import cv2
    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise FileNotFoundError(path)
    return (m > 127).astype(np.uint8)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        raise ValueError(f"shape mismatch: {a.shape} vs {b.shape}")
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(union) if union else 1.0


@pytest.fixture(scope="session")
def fixture_root() -> Path:
    if not FIXTURE_ROOT.exists():
        pytest.skip(f"fixture volume not mounted: {FIXTURE_ROOT}")
    return FIXTURE_ROOT


@pytest.fixture(scope="session")
def snapshot_root() -> Path:
    if not SNAPSHOT_ROOT.exists():
        pytest.fail(f"snapshot baseline missing — run snapshot_baseline.py first ({SNAPSHOT_ROOT})")
    return SNAPSHOT_ROOT


@pytest.fixture(params=REGRESSION_STACKS)
def stack(request) -> str:
    return request.param


@pytest.fixture(params=MATERIALS)
def material(request) -> str:
    return request.param
```

- [ ] **Step 0.3: Create `tests/detector_regression/run_detector.py`**

```python
"""Common detector runner — invokes one of the 4 material detectors and
returns the output mask path. Used by both snapshot_baseline.py and the
regression tests."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DETECT = REPO_ROOT / "skills" / "nanodevice_flakedetect_detect" / "scripts"
ALIGN = REPO_ROOT / "skills" / "nanodevice_flakedetect_align" / "scripts"

# stacks all share pixel_size from their alignment metadata; the canonical
# bench value is 0.087 um/px (100x objective). Phase 0 reads this from
# the fixture if a manifest exists, else falls back to 0.087.
DEFAULT_PIXEL_SIZE_UM = 0.087


def _pixel_size(stack_input: Path) -> float:
    manifest = stack_input / "pixel_size.json"
    if manifest.exists():
        return float(json.loads(manifest.read_text())["pixel_size_um_per_px"])
    return DEFAULT_PIXEL_SIZE_UM


def _run(cmd: list[str], cwd: Path) -> None:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"detector failed: {' '.join(cmd)}\nstderr:\n{proc.stderr[-2000:]}"
        )


def run_graphite(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "graphite.py"),
        "--image", str(stack_input / "bottom_part.jpg"),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "graphite_mask.png"


def run_graphene(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "graphene.py"),
        "--image", str(stack_input / "top_part.jpg"),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "graphene_mask.png"


def run_bottom_hbn(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    warp = stack_input.parent / "output" / "align" / "warp_sift_bottom.npy"
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "bottom_hbn.py"),
        "--image", str(stack_input / "bottom_part.jpg"),
        "--target-image", str(stack_input / "full_stack_raw.jpg"),
        "--warp-matrix", str(warp),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "bottom_hbn_mask.png"


def run_top_hbn(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    footprint = stack_input.parent / "output" / "align" / "footprint_mask.png"
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "top_hbn.py"),
        "--footprint-mask", str(footprint),
        "--image", str(stack_input / "full_stack_raw.jpg"),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "top_hbn_mask.png"


RUNNERS = {
    "graphite": run_graphite,
    "graphene": run_graphene,
    "bottom_hbn": run_bottom_hbn,
    "top_hbn": run_top_hbn,
}


def run(material: str, stack_input: Path, out_dir: Path) -> Path:
    if material not in RUNNERS:
        raise ValueError(material)
    return RUNNERS[material](stack_input, out_dir)
```

- [ ] **Step 0.4: Create `tests/detector_regression/snapshot_baseline.py`**

```python
"""One-shot baseline generator. Run ONCE at Phase 0 to freeze the current
detector outputs as the regression target. Not run in CI."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from conftest import (
    FIXTURE_ROOT,
    MATERIALS,
    REGRESSION_STACKS,
    SNAPSHOT_ROOT,
)
from run_detector import run, _pixel_size


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stacks", nargs="*", default=REGRESSION_STACKS)
    ap.add_argument("--materials", nargs="*", default=MATERIALS)
    ap.add_argument("--force", action="store_true",
                    help="overwrite existing snapshots")
    args = ap.parse_args()

    git_sha = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True
    ).strip()

    for stack in args.stacks:
        stack_input = FIXTURE_ROOT / stack / "input"
        if not stack_input.exists():
            raise SystemExit(f"missing fixture: {stack_input}")
        for material in args.materials:
            snap_dir = SNAPSHOT_ROOT / stack
            snap_dir.mkdir(parents=True, exist_ok=True)
            mask_dst = snap_dir / f"{material}_mask.png"
            meta_dst = snap_dir / f"{material}_meta.json"
            if mask_dst.exists() and not args.force:
                print(f"[skip] {mask_dst}")
                continue
            with tempfile.TemporaryDirectory() as td:
                out = Path(td)
                mask_src = run(material, stack_input, out)
                shutil.copy(mask_src, mask_dst)
            meta_dst.write_text(json.dumps({
                "stack": stack,
                "material": material,
                "pixel_size_um_per_px": _pixel_size(stack_input),
                "source_image": str(stack_input),
                "detector_git_sha": git_sha,
            }, indent=2))
            print(f"[snap] {mask_dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 0.5: Run the baseline generator**

Run (interactive — takes ~20 minutes total):
```bash
cd /Users/andrewwayne/testFolder/KlayoutClaw
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev python \
    tests/detector_regression/snapshot_baseline.py --force
```
Expected:
- Creates `tests_resources/detector_snapshots/{ml04,ml08,ml09,ml11,ml14}/{graphite,graphene,bottom_hbn,top_hbn}_mask.png` (20 files).
- Each accompanied by `*_meta.json` with the current detector git SHA.

If any (stack, material) fails, record the failure in the meta JSON as `"baseline_failure": true` instead of aborting — the snapshot test will skip that pair with a clear message.

- [ ] **Step 0.6: Commit the baseline**

```bash
git add tests_resources/detector_snapshots/ tests/detector_regression/{conftest.py,run_detector.py,snapshot_baseline.py}
git commit -m "test(detect): freeze detector mask baselines on mlxx for regression gate"
```

- [ ] **Step 0.7: Create the IoU regression test**

`tests/detector_regression/test_iou_regression.py`:

```python
"""IoU >= 0.95 vs the frozen snapshot. New detector code must not regress."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from conftest import IOU_THRESHOLD, _read_mask, iou
from run_detector import run


def test_regression(stack, material, fixture_root, snapshot_root):
    snap_mask = snapshot_root / stack / f"{material}_mask.png"
    snap_meta = snapshot_root / stack / f"{material}_meta.json"
    if not snap_mask.exists():
        pytest.skip(f"no snapshot for {stack}/{material}")
    meta = json.loads(snap_meta.read_text())
    if meta.get("baseline_failure"):
        pytest.skip(f"{stack}/{material}: baseline run failed at Phase 0")

    with tempfile.TemporaryDirectory() as td:
        new_mask_path = run(material, fixture_root / stack / "input", Path(td))
        new = _read_mask(new_mask_path)
    base = _read_mask(snap_mask)
    score = iou(new, base)
    assert score >= IOU_THRESHOLD, (
        f"{stack}/{material} IoU={score:.3f} < {IOU_THRESHOLD}"
    )
```

- [ ] **Step 0.8: Run the regression test once to confirm green on current code**

```bash
cd /Users/andrewwayne/testFolder/KlayoutClaw
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -v
```
Expected: 20 PASS, 0 FAIL. The current detectors must agree with their own frozen snapshots — any failure here means the detector is non-deterministic and must be made deterministic before proceeding.

- [ ] **Step 0.9: Create the generality invariants test**

`tests/detector_regression/test_generality_invariants.py`:

```python
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
        def visit_If(self, node):
            seg = ast.get_source_segment(src, node.test) or ""
            for tok in FORBIDDEN_SUBSTRATE_TOKENS:
                if tok in seg:
                    offenders.append((node.lineno, seg.strip()))
            self.generic_visit(node)

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
ALLOWED_NUMERIC_CONTEXTS = (
    ast.Assign,           # SOMETHING = 0.5  (module/class scope ok; gated below)
    ast.AnnAssign,
    ast.arguments,        # def f(x=0.5)
    ast.Call,             # cv2.morphologyEx(... 5 ...)  — many libs need ints
    ast.Subscript,
    ast.List, ast.Tuple, ast.Set, ast.Dict,
    ast.Return,
)


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
                    # 0, 1, -1, 2 are allowed (loop counters, sentinels)
                    if cmp_target.value in (-1, 0, 1, 2, 255):
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
```

- [ ] **Step 0.10: Run the generality test on current code — RECORD baseline failures**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_generality_invariants.py -v --tb=line \
    > /tmp/generality_baseline.txt 2>&1 || true
cat /tmp/generality_baseline.txt
```
Expected: most tests FAIL on current code. This is the punch list — each subsequent phase makes its detector's invariants green.

- [ ] **Step 0.11: Commit the test scaffolding**

```bash
git add tests/detector_regression/test_iou_regression.py \
        tests/detector_regression/test_generality_invariants.py
git commit -m "test(detect): IoU regression + generality property tests (initially red)"
```

---

## Phase 1: `graphite.py` De-Tuning (TRD)

**TRD task:** *Remove sample-fitted constants from `skills/nanodevice_flakedetect_detect/scripts/graphite.py` while keeping IoU ≥ 0.95 vs the Phase 0 snapshot on every `mlxx` stack.*

**Files:**
- Modify: `skills/nanodevice_flakedetect_detect/scripts/graphite.py`
- Modify (helpers only): `skills/nanodevice_flakedetect/scripts/core.py`
- Test: `tests/detector_regression/test_iou_regression.py` (already exists)
- Test: `tests/detector_regression/test_generality_invariants.py` (already exists)
- Add: `tests/detector_regression/test_graphite_unit.py` (new — phase-specific unit tests)

**Audit findings to address (cite line numbers from `graphite.py` head-of-trunk at plan date):**
- L72-104: hardcoded morph kernels, area floors, hysteresis percentiles, score weights → derive from `pixel_size`, CC-area distribution, calibrated probability.
- L180-220: corner-substrate + L-brightness assumption → robust background model (low-texture region union, GMM in LAB, no L preference).
- L240-307: `auto_t_star` count thresholds (500, 2.5, 0.15) → image-size-normalized, Otsu/GMM valley.
- L319-322: "largest host only" → multi-component support.
- L450-532: K range fixed, "largest cluster = bulk" → BIC/silhouette, substrate-aware bulk detection.
- L583-613: scoring assumes elongated/central/gray/contrast/coherent with chroma center `(128,128)` → substrate-normalized contrast and learned/calibrated weights.
- L759-771: `--cluster-id` manual override → keep as opt-in only; calibrated confidence drives default selection.

### Phase 1 Tasks

- [ ] **Step 1.1 (Overseer): Spawn TRD Overseer to write the unit test file**

Dispatch via `/trd Phase 1 — graphite.py de-tuning` and let the Overseer write `tests/detector_regression/test_graphite_unit.py`. The Overseer must include the following specific tests; show them this verbatim in the spawn prompt:

```python
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
    # naked `(128, 128)` or `a=128, b=128` must be gone from scoring
    forbidden_patterns = ["128, 128", "a=128", "b=128"]
    hits = [p for p in forbidden_patterns if p in src]
    assert not hits, (
        f"chroma center still hardcoded: {hits}. Use the substrate or host "
        f"mean LAB as the neutral reference."
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


# --- Property 6: morphology kernels scale with pixel_size -------------
def test_morphology_kernels_derive_from_pixel_size():
    src = (DETECT / "graphite.py").read_text()
    # any helper like scale_kernel(um, pixel_size) is fine; forbid
    # `cv2.morphologyEx(..., kernel=np.ones((K, K)))` with K as a naked
    # int that doesn't derive from pixel_size.
    tree = ast.parse(src)
    for call in ast.walk(tree):
        if not isinstance(call, ast.Call):
            continue
        fname = getattr(call.func, "attr", getattr(call.func, "id", ""))
        if fname != "morphologyEx":
            continue
        # walk into kwargs/args looking for a literal-int kernel
        for kw in call.keywords:
            if kw.arg == "kernel" and isinstance(kw.value, ast.Call):
                for a in kw.value.args:
                    if (isinstance(a, ast.Tuple)
                        and all(isinstance(e, ast.Constant) for e in a.elts)):
                        pytest.fail(
                            f"L{call.lineno}: morphologyEx kernel built from "
                            f"naked tuple {ast.unparse(a)}"
                        )
```

- [ ] **Step 1.2: Run the new unit tests to confirm they FAIL on current code**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_graphite_unit.py -v
```
Expected: all 6 FAIL. This is the work list.

- [ ] **Step 1.3 (Executor): Dispatch TRD Executor to make all of the following green:**
  - `tests/detector_regression/test_iou_regression.py` for `material=graphite` on 5 stacks
  - `tests/detector_regression/test_graphite_unit.py` (all 6 properties)
  - `tests/detector_regression/test_generality_invariants.py` filtered to `graphite.py`

The Executor must NOT touch test files. Must implement adaptive replacements per the audit findings above. Required techniques:

- **Substrate selection (L180-220)**: use a Gaussian Mixture Model over LAB in a low-texture, edge-distance-prioritized sample of pixels (not corners). Pick the substrate cluster by *largest weight that contains a corner pixel*, fall back to *largest weight overall* if no corner is in any cluster. Remove the L-preference term.
- **auto_t_star (L240-307)**: replace the LAB-distance count sweep with multi-level Otsu (`skimage.filters.threshold_multiotsu` with `classes=3`) on the in-image LAB-distance histogram, picking the lower-threshold valley as `T*`. Keep `auto_t_star` as a public function; drop the 500/2.5/0.15 literals.
- **Host extraction (L319-322)**: replace `keep_largest_n(..., 1)` with `keep_largest_n(..., n=<adaptive>)` where `n` is the number of components whose area exceeds `<adaptive_min_area>` (derived from total host pixel count via percentile).
- **K-union (L450-532)**: pick K via silhouette score on a sub-sample of host LAB pixels; bulk cluster = the cluster whose centroid is closest to the substrate sample, not the largest one (substrate-aware).
- **Scoring (L583-613)**: replace the chroma center `(128,128)` with `bulk_mean_ab`; replace fixed weights `(0.3,0.3,0.15,0.15,0.1)` with a function `score_weights(host_aspect, n_candidates)` that returns weights derived from candidate-pool separability (variance of each sub-score across candidates → higher weight for sub-scores with more discriminative power).
- **Morphology**: introduce `_kernel_from_um(radius_um, pixel_size_um)` helper; replace all naked `np.ones((K,K))` kernels with calls to this helper.

- [ ] **Step 1.4: Run the full regression + unit test pair until green**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -k graphite -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_graphite_unit.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_generality_invariants.py -v -k graphite
```
Expected: all PASS.

- [ ] **Step 1.5: Commit Phase 1**

```bash
git add skills/nanodevice_flakedetect_detect/scripts/graphite.py \
        skills/nanodevice_flakedetect/scripts/core.py \
        tests/detector_regression/test_graphite_unit.py
git commit -m "refactor(detect): graphite.py — adaptive substrate, host, scoring (no GT priors)"
```

---

## Phase 2: `graphene.py` De-Tuning (TRD)

**TRD task:** *Remove the offline GT-fitted priors and PDMS-name branch from `graphene.py`. Replace the center-placeholder fallback with an explicit low-confidence empty-mask path.*

**Files:**
- Modify: `skills/nanodevice_flakedetect_detect/scripts/graphene.py`
- Add: `tests/detector_regression/test_graphene_unit.py`
- Delete (if present): any `graphene_shape_priors.json` next to the script.

**Audit findings:**
- L4-13, L41-50: explicit GT-fitted priors and fallback constants → derive from current image's host/flake stats per call.
- L54-64: flake mask `gray>40`, `sat>15`, largest component, `5000 px` floor → Otsu in HSV/LAB, multi-component, area floor scaled by pixel_size.
- L116-142: assumes graphene brighter than host with `rel_L 15..80` sweep → infer contrast polarity (signed) from inside-flake L distribution.
- L147-156: area gate `100..5000 um²` → use FOV-relative bounds (e.g. `0.05% — 25%` of host area).
- L260: `# PDMS over-expands` substrate branch → use boundary-leakage detector (region-grow stops when boundary gradient drops below local p10).
- L313-329: `5x5` center placeholder → emit empty mask with `low_confidence=True` and no fabricated geometry.

### Phase 2 Tasks

- [ ] **Step 2.1 (Overseer): Write `test_graphene_unit.py`**

```python
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
```

- [ ] **Step 2.2: Run new tests to confirm they FAIL**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_graphene_unit.py -v
```
Expected: 6 FAIL.

- [ ] **Step 2.3 (Executor): Refactor `graphene.py`**

Required changes:
- Delete the `fallback_priors` dict + any external `*priors*.json` loading.
- Replace `gray>40`/`sat>15` flake-region mask with `threshold_otsu` on the smoothed L channel (or saturation channel) inside a coarse `top_part` foreground region.
- Replace the bright-only `rel_L` sweep with `multiotsu(classes=3)` on the in-flake L histogram, generating two candidate masks (lower-threshold and upper-threshold) and scoring both.
- Replace area gate `100..5000 um²` with `0.05%..25% × host_area_um2`.
- Replace the PDMS region-grow disable with a boundary-leakage check: stop region grow when boundary mean gradient drops below the in-flake p10 of the same gradient.
- Replace the center placeholder with `np.zeros_like(flake_mask)` + `result["low_confidence"] = True`.

- [ ] **Step 2.4: Run all of:**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -k graphene -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_graphene_unit.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_generality_invariants.py -k graphene -v
```
Expected: all PASS.

- [ ] **Step 2.5: Commit Phase 2**

```bash
git add skills/nanodevice_flakedetect_detect/scripts/graphene.py \
        tests/detector_regression/test_graphene_unit.py
git commit -m "refactor(detect): graphene.py — remove GT priors, PDMS branch, center placeholder"
```

---

## Phase 3: `bottom_hbn.py` De-Tuning (TRD)

**TRD task:** *Stop equating `compute_host` output with bottom hBN. Add an explicit hBN-vs-substrate classification step using the de-tuned graphite host as a region prior only.*

**Files:**
- Modify: `skills/nanodevice_flakedetect_detect/scripts/bottom_hbn.py`
- Add: `tests/detector_regression/test_bottom_hbn_unit.py`

**Audit findings:**
- L5-17: docstring explicitly states "host IS the bottom_hBN region on every bench stack" — sample-specific by design.
- L50-91: re-uses graphite host assumptions (inherited by import).
- L21, L53, L106-111: fixed `1.5 um` GT-matching dilation → derive from registration residual.
- L54, L119: fixed `500 um²` low-confidence threshold → relative to host area.
- L104: fixed `5/3` post-warp morphology → scale by pixel_size.

### Phase 3 Tasks

- [ ] **Step 3.1 (Overseer): Write `test_bottom_hbn_unit.py`**

```python
"""bottom_hbn.py phase-3 unit tests."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"


def _src() -> str:
    return (DETECT / "bottom_hbn.py").read_text()


def test_docstring_does_not_claim_host_equals_hbn():
    src = _src()
    forbidden = [
        "host IS the bottom_hBN",
        "host is the bottom_hbn",
        "host = bottom_hbn",
    ]
    for f in forbidden:
        assert f.lower() not in src.lower(), (
            f"bottom_hbn.py docstring still claims '{f}'"
        )


def test_has_hbn_classification_step():
    src = _src()
    tree = ast.parse(src)
    func_names = {n.name for n in ast.walk(tree)
                  if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert any("classify" in n.lower() or "hbn_mask" in n.lower()
               for n in func_names), (
        "bottom_hbn.py must define an hBN classification/extraction step "
        "distinct from compute_host"
    )


def test_dilation_derived_from_registration():
    src = _src()
    # forbid the literal 1.5 in a dilation expression
    tree = ast.parse(src)
    offenders = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and n.value == 1.5:
            offenders.append(n.lineno)
    assert not offenders, (
        f"bottom_hbn.py still uses literal 1.5 um dilation at lines {offenders}"
    )


def test_low_confidence_threshold_relative_to_host_area():
    src = _src()
    # the historic 500 um^2 floor must be gone in any comparison context
    for line in src.splitlines():
        if "500" in line and ("<" in line or ">" in line):
            assert "host" in line.lower() or "frac" in line.lower(), (
                f"bottom_hbn.py 500-um² literal still in comparison: {line!r}"
            )
```

- [ ] **Step 3.2: Confirm new tests FAIL on current code**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_bottom_hbn_unit.py -v
```

- [ ] **Step 3.3 (Executor): Implement hBN extraction step**

Required:
- New helper inside `bottom_hbn.py`: `extract_hbn(image, host_mask, substrate_lab, pixel_size_um)` — takes the graphite host as region prior, but classifies pixels by LAB distance to substrate vs LAB density in the host interior. Returns the hBN mask.
- Replace literal `1.5` with `max(2, int(2 * registration_residual_px))` where `registration_residual_px` is read from the alignment sidecar.
- Replace literal `500 um²` with `0.5% * host_area_um2`.
- Update docstring to remove the "host IS bottom hBN" claim.

- [ ] **Step 3.4: Run regression + unit + invariants**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -k bottom_hbn -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_bottom_hbn_unit.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_generality_invariants.py -k bottom_hbn -v
```

- [ ] **Step 3.5: Commit Phase 3**

```bash
git add skills/nanodevice_flakedetect_detect/scripts/bottom_hbn.py \
        tests/detector_regression/test_bottom_hbn_unit.py
git commit -m "refactor(detect): bottom_hbn.py — classify hBN instead of equating to host"
```

---

## Phase 4: `top_hbn.py` — Add Material Validation (TRD)

**TRD task:** *`top_hbn.py` currently copies the alignment footprint as the top hBN mask with no material check. Add image-evidence validation: the footprint becomes a region prior, and the script verifies hBN-like contrast inside the footprint before emitting it.*

**Files:**
- Modify: `skills/nanodevice_flakedetect_detect/scripts/top_hbn.py`
- Add: `tests/detector_regression/test_top_hbn_unit.py`

**Audit findings:**
- L2-6, L61-67: no detection performed; just copies the align footprint.
- L69-77: largest-contour-only when no contour supplied.

### Phase 4 Tasks

- [ ] **Step 4.1 (Overseer): Write `test_top_hbn_unit.py`**

```python
"""top_hbn.py phase-4 unit tests."""
from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

DETECT = Path(__file__).resolve().parents[2] / "skills" / "nanodevice_flakedetect_detect" / "scripts"


def _src() -> str:
    return (DETECT / "top_hbn.py").read_text()


def test_performs_material_validation():
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
    src = _src()
    assert "evidence_score" in src or "material_score" in src, (
        "top_hbn.py result JSON must include an evidence/material score"
    )


def test_low_confidence_when_no_material_evidence():
    src = _src()
    assert "low_confidence" in src, (
        "top_hbn.py must set low_confidence when contrast inside the "
        "footprint does not match hBN"
    )


def test_multi_component_supported():
    src = _src()
    # the historic largest-contour-only behavior must be gone for the
    # no-contour-provided path
    for line in src.splitlines():
        if "max(" in line and "contour" in line.lower():
            pytest.fail(
                f"top_hbn.py still selects largest contour: {line.strip()!r}"
            )
```

- [ ] **Step 4.2: Confirm tests FAIL**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_top_hbn_unit.py -v
```

- [ ] **Step 4.3 (Executor): Implement validation**

Required:
- New function `validate_hbn_contrast(full_stack_img, footprint_mask, substrate_lab) -> float`: returns 0..1 score = mean LAB-distance from substrate inside footprint, normalized by the same distance over the whole image. Higher = more material-like.
- Threshold via Otsu on the in-footprint distance histogram; if no bimodal structure, treat as low confidence.
- Replace "largest contour" with "all contours above an adaptive area floor (1% × footprint_area)".
- Emit `result["evidence_score"] = score`; set `result["low_confidence"] = True` when `score < otsu_threshold`.

- [ ] **Step 4.4: Run all tests**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -k top_hbn -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_top_hbn_unit.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_generality_invariants.py -k top_hbn -v
```

- [ ] **Step 4.5: Commit Phase 4**

```bash
git add skills/nanodevice_flakedetect_detect/scripts/top_hbn.py \
        tests/detector_regression/test_top_hbn_unit.py
git commit -m "feat(detect): top_hbn.py — material validation, not footprint copy"
```

---

## Phase 5: `detectors/b1_classifier.py` — Calibration (TRD)

**TRD task:** *Replace the fixed-coefficient logistic model + fixed probability thresholds with a per-image calibrated probability model.*

**Files:**
- Modify: `skills/nanodevice_flakedetect_detect/scripts/detectors/b1_classifier.py`
- Add: `tests/detector_regression/test_b1_unit.py`

**Audit findings:**
- L23-32, L37-56: stored mean/std/coefs; fixed `bg_sigma=80 px` (not scaled).
- L68-82, L94-104: probability thresholds `0.15/0.05`, grow dilation `5 px`, `min_area=200`, morphology `7/3`.

### Phase 5 Tasks

- [ ] **Step 5.1 (Overseer): Write `test_b1_unit.py`**

```python
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
                 "b1_model.json", "classifier_model.json"]
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
```

- [ ] **Step 5.2: Confirm FAIL**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_b1_unit.py -v
```

- [ ] **Step 5.3 (Executor): Refactor b1_classifier.py**

Required:
- Compute logistic features **without** stored model coefficients: train a tiny logistic model **online** per image using `flake_mask` as positive examples and a margin around the host as negatives. (Sklearn `LogisticRegression` with default L2.)
- Replace `bg_sigma=80` with `bg_sigma_px = max(20, int(min(image_h, image_w) * 0.05))`.
- Replace probability thresholds `0.15/0.05` with `threshold_otsu(prob_map)`; if Otsu fails (unimodal), set `low_confidence=True` and return an empty mask.
- All morphology calls go through the shared `_kernel_from_um(radius_um, pixel_size_um)` helper from Phase 1.

- [ ] **Step 5.4: Tests**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_b1_unit.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_generality_invariants.py -k b1_classifier -v
```

- [ ] **Step 5.5: Commit**

```bash
git add skills/nanodevice_flakedetect_detect/scripts/detectors/b1_classifier.py \
        tests/detector_regression/test_b1_unit.py
git commit -m "refactor(detect): b1_classifier — per-image logistic + Otsu (no stored coefs)"
```

---

## Phase 6: `detectors/b2_multik.py` — Adaptive K + Prior Removal (TRD)

**TRD task:** *Remove the GT-fitted priors and replace fixed K choices and area gates with image-derived choices.*

**Files:**
- Modify: `skills/nanodevice_flakedetect_detect/scripts/detectors/b2_multik.py`
- Add: `tests/detector_regression/test_b2_unit.py`

**Audit findings:**
- L1-4, L120-130, L158-166: GT-fitted priors + fixed likelihood weights.
- L23-27, L47-66: fixed K choices, min pixels, min cluster count, top components per cluster.
- L98-100, L144-146: hard area multipliers, `200 px` floor, max `4` CCs per cluster.
- L216-223: graphite ROI = hBN + `50 um` annulus.
- L231-235, L255-262: Mahalanobis threshold capped at `3.0`; graphene grows only if seed area `<0.7 × prior_mean`.

### Phase 6 Tasks

- [ ] **Step 6.1 (Overseer): Write `test_b2_unit.py`**

```python
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
```

- [ ] **Step 6.2: Confirm FAIL; then Executor refactor:**

Required:
- Choose K by `silhouette_score` over `K in range(3, min(8, n_ccs))`; pick the K with highest silhouette.
- Replace prior-based area multiplier gates with **local** gates: components retained if `area > p20(component_area_distribution)`.
- Replace `50 um annulus` with `int(2 × median(host_chamfer_distance_um))`.
- Replace Mahalanobis cap `3.0` with `chi2.ppf(0.95, df=3)` (Mahalanobis is chi-squared distributed under Gaussian).
- Replace `0.7 × prior_area_mean` growth gate with `boundary_gradient_p10 > inflake_gradient_p50` test.

- [ ] **Step 6.3: Tests + commit**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_b2_unit.py -v
git add skills/nanodevice_flakedetect_detect/scripts/detectors/b2_multik.py \
        tests/detector_regression/test_b2_unit.py
git commit -m "refactor(detect): b2_multik — adaptive K (silhouette), chi2 Mahalanobis, no GT priors"
```

---

## Phase 7: `detectors/b3_shapetemplate.py` — Remove GT Priors (TRD)

**TRD task:** *Replace shape/LAB/edge GT priors with per-image candidate-pool calibration; eliminate dark-only contrast assumption and fixed area gates.*

**Files:**
- Modify: `skills/nanodevice_flakedetect_detect/scripts/detectors/b3_shapetemplate.py`
- Add: `tests/detector_regression/test_b3_unit.py`

**Audit findings:**
- L1-6: explicit "parameters baked from offline GT fit".
- L73-91: graphite dark-only contrast, `25 um` annulus, p1/p20 L thresholds, `12` sweeps.
- L83-84, L106-108, L214-215: hard area gates.
- L140-164, L155-156, L252-274: fixed shape/LAB priors + score weights.
- L173-183, L282-284: fixed `15x15` close + largest-component.

### Phase 7 Tasks

- [ ] **Step 7.1 (Overseer): Write `test_b3_unit.py`**

```python
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
```

- [ ] **Step 7.2 (Executor): Refactor**

Required:
- Compute candidate score weights as 1/variance of each sub-score over the candidate pool (high-variance sub-scores get more weight — they discriminate better).
- Replace `25 um annulus` with `int(median_host_chamfer_um)`.
- Replace dark-only `p1/p20` L thresholds with `multiotsu(classes=3)` on in-annulus L, generating both bright-mode and dark-mode candidate masks.
- Replace `15x15` close with `_kernel_from_um(radius_um=3.0, pixel_size_um=ps)`.
- Replace hard area gates with `0.05% .. 25% × host_area_um2`.

- [ ] **Step 7.3: Tests + commit**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_iou_regression.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_b3_unit.py -v
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev pytest \
    tests/detector_regression/test_generality_invariants.py -v
git add skills/nanodevice_flakedetect_detect/scripts/detectors/b3_shapetemplate.py \
        tests/detector_regression/test_b3_unit.py
git commit -m "refactor(detect): b3_shapetemplate — per-image weights, signed contrast, no GT priors"
```

---

## Phase 8: Held-Out Generalization Panel

**TRD task (manual-review):** *Run all four detectors against the 13 held-out fixtures (AH/HM/QH) and render a montage for visual review. No automated assertion — this phase produces evidence that the refactor generalizes.*

**Files:**
- Create: `tests/detector_regression/held_out_panel.py`
- Output: `docs/superpowers/plans/2026-05-20-detector-de-tuning-held-out.png`

### Phase 8 Tasks

- [ ] **Step 8.1: Create `held_out_panel.py`**

```python
"""Render a 13-row × 4-col montage of held-out detector outputs."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

from conftest import FIXTURE_ROOT, HELD_OUT_STACKS, MATERIALS, REPO_ROOT
from run_detector import run

OUT = REPO_ROOT / "docs" / "superpowers" / "plans" / "2026-05-20-detector-de-tuning-held-out.png"
THUMB = 256


def _thumb(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    s = THUMB / max(h, w)
    return cv2.resize(img, (int(w * s), int(h * s)))


def main() -> int:
    rows = []
    for stack in HELD_OUT_STACKS:
        cells = []
        stack_input = FIXTURE_ROOT / stack / "input"
        if not stack_input.exists():
            continue
        for material in MATERIALS:
            with tempfile.TemporaryDirectory() as td:
                try:
                    mask_path = run(material, stack_input, Path(td))
                    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
                except Exception as e:
                    mask = np.zeros((THUMB, THUMB), dtype=np.uint8)
                    print(f"[fail] {stack}/{material}: {e}")
            cells.append(_thumb(mask))
        if cells:
            target = max(c.shape[0] for c in cells)
            cells = [cv2.copyMakeBorder(c, 0, target - c.shape[0], 0, 0,
                                        cv2.BORDER_CONSTANT, value=0)
                     for c in cells]
            rows.append(np.hstack(cells))
    target = max(r.shape[1] for r in rows)
    rows = [cv2.copyMakeBorder(r, 0, 0, 0, target - r.shape[1],
                                cv2.BORDER_CONSTANT, value=0) for r in rows]
    panel = np.vstack(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(OUT), panel)
    print(f"[ok] wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 8.2: Run the panel**

```bash
PYTHONPATH=tests/detector_regression conda run -n instrMCPdev python \
    tests/detector_regression/held_out_panel.py
```
Expected: writes `docs/superpowers/plans/2026-05-20-detector-de-tuning-held-out.png` (13 rows × 4 cols).

- [ ] **Step 8.3: Visual review**

Open the panel and confirm:
1. No stack produces an obviously degenerate mask (full-black or full-image).
2. The `top_hbn` column shows the footprint with material validation (no fabricated geometry for stacks where no flake is present).
3. The `graphene` column shows real flake-shaped contours, not center placeholders.
4. The `bottom_hbn` column shows hBN regions that are visually distinct from the substrate, not just the entire non-substrate area.

- [ ] **Step 8.4: Commit the panel + close**

```bash
git add tests/detector_regression/held_out_panel.py \
        docs/superpowers/plans/2026-05-20-detector-de-tuning-held-out.png
git commit -m "docs(detect): held-out montage on 13 AH/HM/QH fixtures"
```

---

## Self-Review Checklist (run before declaring the plan ready)

- [x] Every audit-cited line range from the consensus has a corresponding task or a documented decision to skip.
- [x] Each phase ends with `pytest` commands using the existing test files; no placeholder commands.
- [x] No "Similar to Phase N" cross-references — each phase repeats the test scaffold and pattern.
- [x] All commit messages are concrete, not "fix things".
- [x] Helper functions referenced across phases (`_kernel_from_um`, `keep_largest_n`, `silhouette_score`) are introduced in the earliest phase that uses them.
- [x] Fixture path is verified before Phase 0 starts.
- [x] Regression baseline is committed before any refactor (Phase 0.6) so every later phase has a single source of truth.
- [x] Held-out validation is manual (Phase 8) — no false claim that AH/HM/QH have GT.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-detector-de-tuning.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per phase, two-stage review between phases. Best when phases may interact (e.g. Phase 3 depends on Phase 1's `compute_host`).

**2. Inline Execution** — execute phases in this session via `superpowers:executing-plans`, batched with checkpoints between phases.

Each phase is also designed to be runnable on its own via `/trd Phase N — <phase name>` if you'd rather drive the whole thing through the project-local TRD skill.
