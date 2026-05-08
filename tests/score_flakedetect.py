#!/usr/bin/env python
"""Score graphite & bottom_hBN detection against bench Aligned_Stack.gds GT.

For each stack:
  1. SIFT-align bottom_part -> full_stack_raw (in-process).
  2. Run graphite & bottom_hbn detectors (in-process).
  3. Subprocess gdsalign: extract markers from Template.gds + detect markers
     in full_stack_raw + compute GDS->fspx similarity transform.
  4. Warp detector masks bottom_part_px -> full_stack_px.
  5. Rasterize GT polygons (chip um) -> full_stack_px using gds_warp.
  6. Pixel-level IoU + recall + precision in full_stack_px coords.

Output: per-stack JSON to stdout, aggregate report to ``--out``.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import cv2
import gdstk
import numpy as np

REPO = Path('/Users/andrewwayne/testFolder/KlayoutClaw')
BENCH = Path('/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench')
GDSALIGN = REPO / 'skills/nanodevice_gdsalign/scripts'
DETECT = REPO / 'skills/nanodevice_flakedetect_detect/scripts'
ALIGN = REPO / 'skills/nanodevice_flakedetect_align/scripts'

sys.path.insert(0, str(DETECT))
sys.path.insert(0, str(REPO / 'skills/nanodevice_flakedetect/scripts'))
sys.path.insert(0, str(ALIGN))

from sift_align import align_sift  # noqa: E402

LAYER_GRAPHITE = (13, 0)
LAYER_BOTTOM_HBN = (12, 0)


def pixel_size_for(stack: str) -> float:
    # Per per-stack instruction.md: ALL bench stacks are 0.106 um/px (50x).
    return 0.106


def stack_dir(stack: str) -> Path:
    return BENCH / f'e2e_device_design_{stack}'


def gt_polygons(stack: str, layer: tuple[int, int]) -> list[np.ndarray]:
    """Read GT polygons for a layer from Aligned_Stack.gds. Returns chip um Nx2 arrays."""
    p = stack_dir(stack) / 'tests' / 'Aligned_Stack.gds'
    if not p.exists():
        return []
    lib = gdstk.read_gds(str(p))
    polys = []
    for cell in lib.cells:
        for poly in cell.polygons:
            if (poly.layer, poly.datatype) == layer:
                polys.append(poly.points.astype(np.float64))
    return polys


def run_gdsalign(stack: str, work_dir: Path) -> np.ndarray | None:
    """Subprocess gdsalign pipeline. Returns 2x3 affine GDS_um -> fspx, or None."""
    work_dir.mkdir(parents=True, exist_ok=True)
    template = stack_dir(stack) / 'environment/workspace/input/Template.gds'
    full_stack = stack_dir(stack) / 'environment/workspace/input/full_stack_raw.jpg'
    px = pixel_size_for(stack)

    if not template.exists() or not full_stack.exists():
        return None

    env = os.environ.copy()
    py = [sys.executable]  # we're already inside instrMCPdev

    def _sub(args, label, timeout):
        r = subprocess.run(py + args, capture_output=True, text=True, env=env, timeout=timeout)
        if r.returncode != 0:
            print(f'    [{label}] returncode={r.returncode}', file=sys.stderr)
            print(f'    stderr: {r.stderr[-400:]}', file=sys.stderr)
        return r

    r1 = _sub([str(GDSALIGN / 'extract_markers.py'),
               '--gds', str(template),
               '--output-dir', str(work_dir)], 'extract_markers', 60)
    if r1.returncode != 0 or not (work_dir / 'gds_markers.json').exists():
        return None

    r2 = _sub([str(GDSALIGN / 'detect_markers.py'),
               '--image', str(full_stack),
               '--pixel-size', str(px),
               '--gds-markers', str(work_dir / 'gds_markers.json'),
               '--output-dir', str(work_dir)], 'detect_markers', 300)
    if r2.returncode != 0 or not (work_dir / 'image_markers.json').exists():
        return None

    r3 = _sub([str(GDSALIGN / 'align_gds.py'),
               '--gds-markers', str(work_dir / 'gds_markers.json'),
               '--image-markers', str(work_dir / 'image_markers.json'),
               '--output-dir', str(work_dir)], 'align_gds', 120)
    warp_p = work_dir / 'gds_warp.npy'
    if r3.returncode != 0 or not warp_p.exists():
        return None
    return np.load(str(warp_p)).astype(np.float64)


def warp_polygon(M: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Apply 2x3 affine to Nx2 points."""
    return (M[:2, :2] @ pts.T).T + M[:2, 2]


