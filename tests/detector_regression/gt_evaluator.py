"""GT-based evaluator for detector regression tests.

Transform chain (full pipeline summary):
  1. Each detector runs on its native source image:
       graphite   → bottom_part.jpg  (bottom_part pixel coords)
       graphene   → top_part.jpg     (top_part pixel coords, mirrored)
       bottom_hBN → full_stack_raw.jpg (already full_stack coords)
       top_hBN    → full_stack_raw.jpg (already full_stack coords / footprint)

  2. combine/transform.py: warps each material mask into the shared
     full_stack pixel frame using:
       graphite:   invert warp_sift_bottom.npy → transform contour points
       graphene:   apply warp_top.npy to mask (INTER_NEAREST), clip to footprint
       bot/top_hBN: pass-through (already in full_stack coords)
     Output: traces.json (contours in full_stack pixel + µm coords)

  3. gdsalign/commit_gds.py --warp-only: applies gds_warp.npy
     (image_um → GDS_um affine, pre-computed and stored in fixture output)
     to transform traces.json contours into GDS micron coordinates.
     Output: traces_gds.json (adds contour_gds field to each entry)

  4. This module builds a GDS file from traces_gds.json using gdstk
     (no KLayout required) and scores it against Aligned_Stack.gds via
     detect_evaluator.evaluate_flake_detect.

Fixture layout expected (set via FIXTURE_ROOT in conftest.py):
  {fixture_root}/{stack}/input/         — source images + Template.gds
  {fixture_root}/{stack}/output/align/  — warp_sift_bottom.npy, warp_top.npy,
                                          footprint_mask.png, alignment_report.json
  {fixture_root}/{stack}/output/gdsalign/ — gds_warp.npy

GT files live at:
  {gt_root}/flake_detect_{stack}/tests/Aligned_Stack.gds
  {gt_root}/flake_detect_{stack}/tests/detect_evaluator.py  (canonical, read-only)
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict

import gdstk
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
DETECT_SCRIPTS = REPO_ROOT / "skills" / "nanodevice_flakedetect_detect" / "scripts"
COMBINE_SCRIPTS = REPO_ROOT / "skills" / "nanodevice_flakedetect_combine" / "scripts"
GDSALIGN_SCRIPTS = REPO_ROOT / "skills" / "nanodevice_gdsalign" / "scripts"

# Default pixel size — all bench stacks use 0.106 µm/px (100x objective)
DEFAULT_PIXEL_SIZE_UM = 0.106

# GDS layer mapping — must match commit_gds.py and detect_evaluator.py
LAYER_MAP = {
    "top_hBN":    (10, 0),
    "graphene":   (11, 0),
    "bottom_hBN": (12, 0),
    "graphite":   (13, 0),
}

CONDA_PYTHON = "/Users/andrewwayne/anaconda3/envs/instrMCPdev/bin/python"

# ---------------------------------------------------------------------------
# Reference baseline: existing priored-pipeline result.gds GT scores
# (measured 2026-05-20 by running detect_evaluator on
#  /Volumes/RandomData/harbour-workspace/qlaybot/detect/{stack}/output/result.gds
#  against the GT Aligned_Stack.gds for each stack)
# ---------------------------------------------------------------------------
BASELINE_SCORES: Dict[str, Dict] = {
    "ml04": {
        "weighted": 0.833,
        "per_material": {
            "top_hbn":    0.97,
            "graphene":   0.87,
            "bottom_hbn": 0.92,
            "graphite":   0.66,
        },
    },
    "ml08": {
        "weighted": 1.000,
        "per_material": {
            "top_hbn":    0.87,
            "graphene":   0.79,
            "bottom_hbn": 0.79,
            "graphite":   0.87,
        },
    },
    "ml09": {
        "weighted": 0.833,
        "per_material": {
            "top_hbn":    0.95,
            "graphene":   0.62,
            "bottom_hbn": 0.81,
            "graphite":   0.85,
        },
    },
    "ml11": {
        "weighted": 0.417,
        "per_material": {
            "top_hbn":    0.94,
            "graphene":   0.22,
            "bottom_hbn": 0.53,
            "graphite":   0.60,
        },
    },
    "ml14": {
        "weighted": 0.667,
        "per_material": {
            "top_hbn":    0.97,
            "graphene":   0.52,
            "bottom_hbn": 0.91,
            "graphite":   0.64,
        },
    },
}


def _run(cmd: list[str], cwd: Path, label: str) -> None:
    """Run a subprocess; raise RuntimeError with stderr on failure."""
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=300
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"{label}: timed out after 300s") from e
    if proc.returncode != 0:
        raise RuntimeError(
            f"{label}: exit {proc.returncode}\nstderr:\n{proc.stderr[-3000:]}"
        )


def _pixel_size(stack_input: Path) -> float:
    """Read pixel_size_um from pixel_size.json if present, else return default."""
    manifest = stack_input / "pixel_size.json"
    if manifest.exists():
        return float(json.loads(manifest.read_text())["pixel_size_um_per_px"])
    return DEFAULT_PIXEL_SIZE_UM


def _graphene_mirror_from_align(align_dir: Path) -> bool:
    """Read alignment_report.json to determine if graphene was detected with mirror.

    warp_top.npy was computed against a possibly-mirrored top_part image.
    The graphene detector must use the same mirror flag so its output is in
    the same coordinate system as warp_top expects.
    """
    report_path = align_dir / "alignment_report.json"
    if report_path.exists():
        try:
            report = json.loads(report_path.read_text())
            return bool(report.get("alignments", {}).get("top", {}).get("mirror", False))
        except Exception:
            pass
    return True  # conservative default: most stacks use mirrored top_part


def _run_detectors(stack_input: Path, align_dir: Path, work_dir: Path) -> Path:
    """Run all 4 detectors and write detections.json into work_dir.

    Returns Path to detections.json.
    """
    detect_dir = work_dir / "detect"
    detect_dir.mkdir(parents=True, exist_ok=True)

    ps = _pixel_size(stack_input)

    # Read mirror flag from alignment report so graphene detector runs in the
    # same coordinate system as warp_top.npy (which may have been computed on
    # a mirrored image). Mismatch here causes IoU=0 for graphene.
    graphene_mirror = _graphene_mirror_from_align(align_dir)

    # --- graphite ---
    _run([
        CONDA_PYTHON,
        str(DETECT_SCRIPTS / "graphite.py"),
        "--image", str(stack_input / "bottom_part.jpg"),
        "--pixel-size", str(ps),
        "--output-dir", str(detect_dir),
    ], cwd=DETECT_SCRIPTS, label="graphite detector")

    # --- graphene ---
    # Pass --mirror only when the align warp_top was computed on a mirrored image.
    graphene_cmd = [
        CONDA_PYTHON,
        str(DETECT_SCRIPTS / "graphene.py"),
        "--image", str(stack_input / "top_part.jpg"),
        "--pixel-size", str(ps),
        "--output-dir", str(detect_dir),
    ]
    if graphene_mirror:
        graphene_cmd.append("--mirror")
    _run(graphene_cmd, cwd=DETECT_SCRIPTS, label="graphene detector")

    # --- bottom_hBN ---
    warp_mat = align_dir / "warp_sift_bottom.npy"
    _run([
        CONDA_PYTHON,
        str(DETECT_SCRIPTS / "bottom_hbn.py"),
        "--image", str(stack_input / "bottom_part.jpg"),
        "--target-image", str(stack_input / "full_stack_raw.jpg"),
        "--warp-matrix", str(warp_mat),
        "--pixel-size", str(ps),
        "--output-dir", str(detect_dir),
    ], cwd=DETECT_SCRIPTS, label="bottom_hbn detector")

    # --- top_hBN ---
    fp_mask = align_dir / "footprint_mask.png"
    _run([
        CONDA_PYTHON,
        str(DETECT_SCRIPTS / "top_hbn.py"),
        "--footprint-mask", str(fp_mask),
        "--image", str(stack_input / "full_stack_raw.jpg"),
        "--pixel-size", str(ps),
        "--output-dir", str(detect_dir),
    ], cwd=DETECT_SCRIPTS, label="top_hbn detector")

    # --- assemble detections.json ---
    # Load areas from per-detector sidecars if available; else compute from masks.
    def _area(result_path: Path, mask_path: Path, ps: float) -> tuple[int, float]:
        """Return (area_px, area_um2) from sidecar or mask file."""
        if result_path.exists():
            d = json.loads(result_path.read_text())
            area_px = int(d.get("area_px", 0))
            area_um2 = float(d.get("area_um2", 0.0))
            return area_px, area_um2
        # Fallback: count non-zero pixels from mask
        import cv2  # noqa: PLC0415
        m = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if m is None:
            return 0, 0.0
        px = int((m > 0).sum())
        return px, round(px * ps * ps, 2)

    g_px, g_um2 = _area(detect_dir / "graphite_result.json",
                         detect_dir / "graphite_mask.png", ps)
    ge_px, ge_um2 = _area(detect_dir / "graphene_result.json",
                           detect_dir / "graphene_mask.png", ps)
    bh_px, bh_um2 = _area(detect_dir / "bottom_hbn_result.json",
                           detect_dir / "bottom_hbn_mask.png", ps)
    th_px, th_um2 = _area(detect_dir / "top_hbn_result.json",
                           detect_dir / "top_hbn_mask.png", ps)

    detections = {
        "pixel_size_um": ps,
        "source_images": {
            "graphite":   str(stack_input / "bottom_part.jpg"),
            "graphene":   str(stack_input / "top_part.jpg"),
            "bottom_hBN": str(stack_input / "full_stack_raw.jpg"),
            "top_hBN":    str(stack_input / "full_stack_raw.jpg"),
        },
        "materials": {
            "graphite": {
                "mask_file":        "graphite_mask.png",
                "contour_file":     "graphite_contour.npy",
                "area_px":          g_px,
                "area_um2":         g_um2,
                "coordinate_system": "bottom_part",
                "mirrored":         False,
            },
            "graphene": {
                "mask_file":        "graphene_mask.png",
                "contour_file":     "graphene_contour.npy",
                "area_px":          ge_px,
                "area_um2":         ge_um2,
                "coordinate_system": "top_part",
                "mirrored":         graphene_mirror,
            },
            "bottom_hBN": {
                "mask_file":        "bottom_hbn_mask.png",
                "contour_file":     "bottom_hbn_contour.npy",
                "area_px":          bh_px,
                "area_um2":         bh_um2,
                "coordinate_system": "full_stack",
                "mirrored":         False,
            },
            "top_hBN": {
                "mask_file":        "top_hbn_mask.png",
                "contour_file":     "top_hbn_contour.npy",
                "area_px":          th_px,
                "area_um2":         th_um2,
                "coordinate_system": "full_stack",
                "mirrored":         False,
            },
        },
    }
    det_path = detect_dir / "detections.json"
    det_path.write_text(json.dumps(detections, indent=2))
    return det_path


def _run_combine_transform(
    detections_path: Path,
    align_dir: Path,
    image_path: Path,
    pixel_size: float,
    work_dir: Path,
) -> Path:
    """Run combine/transform.py → work_dir/combine/traces.json."""
    combine_dir = work_dir / "combine"
    combine_dir.mkdir(parents=True, exist_ok=True)
    _run([
        CONDA_PYTHON,
        str(COMBINE_SCRIPTS / "transform.py"),
        "--detections", str(detections_path),
        "--align-dir", str(align_dir),
        "--image", str(image_path),
        "--pixel-size", str(pixel_size),
        "--output-dir", str(combine_dir),
    ], cwd=COMBINE_SCRIPTS, label="combine/transform")
    return combine_dir / "traces.json"


def _run_gdsalign_warp_only(
    traces_path: Path,
    gds_warp_path: Path,
    image_path: Path,
    pixel_size: float,
    template_gds: Path,
    work_dir: Path,
) -> Path:
    """Run commit_gds.py --warp-only → work_dir/gdsalign/traces_gds.json."""
    gdsalign_dir = work_dir / "gdsalign"
    gdsalign_dir.mkdir(parents=True, exist_ok=True)
    _run([
        CONDA_PYTHON,
        str(GDSALIGN_SCRIPTS / "commit_gds.py"),
        "--warp", str(gds_warp_path),
        "--traces", str(traces_path),
        "--image", str(image_path),
        "--pixel-size", str(pixel_size),
        "--gds", str(template_gds),
        "--output-dir", str(gdsalign_dir),
        "--warp-only",
    ], cwd=GDSALIGN_SCRIPTS, label="gdsalign/commit_gds --warp-only")
    return gdsalign_dir / "traces_gds.json"


def _build_gds(traces_gds_path: Path, out_gds: Path) -> None:
    """Build a GDS file from traces_gds.json using gdstk (no KLayout needed)."""
    with open(traces_gds_path) as f:
        traces = json.load(f)

    lib = gdstk.Library()
    cell = lib.new_cell("DETECT_OUT")

    for mat_name, entries in traces.get("materials", {}).items():
        layer_dt = LAYER_MAP.get(mat_name)
        if layer_dt is None:
            continue
        layer, datatype = layer_dt
        for entry in entries:
            pts = entry.get("contour_gds")
            if not pts or len(pts) < 3:
                continue
            poly = gdstk.Polygon(pts, layer=layer, datatype=datatype)
            cell.add(poly)

    lib.write_gds(str(out_gds))


def _load_evaluator(gt_root: Path, stack: str):
    """Import detect_evaluator.py from the GT fixture (canonical, read-only)."""
    evaluator_path = gt_root / f"flake_detect_{stack}" / "tests" / "detect_evaluator.py"
    spec = importlib.util.spec_from_file_location("detect_evaluator", evaluator_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _compute_per_material_iou(
    result_gds: Path, gt_gds: Path, evaluator_mod
) -> Dict[str, float]:
    """Compute per-material raw IoU (not tiered) for diagnostics."""
    import gdstk as _gdstk
    import shapely.geometry as _sg
    from shapely.ops import unary_union
    from shapely.validation import make_valid

    out_lib = _gdstk.read_gds(str(result_gds))
    ref_lib = _gdstk.read_gds(str(gt_gds))

    # Layer → material name mapping (inverse of LAYER_MAP)
    layer_to_mat = {
        (10, 0): "top_hbn",
        (11, 0): "graphene",
        (12, 0): "bottom_hbn",
        (13, 0): "graphite",
    }

    per_mat = {}
    for (layer, dt), mat_name in layer_to_mat.items():
        ref_geom = evaluator_mod._shapely_union(ref_lib, layer, dt)
        if ref_geom is None or ref_geom.is_empty:
            continue
        out_geom = evaluator_mod._shapely_union(out_lib, layer, dt)
        if out_geom is None or out_geom.is_empty:
            per_mat[mat_name] = 0.0
        else:
            inter = ref_geom.intersection(out_geom)
            union = ref_geom.union(out_geom)
            per_mat[mat_name] = float(inter.area / union.area) if union.area > 0 else 0.0

    return per_mat


def score_stack(stack: str, fixture_root: Path, gt_root: Path, *, work_dir: Path) -> Dict:
    """Run all 4 detectors on `stack`, assemble result.gds in full_stack/gdsalign
    frame, score against Aligned_Stack.gds via detect_evaluator.

    Returns:
        {
            "weighted": 0.833,
            "per_material": {"top_hbn": 0.97, "graphene": 0.87,
                             "bottom_hbn": 0.92, "graphite": 0.66},
        }

    Pipeline:
      1. Run 4 detectors → detect_dir/{material}_mask.png + contour.npy
      2. Assemble detections.json from detector outputs
      3. combine/transform.py (with existing align matrices) → traces.json
      4. gdsalign/commit_gds.py --warp-only (with existing gds_warp.npy) → traces_gds.json
      5. Build GDS from traces_gds.json using gdstk (no KLayout)
      6. Score via detect_evaluator.evaluate_flake_detect
      7. Compute per-material raw IoU for detailed diagnostics

    All warp matrices (warp_sift_bottom.npy, warp_top.npy, footprint_mask.png,
    gds_warp.npy) are read from the fixture's pre-existing output directories —
    no re-running of align/gdsalign pipelines is needed.
    """
    stack_dir = fixture_root / stack
    stack_input = stack_dir / "input"
    align_dir = stack_dir / "output" / "align"
    gdsalign_dir = stack_dir / "output" / "gdsalign"
    template_gds = stack_input / "Template.gds"
    gt_gds = gt_root / f"flake_detect_{stack}" / "tests" / "Aligned_Stack.gds"

    for p, label in [
        (stack_input, "stack input dir"),
        (align_dir, "align output dir"),
        (gdsalign_dir, "gdsalign output dir"),
        (gt_gds, "Aligned_Stack.gds"),
        (template_gds, "Template.gds"),
    ]:
        if not p.exists():
            raise FileNotFoundError(f"{label} not found: {p}")

    gds_warp = gdsalign_dir / "gds_warp.npy"
    if not gds_warp.exists():
        raise FileNotFoundError(f"gds_warp.npy not found in {gdsalign_dir}")

    ps = _pixel_size(stack_input)
    full_stack_image = stack_input / "full_stack_raw.jpg"

    # Step 1+2: Run detectors + build detections.json
    detections_path = _run_detectors(stack_input, align_dir, work_dir)

    # Step 3: Combine transform
    traces_path = _run_combine_transform(
        detections_path, align_dir, full_stack_image, ps, work_dir
    )

    # Step 4: GDS-align warp (--warp-only: no KLayout)
    traces_gds_path = _run_gdsalign_warp_only(
        traces_path, gds_warp, full_stack_image, ps, template_gds, work_dir
    )

    # Step 5: Build GDS
    result_gds = work_dir / "result.gds"
    _build_gds(traces_gds_path, result_gds)

    # Step 6: Load evaluator and score
    evaluator_mod = _load_evaluator(gt_root, stack)
    weighted = evaluator_mod.evaluate_flake_detect(str(result_gds), str(gt_gds))

    # Step 7: Per-material IoU
    per_mat = _compute_per_material_iou(result_gds, gt_gds, evaluator_mod)

    return {
        "weighted": round(weighted, 4),
        "per_material": {k: round(v, 4) for k, v in per_mat.items()},
    }
