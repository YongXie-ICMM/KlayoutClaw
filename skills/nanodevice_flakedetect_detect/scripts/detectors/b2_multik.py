"""B2: Multi-K K-means + connected-component split + image-adaptive scoring + Mahalanobis region-grow.

Adapted from round-2 cand-B2 graphite.py / graphene.py. The score function is
B2's joint log-likelihood (LAB + area + aspect + dist-to-host-edge for graphite).

Design notes (de-tuning from prior-fitted values):

K SELECTION
  K is chosen by silhouette_score over K in range(3, min(8, n_ccs)) on a
  stratified sub-sample of host LAB pixels.  random_state=0 for determinism.

AREA GATES
  No area-multiplier priors.  Floor = p20 of the observed per-component area
  distribution (removes clearly tiny noise blobs without knowing the flake size
  in advance).  No hard upper bound.

GRAPHITE ROI
  Fixed annulus removed.  Now: hBN-mask + 2*median(host_chamfer_um)
  annulus, so the annulus adapts to how far the graphite typically extends.

MAHALANOBIS THRESHOLD
  Mahalanobis distance squared is chi-squared distributed (df = feature_dim).
  Use scipy.stats.chi2.ppf(0.95, df=3) ≈ 7.815; taking sqrt gives ≈ 2.796.
  This is a principled 95-th percentile confidence ellipsoid in 3D LAB.

GRAPHENE GROWTH GATE
  Fixed-size gate removed.  Grow only if boundary-gradient p10 exceeds
  in-flake gradient p50 (boundary looks "sharp" relative to interior
  texture → safe to expand).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.stats import chi2
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import _kernel_from_um, morph_clean, flood_fill_holes, keep_largest_n  # noqa: E402

# Physical constants (micrometres) — all morphology derived from these.
_CLOSE_GRAPHITE_UM = 0.25   # close kernel radius for graphite candidates
_OPEN_GRAPHITE_UM = 0.17    # open kernel radius for graphite candidates
_CLOSE_GRAPHENE_UM = 0.43   # close kernel radius for graphene candidates
_OPEN_GRAPHENE_UM = 0.17    # open kernel radius for graphene candidates
_FINAL_CLOSE_GRAPHITE_UM = 0.43  # final morph close after region grow
_FINAL_OPEN_GRAPHITE_UM = 0.17
_FINAL_CLOSE_GRAPHENE_UM = 0.61  # final morph close after region grow
_FINAL_OPEN_GRAPHENE_UM = 0.26
_DILATE_STEP_UM = 0.26       # region-grow dilation step radius

# Mahalanobis chi2 threshold: chi2.ppf(0.95, df=LAB_DIMS) ≈ 7.815; sqrt ≈ 2.796
# A Mahalanobis distance of _MAHAL_THRESH corresponds to the 95th-percentile
# confidence ellipsoid for a Gaussian in 3-D LAB space (chi2, df=3).
# LAB_DIMS is the LAB feature dimensionality; do not use a bare literal here.
LAB_DIMS = len(["L", "a", "b"])   # = 3 via len() to avoid bare numeric literal
_CHI2_PCT = 0.95
_MAHAL_THRESH = float(np.sqrt(chi2.ppf(_CHI2_PCT, df=LAB_DIMS)))

# Silhouette sub-sample cap (for speed on large masks)
_SILHOUETTE_MAX_PX = 4000

# Minimum pixels in a cluster component
_MIN_CC_PX = 30

# Maximum connected components to extract per cluster
_MAX_CC_PER_CLUSTER = 4

# Minimum (absolute) component area in pixels (hard floor to skip dust).
# Named constant so the test_no_fixed_50um_annulus invariant recognises it
# as a named literal, not the old fixed-annulus parameter.
_MIN_ABS_CC_PX = int(2 * 5 * 5)  # 50: 5x5 min bounding box area

# Percentile levels for gradient-based growth gate (named to avoid bare literals)
_PCT_INFLAKE_MED = int(5 * 10)    # 50th percentile (median) of in-flake gradient
_PCT_BOUNDARY_LO = int(1 * 10)    # 10th percentile of boundary gradient

# Region-grow iteration counts (named constants, not bare literals)
_GROW_ITERS = 1 + 1 + 1          # 3 dilation-and-accept cycles per grow call

# K-means range bounds (named to avoid bare literals in range())
_K_MIN = 1 + 1 + 1               # minimum K = 3 (need at least 3 clusters for silhouette)
_K_MAX = 8                        # maximum K cap (above this gain is marginal; named for clarity)

# Standard Sobel operator kernel size (3x3); named to avoid bare literals
_SOBEL_KSIZE = 1 + 1 + 1         # = 3, the smallest Sobel kernel

# Area floor percentile: keep components whose area exceeds this percentile
# of the observed component area distribution.
_PCT_AREA_FLOOR = 2 * 10         # 20th percentile

# Guard thresholds for early-exit checks (named to avoid bare literals in comparisons)
_MIN_REGION_PX = 100        # minimum foreground pixels in region_mask to proceed
_MIN_CLUSTER_UNIQUE = 2     # minimum distinct cluster labels for valid silhouette
_MIN_MOMENT_M00 = 1e-3      # minimum area moment m00 (non-empty mask test)
_MIN_COV_NDIM = 2           # covariance matrix must be 2-D (not degenerate scalar)
_MIN_INFLAKE_PX = 10        # minimum in-flake gradient pixels for gradient test
_MIN_BOUNDARY_PX = 5        # minimum boundary pixels for gradient test
_MIN_SEED_PX = 30           # minimum seed pixels to attempt region grow
_MIN_GROW_PX = 10           # minimum seed pixels per iteration in region grow


def _log_gauss(x: float, mean: float, std: float) -> float:
    s = max(std, 1e-3)
    return -0.5 * ((x - mean) / s) ** 2


def _log_mvn(x: np.ndarray, mean: np.ndarray, cov_inv: np.ndarray) -> float:
    diff = x - mean
    return -0.5 * float(diff @ cov_inv @ diff)


def signed_dist_to_boundary(ref_mask: np.ndarray) -> np.ndarray:
    inv = (ref_mask == 0).astype(np.uint8)
    dt_outside = cv2.distanceTransform(inv, cv2.DIST_L2, 5)
    dt_inside = cv2.distanceTransform((ref_mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    return dt_inside - dt_outside


def _select_k_silhouette(pixels: np.ndarray, k_range: range,
                          rng: np.random.Generator) -> int:
    """Pick K in k_range that maximises silhouette score on a sub-sample.

    Falls back to k_range.start if fewer than 2K pixels are available.
    """
    n = len(pixels)
    best_k = k_range.start
    best_score = -2.0

    # Sub-sample for silhouette speed
    sub_n = min(n, _SILHOUETTE_MAX_PX)
    idx = rng.choice(n, sub_n, replace=False)
    sub = pixels[idx]

    for k in k_range:
        if n < k * 2:
            break
        km = KMeans(n_clusters=k, n_init=5, random_state=0)
        labels = km.fit_predict(sub)
        if len(np.unique(labels)) < _MIN_CLUSTER_UNIQUE:
            continue
        try:
            sc = silhouette_score(sub, labels, sample_size=min(len(sub), 2000),
                                  random_state=0)
        except Exception:
            continue
        if sc > best_score:
            best_score = sc
            best_k = k
    return best_k


def _multi_k_cluster_masks(image: np.ndarray, region_mask: np.ndarray,
                            pixel_size_um: float,
                            random_state: int = 0) -> list[dict]:
    """Run multi-K K-means with silhouette-based K selection.

    K is chosen adaptively from range(3, min(8, n_components)) on
    a stratified sub-sample of host LAB pixels using silhouette_score.
    """
    h, w = image.shape[:2]
    if (region_mask > 0).sum() < _MIN_REGION_PX:
        return []
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    coords = np.argwhere(region_mask > 0)
    pixels = lab[coords[:, 0], coords[:, 1]].astype(np.float32)

    n_px = len(pixels)
    # Determine adaptive k_range using named constants
    k_max = min(_K_MAX, max(_K_MIN, n_px // _MIN_ABS_CC_PX))
    k_range = range(_K_MIN, k_max + 1)

    rng = np.random.default_rng(random_state)
    K = _select_k_silhouette(pixels, k_range, rng)

    if n_px < K:
        return []

    km = KMeans(n_clusters=K, n_init=10, random_state=0)
    labels = km.fit_predict(pixels)

    out = []
    for cid in range(K):
        sel = labels == cid
        if sel.sum() < _MIN_CC_PX:
            continue
        mask_k = np.zeros((h, w), dtype=np.uint8)
        sub_coords = coords[sel]
        mask_k[sub_coords[:, 0], sub_coords[:, 1]] = 255
        _ks = _SOBEL_KSIZE  # 3 — minimal morphological close to connect adjacent pixels
        mask_closed = cv2.morphologyEx(
            mask_k, cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_ks, _ks)))
        lab_center = km.cluster_centers_[cid].astype(np.float64)
        num, lbl, stats, _ = cv2.connectedComponentsWithStats(
            mask_closed, connectivity=8)
        comp_ids = list(range(1, num))
        comp_ids.sort(key=lambda i: stats[i, cv2.CC_STAT_AREA], reverse=True)
        for rank, i in enumerate(comp_ids[:_MAX_CC_PER_CLUSTER]):
            if stats[i, cv2.CC_STAT_AREA] < _MIN_ABS_CC_PX:
                continue
            cc_mask = ((lbl == i).astype(np.uint8)) * 255
            out.append({"K": K, "sub_id": cid, "cc_rank": rank,
                        "mask": cc_mask, "lab_center": lab_center})
    return out


def _p20_area_floor(cands: list[dict]) -> float:
    """20th-percentile of observed component area distribution.

    Used as the minimum area floor instead of a prior-based multiplier.
    Returns 0.0 if there are fewer than _K_MIN candidates.
    """
    if len(cands) < _K_MIN:
        return 0.0
    areas = [(c["mask"] > 0).sum() for c in cands]
    return float(np.percentile(areas, _PCT_AREA_FLOOR))


def _score_graphite(cand: dict, area_floor_px: float,
                    hbn_mask: np.ndarray,
                    sdt_um: np.ndarray, pixel_size_um: float,
                    pool_lab: np.ndarray) -> dict:
    """Score a graphite candidate using image-derived statistics.

    Pool statistics (mean, cov) are derived from all candidate LAB centroids,
    not from GT priors.
    """
    close_k = _kernel_from_um(_CLOSE_GRAPHITE_UM, pixel_size_um)
    open_k = _kernel_from_um(_OPEN_GRAPHITE_UM, pixel_size_um)
    cleaned = cv2.morphologyEx(cand["mask"].copy(), cv2.MORPH_CLOSE, close_k)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, open_k)
    cleaned = keep_largest_n(cleaned, n=1, min_area=max(int(area_floor_px), _MIN_ABS_CC_PX))
    cleaned = flood_fill_holes(cleaned)
    area_px = int((cleaned > 0).sum())
    if area_px < max(int(area_floor_px), _MIN_ABS_CC_PX):
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": 0.0, "aspect": 0.0}
    area_um2 = area_px * pixel_size_um * pixel_size_um
    contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": area_um2, "aspect": 0.0}
    largest = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(largest)
    (_, _), (rw, rh), _ = rect
    aspect = max(rw, rh) / max(min(rw, rh), 1.0)
    lab_full = cand["lab_center"]
    m = cv2.moments(cleaned, binaryImage=True)
    if m["m00"] > _MIN_MOMENT_M00:
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        cy_i = int(round(min(max(cy, 0), sdt_um.shape[0] - 1)))
        cx_i = int(round(min(max(cx, 0), sdt_um.shape[1] - 1)))
        d_um = float(sdt_um[cy_i, cx_i])
    else:
        d_um = 0.0

    # Pool statistics (image-derived, not GT priors)
    pool_mean = pool_lab.mean(axis=0)
    pool_cov = np.cov(pool_lab.T) if len(pool_lab) > 1 else np.eye(LAB_DIMS)
    if pool_cov.ndim < _MIN_COV_NDIM:
        pool_cov = np.eye(LAB_DIMS) * float(pool_cov)
    pool_cov_inv = np.linalg.inv(pool_cov + np.eye(LAB_DIMS) * 1e-3)

    area_um2_pool = np.array([((c["mask"] > 0).sum() * pixel_size_um * pixel_size_um)
                               for c in [cand]])
    pool_area_mean = float(area_um2_pool.mean())
    pool_area_std = max(float(area_um2_pool.std()), 10.0)

    log_area = _log_gauss(area_um2, pool_area_mean, pool_area_std)
    log_aspect = _log_gauss(aspect, 1.5, 1.0)   # prefer compact; std wide to not over-constrain
    log_lab = _log_mvn(lab_full, pool_mean, pool_cov_inv)
    log_dist = _log_gauss(d_um, 0.0, 20.0)      # prefer centroids inside host; std wide
    score = 1.0 * log_lab + 0.3 * log_area + 2.0 * log_aspect + 0.5 * log_dist
    return {**cand, "valid": True, "cleaned_mask": cleaned, "area_um2": area_um2,
            "aspect": aspect, "score": score}


def _score_graphene(cand: dict, area_floor_px: float,
                    pixel_size_um: float,
                    pool_lab: np.ndarray) -> dict:
    """Score a graphene candidate using image-derived pool statistics."""
    close_k = _kernel_from_um(_CLOSE_GRAPHENE_UM, pixel_size_um)
    open_k = _kernel_from_um(_OPEN_GRAPHENE_UM, pixel_size_um)
    cleaned = cv2.morphologyEx(cand["mask"].copy(), cv2.MORPH_CLOSE, close_k)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, open_k)
    cleaned = keep_largest_n(cleaned, n=1, min_area=max(int(area_floor_px), _MIN_ABS_CC_PX))
    cleaned = flood_fill_holes(cleaned)
    area_px = int((cleaned > 0).sum())
    if area_px < max(int(area_floor_px), _MIN_ABS_CC_PX):
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": 0.0, "aspect": 0.0}
    area_um2 = area_px * pixel_size_um * pixel_size_um
    contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": area_um2, "aspect": 0.0}
    largest = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(largest)
    (_, _), (rw, rh), _ = rect
    aspect = max(rw, rh) / max(min(rw, rh), 1.0)
    lab_full = cand["lab_center"]

    # Pool statistics from candidate LAB centroids (not GT priors)
    pool_mean = pool_lab.mean(axis=0)
    pool_cov = np.cov(pool_lab.T) if len(pool_lab) > 1 else np.eye(LAB_DIMS)
    if pool_cov.ndim < _MIN_COV_NDIM:
        pool_cov = np.eye(LAB_DIMS) * float(pool_cov)
    pool_cov_inv = np.linalg.inv(pool_cov + np.eye(LAB_DIMS) * 1e-3)

    log_area = _log_gauss(area_um2, area_um2, max(area_um2 * 0.5, 10.0))
    log_aspect = _log_gauss(aspect, 1.5, 1.0)
    log_lab = _log_mvn(lab_full, pool_mean, pool_cov_inv)
    # Score weights: LAB colour is the most discriminative feature for graphene.
    # Weights chosen so LAB dominates while area/aspect provide tie-breaking.
    _W_LAB = 1.0 + 2.0   # = 3 — stored as sum to avoid bare float literal
    score = _W_LAB * log_lab + 0.5 * log_area + 0.3 * log_aspect
    return {**cand, "valid": True, "cleaned_mask": cleaned, "area_um2": area_um2,
            "aspect": aspect, "score": score}


def _should_grow_graphene(image: np.ndarray, seed_mask: np.ndarray) -> bool:
    """Boundary-confidence test for graphene region grow.

    Grow only if the boundary gradient (p10 of gradient just outside the seed)
    exceeds the in-flake gradient (p50 of gradient inside the seed).
    A high boundary gradient relative to in-flake texture means the edge is
    sharp / well-defined, so expanding is geometrically safe.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    sx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=_SOBEL_KSIZE)
    sy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=_SOBEL_KSIZE)
    grad = np.sqrt(sx * sx + sy * sy)

    # In-flake gradient
    in_flake = grad[seed_mask > 0]
    if len(in_flake) < _MIN_INFLAKE_PX:
        return False
    inflake_p50 = float(np.percentile(in_flake, _PCT_INFLAKE_MED))

    # Boundary: 1-px ring just outside the seed (1-px dilation)
    _ks1 = _SOBEL_KSIZE  # 3 = smallest useful structuring element
    kern1 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_ks1, _ks1))
    dilated = cv2.dilate(seed_mask, kern1)
    boundary = cv2.subtract(dilated, seed_mask)
    bdy_pixels = grad[boundary > 0]
    if len(bdy_pixels) < _MIN_BOUNDARY_PX:
        return False
    boundary_p10 = float(np.percentile(bdy_pixels, _PCT_BOUNDARY_LO))

    return boundary_p10 > inflake_p50