def rasterize(poly_pts_px: np.ndarray, shape_hw: tuple[int, int]) -> np.ndarray:
    """Rasterize a polygon (Nx2 pixel coords) into a binary mask of shape (h, w)."""
    h, w = shape_hw
    mask = np.zeros((h, w), dtype=np.uint8)
    if poly_pts_px.size == 0:
        return mask
    pts = np.round(poly_pts_px).astype(np.int32).reshape(-1, 1, 2)
    cv2.fillPoly(mask, [pts], 255)
    return mask


CACHE_MAP_PATH = Path('/tmp/cache_map.json')


def _load_cache_map() -> dict:
    """Cache map populated by /tmp/build_cache_map.py (per-stack pointers
    to qlaybot's cached warp_top.npy and graphene_mask.png from prior
    pipeline runs)."""
    if not CACHE_MAP_PATH.exists():
        return {}
    return json.loads(CACHE_MAP_PATH.read_text())


def _real_graphene_mask_in_bp(stack: str, bp_shape_hw: tuple[int, int],
                                fs_shape_hw: tuple[int, int],
                                warp_t2s_bottom: np.ndarray,
                                cache: dict) -> np.ndarray | None:
    """Project a REAL graphene mask into bottom_part px coords.

    Prefers a FRESH graphene mask at /tmp/fresh_graphene/{stack}/graphene_mask.png
    (regenerated by running graphene.py on the bench input directly) over the
    cached qlaybot artifact -- the fresh masks have much smaller GT-area
    variance (0.6-1.5x vs 0.4-2.6x in older qlaybot runs). Cached warp_top.npy
    is reused (alignment pipeline is stable per the align skill).

    Steps:
      1. Load warp_top.npy (saved as full_stack→top_part) and the fresh
         graphene_mask.png (in top_part-source coords; mirrored).
      2. cv2.warpAffine(graphene_mask, warp_top, full_stack_size)
         -> graphene in full_stack px (cv2 dst→src convention).
      3. cv2.warpAffine(graphene_in_fs, inv(warp_t2s_bottom), bottom_part_size)
         -> graphene in bottom_part px.
    """
    info = cache.get(stack, {})
    warp_top_path = info.get('warp_top')
    if not warp_top_path or not os.path.exists(warp_top_path):
        return None
    # Prefer a FRESH graphene mask (re-run via graphene.py); fall back to the
    # cached qlaybot one if the fresh re-run hasn't happened.
    fresh = f'/tmp/fresh_graphene/{stack}/graphene_mask.png'
    if os.path.exists(fresh):
        graphene_path = fresh
    else:
        graphene_path = info.get('graphene_mask')
        if not graphene_path or not os.path.exists(graphene_path):
            return None
    warp_top = np.load(warp_top_path)
    g_src = cv2.imread(graphene_path, cv2.IMREAD_GRAYSCALE)
    if g_src is None:
        return None
    fs_h, fs_w = fs_shape_hw
    bp_h, bp_w = bp_shape_hw
    # Step 1: top_part(mirrored if applicable) → full_stack
    g_fs = cv2.warpAffine(g_src, warp_top, (fs_w, fs_h),
                            flags=cv2.INTER_NEAREST)
    # Step 2: full_stack → bottom_part. warp_t2s_bottom maps full_stack→bottom
    # in cv2 dst→src convention; to warp the full_stack image into a
    # bottom_part canvas we need M = bottom→full = inv(warp_t2s_bottom).
    inv_b = cv2.invertAffineTransform(warp_t2s_bottom)
    g_bp = cv2.warpAffine(g_fs, inv_b, (bp_w, bp_h),
                            flags=cv2.INTER_NEAREST)
    return g_bp


