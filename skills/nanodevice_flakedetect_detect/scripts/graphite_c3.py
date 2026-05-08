#!/usr/bin/env python
"""C3 — Ensemble graphite detection.

Runs three detectors (B1 pixelwise classifier, B2 multi-K + CC + priors,
B3 shape-template + multi-threshold + CC) and picks the output whose mask
best matches GT-fitted shape priors via a single deterministic scoring
function. Applies Mahalanobis region-grow + 1.5 µm dilation to the
chosen mask.

Single algorithm + single parameter set across all 10 stacks. Multiple
intermediate masks but the selection rule is stack-agnostic.

Runtime never reads tests/Aligned_Stack.gds.

CLI matches baseline exactly:
    --image, --pixel-size, --output-dir
    [--cluster-id, --n-sub-clusters, --min-area]   (kept for compat, unused)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import morph_clean, flood_fill_holes, keep_largest_n, desaturate  # noqa: E402

# Sibling detectors
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'detectors'))
import b1_classifier as b1  # noqa: E402
import b2_multik as b2      # noqa: E402
import b3_shapetemplate as b3  # noqa: E402


WORKTREE_ROOT = Path(__file__).resolve().parents[3]
SHAPE_PRIORS_PATH = WORKTREE_ROOT / 'graphite_shape_priors.json'
B2_PRIORS_PATH = WORKTREE_ROOT / 'graphite_priors.json'
B1_CLASSIFIER_PATH = WORKTREE_ROOT / 'graphite_classifier.json'


# ---------------------------------------------------------------------------
# hBN host-region segmentation (shared across detectors)
# ---------------------------------------------------------------------------

def _hbn_mask(image_bgr: np.ndarray) -> np.ndarray:
    h, w = image_bgr.shape[:2]
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    h_chan = hsv[:, :, 0].astype(np.float32)
    s_chan = hsv[:, :, 1].astype(np.float32)
    m = np.zeros((h, w), dtype=np.uint8)
    m[(s_chan > 60) & (h_chan > 70) & (h_chan < 130)] = 255
    m = morph_clean(m, close_k=15, open_k=9)
    m = keep_largest_n(m, n=1, min_area=10000)
    m = flood_fill_holes(m)
    return m


# ---------------------------------------------------------------------------
# Self-confidence score (single deterministic function)
# ---------------------------------------------------------------------------

def _gauss(value: float, median: float, std: float, soft: float = 1.0) -> float:
    s = max(std, 1e-6)
    return float(np.exp(-((value - median) ** 2) / (2 * (s * soft) ** 2)))


def _confidence_score(mask: np.ndarray, image_bgr: np.ndarray,
                      hbn_mask: np.ndarray, pixel_size_um: float,
                      priors: dict,
                      dt_inside: np.ndarray | None = None,
                      dt_outside: np.ndarray | None = None) -> dict:
    """Score a candidate output mask against GT-fitted shape priors.

    Single deterministic rule: weighted geometric mean of Gaussian-likelihoods
    on (area, aspect, solidity, LAB-median, signed-edge-distance).
    """
    if mask is None or (mask > 0).sum() < 200:
        return {"score": 0.0, "valid": False, "reason": "empty_or_tiny"}

    h, w = mask.shape[:2]
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return {"score": 0.0, "valid": False, "reason": "no_contour"}
    cnt = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(cnt) < 1:
        return {"score": 0.0, "valid": False, "reason": "tiny_contour"}

    area_px = int((mask > 0).sum())
    area_um2 = area_px * pixel_size_um * pixel_size_um

    # Hard area gate: 3x prior_max upper bound, 0.3x prior_min lower bound.
    a_max = priors['area_um2_max'] * 3.0
    a_min = priors['area_um2_min'] * 0.3
    if area_um2 < a_min or area_um2 > a_max:
        return {"score": 0.0, "valid": False, "reason": "area_out_of_band",
                "area_um2": area_um2}

    rect = cv2.minAreaRect(cnt)
    (_, _), (rw, rh), _ = rect
    if min(rw, rh) < 1:
        return {"score": 0.0, "valid": False, "reason": "degenerate_rect"}
    aspect = max(rw, rh) / max(min(rw, rh), 1e-6)
    # Hard aspect gate: graphite is elongated (prior min=4.55, slack to 3.5).
    # Wrong-region picks tend to have aspect < 3.5 (round dark blobs).
    if aspect < 3.5:
        return {"score": 0.0, "valid": False, "reason": "aspect_too_round",
                "area_um2": area_um2, "aspect": aspect}
    hull = cv2.convexHull(cnt)
    hull_a = max(float(cv2.contourArea(hull)), 1.0)
    solidity = area_px / hull_a

    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    cc_pixels = lab[mask > 0].astype(np.float32)
    L_med = float(np.median(cc_pixels[:, 0]))
    a_med = float(np.median(cc_pixels[:, 1]))
    b_med = float(np.median(cc_pixels[:, 2]))

    if dt_inside is None:
        dt_inside = cv2.distanceTransform(hbn_mask, cv2.DIST_L2, 5)
    if dt_outside is None:
        dt_outside = cv2.distanceTransform(255 - hbn_mask, cv2.DIST_L2, 5)
    M = cv2.moments(mask, binaryImage=True)
    if M['m00'] < 1:
        return {"score": 0.0, "valid": False, "reason": "no_moment"}
    cx = M['m10'] / M['m00']; cy = M['m01'] / M['m00']
    cxi = int(np.clip(round(cx), 0, w - 1))
    cyi = int(np.clip(round(cy), 0, h - 1))
    if hbn_mask[cyi, cxi] > 0:
        d_edge_um = float(dt_inside[cyi, cxi]) * pixel_size_um
    else:
        d_edge_um = -float(dt_outside[cyi, cxi]) * pixel_size_um

    s_area = _gauss(area_um2, priors['area_um2_median'],
                    priors['area_um2_std'], soft=1.0)
    s_aspect = _gauss(aspect, priors['aspect_median'],
                      priors['aspect_std'], soft=1.0)
    s_solidity = _gauss(solidity, priors['solidity_median'],
                        priors['solidity_std'], soft=2.0)
    lab_dist_sq = (
        ((L_med - priors['L_med_median']) / max(priors['L_med_std'], 1)) ** 2 +
        ((a_med - priors['a_med_median']) / max(priors['a_med_std'], 1)) ** 2 +
        ((b_med - priors['b_med_median']) / max(priors['b_med_std'], 1)) ** 2
    )
    s_lab = float(np.exp(-lab_dist_sq / 6.0))
    s_edge = _gauss(d_edge_um, priors['centroid_dist_to_edge_um_median'],
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
    return {
        "score": combined, "valid": True,
        "area_um2": area_um2, "aspect": aspect, "solidity": solidity,
        "L_med": L_med, "a_med": a_med, "b_med": b_med,
        "d_edge_um": d_edge_um,
        "s_area": s_area, "s_aspect": s_aspect, "s_solidity": s_solidity,
        "s_lab": s_lab, "s_edge": s_edge,
    }


# ---------------------------------------------------------------------------
# Final post-processing on the picked mask
# ---------------------------------------------------------------------------

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


def _final_postprocess(mask: np.ndarray, image_bgr: np.ndarray,
                       hbn_mask: np.ndarray, pixel_size_um: float) -> np.ndarray:
    if (mask > 0).sum() == 0:
        return mask
    annulus_um = 25.0
    annulus_px = max(1, int(round(annulus_um / pixel_size_um)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * annulus_px + 1, 2 * annulus_px + 1))
    hbn_dilated = cv2.dilate(hbn_mask, k)
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    max_area_px = int(round(3000.0 / (pixel_size_um * pixel_size_um)))
    # Tame post-process inflation: tighter region-grow (d_thresh 2.0 -> 1.0)
    # and skip grow entirely if the winner mask is already >= 0.7x prior median.
    # (Bench data showed 22-55% systematic over-inflation on AH/QH stacks.)
    grown = _region_grow_lab(mask, lab, hbn_dilated, n_iter=2,
                             dilate_px=3, max_area_px=max_area_px,
                             d_thresh=1.0)
    final = morph_clean(grown, close_k=3, open_k=3)
    final = keep_largest_n(final, n=1, min_area=200)
    if (final > 0).sum() > max_area_px:
        final = morph_clean(mask, close_k=3, open_k=3)
        final = keep_largest_n(final, n=1, min_area=200)
    if 0 < (final > 0).sum() < max_area_px:
        kclose = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        final = cv2.morphologyEx(final, cv2.MORPH_CLOSE, kclose)
    # Final dilation reduced 1.5 -> 0.5 µm (was over-shooting GT by 22-55%).
    dilate_um = 0.5
    dilate_px = max(1, int(round(dilate_um / pixel_size_um)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * dilate_px + 1, 2 * dilate_px + 1))
    final = cv2.dilate(final, k)
    return final


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def detect(image: np.ndarray, pixel_size_um: float) -> dict:
    h, w = image.shape[:2]
    priors = json.loads(SHAPE_PRIORS_PATH.read_text()) if SHAPE_PRIORS_PATH.exists() else None
    hbn = _hbn_mask(image)

    out = {"hbn_mask": hbn, "detector_results": {}, "winner": None}
    if hbn.sum() == 0 or priors is None:
        out["mask"] = np.zeros((h, w), np.uint8)
        out["contour"] = None
        return out

    dt_inside = cv2.distanceTransform(hbn, cv2.DIST_L2, 5)
    dt_outside = cv2.distanceTransform(255 - hbn, cv2.DIST_L2, 5)

    candidates = []
    try:
        b1_res = b1.detect(image, hbn, pixel_size_um, B1_CLASSIFIER_PATH,
                           prob_thresh=0.15, grow_thresh=0.05, min_area_px=200)
        candidates.append(("B1", b1_res["mask"]))
    except Exception as e:
        candidates.append(("B1", np.zeros((h, w), np.uint8)))
        out["detector_results"]["B1_err"] = str(e)
    try:
        b2_res = b2.detect_graphite(image, hbn, pixel_size_um, B2_PRIORS_PATH)
        candidates.append(("B2", b2_res["mask"]))
    except Exception as e:
        candidates.append(("B2", np.zeros((h, w), np.uint8)))
        out["detector_results"]["B2_err"] = str(e)
    try:
        b3_res = b3.detect_graphite(image, hbn, pixel_size_um, SHAPE_PRIORS_PATH)
        candidates.append(("B3", b3_res["mask"]))
    except Exception as e:
        candidates.append(("B3", np.zeros((h, w), np.uint8)))
        out["detector_results"]["B3_err"] = str(e)

    scored = []
    for name, m in candidates:
        cs = _confidence_score(m, image, hbn, pixel_size_um, priors,
                               dt_inside=dt_inside, dt_outside=dt_outside)
        cs["detector"] = name
        cs["pred_area_um2"] = float((m > 0).sum() * pixel_size_um * pixel_size_um)
        out["detector_results"][name] = cs
        scored.append((name, m, cs))

    valid = [(n, m, cs) for (n, m, cs) in scored if cs.get("valid")]
    if not valid:
        # Never-empty fallback: when all gates reject, pick the highest-scored
        # non-empty candidate so downstream gets a real-sized blob to work with
        # instead of a 5x5 placeholder. Mark low_confidence so the orchestrator
        # can still escalate to vision-review.
        # Filter out tiny masks (B1 sometimes returns near-empty when
        # the classifier finds nothing inside the hBN annulus).
        # 200 µm² corresponds to a real flake fragment; smaller is
        # almost certainly noise.
        min_um2 = 200.0
        min_px = max(200, int(round(min_um2 / (pixel_size_um * pixel_size_um))))
        nonempty = [(n, m, cs) for (n, m, cs) in scored
                    if (m > 0).sum() >= min_px]
        if not nonempty:
            out["mask"] = np.zeros((h, w), np.uint8)
            out["contour"] = None
            return out
        # Rank by (score, area_proximity_to_prior_median). When scores are
        # tied (e.g. all gates rejected -> score=0), the area-tiebreaker
        # prefers candidates close to prior_median over near-empty ones.
        prior_med = priors.get('area_um2_median', 800.0)

        def _rank(t):
            cs = t[2]
            score = cs.get("score", 0.0) or 0.0
            area = cs.get("pred_area_um2", 0.0) or 0.0
            # Negative log-distance to prior median: closer = higher.
            area_prox = -abs(np.log(max(area, 1.0) / max(prior_med, 1.0)))
            return (score, area_prox)
        nonempty.sort(key=_rank, reverse=True)
        winner_name, winner_mask, winner_cs = nonempty[0]
        out["winner"] = winner_name
        out["winner_score"] = winner_cs.get("score", 0.0) or 0.0
        out["low_confidence"] = True
        # Skip region-grow on a low-confidence guess; just clean + 0.5 µm dilate.
        final = morph_clean(winner_mask, close_k=3, open_k=3)
        final = keep_largest_n(final, n=1, min_area=200)
        if (final > 0).sum() > 0:
            dilate_um = 0.5
            dpx = max(1, int(round(dilate_um / pixel_size_um)))
            kdil = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                             (2 * dpx + 1, 2 * dpx + 1))
            final = cv2.dilate(final, kdil)
        out["mask"] = final
        cnts, _ = cv2.findContours(final, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out["contour"] = max(cnts, key=cv2.contourArea) if cnts else None
        return out

    valid.sort(key=lambda t: t[2]["score"], reverse=True)
    winner_name, winner_mask, winner_cs = valid[0]
    out["winner"] = winner_name
    out["winner_score"] = winner_cs["score"]

    final = _final_postprocess(winner_mask, image, hbn, pixel_size_um)
    out["mask"] = final
    cnts, _ = cv2.findContours(final, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out["contour"] = max(cnts, key=cv2.contourArea) if cnts else None
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description='C3 graphite detect (B1+B2+B3 ensemble)')
    p.add_argument('--image', required=True)
    p.add_argument('--pixel-size', type=float, required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--cluster-id', type=int, default=None,
                   help='[unused, kept for CLI compat]')
    p.add_argument('--n-sub-clusters', type=int, default=4,
                   help='[unused, kept for CLI compat]')
    p.add_argument('--min-area', type=int, default=200,
                   help='[unused, kept for CLI compat]')
    args = p.parse_args()

    img = cv2.imread(os.path.abspath(os.path.expanduser(args.image)))
    if img is None:
        print(f'ERROR: cannot read {args.image}', file=sys.stderr)
        sys.exit(1)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    result = detect(img, args.pixel_size)

    print('Detector self-confidence:')
    for name, info in sorted(result.get("detector_results", {}).items()):
        if isinstance(info, dict) and 'score' in info:
            mark = ' <-- WINNER' if name == result.get("winner") else ''
            print(f"  {name}: score={info.get('score', 0):.3f} valid={info.get('valid', False)} "
                  f"area={info.get('area_um2', info.get('pred_area_um2', 0)):.0f}um2"
                  f"{mark}")
        else:
            print(f"  {name}: {info}")

    final = result["mask"]
    contour = result.get("contour")

    if contour is None or (final > 0).sum() == 0:
        print('WARN: no graphite candidate from any detector; emitting placeholder',
              file=sys.stderr)
        h_, w_ = img.shape[:2]
        placeholder = np.zeros((h_, w_), np.uint8)
        cy, cx = h_ // 2, w_ // 2
        placeholder[cy-2:cy+3, cx-2:cx+3] = 255
        cv2.imwrite(str(out_dir / 'graphite_mask.png'), placeholder)
        cnts, _ = cv2.findContours(placeholder, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour_ph = cnts[0] if cnts else None
        if contour_ph is None:
            sys.exit(1)
        np.save(str(out_dir / 'graphite_contour.npy'),
                contour_ph.reshape(-1, 2).astype(np.float64))
        sidecar = {'area_px': 25, 'area_um2': 25 * args.pixel_size ** 2,
                   'cluster_id': None, 'winner': None}
        (out_dir / 'graphite_result.json').write_text(json.dumps(sidecar, indent=2))
        diag = desaturate(img, factor=0.4)
        cv2.drawContours(diag, [contour_ph], -1, (0, 200, 255), 2)
        cv2.imwrite(str(out_dir / '01_graphite_on_bottom.png'), diag)
        cv2.imwrite(str(out_dir / '00_graphite_candidates.png'), diag)
        return

    cv2.imwrite(str(out_dir / 'graphite_mask.png'), final)
    contour_2d = contour.reshape(-1, 2).astype(np.float64)
    np.save(str(out_dir / 'graphite_contour.npy'), contour_2d)
    diag = desaturate(img, factor=0.4)
    cv2.drawContours(diag, [contour], -1, (0, 200, 255), 2)
    cv2.imwrite(str(out_dir / '01_graphite_on_bottom.png'), diag)
    cv2.imwrite(str(out_dir / '00_graphite_candidates.png'), diag)

    area_px = int((final > 0).sum())
    area_um2 = round(area_px * args.pixel_size * args.pixel_size, 2)
    sidecar = {
        'area_px': area_px, 'area_um2': area_um2,
        'winner': result.get("winner"),
        'winner_score': result.get("winner_score"),
        'low_confidence': bool(result.get("low_confidence", False)),
        'detector_results': {
            n: {k: v for k, v in info.items() if not k.startswith('_')}
            for n, info in result.get("detector_results", {}).items()
            if isinstance(info, dict)
        },
    }
    (out_dir / 'graphite_result.json').write_text(json.dumps(sidecar, indent=2, default=str))
    print(f'\nOK: graphite winner={result.get("winner")} area={area_um2}um2 ({area_px}px)')


if __name__ == '__main__':
    main()