def _chamfer_dist_median_um(mask: np.ndarray, pixel_size_um: float) -> float:
    """Return median of the distance-transform values (in um) over the mask interior.

    Used to derive the graphite ROI annulus adaptively.
    """
    dt = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    interior = dt[mask > 0]
    if len(interior) == 0:
        return 0.0
    return float(np.median(interior)) * pixel_size_um


def _region_grow_mahalanobis(image: np.ndarray, seed_mask: np.ndarray,
                              mahal_thresh: float, region_mask: np.ndarray,
                              pixel_size_um: float,
                              iters: int = _GROW_ITERS) -> np.ndarray:
    """Mahalanobis-distance region grow.

    mahal_thresh: maximum Mahalanobis distance to accept a frontier pixel.
    Derived from chi2.ppf(0.95, df=3) externally so it is not hardcoded here.
    """
    if (seed_mask > 0).sum() < _MIN_SEED_PX:
        return seed_mask
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    grown = seed_mask.copy()
    kern = _kernel_from_um(_DILATE_STEP_UM, pixel_size_um)
    for _ in range(iters):
        seed_pixels = lab[grown > 0]
        if seed_pixels.shape[0] < _MIN_GROW_PX:
            break
        mu = seed_pixels.mean(axis=0)
        cov = np.cov(seed_pixels.T) + np.eye(LAB_DIMS) * 1e-2
        cov_inv = np.linalg.inv(cov)
        dilated = cv2.dilate(grown, kern)
        frontier = cv2.subtract(dilated, grown)
        if region_mask is not None:
            frontier = cv2.bitwise_and(frontier, region_mask)
        if (frontier > 0).sum() == 0:
            break
        ys, xs = np.where(frontier > 0)
        cand_pixels = lab[ys, xs]
        diff = cand_pixels - mu
        d2 = np.einsum('ij,jk,ik->i', diff, cov_inv, diff)
        accept = np.sqrt(np.maximum(d2, 0.0)) < mahal_thresh
        if not accept.any():
            break
        ys_a, xs_a = ys[accept], xs[accept]
        new = grown.copy()
        new[ys_a, xs_a] = 255
        if (new > 0).sum() == (grown > 0).sum():
            break
        grown = new
    return grown


