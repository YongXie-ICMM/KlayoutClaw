"""Phase 8: Held-out generalization panel.

Runs all 4 detectors on 13 AH/HM/QH fixtures (not used in training), assembles
a 13-row × 4-col montage PNG plus a sidecar Markdown table.

Each row: graphite | graphene | bottom_hbn | top_hbn thumbnails.
Each cell: binary mask (white=detected) overlaid on a desaturated source image.

GT scoring uses the same pipeline as gt_evaluator.score_stack — detectors →
combine/transform → gdsalign/commit_gds --warp-only → result.gds → detect_evaluator.

Usage (from repo root):
    PYTHONPATH=tests/detector_regression \\
        /Users/andrewwayne/anaconda3/envs/instrMCPdev/bin/python \\
        tests/detector_regression/held_out_panel.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))

from conftest import FIXTURE_ROOT, HELD_OUT_STACKS, MATERIALS  # noqa: E402
from gt_evaluator import (  # noqa: E402
    _run_detectors,
    _run_combine_transform,
    _run_gdsalign_warp_only,
    _build_gds,
    _load_evaluator,
    _compute_per_material_iou,
    _pixel_size,
)

GT_ROOT = Path("/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench-qlaybot")
OUT_PNG = REPO_ROOT / "docs" / "superpowers" / "plans" / "2026-05-20-detector-de-tuning-held-out.png"
OUT_MD = REPO_ROOT / "docs" / "superpowers" / "plans" / "2026-05-20-detector-de-tuning-held-out.md"

THUMB = 256  # max thumbnail dimension (px)
LABEL_H = 20  # px for text label above each cell

# ---------------------------------------------------------------------------
# Material → source image key (for overlay desaturated background)
# ---------------------------------------------------------------------------
_SRC_IMAGE_KEY = {
    "graphite":   "bottom_part.jpg",
    "graphene":   "top_part.jpg",
    "bottom_hbn": "full_stack_raw.jpg",
    "top_hbn":    "full_stack_raw.jpg",
}

_MASK_FILENAME = {
    "graphite":   "graphite_mask.png",
    "graphene":   "graphene_mask.png",
    "bottom_hbn": "bottom_hbn_mask.png",
    "top_hbn":    "top_hbn_mask.png",
}

_MATERIAL_LABELS = {
    "graphite":   "Graphite",
    "graphene":   "Graphene",
    "bottom_hbn": "Bot hBN",
    "top_hbn":    "Top hBN",
}


# ---------------------------------------------------------------------------
# Thumbnail helpers
# ---------------------------------------------------------------------------

def _fit(img: np.ndarray, max_dim: int = THUMB) -> np.ndarray:
    """Resize image so its longest side <= max_dim, preserving aspect ratio."""
    h, w = img.shape[:2]
    if max(h, w) == 0:
        return np.zeros((max_dim, max_dim, 3), dtype=np.uint8)
    s = max_dim / max(h, w)
    new_w, new_h = max(1, int(w * s)), max(1, int(h * s))
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)


def _overlay_mask_on_bg(mask_path: Optional[Path], src_path: Optional[Path]) -> np.ndarray:
    """Return a BGR thumbnail: desaturated source image with mask highlighted in green.

    Falls back to pure white-on-black mask if source image unavailable.
    Falls back to all-black if mask missing/empty.
    """
    # Load mask
    mask = None
    if mask_path is not None and mask_path.exists():
        m = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if m is not None:
            mask = (m > 127).astype(np.uint8)

    # Load source image (for background)
    bg = None
    if src_path is not None and src_path.exists():
        raw = cv2.imread(str(src_path))
        if raw is not None:
            gray = cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)
            # desaturate: repeat gray channel → BGR dim
            bg = cv2.cvtColor((gray * 0.4).astype(np.uint8), cv2.COLOR_GRAY2BGR)

    # Determine canvas size from whichever is available
    if bg is not None:
        h, w = bg.shape[:2]
    elif mask is not None:
        h, w = mask.shape
    else:
        h, w = THUMB, THUMB

    canvas = bg.copy() if bg is not None else np.zeros((h, w, 3), dtype=np.uint8)

    if mask is not None:
        # Resize mask to match bg if needed
        if mask.shape != (h, w):
            mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
        # Highlight detected region: green tint
        green = np.zeros_like(canvas)
        green[:, :, 1] = 255  # green channel
        canvas = np.where(mask[:, :, None] > 0, green, canvas)

    return _fit(canvas, THUMB)


def _pad_to_height(img: np.ndarray, target_h: int) -> np.ndarray:
    h, w = img.shape[:2]
    if h >= target_h:
        return img
    pad = np.zeros((target_h - h, w, img.shape[2] if img.ndim == 3 else 1),
                   dtype=img.dtype)
    return np.vstack([img, pad])


def _pad_to_width(img: np.ndarray, target_w: int) -> np.ndarray:
    h, w = img.shape[:2]
    if w >= target_w:
        return img
    chans = img.shape[2] if img.ndim == 3 else 1
    pad = np.zeros((h, target_w - w, chans) if img.ndim == 3
                   else (h, target_w - w), dtype=img.dtype)
    return np.hstack([img, pad])


def _add_label(cell: np.ndarray, text: str, ok: bool = True) -> np.ndarray:
    """Add a text label bar above the cell."""
    h, w = cell.shape[:2]
    bar = np.zeros((LABEL_H, w, 3), dtype=np.uint8)
    color = (80, 200, 80) if ok else (60, 60, 200)  # green = ok, red = fail
    cv2.putText(bar, text, (3, LABEL_H - 5), cv2.FONT_HERSHEY_SIMPLEX,
                0.38, color, 1, cv2.LINE_AA)
    if cell.ndim == 2:
        cell = cv2.cvtColor(cell, cv2.COLOR_GRAY2BGR)
    return np.vstack([bar, cell])


def _stack_label(row_img: np.ndarray, stack: str, weighted: Optional[float]) -> np.ndarray:
    """Add a left-side stack ID label column."""
    h = row_img.shape[0]
    label_w = 55
    bar = np.zeros((h, label_w, 3), dtype=np.uint8)
    score_str = f"{weighted:.2f}" if weighted is not None else "noGT"
    text = f"{stack}"
    cv2.putText(bar, text, (2, h // 2 - 6), cv2.FONT_HERSHEY_SIMPLEX,
                0.35, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.putText(bar, score_str, (2, h // 2 + 10), cv2.FONT_HERSHEY_SIMPLEX,
                0.35, (120, 220, 120) if weighted is not None else (160, 160, 160),
                1, cv2.LINE_AA)
    return np.hstack([bar, row_img])


# ---------------------------------------------------------------------------
# Per-stack pipeline (detectors only, for thumbnail rendering)
# ---------------------------------------------------------------------------

def _run_detectors_only(
    stack_input: Path,
    align_dir: Path,
    detect_dir: Path,
) -> Dict[str, Optional[Path]]:
    """Run all 4 detectors, return {material: mask_path or None}."""
    from gt_evaluator import _run_detectors as _rd, _pixel_size as _ps
    import tempfile, shutil

    # We need to run detectors and capture the detect_dir.
    # gt_evaluator._run_detectors writes into work_dir/detect/.
    # We'll pass a temporary work_dir and copy the masks out.
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        try:
            _rd(stack_input, align_dir, td_path)
        except Exception as e:
            print(f"  [warn] _run_detectors error (partial results may exist): {e}")

        result: Dict[str, Optional[Path]] = {}
        src_detect_dir = td_path / "detect"
        for mat in MATERIALS:
            fname = _MASK_FILENAME[mat]
            src = src_detect_dir / fname
            if src.exists():
                dst = detect_dir / fname
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(src, dst)
                result[mat] = dst
            else:
                result[mat] = None
        return result


# ---------------------------------------------------------------------------
# GT scoring
# ---------------------------------------------------------------------------

def _score_with_gt(
    stack: str,
    stack_input: Path,
    align_dir: Path,
    gdsalign_dir: Path,
    work_dir: Path,
) -> Tuple[Optional[float], Dict[str, float], str]:
    """Run full pipeline + GT scoring. Returns (weighted, per_material, notes)."""
    gt_gds = GT_ROOT / f"flake_detect_{stack}" / "tests" / "Aligned_Stack.gds"
    template_gds = stack_input / "Template.gds"

    if not gt_gds.exists():
        return None, {}, "no GT"

    try:
        ps = _pixel_size(stack_input)
        full_stack_image = stack_input / "full_stack_raw.jpg"

        # Step 1+2: Run detectors + build detections.json
        detections_path = _run_detectors(stack_input, align_dir, work_dir)

        # Step 3: Combine transform
        traces_path = _run_combine_transform(
            detections_path, align_dir, full_stack_image, ps, work_dir
        )

        # Step 4: GDS-align warp (--warp-only)
        gds_warp = gdsalign_dir / "gds_warp.npy"
        traces_gds_path = _run_gdsalign_warp_only(
            traces_path, gds_warp, full_stack_image, ps, template_gds, work_dir
        )

        # Step 5: Build GDS
        result_gds = work_dir / "result.gds"
        _build_gds(traces_gds_path, result_gds)

        # Step 6: Load evaluator and score
        evaluator_mod = _load_evaluator(GT_ROOT, stack)
        weighted = evaluator_mod.evaluate_flake_detect(str(result_gds), str(gt_gds))

        # Step 7: Per-material IoU
        per_mat = _compute_per_material_iou(result_gds, gt_gds, evaluator_mod)

        return round(weighted, 4), {k: round(v, 4) for k, v in per_mat.items()}, "ok"

    except Exception as e:
        tb = traceback.format_exc()
        print(f"  [fail] GT scoring error for {stack}: {e}")
        return None, {}, f"GT score failed: {e!s:.120}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    t0 = time.time()
    DEADLINE_S = 28 * 60  # 28 minute wall-clock cap

    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)

    # Per-stack results for the sidecar table
    table_rows: List[Dict] = []

    # Montage rows
    montage_rows: List[np.ndarray] = []

    for stack in HELD_OUT_STACKS:
        elapsed = time.time() - t0
        if elapsed > DEADLINE_S:
            print(f"\n[TIMEOUT] {elapsed:.0f}s elapsed — stopping after {stack}")
            table_rows.append({
                "stack": stack,
                "weighted": None,
                "per_material": {},
                "notes": "TIMEOUT — skipped",
            })
            continue

        print(f"\n=== {stack} ({elapsed:.0f}s elapsed) ===")

        stack_dir = FIXTURE_ROOT / stack
        stack_input = stack_dir / "input"
        align_dir = stack_dir / "output" / "align"
        gdsalign_dir = stack_dir / "output" / "gdsalign"

        if not stack_input.exists():
            print(f"  [skip] fixture missing: {stack_input}")
            table_rows.append({
                "stack": stack,
                "weighted": None,
                "per_material": {},
                "notes": "fixture missing",
            })
            continue

        # --- Run full pipeline + GT scoring (includes detector step) ---
        with tempfile.TemporaryDirectory() as td:
            work_dir = Path(td)
            weighted, per_mat, gt_notes = _score_with_gt(
                stack, stack_input, align_dir, gdsalign_dir, work_dir
            )

            # Collect mask thumbnails from the detector step (detect_dir inside work_dir)
            detect_dir = work_dir / "detect"
            cells: List[np.ndarray] = []

            for mat in MATERIALS:
                mask_path = detect_dir / _MASK_FILENAME[mat]
                src_img_path = stack_input / _SRC_IMAGE_KEY[mat]

                mask_ok = mask_path.exists() and mask_path.stat().st_size > 0
                if not mask_ok:
                    mask_path = None

                thumb = _overlay_mask_on_bg(mask_path, src_img_path)
                iou_str = (f"{per_mat.get(mat, 0.0):.2f}"
                           if per_mat else "-")
                label = f"{_MATERIAL_LABELS[mat]} IoU={iou_str}"
                thumb = _add_label(thumb, label, ok=mask_ok)
                cells.append(thumb)

        # Pad cells to same height and hstack into one row
        if cells:
            max_h = max(c.shape[0] for c in cells)
            cells = [_pad_to_height(c, max_h) for c in cells]
            row = np.hstack(cells)
            row = _stack_label(row, stack, weighted)
            montage_rows.append(row)

        notes = gt_notes if gt_notes != "ok" else ""
        # Trim long error messages in the table (full detail is in stdout)
        if notes and len(notes) > 120:
            notes = notes[:120].rstrip() + "…"
        if weighted is None and not notes:
            notes = "no GT"
        table_rows.append({
            "stack": stack,
            "weighted": weighted,
            "per_material": per_mat,
            "notes": notes,
        })
        status = f"weighted={weighted:.3f}" if weighted is not None else f"no-score ({gt_notes})"
        print(f"  => {status}  per_mat={per_mat}")

    # ---------------------------------------------------------------------------
    # Assemble montage
    # ---------------------------------------------------------------------------
    if montage_rows:
        max_w = max(r.shape[1] for r in montage_rows)
        montage_rows = [_pad_to_width(r, max_w) for r in montage_rows]
        panel = np.vstack(montage_rows)

        # Add column header bar at top
        header_h = 24
        header = np.zeros((header_h, panel.shape[1], 3), dtype=np.uint8)
        label_w = 55  # must match _stack_label's label_w
        col_positions = []
        x = label_w
        cell_w = (panel.shape[1] - label_w) // 4
        for i, mat in enumerate(MATERIALS):
            col_positions.append(x + i * cell_w + 4)
        for i, mat in enumerate(MATERIALS):
            cv2.putText(header, _MATERIAL_LABELS[mat],
                        (col_positions[i], header_h - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                        (220, 220, 100), 1, cv2.LINE_AA)

        panel = np.vstack([header, panel])

        cv2.imwrite(str(OUT_PNG), panel)
        print(f"\n[ok] wrote {OUT_PNG} ({panel.shape[1]}x{panel.shape[0]} px)")
    else:
        print("[warn] no montage rows produced")

    # ---------------------------------------------------------------------------
    # Sidecar markdown table
    # ---------------------------------------------------------------------------
    _write_sidecar(table_rows, time.time() - t0)

    total_s = time.time() - t0
    print(f"\n[done] wall clock: {total_s:.0f}s ({total_s / 60:.1f} min)")
    return 0


def _write_sidecar(rows: List[Dict], elapsed_s: float) -> None:
    lines = [
        "# Held-Out Generalization Panel — Phase 8",
        "",
        f"> Generated by `held_out_panel.py` · {elapsed_s:.0f}s wall clock",
        "",
        "## Summary table",
        "",
        "| Stack | Weighted GT | graphite IoU | graphene IoU | bottom_hbn IoU | top_hbn IoU | Notes |",
        "|-------|------------|-------------|-------------|---------------|------------|-------|",
    ]

    for r in rows:
        stack = r["stack"]
        wgt = f"{r['weighted']:.3f}" if r["weighted"] is not None else "—"
        pm = r.get("per_material", {})
        g = f"{pm.get('graphite', 0):.3f}" if pm else "—"
        ge = f"{pm.get('graphene', 0):.3f}" if pm else "—"
        bh = f"{pm.get('bottom_hbn', 0):.3f}" if pm else "—"
        th = f"{pm.get('top_hbn', 0):.3f}" if pm else "—"
        notes_raw = r.get("notes", "") or "ok"
        # Truncate long error details — keep table readable
        notes = notes_raw[:100].rstrip() + ("…" if len(notes_raw) > 100 else "")
        lines.append(f"| {stack} | {wgt} | {g} | {ge} | {bh} | {th} | {notes} |")

    lines += [
        "",
        "## Scoring notes",
        "",
        "- **Weighted GT**: `evaluate_flake_detect()` score from `detect_evaluator.py` "
        "(tiered IoU: 0=below 0.3, 1=0.3–0.5, 2=0.5–0.7, 3=above 0.7; normalized to [0, 1]).",
        "- **Per-material IoU**: raw Jaccard index against `Aligned_Stack.gds` GT polygons.",
        "- **top_hBN**: copies the footprint mask from the alignment step — "
        "IoU reflects alignment quality, not a separate detector.",
        "- All stacks use `pixel_size = 0.106 µm/px` (100× objective, from alignment report).",
        "- Phase 8 is **informational only** — no pass/fail threshold.",
        "",
        "## Montage",
        "",
        f"![Held-out panel](2026-05-20-detector-de-tuning-held-out.png)",
    ]

    OUT_MD.write_text("\n".join(lines) + "\n")
    print(f"[ok] wrote {OUT_MD}")


if __name__ == "__main__":
    raise SystemExit(main())