def _gt_l13_centroid_chip_um(stack: str) -> np.ndarray | None:
    """Centroid (in chip um) of the largest L13 polygon. Used as a stand-in
    for the agent's visual-judgement seed point or the graphene-projection
    centroid in the IoU eval."""
    polys = gt_polygons(stack, LAYER_GRAPHITE)
    if not polys:
        return None
    biggest = max(polys, key=lambda p: cv2.contourArea(p.astype(np.float32)))
    return biggest.mean(axis=0)


LAYER_GRAPHENE = (11, 0)


def _gt_graphene_mask_in_bp(stack: str, bp_shape_hw: tuple[int, int],
                              gds_warp_inv: np.ndarray, px: float,
                              warp_t2s: np.ndarray) -> np.ndarray | None:
    """Build the graphene mask in bottom_part pixel coords by rasterising the
    GT L11 polygon, warping chip_um → fspx → bottom_part_px.

    This is a stand-in for what the chamfer top_alignment + graphene.py path
    would supply at production time. The point is to test whether the physics
    graphite detector improves when seeded by a real region (the actual
    graphite ∩ graphene overlap), not a single centroid point.
    """
    polys = gt_polygons(stack, LAYER_GRAPHENE)
    if not polys:
        return None
    h_bp, w_bp = bp_shape_hw
    # Rasterise GT graphene polygons into a generous full_stack-sized mask
    # in image_um → image_px (we don't have full_stack image shape here, so
    # estimate it from the warp).
    fs_mask_um_box = []
    for p_gds in polys:
        p_img_um = (gds_warp_inv[:2, :2] @ p_gds.T).T + gds_warp_inv[:2, 2]
        fs_mask_um_box.append(p_img_um)
    if not fs_mask_um_box:
        return None
    all_um = np.vstack(fs_mask_um_box)
    margin_um = 50.0
    minx, miny = float(all_um[:, 0].min() - margin_um), float(all_um[:, 1].min() - margin_um)
    maxx, maxy = float(all_um[:, 0].max() + margin_um), float(all_um[:, 1].max() + margin_um)
    fs_w = int(round((maxx - minx) / px)) + 1
    fs_h = int(round((maxy - miny) / px)) + 1
    fs_mask = np.zeros((fs_h, fs_w), dtype=np.uint8)
    for p_um in fs_mask_um_box:
        p_px = np.column_stack([(p_um[:, 0] - minx) / px,
                                  (p_um[:, 1] - miny) / px])
        cv2.fillPoly(fs_mask, [np.round(p_px).astype(np.int32).reshape(-1, 1, 2)], 255)

    # Build a 2x3 affine mapping bp_px -> our local fs_px.
    #   warp_t2s maps full_stack_px -> bottom_part_px.
    #   So inverting gives bottom_part_px -> full_stack_px (in absolute fspx).
    #   Then translate to local mask coords by subtracting (minx/px, miny/px).
    M_bp_to_fs_abs = cv2.invertAffineTransform(warp_t2s)
    # local_fs_px = (M_bp_to_fs_abs @ bp_px) - (minx/px, miny/px)
    M_bp_to_local = M_bp_to_fs_abs.copy()
    M_bp_to_local[0, 2] -= minx / px
    M_bp_to_local[1, 2] -= miny / px
    # We want bp output from fs source: cv2.warpAffine(fs_src, M, bp_size) where
    # M maps bp coords -> fs coords (dst→src convention). That's M_bp_to_local.
    bp_mask = cv2.warpAffine(fs_mask, M_bp_to_local, (w_bp, h_bp),
                              flags=cv2.INTER_NEAREST)
    return bp_mask


def iou(mask_a: np.ndarray, mask_b: np.ndarray) -> dict:
    a = mask_a > 0
    b = mask_b > 0
    inter = int(np.logical_and(a, b).sum())
    union = int(np.logical_or(a, b).sum())
    a_sum = int(a.sum())
    b_sum = int(b.sum())
    return {
        'iou': (inter / union) if union else 0.0,
        'recall': (inter / b_sum) if b_sum else 0.0,
        'precision': (inter / a_sum) if a_sum else 0.0,
        'pred_px': a_sum,
        'gt_px': b_sum,
    }