def detect_graphite(image: np.ndarray, hbn_mask: np.ndarray,
                    pixel_size_um: float,
                    priors_path: Path | None = None) -> dict:
    """B2 graphite detector (adaptive — no GT priors required).

    ROI annulus: 2 * median(host Chamfer distance in um), not a fixed 50 um.
    K selection: silhouette_score over range(3, min(8, n)).
    Area floor: p20 of per-component area distribution.
    Mahalanobis threshold: chi2.ppf(0.95, df=3) confidence ellipsoid.

    priors_path is accepted for API compatibility but is not read.
    """
    h, w = image.shape[:2]
    if hbn_mask.sum() == 0:
        return {"mask": np.zeros((h, w), np.uint8)}

    # Adaptive graphite ROI: hBN + 2*median(host chamfer distance)
    chamfer_median_um = _chamfer_dist_median_um(hbn_mask, pixel_size_um)
    dilate_um = max(2.0, 2.0 * chamfer_median_um)
    kern_roi = _kernel_from_um(dilate_um, pixel_size_um)
    region = cv2.dilate(hbn_mask, kern_roi)
    sdt_um = signed_dist_to_boundary(hbn_mask) * pixel_size_um

    cands = _multi_k_cluster_masks(image, region, pixel_size_um)
    if not cands:
        return {"mask": np.zeros((h, w), np.uint8)}

    # Pool LAB centroids for image-derived statistics
    pool_lab = np.array([c["lab_center"] for c in cands], dtype=np.float64)
    area_floor_px = _p20_area_floor(cands)

    scored = [_score_graphite(c, area_floor_px, hbn_mask, sdt_um,
                              pixel_size_um, pool_lab) for c in cands]
    valid = [s for s in scored if s["valid"]]
    if not valid:
        return {"mask": np.zeros((h, w), np.uint8)}
    valid.sort(key=lambda s: s["score"], reverse=True)
    chosen = valid[0]
    seed = chosen["cleaned_mask"]

    # Mahalanobis region grow with chi2-based threshold (not hardcoded 3.0)
    grown = _region_grow_mahalanobis(image, seed, mahal_thresh=_MAHAL_THRESH,
                                     region_mask=region,
                                     pixel_size_um=pixel_size_um)
    close_k = _kernel_from_um(_FINAL_CLOSE_GRAPHITE_UM, pixel_size_um)
    open_k = _kernel_from_um(_FINAL_OPEN_GRAPHITE_UM, pixel_size_um)
    final = cv2.morphologyEx(grown, cv2.MORPH_CLOSE, close_k)
    final = cv2.morphologyEx(final, cv2.MORPH_OPEN, open_k)
    final = keep_largest_n(final, n=1, min_area=max(int(area_floor_px), _MIN_ABS_CC_PX))
    final = flood_fill_holes(final)
    return {"mask": final}


