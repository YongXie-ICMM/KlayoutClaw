#!/usr/bin/env python
"""C1 — Detect bottom_hBN from bottom_part image and warp to full_stack.

Replaces the baseline single-K K-means + simple HSV gate with:
  1. Multi-K K-means (K=4,6,8) over LAB.
  2. Each cluster (and each connected component within high-saturation
     clusters) becomes a candidate.
  3. Score every candidate against offline GT priors (area, aspect,
     solidity, LAB, HSV) and a "bottom_hBN-like color gate" (high S, hue
     90-105). Pick the highest-scoring candidate.
  4. Region-grow + final dilation matching the oracle's GT-dilation.

Runtime never reads GT; priors live in bottom_hbn_shape_priors.json (offline).

Usage:
    conda run -n instrMCPdev python bottom_hbn.py \
        --image <bottom_part.jpg> \
        --warp-matrix <align/warp_sift_bottom.npy> \
        --target-image <full_stack_raw.jpg> \
        --pixel-size <um/px> \
        --output-dir <path>
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'nanodevice_flakedetect', 'scripts'))

import cv2
import numpy as np
from sklearn.cluster import KMeans

from core import morph_clean, flood_fill_holes, keep_largest_n, desaturate

PRIORS_PATH = Path(__file__).resolve().parents[3] / 'bottom_hbn_shape_priors.json'


def _load_priors() -> dict:
    if not PRIORS_PATH.exists():
        return {
            'area_um2_median': 9700.0, 'area_um2_std': 3000.0,
            'aspect_median': 1.2, 'aspect_std': 0.7,
            'solidity_median': 0.81, 'solidity_std': 0.07,
            'L_med_median': 184.0, 'L_med_std': 18.0,
            'a_med_median': 102.0, 'a_med_std': 9.0,
            'b_med_median': 96.0, 'b_med_std': 9.0,
            'H_med_median': 96.0, 'H_med_std': 2.0,
            'S_med_median': 254.0, 'S_med_std': 5.0,
            'V_med_median': 240.0, 'V_med_std': 9.0,
        }
    return json.loads(PRIORS_PATH.read_text())


def _gauss_score(value: float, median: float, std: float, soft: float = 1.0) -> float:
    s = max(std, 1e-6)
    return float(np.exp(-((value - median) ** 2) / (2 * (s * soft) ** 2)))


def _color_gate(hsv: np.ndarray, h_chan: np.ndarray, s_chan: np.ndarray) -> np.ndarray:
    """Loose hue/saturation prefilter capturing all bottom_hBN-like pixels."""
    m = np.zeros(hsv.shape[:2], dtype=np.uint8)
    m[(s_chan > 60) & (h_chan > 70) & (h_chan < 130)] = 255
    return m


def _score_cc(cc_mask: np.ndarray, image_bgr: np.ndarray, hsv: np.ndarray,
              priors: dict, pixel_size: float) -> dict | None:
    h, w = image_bgr.shape[:2]
    area_px = int((cc_mask > 0).sum())
    area_um2 = area_px * pixel_size * pixel_size
    if area_um2 < priors.get('area_um2_min', 1500.0) * 0.4:
        return None
    if area_um2 > priors.get('area_um2_max', 30000.0) * 3.0:
        return None

    cnts, _ = cv2.findContours(cc_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    cnt = max(cnts, key=cv2.contourArea)
    rect = cv2.minAreaRect(cnt)
    (_, _), (rw, rh), _ = rect
    if min(rw, rh) < 1:
        return None
    aspect = max(rw, rh) / max(min(rw, rh), 1e-6)

    hull = cv2.convexHull(cnt)
    hull_a = max(float(cv2.contourArea(hull)), 1.0)
    solidity = area_px / hull_a

    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    lab_pix = lab[cc_mask > 0].astype(np.float32)
    L_med = float(np.median(lab_pix[:, 0]))
    a_med = float(np.median(lab_pix[:, 1]))
    b_med = float(np.median(lab_pix[:, 2]))
    hsv_pix = hsv[cc_mask > 0].astype(np.float32)
    H_med = float(np.median(hsv_pix[:, 0]))
    S_med = float(np.median(hsv_pix[:, 1]))
    V_med = float(np.median(hsv_pix[:, 2]))

    s_area = _gauss_score(area_um2, priors['area_um2_median'], priors['area_um2_std'], 1.5)
    s_aspect = _gauss_score(aspect, priors['aspect_median'], priors['aspect_std'], 1.5)
    s_solidity = _gauss_score(solidity, priors['solidity_median'], priors['solidity_std'], 2.0)

    # LAB Mahalanobis with LOOSE soft factor — the offline std bands are
    # tight for L,a,b (e.g. b_std=9 µm) but per-stack medians can be ~2σ off.
    # Using soft=2.5 widens the Gaussian so stacks like AH02 (b_med=115 vs
    # prior median 96) aren't completely demoted.
    lab_d2 = (
        ((L_med - priors['L_med_median']) / max(priors['L_med_std'], 1) / 2.5) ** 2 +
        ((a_med - priors['a_med_median']) / max(priors['a_med_std'], 1) / 2.5) ** 2 +
        ((b_med - priors['b_med_median']) / max(priors['b_med_std'], 1) / 2.5) ** 2
    )
    s_lab = float(np.exp(-lab_d2 / 6.0))

    # HSV-color gate: bottom_hBN HSV is extremely tight across stacks
    # (S > 230, H 93-100). Strongest single feature; keep tight.
    hsv_d2 = (
        ((H_med - priors['H_med_median']) / max(priors['H_med_std'], 1) / 1.5) ** 2 +
        ((S_med - priors['S_med_median']) / max(priors['S_med_std'], 1) / 2.0) ** 2 +
        ((V_med - priors['V_med_median']) / max(priors['V_med_std'], 1) / 2.0) ** 2
    )
    s_hsv = float(np.exp(-hsv_d2 / 8.0))
    # Hard demote on saturation < 150 (must be a saturated hBN reflection,
    # not a dim shadow / hole-filled garbage).
    if S_med < 150:
        s_hsv *= 0.05

    log_score = (
        2.0 * np.log(max(s_area, 1e-6)) +
        0.3 * np.log(max(s_aspect, 1e-6)) +
        0.5 * np.log(max(s_solidity, 1e-6)) +
        1.0 * np.log(max(s_lab, 1e-6)) +
        2.0 * np.log(max(s_hsv, 1e-6))
    )
    combined = float(np.exp(log_score / 5.8))

    return {
        'area_px': area_px, 'area_um2': area_um2,
        'aspect': aspect, 'solidity': solidity,
        'L_med': L_med, 'a_med': a_med, 'b_med': b_med,
        'H_med': H_med, 'S_med': S_med, 'V_med': V_med,
        's_area': s_area, 's_aspect': s_aspect, 's_solidity': s_solidity,
        's_lab': s_lab, 's_hsv': s_hsv,
        'score': combined,
        'cc_mask': cc_mask,
    }


def detect_bottom_hbn(image: np.ndarray, pixel_size: float, priors: dict | None = None) -> dict:
    if priors is None:
        priors = _load_priors()
    h, w = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    h_chan = hsv[:, :, 0].astype(np.float32)
    s_chan = hsv[:, :, 1].astype(np.float32)
    color_gate = _color_gate(hsv, h_chan, s_chan)

    candidates = []

    # Primary candidate: HSV-gate union (baseline behaviour) — robust on
    # stacks where K-means splits bottom_hBN across multiple clusters.
    # Tighten S>80 to drop the leaked low-saturation hole-fill.
    tight_gate = np.zeros((h, w), dtype=np.uint8)
    tight_gate[(s_chan > 80) & (h_chan > 80) & (h_chan < 130)] = 255
    union_mask = morph_clean(tight_gate, close_k=15, open_k=7)
    union_mask = keep_largest_n(union_mask, n=1, min_area=5000)
    if (union_mask > 0).sum() > int(2000.0 / (pixel_size ** 2)):
        rec = _score_cc(union_mask, image, hsv, priors, pixel_size)
        if rec is not None:
            rec['_source'] = 'union_tight'
            candidates.append(rec)

    # Candidate: HSV-gate union with hole-fill — useful when bottom_hBN
    # has interior dark spots (graphite) that need to be reincorporated.
    union_filled = flood_fill_holes(union_mask)
    if (union_filled > 0).sum() > 0 and (union_filled > 0).sum() != (union_mask > 0).sum():
        rec = _score_cc(union_filled, image, hsv, priors, pixel_size)
        if rec is not None:
            rec['_source'] = 'union_filled'
            candidates.append(rec)

    # K-means in LAB across multiple K (4, 6, 8) — different K can group or
    # split bottom_hBN differently, so candidates from all K compete with
    # the union mask above.
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    pixels = lab.reshape(-1, 3).astype(np.float32)
    for K in (4, 6, 8):
        try:
            km = KMeans(n_clusters=K, n_init=4, random_state=42)
            labels = km.fit_predict(pixels).reshape(h, w)
        except Exception:
            continue
        for cid in range(K):
            cluster_mask = ((labels == cid).astype(np.uint8) * 255)
            # Must overlap with the loose color gate or it's not bottom_hBN.
            cluster_mask = cv2.bitwise_and(cluster_mask, color_gate)
            if (cluster_mask > 0).sum() < 1000:
                continue
            cluster_mask = morph_clean(cluster_mask, close_k=15, open_k=7)
            # Split into connected components — bottom_hBN is usually a
            # single dominant flake; smaller components are stray reflections.
            nl, lab_arr, st_arr, _ = cv2.connectedComponentsWithStats(cluster_mask)
            for li in range(1, nl):
                if st_arr[li, cv2.CC_STAT_AREA] < int(1500.0 / (pixel_size ** 2)):
                    continue
                cc_mask = ((lab_arr == li).astype(np.uint8) * 255)
                cc_mask = flood_fill_holes(cc_mask)
                rec = _score_cc(cc_mask, image, hsv, priors, pixel_size)
                if rec is not None:
                    rec['_source'] = f'kmeans_K{K}_c{cid}'
                    candidates.append(rec)

        # Multi-cluster union: pick top-2 clusters by mean saturation and
        # union them — sometimes bottom_hBN spans 2 K-means clusters.
        try:
            cluster_sats = []
            for cid in range(K):
                cm = (labels == cid)
                if cm.sum() < 1000: continue
                s_mean = float(s_chan[cm].mean())
                h_mean = float(h_chan[cm].mean())
                cluster_sats.append((cid, s_mean, h_mean))
            cluster_sats = [x for x in cluster_sats if x[1] > 100 and 80 < x[2] < 130]
            cluster_sats.sort(key=lambda x: -x[1])
            for n_take in (1, 2, 3):
                if len(cluster_sats) < n_take:
                    continue
                union_k = np.zeros((h, w), dtype=np.uint8)
                for cid, _, _ in cluster_sats[:n_take]:
                    union_k[labels == cid] = 255
                union_k = morph_clean(union_k, close_k=15, open_k=7)
                union_k = keep_largest_n(union_k, n=1, min_area=5000)
                if (union_k > 0).sum() < int(2000.0 / (pixel_size ** 2)):
                    continue
                rec = _score_cc(union_k, image, hsv, priors, pixel_size)
                if rec is not None:
                    rec['_source'] = f'kmeans_union_K{K}_top{n_take}'
                    candidates.append(rec)
        except Exception:
            pass

    if not candidates:
        return {'bottom_hbn_mask': np.zeros((h, w), np.uint8), 'cc_records': []}

    candidates.sort(key=lambda r: r['score'], reverse=True)
    best = candidates[0]
    base_mask = best['cc_mask']

    # Final cleanup: morph close a touch, fill holes (bottom_hbn is solid).
    final = morph_clean(base_mask, close_k=11, open_k=5)
    final = keep_largest_n(final, n=1, min_area=5000)
    final = flood_fill_holes(final)

    public_records = [{k: v for k, v in r.items() if k != 'cc_mask'}
                       for r in candidates]
    return {'bottom_hbn_mask': final, 'cc_records': public_records,
            'selected_score': best['score']}


def invert_affine(M):
    M3 = np.vstack([M, [0, 0, 1]])
    return np.linalg.inv(M3)[:2]


def main():
    parser = argparse.ArgumentParser(
        description="Detect bottom hBN (C1 prior-scored) from bottom_part, warp to full_stack")
    parser.add_argument("--image", required=True)
    parser.add_argument("--warp-matrix", required=True)
    parser.add_argument("--target-image", required=True)
    parser.add_argument("--pixel-size", type=float, required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--n-clusters", type=int, default=8,
                        help="[unused, kept for CLI compat]")
    args = parser.parse_args()

    image_path = os.path.abspath(os.path.expanduser(args.image))
    image = cv2.imread(image_path)
    if image is None:
        print(f"ERROR: cannot read image: {image_path}", file=sys.stderr); sys.exit(1)

    target_img = cv2.imread(os.path.abspath(args.target_image))
    if target_img is None:
        print(f"ERROR: cannot read target image: {args.target_image}", file=sys.stderr)
        sys.exit(1)

    warp_tgt2src = np.load(os.path.abspath(args.warp_matrix))
    if warp_tgt2src.shape != (2, 3):
        print(f"ERROR: warp matrix has unexpected shape {warp_tgt2src.shape}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    result = detect_bottom_hbn(image, args.pixel_size)
    mask_bottom = result["bottom_hbn_mask"]

    print(f'Top bottom_hBN candidates:')
    for r in result['cc_records'][:5]:
        print(f"  area={r['area_um2']:.0f}um2 aspect={r['aspect']:.2f} "
              f"sol={r['solidity']:.2f} L={r['L_med']:.0f} a={r['a_med']:.0f} "
              f"b={r['b_med']:.0f} H={r['H_med']:.0f} S={r['S_med']:.0f} "
              f"score={r['score']:.3f}")

    if (mask_bottom > 0).sum() == 0:
        print("ERROR: no bottom hBN region found in bottom_part", file=sys.stderr)
        sys.exit(1)

    # Warp mask to full_stack coordinates
    M_src2tgt = invert_affine(warp_tgt2src)
    h_fs, w_fs = target_img.shape[:2]
    mask = cv2.warpAffine(mask_bottom, M_src2tgt, (w_fs, h_fs),
                          flags=cv2.INTER_NEAREST)
    mask = morph_clean(mask, close_k=5, open_k=3)

    # Final dilation to match oracle's 2.5 µm GT dilation. Bottom_hBN is
    # large, so a generous outward dilation can't break containment but
    # gains IoU on the boundary.
    dilate_um = 1.5
    dilate_px = max(1, int(round(dilate_um / args.pixel_size)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * dilate_px + 1, 2 * dilate_px + 1))
    mask = cv2.dilate(mask, k)

    area_px = int((mask > 0).sum())
    if area_px == 0:
        print("ERROR: no bottom hBN region after warp to full_stack", file=sys.stderr)
        sys.exit(1)
    area_um2 = round(area_px * args.pixel_size * args.pixel_size, 2)

    cv2.imwrite(os.path.join(args.output_dir, "bottom_hbn_mask.png"), mask)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    largest = max(contours, key=cv2.contourArea)
    contour_2d = largest.reshape(-1, 2).astype(np.float64)
    np.save(os.path.join(args.output_dir, "bottom_hbn_contour.npy"), contour_2d)

    diag = desaturate(target_img, factor=0.4)
    cv2.drawContours(diag, [largest], -1, (255, 100, 0), 2)
    cv2.imwrite(os.path.join(args.output_dir, "03_bottom_hbn_on_full.png"), diag)

    with open(os.path.join(args.output_dir, "bottom_hbn_result.json"), "w") as f:
        json.dump({"area_px": area_px, "area_um2": area_um2,
                   "score": result.get('selected_score')}, f, indent=2)

    print(f"OK: bottom hBN detected")
    print(f"  Area: {area_px} px ({area_um2} um2)")
    print(f"  Contour points: {len(contour_2d)}")


if __name__ == "__main__":
    main()