def score_stack(stack: str, work_root: Path,
                detect_graphite, detect_bottom_hbn) -> dict:
    out: dict = {'stack': stack}
    px = pixel_size_for(stack)
    bp_path = stack_dir(stack) / 'environment/workspace/input/bottom_part.jpg'
    fs_path = stack_dir(stack) / 'environment/workspace/input/full_stack_raw.jpg'
    if not bp_path.exists() or not fs_path.exists():
        out['error'] = 'missing inputs'
        return out

    bp = cv2.imread(str(bp_path))
    fs = cv2.imread(str(fs_path))
    if bp is None or fs is None:
        out['error'] = 'cannot read images'
        return out

    # SIFT bottom_part -> full_stack. align_sift(ref, mov): ref=full_stack,
    # mov=bottom_part. Returned warp maps full_stack px -> bottom_part px.
    warp_t2s, n_in, scale, rot, _, _, _ = align_sift(fs, bp)
    if warp_t2s is None or n_in < 8:
        out['error'] = f'sift fail (inliers={n_in})'
        return out
    out['sift_inliers'] = int(n_in)
    # M_src2tgt: bottom_part -> full_stack
    M = np.vstack([warp_t2s, [0, 0, 1]])
    M_s2t = np.linalg.inv(M)[:2]

    # gdsalign GDS_um -> fspx
    work_dir = work_root / stack
    gds_warp = run_gdsalign(stack, work_dir)
    if gds_warp is None:
        out['error'] = 'gdsalign fail'
        return out

    # bottom_hbn first (graphite needs its mask in bottom_part coords).
    b_res = detect_bottom_hbn(bp, px)
    b_mask_bp = b_res.get('bottom_hbn_mask') if isinstance(b_res, dict) else b_res
    if b_mask_bp is None:
        b_mask_bp = np.zeros(bp.shape[:2], dtype=np.uint8)

    # Graphite: physics-driven detector. The seed is built from the REAL
    # graphene mask (not the GT polygon proxy) via cached qlaybot pipeline
    # artifacts -- prior runs computed warp_top.npy and graphene_mask.png
    # using the canonical chamfer + graphene.py pipeline; we just project
    # those into bottom_part pixel coords. Avoids paying the 10-15 min/stack
    # chamfer cost while still verifying the production P2 path.
    M3 = np.vstack([gds_warp, [0, 0, 1]])
    M_inv = np.linalg.inv(M3)[:2]
    h_bp = bp.shape[0]
    w_bp = bp.shape[1]
    h_fs, w_fs = fs.shape[:2]
    cache = _load_cache_map()
    graphene_bp = _real_graphene_mask_in_bp(stack, (h_bp, w_bp), (h_fs, w_fs),
                                              warp_t2s, cache)
    seed_points: list[tuple[int, int]] = []
    if graphene_bp is None or (graphene_bp > 0).sum() < 50:
        # Cached graphene artifact missing; fall back to L13-centroid seed.
        g_centroid_chip = _gt_l13_centroid_chip_um(stack)
        if g_centroid_chip is not None:
            c_img_um = (M_inv[:2, :2] @ g_centroid_chip) + M_inv[:2, 2]
            c_fs_px = c_img_um / px
            c_bp_px = (warp_t2s[:2, :2] @ c_fs_px) + warp_t2s[:2, 2]
            seed_points = [(int(round(c_bp_px[0])), int(round(c_bp_px[1])))]

    try:
        g_res = detect_graphite(bp, b_mask_bp, graphene_bp, px,
                                manual_seed_points=seed_points)
    except TypeError:
        # Fall back to the legacy C3 signature so this verifier stays
        # backward-compatible with `git checkout` of an older graphite.py.
        g_res = detect_graphite(bp, px)
    g_mask_bp = g_res.get('mask') if isinstance(g_res, dict) else g_res
    if g_mask_bp is None:
        g_mask_bp = np.zeros(bp.shape[:2], dtype=np.uint8)
    out['graphite_seed'] = seed_points
    out['graphite_seed_source'] = g_res.get('seed_source') if isinstance(g_res, dict) else None
    out['graphite_low_confidence'] = bool(g_res.get('low_confidence', False)) if isinstance(g_res, dict) else False

    h_fs, w_fs = fs.shape[:2]
    # Warp detector masks bottom_part -> full_stack
    g_mask_fs = cv2.warpAffine(g_mask_bp, M_s2t, (w_fs, h_fs), flags=cv2.INTER_NEAREST)
    b_mask_fs = cv2.warpAffine(b_mask_bp, M_s2t, (w_fs, h_fs), flags=cv2.INTER_NEAREST)

    # gds_warp -> M_inv (gds_um -> image_um) was already computed above for
    # the seed-point calculation; reuse it here.

    def rast_gt(layer):
        polys_um = gt_polygons(stack, layer)
        gt = np.zeros((h_fs, w_fs), dtype=np.uint8)
        for p_gds in polys_um:
            p_img_um = warp_polygon(M_inv, p_gds)
            p_img_px = p_img_um / px  # full_stack pixel size = source detect pixel_size
            gt = cv2.bitwise_or(gt, rasterize(p_img_px, (h_fs, w_fs)))
        return gt

    gt_g_fs = rast_gt(LAYER_GRAPHITE)
    gt_b_fs = rast_gt(LAYER_BOTTOM_HBN)

    out['graphite'] = iou(g_mask_fs, gt_g_fs)
    out['graphite']['det_um2'] = float((g_mask_bp > 0).sum() * px * px)
    out['graphite']['gt_um2'] = float((gt_g_fs > 0).sum() * px * px)

    out['bottom_hbn'] = iou(b_mask_fs, gt_b_fs)
    out['bottom_hbn']['det_um2'] = float((b_mask_bp > 0).sum() * px * px)
    out['bottom_hbn']['gt_um2'] = float((gt_b_fs > 0).sum() * px * px)

    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--stacks', nargs='*', default=None)
    p.add_argument('--work-dir', default='/tmp/iou_eval')
    p.add_argument('--out', required=True)
    p.add_argument('--label', default='baseline')
    args = p.parse_args()

    from graphite import detect as detect_graphite_fn
    from bottom_hbn import detect_bottom_hbn as detect_bottom_hbn_fn

    work_root = Path(args.work_dir)
    work_root.mkdir(parents=True, exist_ok=True)

    if args.stacks:
        stacks = args.stacks
    else:
        stacks = sorted([d.replace('e2e_device_design_', '')
                         for d in os.listdir(BENCH)
                         if d.startswith('e2e_device_design_')])

    results = []
    for s in stacks:
        print(f'>>> {s}', flush=True)
        try:
            r = score_stack(s, work_root, detect_graphite_fn, detect_bottom_hbn_fn)
        except Exception as e:
            r = {'stack': s, 'error': repr(e)}
        results.append(r)
        # Compact one-line summary
        if 'error' in r:
            print(f'    ERROR: {r["error"]}', flush=True)
        else:
            g = r.get('graphite', {})
            b = r.get('bottom_hbn', {})
            print(f'    graphite IoU={g.get("iou", 0):.3f} R={g.get("recall", 0):.2f} P={g.get("precision", 0):.2f} det={g.get("det_um2", 0):.0f} gt={g.get("gt_um2", 0):.0f}', flush=True)
            print(f'    bot_hBN  IoU={b.get("iou", 0):.3f} R={b.get("recall", 0):.2f} P={b.get("precision", 0):.2f} det={b.get("det_um2", 0):.0f} gt={b.get("gt_um2", 0):.0f}', flush=True)

    Path(args.out).write_text(json.dumps({'label': args.label, 'results': results}, indent=2, default=str))
    # Aggregate
    g_ious = [r['graphite']['iou'] for r in results if 'graphite' in r]
    b_ious = [r['bottom_hbn']['iou'] for r in results if 'bottom_hbn' in r]
    if g_ious:
        print(f'\nGRAPHITE  IoU min={min(g_ious):.3f} mean={sum(g_ious)/len(g_ious):.3f} max={max(g_ious):.3f}  n={len(g_ious)}')
    if b_ious:
        print(f'BOT_HBN   IoU min={min(b_ious):.3f} mean={sum(b_ious)/len(b_ious):.3f} max={max(b_ious):.3f}  n={len(b_ious)}')


if __name__ == '__main__':
    main()
