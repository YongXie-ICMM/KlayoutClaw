#!/usr/bin/env python
"""B3 — Detect graphene via shape-template + connected-component scoring (no K-means).

Strategy (parameters baked from offline GT fit, see fit_shape_priors.py):
  1. Mirror top_part if requested; isolate flake region (bright + saturated).
  2. Build a "candidate bright" binary mask = pixels inside flake-region whose
     L is above the flake's modal L by an adaptive delta.
  3. Extract connected components, score each by area, aspect, solidity,
     LAB-distance-to-prior, and centroid distance-to-flake-edge.
  4. Pick the highest-scoring CC.
  5. Mahalanobis-LAB region grow + morph_clean.

Runtime never reads GT; priors live in graphene_shape_priors.json (offline).

CLI signature MUST match the baseline (graphene_baseline.py):
    --image, --pixel-size, --output-dir, [--mirror]
    [--cluster-id N]    (kept for backwards compat, unused)
    [--n-sub-clusters]  (kept for backwards compat, unused)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'nanodevice_flakedetect', 'scripts'))

import cv2
import numpy as np

from core import morph_clean, flood_fill_holes, keep_largest_n, desaturate

PRIORS_PATH = Path(__file__).resolve().parents[3] / 'graphene_shape_priors.json'


def _load_priors() -> dict:
    if not PRIORS_PATH.exists():
        return {
            'area_um2_median': 950.0, 'area_um2_std': 600.0,
            'aspect_median': 2.0, 'aspect_std': 1.0,
            'solidity_median': 0.96, 'solidity_std': 0.10,
            'L_med_median': 160.0, 'L_med_std': 22.0,
            'a_med_median': 125.0, 'a_med_std': 7.0,
            'b_med_median': 102.0, 'b_med_std': 15.0,
            'centroid_dist_to_edge_um_median': 13.0,
            'centroid_dist_to_edge_um_std': 6.0,
        }
    return json.loads(PRIORS_PATH.read_text())


def _flake_mask(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    s_chan = hsv[:, :, 1]
    bright = (gray > 40).astype(np.uint8) * 255
    sat = (s_chan > 15).astype(np.uint8) * 255
    flake = cv2.bitwise_and(bright, sat)
    flake = morph_clean(flake, close_k=15, open_k=11)
    flake = keep_largest_n(flake, n=1, min_area=5000)
    flake = flood_fill_holes(flake)
    return flake


def _gauss_score(value: float, median: float, std: float, soft: float = 1.0) -> float:
    s = max(std, 1e-6)
    return float(np.exp(-((value - median) ** 2) / (2 * (s * soft) ** 2)))


def _region_grow(base_mask: np.ndarray, lab_image: np.ndarray,
                 region_mask: np.ndarray, n_iter: int = 2, dilate_px: int = 3) -> np.ndarray:
    cur = base_mask.copy()
    for _ in range(n_iter):
        pix = lab_image[cur > 0].astype(np.float32)
        if len(pix) < 5:
            break
        mu = pix.mean(axis=0)
        sigma = pix.std(axis=0) + 1.0
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                      (2 * dilate_px + 1, 2 * dilate_px + 1))
        dil = cv2.dilate(cur, k)
        candidate = cv2.bitwise_and(dil, region_mask)
        ys, xs = np.where(candidate > 0)
        if len(ys) == 0:
            break
        vals = lab_image[ys, xs].astype(np.float32)
        d = np.sqrt((((vals - mu) / sigma) ** 2).sum(axis=1))
        keep = d < 2.5
        new_mask = cur.copy()
        new_mask[ys[keep], xs[keep]] = 255
        if (new_mask > 0).sum() == (cur > 0).sum():
            break
        cur = new_mask
    return cur


def detect_graphene(image: np.ndarray, pixel_size: float, mirror: bool = True,
                    priors: dict | None = None) -> dict:
    if priors is None:
        priors = _load_priors()
    img = cv2.flip(image, 1) if mirror else image.copy()
    h, w = img.shape[:2]

    flake = _flake_mask(img)
    if flake.sum() == 0:
        return {'graphene_mask': np.zeros((h, w), np.uint8),
                'graphene_contour': None, 'top_flake_mask': flake,
                'processed_image': img, 'cc_records': [], 'selected_idx': None}

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)

    # Background-subtracted bright threshold: graphene is consistently
    # BRIGHTER than its host flake (rel_L spans 16..80 across all 10 stacks
    # per offline GT fit). Use signed rel_L = L - L_bg(flake) thresholds so
    # the same threshold works whether flake_L absolute level is 100 or 200.
    flake_pix = lab[flake > 0].astype(np.float32)
    L_bg = float(np.median(flake_pix[:, 0]))
    a_bg = float(np.median(flake_pix[:, 1]))
    b_bg = float(np.median(flake_pix[:, 2]))
    rel_L = L - L_bg
    flake_ref_L = L_bg
    # Sweep rel_L > thr for thr ∈ [15, 80] in 10 steps. Covers the entire
    # priors range (rel_L_med 16..80). Higher minimum threshold (15) keeps
    # CCs tighter to the bright core and avoids dragging in the halo.
    sweep_thrs = list(np.linspace(15, 80, 10))
    multi_bright = []
    for thr in sweep_thrs:
        m = ((rel_L > thr).astype(np.uint8) * 255)
        m = cv2.bitwise_and(m, flake)
        m = morph_clean(m, close_k=7, open_k=3)
        if (m > 0).sum() == 0:
            continue
        multi_bright.append((m, float(thr)))
    if not multi_bright:
        bright = np.zeros_like(L, dtype=np.uint8)
        bright_thresh = 30.0
    else:
        bright, bright_thresh = multi_bright[len(multi_bright)//2]

    dt_inside = cv2.distanceTransform(flake, cv2.DIST_L2, 5)
    dt_outside = cv2.distanceTransform(255 - flake, cv2.DIST_L2, 5)

    # Hard area floor: real graphene ≥ 100 µm², well above noise blobs.
    min_area_px = max(200, int(round(100.0 / (pixel_size * pixel_size))))
    max_area_px = int(round(5000.0 / (pixel_size * pixel_size)))  # priors max ~2295
    cc_records = []
    multi_iter = multi_bright if multi_bright else [(bright, bright_thresh)]
    for source_mask, source_thr in multi_iter:
        nl, lab_arr, st_arr, _ = cv2.connectedComponentsWithStats(source_mask, connectivity=8)
        for lab_idx in range(1, nl):
            area_px = int(st_arr[lab_idx, cv2.CC_STAT_AREA])
            if area_px < min_area_px or area_px > max_area_px:
                continue
            cc_mask = (lab_arr == lab_idx).astype(np.uint8) * 255
            cnts, _ = cv2.findContours(cc_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cnts:
                continue
            cnt = max(cnts, key=cv2.contourArea)
            rect = cv2.minAreaRect(cnt)
            (_, _), (rw, rh), _ = rect
            if min(rw, rh) < 1:
                continue
            aspect = max(rw, rh) / max(min(rw, rh), 1e-6)

            hull = cv2.convexHull(cnt)
            hull_a = max(float(cv2.contourArea(hull)), 1.0)
            solidity = area_px / hull_a

            cc_pixels = lab[cc_mask > 0].astype(np.float32)
            L_med = float(np.median(cc_pixels[:, 0]))
            a_med = float(np.median(cc_pixels[:, 1]))
            b_med = float(np.median(cc_pixels[:, 2]))
            rel_L_med = L_med - L_bg
            rel_a_med = a_med - a_bg
            rel_b_med = b_med - b_bg

            M = cv2.moments(cc_mask, binaryImage=True)
            if M['m00'] < 1:
                continue
            cx = M['m10'] / M['m00']; cy = M['m01'] / M['m00']
            cxi = int(np.clip(round(cx), 0, w - 1))
            cyi = int(np.clip(round(cy), 0, h - 1))
            if flake[cyi, cxi] > 0:
                d_edge_um = float(dt_inside[cyi, cxi]) * pixel_size
            else:
                d_edge_um = -float(dt_outside[cyi, cxi]) * pixel_size

            area_um2 = area_px * pixel_size * pixel_size

            s_area = _gauss_score(area_um2,
                                  priors['area_um2_median'], priors['area_um2_std'],
                                  soft=1.0)
            s_aspect = _gauss_score(aspect,
                                    priors['aspect_median'], priors['aspect_std'],
                                    soft=1.5)
            s_solidity = _gauss_score(solidity,
                                      priors['solidity_median'], priors['solidity_std'],
                                      soft=2.0)
            # Background-subtracted Mahalanobis using rel_*_med priors —
            # stack-invariant. Falls back to absolute-LAB priors if the
            # rel_* keys are missing (older priors file).
            rel_L_v = priors.get('rel_L_med_median', 38.0)
            rel_L_s = priors.get('rel_L_med_std', 18.0)
            rel_a_v = priors.get('rel_a_med_median', 1.0)
            rel_a_s = priors.get('rel_a_med_std', 5.0)
            rel_b_v = priors.get('rel_b_med_median', 0.0)
            rel_b_s = priors.get('rel_b_med_std', 8.0)
            lab_dist_sq = (
                ((rel_L_med - rel_L_v) / max(rel_L_s, 1)) ** 2 +
                ((rel_a_med - rel_a_v) / max(rel_a_s, 1)) ** 2 +
                ((rel_b_med - rel_b_v) / max(rel_b_s, 1)) ** 2
            )
            s_lab = float(np.exp(-lab_dist_sq / 3.0))
            # Demote near-zero rel_L (background blob, not graphene).
            if rel_L_med < 5.0:
                s_lab *= 0.3
            s_edge = _gauss_score(d_edge_um,
                                  priors['centroid_dist_to_edge_um_median'],
                                  priors['centroid_dist_to_edge_um_std'],
                                  soft=2.5)

            # Weighted geometric mean. LAB carries 1.5x weight to avoid
            # picking the bright-edge halo in stacks where graphene is dim.
            log_score = (
                1.0 * np.log(max(s_area, 1e-6)) +
                1.0 * np.log(max(s_aspect, 1e-6)) +
                1.0 * np.log(max(s_solidity, 1e-6)) +
                1.5 * np.log(max(s_lab, 1e-6)) +
                1.0 * np.log(max(s_edge, 1e-6))
            )
            combined = float(np.exp(log_score / 5.5))

            cc_records.append({
                'lab_idx': lab_idx,
                'area_px': area_px, 'area_um2': area_um2,
                'aspect': aspect, 'solidity': solidity,
                'L_med': L_med, 'a_med': a_med, 'b_med': b_med,
                'rel_L_med': rel_L_med, 'rel_a_med': rel_a_med, 'rel_b_med': rel_b_med,
                'd_edge_um': d_edge_um,
                's_area': s_area, 's_aspect': s_aspect, 's_solidity': s_solidity,
                's_lab': s_lab, 's_edge': s_edge,
                'score': combined,
                '_cc_mask': cc_mask,
                '_thr': source_thr,
            })

    if not cc_records:
        return {'graphene_mask': np.zeros((h, w), np.uint8),
                'graphene_contour': None, 'top_flake_mask': flake,
                'processed_image': img, 'cc_records': [], 'selected_idx': None}

    cc_records.sort(key=lambda r: r['score'], reverse=True)
    best = cc_records[0]
    base_mask = best['_cc_mask']

    grow_mask = base_mask  # Region grow can over-expand on PDMS; rely on threshold.
    final = morph_clean(grow_mask, close_k=11, open_k=5)
    final = keep_largest_n(final, n=1, min_area=200)
    final = flood_fill_holes(final)

    cnts, _ = cv2.findContours(final, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = max(cnts, key=cv2.contourArea) if cnts else None

    public_records = [{k: v for k, v in r.items() if not k.startswith('_')}
                       for r in cc_records]
    return {
        'graphene_mask': final,
        'graphene_contour': contour,
        'top_flake_mask': flake,
        'processed_image': img,
        'cc_records': public_records,
        'selected_idx': best['lab_idx'],
        'flake_ref_L': float(flake_ref_L),
        'L_bg': float(L_bg),
        'bright_thresh_L': float(bright_thresh),
    }


def main():
    p = argparse.ArgumentParser(description='B3 graphene detect (shape-CC scoring)')
    p.add_argument('--image', required=True)
    p.add_argument('--pixel-size', type=float, required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--mirror', action='store_true', default=False)
    p.add_argument('--cluster-id', type=int, default=None,
                   help='[unused, kept for CLI compat]')
    p.add_argument('--n-sub-clusters', type=int, default=3,
                   help='[unused, kept for CLI compat]')
    args = p.parse_args()

    img = cv2.imread(os.path.abspath(os.path.expanduser(args.image)))
    if img is None:
        print(f'ERROR: cannot read {args.image}', file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    result = detect_graphene(img, args.pixel_size, mirror=args.mirror)

    print(f'L_bg(flake)={result.get("L_bg","?"):.1f}, rel_L thr={result.get("bright_thresh_L","?"):.1f}')
    print('Top candidates:')
    for r in result['cc_records'][:5]:
        marker = ' <-- selected' if r['lab_idx'] == result.get('selected_idx') else ''
        print(f"  cc{r['lab_idx']}: area={r['area_um2']:.0f}um2 aspect={r['aspect']:.1f} "
              f"sol={r['solidity']:.2f} L={r['L_med']:.0f} relL={r.get('rel_L_med',0):.1f} "
              f"score={r['score']:.3f}{marker}")

    if result['graphene_contour'] is None:
        print('WARN: no graphene candidate; emitting tiny placeholder', file=sys.stderr)
        h_, w_ = result['processed_image'].shape[:2]
        placeholder = np.zeros((h_, w_), np.uint8)
        cy, cx = h_ // 2, w_ // 2
        placeholder[cy-2:cy+3, cx-2:cx+3] = 255
        cv2.imwrite(str(out_dir / 'graphene_mask.png'), placeholder)
        cnts, _ = cv2.findContours(placeholder, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
        contour = cnts[0] if cnts else None
        if contour is None:
            sys.exit(1)
        np.save(str(out_dir / 'graphene_contour.npy'),
                contour.reshape(-1, 2).astype(np.float64))
        sidecar = {'area_px': 25, 'area_um2': 25 * args.pixel_size ** 2,
                   'cluster_id': None}
        (out_dir / 'graphene_result.json').write_text(json.dumps(sidecar, indent=2))
        diag = desaturate(result['processed_image'], factor=0.4)
        cv2.drawContours(diag, [contour], -1, (0, 0, 255), 2)
        cv2.imwrite(str(out_dir / '02_graphene_on_top.png'), diag)
        cv2.imwrite(str(out_dir / '00_graphene_candidates.png'), diag)
        return

    contour = result['graphene_contour']
    mask = result['graphene_mask']

    cv2.imwrite(str(out_dir / 'graphene_mask.png'), mask)
    contour_2d = contour.reshape(-1, 2).astype(np.float64)
    np.save(str(out_dir / 'graphene_contour.npy'), contour_2d)

    diag = desaturate(result['processed_image'], factor=0.4)
    cv2.drawContours(diag, [contour], -1, (0, 0, 255), 2)
    cv2.imwrite(str(out_dir / '02_graphene_on_top.png'), diag)
    cv2.imwrite(str(out_dir / '00_graphene_candidates.png'), diag)  # legacy

    area_px = int((mask > 0).sum())
    area_um2 = round(area_px * args.pixel_size * args.pixel_size, 2)
    sidecar = {'area_px': area_px, 'area_um2': area_um2,
               'cluster_id': result.get('selected_idx')}
    (out_dir / 'graphene_result.json').write_text(json.dumps(sidecar, indent=2))

    print(f'\nOK: graphene area={area_um2}um2 ({area_px}px)')


if __name__ == '__main__':
    main()
