"""B3: shape-template + multi-threshold sweep + connected-component scoring.

Adaptive pipeline (no GT-fitted parameters):

  1. Build a search annulus around the host mask whose radius equals
     int(median_host_chamfer_um) derived from the host distance transform.
  2. Infer contrast polarity per image via threshold_multiotsu(classes=3) on
     in-annulus L-channel pixels.  Both bright-mode and dark-mode candidate
     masks are generated and scored; the higher-scoring polarity wins.
  3. Area gates are host-fraction-derived: [AREA_MIN_FRAC, AREA_MAX_FRAC] ×
     host_area_um².  No fixed um² window.
  4. Score each CC by five sub-features (area, aspect, solidity, rel_L,
     edge-distance).  Weights are computed as 1/variance of each sub-score
     over the candidate pool (high-variance sub-scores discriminate better).
     Falls back to equal weights when fewer than MIN_CANDIDATES candidates
     are available.
  5. Region-grow best candidate in LAB space.
  6. Final close via _kernel_from_um(radius_um=CLOSE_RADIUS_UM).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import morph_clean, flood_fill_holes, keep_largest_n, _kernel_from_um  # noqa: E402

# ---------------------------------------------------------------------------
# Named constants — all physical, no GT-fitted values
# ---------------------------------------------------------------------------

AREA_MIN_FRAC = 0.0005   # 0.05% of host area
AREA_MAX_FRAC = 0.25     # 25%  of host area
AREA_MIN_ABS_PX = 30     # hard floor to discard single-pixel noise
CLOSE_RADIUS_UM = 3.0    # physical radius for final morphology close
MIN_CANDIDATES = 3       # minimum candidate count before variance weighting
N_SWEEP = 8              # number of threshold levels per polarity
REGION_GROW_MIN_PX = 5   # minimum CC size before region-grow is attempted
VARIANCE_FLOOR = 1e-12   # replace zero variance to avoid division by zero

try:
    from skimage.filters import threshold_multiotsu as _threshold_multiotsu
    _HAS_SKIMAGE = True
except ImportError:  # pragma: no cover
    _HAS_SKIMAGE = False


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _multiotsu_thresholds(vals: np.ndarray, classes: int = 3):
    """Return (t_low, t_high) from multiotsu; fall back to ±1σ."""
    if _HAS_SKIMAGE and len(vals) >= classes * 10:
        try:
            thr = _threshold_multiotsu(vals.astype(np.float32), classes=classes)
            return float(thr[0]), float(thr[1])
        except Exception:
            pass
    sigma = max(float(np.std(vals)), 5.0)
    mu = float(np.mean(vals))
    return mu - sigma, mu + sigma


def _region_grow_lab(base_mask: np.ndarray, lab_image: np.ndarray,
                      region_mask: np.ndarray, n_iter: int = 2,
                      dilate_px: int = 3, max_area_px: int | None = None,
                      d_thresh: float = 2.0) -> np.ndarray:
    cur = base_mask.copy()
    init_area = (cur > 0).sum()
    cap = max_area_px if max_area_px is not None else int(2.5 * max(init_area, 1))
    for _ in range(n_iter):
        pix = lab_image[cur > 0].astype(np.float32)
        if len(pix) < REGION_GROW_MIN_PX:
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


def _variance_weights(sub_scores_list: list[list[float]]) -> np.ndarray:
    """Compute weights as 1/variance (normalised) over candidate pool.

    Falls back to equal weights when fewer than MIN_CANDIDATES candidates
    exist or when any sub-score has zero variance (all identical).
    """
    n = len(sub_scores_list[0]) if sub_scores_list else 0
    n_feat = len(sub_scores_list)
    if n < MIN_CANDIDATES or n_feat == 0:
        return np.ones(n_feat, dtype=np.float64) / max(n_feat, 1)
    variances = np.array([float(np.var(s)) for s in sub_scores_list],
                         dtype=np.float64)
    # Replace zero variance with a small epsilon so equal-variance features
    # still receive some weight rather than inf.
    variances = np.where(variances < VARIANCE_FLOOR, VARIANCE_FLOOR, variances)
    inv_var = 1.0 / variances
    return inv_var / inv_var.sum()


def _score_cc_pool(cc_records: list[dict]) -> list[dict]:
    """Attach a combined score to each cc_record using per-image variance weights.

    Sub-features scored as z-score proximity (converted to [0,1] via exp):
        s_area       — area_um2 relative to pool median
        s_aspect     — aspect ratio relative to pool median
        s_solidity   — solidity relative to pool median
        s_rel_L      — signed_contrast (rel_L median of CC relative to annulus L)
                       scored as absolute value (larger contrast = higher score)
        s_edge       — centroid distance-to-edge (in um) relative to pool median

    Polarity-specific: cc_records already contain only one polarity's CCs.
    """
    if not cc_records:
        return cc_records

    def _pool(key):
        return [r[key] for r in cc_records]

    def _zscore_score(vals: list[float]) -> list[float]:
        arr = np.array(vals, dtype=np.float64)
        mu = float(np.median(arr))
        sd = max(float(np.std(arr)), 1e-6)
        return [float(np.exp(-((v - mu) ** 2) / (2 * sd ** 2))) for v in vals]

    s_area = _zscore_score(_pool('area_um2'))
    s_aspect = _zscore_score(_pool('aspect'))
    s_solidity = _zscore_score(_pool('solidity'))
    # rel_L: reward higher absolute contrast
    rel_L_vals = _pool('rel_L')
    abs_rel = [abs(v) for v in rel_L_vals]
    s_rel_L = _zscore_score(abs_rel)
    s_edge = _zscore_score(_pool('d_edge_um'))

    weights = _variance_weights([s_area, s_aspect, s_solidity, s_rel_L, s_edge])

    for i, rec in enumerate(cc_records):
        sub = np.array([s_area[i], s_aspect[i], s_solidity[i],
                        s_rel_L[i], s_edge[i]], dtype=np.float64)
        rec['score'] = float(np.dot(weights, sub))
    return cc_records


def _extract_ccs(source_mask: np.ndarray, host_mask: np.ndarray,
                 lab: np.ndarray, L: np.ndarray, annulus_L_median: float,
                 dt_inside: np.ndarray, dt_outside: np.ndarray,
                 pixel_size_um: float, min_area_px: int, max_area_px: int,
                 ) -> list[dict]:
    """Extract connected-component feature records from a binary threshold mask."""
    h, w = host_mask.shape[:2]
    nl, lab_arr, st_arr, _ = cv2.connectedComponentsWithStats(
        source_mask, connectivity=8)
    records = []
    for lab_idx in range(1, nl):
        area_px = int(st_arr[lab_idx, cv2.CC_STAT_AREA])
        if area_px < min_area_px or area_px > max_area_px:
            continue
        cc_mask = (lab_arr == lab_idx).astype(np.uint8) * 255
        cnts, _ = cv2.findContours(cc_mask, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
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
        rel_L = L_med - annulus_L_median   # signed contrast vs host L median
        M = cv2.moments(cc_mask, binaryImage=True)
        if M['m00'] < 1:
            continue
        cx = M['m10'] / M['m00']
        cy = M['m01'] / M['m00']
        cxi = int(np.clip(round(cx), 0, w - 1))
        cyi = int(np.clip(round(cy), 0, h - 1))
        if host_mask[cyi, cxi] > 0:
            d_edge_um = float(dt_inside[cyi, cxi]) * pixel_size_um
        else:
            d_edge_um = -float(dt_outside[cyi, cxi]) * pixel_size_um
        area_um2 = area_px * pixel_size_um * pixel_size_um
        records.append({
            'area_um2': area_um2,
            'aspect': aspect,
            'solidity': solidity,
            'rel_L': rel_L,
            'd_edge_um': d_edge_um,
            '_cc_mask': cc_mask,
        })
    return records


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def detect_graphite(image: np.ndarray, hbn_mask: np.ndarray,
                    pixel_size_um: float,
                    priors_path: Path | None = None) -> dict:
    """B3 graphite detector.

    Args:
        image: BGR uint8 image.
        hbn_mask: Binary uint8 host (hBN) mask.
        pixel_size_um: Physical pixel size in micrometres.
        priors_path: Ignored — retained only for call-site compatibility.

    Returns:
        {'mask': final uint8 mask, 'best_score': float}
    """
    h, w = image.shape[:2]
    if hbn_mask.sum() == 0:
        return {"mask": np.zeros((h, w), np.uint8)}

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)

    # --- Adaptive annulus radius from host distance transform ---------------
    dt_host = cv2.distanceTransform(hbn_mask, cv2.DIST_L2, 5)
    host_chamfer_vals = dt_host[hbn_mask > 0]
    median_host_chamfer_um = float(np.median(host_chamfer_vals)) * pixel_size_um
    annulus_um = max(1.0, float(int(median_host_chamfer_um)))
    annulus_px = int(round(annulus_um / pixel_size_um))
    k_ann = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                      (2 * annulus_px + 1, 2 * annulus_px + 1))
    hbn_dilated = cv2.dilate(hbn_mask, k_ann)

    # --- Host-fraction area gates -------------------------------------------
    host_area_px = int((hbn_mask > 0).sum())
    host_area_um2 = host_area_px * pixel_size_um * pixel_size_um
    min_area_px = max(AREA_MIN_ABS_PX,
                      int(round(AREA_MIN_FRAC * host_area_um2
                                / (pixel_size_um * pixel_size_um))))
    max_area_px = int(round(AREA_MAX_FRAC * host_area_um2
                            / (pixel_size_um * pixel_size_um)))
    if max_area_px < min_area_px:
        max_area_px = min_area_px * 10

    # --- Infer contrast polarity (both bright and dark modes) ---------------
    annulus_L_vals = L[hbn_dilated > 0].astype(np.float32)
    annulus_L_median = float(np.median(annulus_L_vals))
    t_low, t_high = _multiotsu_thresholds(annulus_L_vals, classes=3)

    # Distance transforms for d_edge scoring.
    dt_inside = cv2.distanceTransform(hbn_mask, cv2.DIST_L2, 5)
    dt_outside = cv2.distanceTransform(255 - hbn_mask, cv2.DIST_L2, 5)

    # --- Sweep thresholds for dark polarity and bright polarity -------------
    dark_lo = min(t_low, annulus_L_median - 5.0)
    dark_hi = t_low + 5.0
    bright_lo = t_high - 5.0
    bright_hi = max(t_high, annulus_L_median + 5.0)

    all_cc_records: list[list[dict]] = []  # one list per sweep mask

    for thr in np.linspace(dark_lo, dark_hi, N_SWEEP):
        candidate = (L < thr).astype(np.uint8) * 255
        candidate = cv2.bitwise_and(candidate, hbn_dilated)
        candidate = morph_clean(candidate, close_k=5, open_k=3)
        if (candidate > 0).sum() == 0:
            continue
        recs = _extract_ccs(candidate, hbn_mask, lab, L, annulus_L_median,
                             dt_inside, dt_outside, pixel_size_um,
                             min_area_px, max_area_px)
        all_cc_records.extend(recs)

    bright_recs: list[dict] = []
    for thr in np.linspace(bright_lo, bright_hi, N_SWEEP):
        candidate = (L > thr).astype(np.uint8) * 255
        candidate = cv2.bitwise_and(candidate, hbn_dilated)
        candidate = morph_clean(candidate, close_k=5, open_k=3)
        if (candidate > 0).sum() == 0:
            continue
        recs = _extract_ccs(candidate, hbn_mask, lab, L, annulus_L_median,
                             dt_inside, dt_outside, pixel_size_um,
                             min_area_px, max_area_px)
        bright_recs.extend(recs)

    # Score each polarity independently then pick polarity with best top score.
    dark_scored = _score_cc_pool(all_cc_records)
    bright_scored = _score_cc_pool(bright_recs)

    best_dark = max(dark_scored, key=lambda r: r['score']) if dark_scored else None
    best_bright = max(bright_scored, key=lambda r: r['score']) if bright_scored else None

    if best_dark is None and best_bright is None:
        return {"mask": np.zeros((h, w), np.uint8)}

    if best_dark is None:
        best_rec = best_bright
    elif best_bright is None:
        best_rec = best_dark
    elif best_bright['score'] >= best_dark['score']:
        best_rec = best_bright
    else:
        best_rec = best_dark

    best_mask = best_rec['_cc_mask']

    # --- Region grow + final close ------------------------------------------
    grow_mask = _region_grow_lab(best_mask, lab, hbn_dilated, n_iter=2,
                                  dilate_px=3, max_area_px=max_area_px,
                                  d_thresh=2.0)
    kclose = _kernel_from_um(radius_um=CLOSE_RADIUS_UM,
                             pixel_size_um=pixel_size_um, ellipse=True)
    final = cv2.morphologyEx(grow_mask, cv2.MORPH_CLOSE, kclose)
    final = morph_clean(final, close_k=3, open_k=3)
    final = keep_largest_n(final, n=1, min_area=AREA_MIN_ABS_PX)
    if (final > 0).sum() > max_area_px:
        final = morph_clean(best_mask.copy(), close_k=3, open_k=3)
        final = keep_largest_n(final, n=1, min_area=AREA_MIN_ABS_PX)
    return {"mask": final, "best_score": best_rec['score']}


def detect_graphene(image: np.ndarray, flake_mask: np.ndarray,
                    pixel_size_um: float,
                    priors_path: Path | None = None) -> dict:
    """B3 graphene detector.

    Args:
        image: BGR uint8 image.
        flake_mask: Binary uint8 host flake mask.
        pixel_size_um: Physical pixel size in micrometres.
        priors_path: Ignored — retained only for call-site compatibility.

    Returns:
        {'mask': final uint8 mask, 'best_score': float}
    """
    h, w = image.shape[:2]
    if flake_mask.sum() == 0:
        return {"mask": np.zeros((h, w), np.uint8)}

    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)

    # --- Host-fraction area gates -------------------------------------------
    host_area_px = int((flake_mask > 0).sum())
    host_area_um2 = host_area_px * pixel_size_um * pixel_size_um
    min_area_px = max(AREA_MIN_ABS_PX,
                      int(round(AREA_MIN_FRAC * host_area_um2
                                / (pixel_size_um * pixel_size_um))))
    max_area_px = int(round(AREA_MAX_FRAC * host_area_um2
                            / (pixel_size_um * pixel_size_um)))
    if max_area_px < min_area_px:
        max_area_px = min_area_px * 10

    # --- Infer contrast polarity (both bright and dark) ---------------------
    flake_L_vals = L[flake_mask > 0].astype(np.float32)
    flake_L_median = float(np.median(flake_L_vals))
    t_low, t_high = _multiotsu_thresholds(flake_L_vals, classes=3)

    dt_inside = cv2.distanceTransform(flake_mask, cv2.DIST_L2, 5)
    dt_outside = cv2.distanceTransform(255 - flake_mask, cv2.DIST_L2, 5)

    # --- Threshold sweep for bright and dark polarity -----------------------
    bright_lo = t_high - 5.0
    bright_hi = max(t_high, flake_L_median + 5.0)
    dark_lo = min(t_low, flake_L_median - 5.0)
    dark_hi = t_low + 5.0

    all_bright: list[dict] = []
    for thr in np.linspace(bright_lo, bright_hi, N_SWEEP):
        candidate = (L > thr).astype(np.uint8) * 255
        candidate = cv2.bitwise_and(candidate, flake_mask)
        candidate = morph_clean(candidate, close_k=7, open_k=3)
        if (candidate > 0).sum() == 0:
            continue
        recs = _extract_ccs(candidate, flake_mask, lab, L, flake_L_median,
                             dt_inside, dt_outside, pixel_size_um,
                             min_area_px, max_area_px)
        all_bright.extend(recs)

    all_dark: list[dict] = []
    for thr in np.linspace(dark_lo, dark_hi, N_SWEEP):
        candidate = (L < thr).astype(np.uint8) * 255
        candidate = cv2.bitwise_and(candidate, flake_mask)
        candidate = morph_clean(candidate, close_k=7, open_k=3)
        if (candidate > 0).sum() == 0:
            continue
        recs = _extract_ccs(candidate, flake_mask, lab, L, flake_L_median,
                             dt_inside, dt_outside, pixel_size_um,
                             min_area_px, max_area_px)
        all_dark.extend(recs)

    bright_scored = _score_cc_pool(all_bright)
    dark_scored = _score_cc_pool(all_dark)

    best_bright = max(bright_scored, key=lambda r: r['score']) if bright_scored else None
    best_dark = max(dark_scored, key=lambda r: r['score']) if dark_scored else None

    if best_bright is None and best_dark is None:
        return {"mask": np.zeros((h, w), np.uint8)}

    if best_bright is None:
        best_rec = best_dark
    elif best_dark is None:
        best_rec = best_bright
    elif best_bright['score'] >= best_dark['score']:
        best_rec = best_bright
    else:
        best_rec = best_dark

    best_mask = best_rec['_cc_mask']

    kclose = _kernel_from_um(radius_um=CLOSE_RADIUS_UM,
                             pixel_size_um=pixel_size_um, ellipse=True)
    final = cv2.morphologyEx(best_mask, cv2.MORPH_CLOSE, kclose)
    final = morph_clean(final, close_k=11, open_k=5)
    final = keep_largest_n(final, n=1, min_area=AREA_MIN_ABS_PX)
    final = flood_fill_holes(final)
    return {"mask": final, "best_score": best_rec['score']}
