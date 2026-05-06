"""B3: shape-template + multi-threshold sweep + connected-component scoring.

Adapted from round-2 cand-B3 graphite.py / graphene.py. Bypasses K-means; sweeps
multiple darkness/brightness thresholds inside the host mask, scores each CC by
weighted Gaussian-likelihood against shape priors (area, aspect, solidity, LAB,
edge-distance), picks the highest-scoring CC.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import morph_clean, flood_fill_holes, keep_largest_n  # noqa: E402


def _gauss_score(value: float, median: float, std: float, soft: float = 1.0) -> float:
    s = max(std, 1e-6)
    return float(np.exp(-((value - median) ** 2) / (2 * (s * soft) ** 2)))


def _region_grow_lab(base_mask: np.ndarray, lab_image: np.ndarray,
                      region_mask: np.ndarray, n_iter: int = 2,
                      dilate_px: int = 3, max_area_px: int | None = None,
                      d_thresh: float = 2.0) -> np.ndarray:
    cur = base_mask.copy()
    init_area = (cur > 0).sum()
    cap = max_area_px if max_area_px is not None else int(2.5 * max(init_area, 1))
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
        keep = d < d_thresh
        new_mask = cur.copy()
        new_mask[ys[keep], xs[keep]] = 255
        new_area = (new_mask > 0).sum()
        if new_area == (cur > 0).sum():
            break
        if new_area > cap:
            break
        cur = new_mask
    return cur


def detect_graphite(image: np.ndarray, hbn_mask: np.ndarray,
                    pixel_size_um: float, priors_path: Path) -> dict:
    """B3 graphite. Returns {'mask': final mask, 'best_score': float}."""
    h, w = image.shape[:2]
    if hbn_mask.sum() == 0 or not priors_path.exists():
        return {"mask": np.zeros((h, w), np.uint8)}
    priors = json.loads(priors_path.read_text())

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)
    hbn_pixels_L = L[hbn_mask > 0]
    annulus_um = 25.0
    annulus_px = int(round(annulus_um / pixel_size_um))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * annulus_px + 1, 2 * annulus_px + 1))
    hbn_dilated = cv2.dilate(hbn_mask, k)

    p_lo = float(np.percentile(hbn_pixels_L, 1))
    p_hi = float(np.percentile(hbn_pixels_L, 20))
    if p_hi - p_lo < 8:
        p_hi = p_lo + 8
    min_area_px = max(200, int(round(200.0 / (pixel_size_um * pixel_size_um))))
    max_area_px = int(round(3000.0 / (pixel_size_um * pixel_size_um)))

    sweep_thresholds = list(np.linspace(p_lo, p_hi + 5, 12))
    multi_dark_records = []
    for thr in sweep_thresholds:
        candidate = (L < thr).astype(np.uint8) * 255
        candidate = cv2.bitwise_and(candidate, hbn_dilated)
        candidate = morph_clean(candidate, close_k=5, open_k=3)
        if (candidate > 0).sum() == 0:
            continue
        multi_dark_records.append((candidate, float(thr)))

    if not multi_dark_records:
        return {"mask": np.zeros((h, w), np.uint8)}

    dt_inside = cv2.distanceTransform(hbn_mask, cv2.DIST_L2, 5)
    dt_outside = cv2.distanceTransform(255 - hbn_mask, cv2.DIST_L2, 5)

    cc_records = []
    for source_mask, _ in multi_dark_records:
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
            if cv2.contourArea(cnt) < 1:
                continue
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
            M = cv2.moments(cc_mask, binaryImage=True)
            if M['m00'] < 1:
                continue
            cx = M['m10'] / M['m00']; cy = M['m01'] / M['m00']
            cxi = int(np.clip(round(cx), 0, w - 1))
            cyi = int(np.clip(round(cy), 0, h - 1))
            if hbn_mask[cyi, cxi] > 0:
                d_edge_um = float(dt_inside[cyi, cxi]) * pixel_size_um
            else:
                d_edge_um = -float(dt_outside[cyi, cxi]) * pixel_size_um
            area_um2 = area_px * pixel_size_um * pixel_size_um

            s_area = _gauss_score(area_um2, priors['area_um2_median'],
                                  priors['area_um2_std'], soft=1.0)
            s_aspect = _gauss_score(aspect, priors['aspect_median'],
                                    priors['aspect_std'], soft=1.0)
            s_solidity = _gauss_score(solidity, priors['solidity_median'],
                                      priors['solidity_std'], soft=2.0)
            lab_dist_sq = (
                ((L_med - priors['L_med_median']) / max(priors['L_med_std'], 1)) ** 2 +
                ((a_med - priors['a_med_median']) / max(priors['a_med_std'], 1)) ** 2 +
                ((b_med - priors['b_med_median']) / max(priors['b_med_std'], 1)) ** 2
            )
            s_lab = float(np.exp(-lab_dist_sq / 6.0))
            s_edge = _gauss_score(d_edge_um,
                                  priors['centroid_dist_to_edge_um_median'],
                                  priors['centroid_dist_to_edge_um_std'], soft=1.0)
            if d_edge_um < -5.0:
                s_edge *= 0.1
            log_score = (
                1.0 * np.log(max(s_area, 1e-6)) +
                2.0 * np.log(max(s_aspect, 1e-6)) +
                1.0 * np.log(max(s_solidity, 1e-6)) +
                1.0 * np.log(max(s_lab, 1e-6)) +
                1.0 * np.log(max(s_edge, 1e-6))
            )
            combined = float(np.exp(log_score / 6.0))
            cc_records.append({"score": combined, "_cc_mask": cc_mask})

    if not cc_records:
        return {"mask": np.zeros((h, w), np.uint8)}

    cc_records.sort(key=lambda r: r['score'], reverse=True)
    best_mask = cc_records[0]['_cc_mask']

    grow_mask = _region_grow_lab(best_mask, lab, hbn_dilated, n_iter=2,
                                  dilate_px=3, max_area_px=max_area_px,
                                  d_thresh=2.0)
    final = morph_clean(grow_mask, close_k=3, open_k=3)
    final = keep_largest_n(final, n=1, min_area=200)
    if (final > 0).sum() > max_area_px:
        final = morph_clean(best_mask.copy(), close_k=3, open_k=3)
        final = keep_largest_n(final, n=1, min_area=200)
    if 0 < (final > 0).sum() < max_area_px:
        kclose = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        final = cv2.morphologyEx(final, cv2.MORPH_CLOSE, kclose)
    return {"mask": final, "best_score": cc_records[0]['score']}


def detect_graphene(image: np.ndarray, flake_mask: np.ndarray,
                    pixel_size_um: float, priors_path: Path) -> dict:
    """B3 graphene. Returns {'mask': final mask}."""
    h, w = image.shape[:2]
    if flake_mask.sum() == 0 or not priors_path.exists():
        return {"mask": np.zeros((h, w), np.uint8)}
    priors = json.loads(priors_path.read_text())

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)
    flake_L = L[flake_mask > 0]
    sweep_pcts = [60, 65, 70, 75, 80, 85, 90]
    multi_bright = []
    for pct in sweep_pcts:
        thr = float(np.percentile(flake_L, pct))
        m = (L > thr).astype(np.uint8) * 255
        m = cv2.bitwise_and(m, flake_mask)
        m = morph_clean(m, close_k=7, open_k=3)
        if (m > 0).sum() == 0:
            continue
        multi_bright.append((m, thr))
    if not multi_bright:
        return {"mask": np.zeros((h, w), np.uint8)}

    dt_inside = cv2.distanceTransform(flake_mask, cv2.DIST_L2, 5)
    dt_outside = cv2.distanceTransform(255 - flake_mask, cv2.DIST_L2, 5)

    min_area_px = max(200, int(round(100.0 / (pixel_size_um * pixel_size_um))))
    max_area_px = int(round(5000.0 / (pixel_size_um * pixel_size_um)))
    cc_records = []
    for source_mask, _ in multi_bright:
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
            M = cv2.moments(cc_mask, binaryImage=True)
            if M['m00'] < 1:
                continue
            cx = M['m10'] / M['m00']; cy = M['m01'] / M['m00']
            cxi = int(np.clip(round(cx), 0, w - 1))
            cyi = int(np.clip(round(cy), 0, h - 1))
            if flake_mask[cyi, cxi] > 0:
                d_edge_um = float(dt_inside[cyi, cxi]) * pixel_size_um
            else:
                d_edge_um = -float(dt_outside[cyi, cxi]) * pixel_size_um
            area_um2 = area_px * pixel_size_um * pixel_size_um

            s_area = _gauss_score(area_um2, priors['area_um2_median'],
                                  priors['area_um2_std'], soft=1.0)
            s_aspect = _gauss_score(aspect, priors['aspect_median'],
                                    priors['aspect_std'], soft=1.5)
            s_solidity = _gauss_score(solidity, priors['solidity_median'],
                                      priors['solidity_std'], soft=2.0)
            lab_dist_sq = (
                ((L_med - priors['L_med_median']) / max(priors['L_med_std'], 1)) ** 2 +
                ((a_med - priors['a_med_median']) / max(priors['a_med_std'], 1)) ** 2 +
                ((b_med - priors['b_med_median']) / max(priors['b_med_std'], 1)) ** 2
            )
            s_lab = float(np.exp(-lab_dist_sq / 3.0))
            s_edge = _gauss_score(d_edge_um,
                                  priors['centroid_dist_to_edge_um_median'],
                                  priors['centroid_dist_to_edge_um_std'], soft=2.5)
            log_score = (
                1.0 * np.log(max(s_area, 1e-6)) +
                1.0 * np.log(max(s_aspect, 1e-6)) +
                1.0 * np.log(max(s_solidity, 1e-6)) +
                1.5 * np.log(max(s_lab, 1e-6)) +
                1.0 * np.log(max(s_edge, 1e-6))
            )
            combined = float(np.exp(log_score / 5.5))
            cc_records.append({"score": combined, "_cc_mask": cc_mask})

    if not cc_records:
        return {"mask": np.zeros((h, w), np.uint8)}

    cc_records.sort(key=lambda r: r['score'], reverse=True)
    best_mask = cc_records[0]['_cc_mask']
    final = morph_clean(best_mask, close_k=11, open_k=5)
    final = keep_largest_n(final, n=1, min_area=200)
    final = flood_fill_holes(final)
    return {"mask": final, "best_score": cc_records[0]['score']}