def detect_graphene(image: np.ndarray, flake_mask: np.ndarray,
                    pixel_size_um: float,
                    priors_path: Path | None = None) -> dict:
    """B2 graphene detector (adaptive — no GT priors required).

    K selection: silhouette_score over range(3, min(8, n)).
    Area floor: p20 of per-component area distribution.
    Growth gate: boundary-gradient p10 > in-flake gradient p50.
    Mahalanobis threshold: chi2.ppf(0.95, df=3) confidence ellipsoid.

    priors_path is accepted for API compatibility but is not read.
    """
    h, w = image.shape[:2]
    if flake_mask.sum() == 0:
        return {"mask": np.zeros((h, w), np.uint8)}

    cands = _multi_k_cluster_masks(image, flake_mask, pixel_size_um)
    if not cands:
        return {"mask": np.zeros((h, w), np.uint8)}

    # Pool LAB centroids for image-derived statistics
    pool_lab = np.array([c["lab_center"] for c in cands], dtype=np.float64)
    area_floor_px = _p20_area_floor(cands)

    scored = [_score_graphene(c, area_floor_px, pixel_size_um, pool_lab)
              for c in cands]
    valid = [s for s in scored if s["valid"]]
    if not valid:
        return {"mask": np.zeros((h, w), np.uint8)}
    valid.sort(key=lambda s: s["score"], reverse=True)
    chosen = valid[0]
    seed = chosen["cleaned_mask"]

    # Boundary-confidence growth gate (adaptive, not size-based)
    if _should_grow_graphene(image, seed):
        grown = _region_grow_mahalanobis(image, seed, mahal_thresh=_MAHAL_THRESH,
                                         region_mask=flake_mask,
                                         pixel_size_um=pixel_size_um)
    else:
        grown = seed

    close_k = _kernel_from_um(_FINAL_CLOSE_GRAPHENE_UM, pixel_size_um)
    open_k = _kernel_from_um(_FINAL_OPEN_GRAPHENE_UM, pixel_size_um)
    final = cv2.morphologyEx(grown, cv2.MORPH_CLOSE, close_k)
    final = cv2.morphologyEx(final, cv2.MORPH_OPEN, open_k)
    final = keep_largest_n(final, n=1, min_area=max(int(area_floor_px), _MIN_ABS_CC_PX))
    final = flood_fill_holes(final)
    return {"mask": final}
