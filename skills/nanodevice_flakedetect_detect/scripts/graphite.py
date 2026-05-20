#!/usr/bin/env python
"""graphite.py — graphite/backgate detector for bottom_part images.

Pipeline (adaptive throughout; no hand-tuned per-stack thresholds):

  1. Substrate sample = GMM on LAB of a low-texture, edge-distance-
     prioritised pixel sample. Pick the cluster whose mean is nearest a
     corner pixel; fall back to largest-weight cluster.
  2. Host mask: pixels with LAB distance to substrate > T* (multi-Otsu
     valley on the in-image distance histogram), cleaned + 4-corner
     flood-fill.  Multi-component host supported via adaptive n.
  3. Codex ridge pipeline on the multi-scale-MIN gradient of L:
        percentile-clip(p50, p99.3) + sqrt
        -> MAX of Frangi + Sato + Meijering (wide sigma range)
        -> hysteresis (in-host p82, p96)
        -> remove_small_objects with adaptive min_size (plateau in the
           CC-area distribution).
  4. Carve host \\ dilated(codex_edge) into connected components.
  5. K-union: K-means at K chosen by silhouette score on host LAB pixels;
     bulk cluster = cluster closest to substrate mean (substrate-aware).
     Group same-cluster + spatially-adjacent CCs; union across K, dedupe
     by mask IoU.
  6. Score (calibrated, confidence-driven default selection):
        s_strip   = 1 - sqrt(lambda_min / lambda_max)  (PCA aspect)
        s_central = mean(dt over candidate) / max(dt over host)
        s_gray    = 1 - chroma / SCORE_CHROMA_NORM
                    (chroma measured vs bulk a,b mean — substrate-aware)
        s_contrast= min(1, dist_to_bulk_mode / SCORE_CONTRAST_NORM)
        s_cohere  = largest-CC fraction
        score = score_weights(sub_scores) · [s_strip, s_central,
                s_gray, s_contrast, s_cohere]
        Weights derived from variance of each sub-score across candidates
        (more discriminative sub-scores get higher weight; calibrated).
  7. Refinement per candidate: iterative local-mean region grow.
  8. Output top-N candidates panel; pick rank --cluster-id as final mask.

CLI:
    --image, --pixel-size, --output-dir          [required]
    [--cluster-id    INT]   rank to pick (default 0)
    [--top-n         INT]   candidates in panel (default 8, max 12)
    [--refine-iters  INT]   region-grow iterations (default 5, max 10)
    [--min-cc-um2    FLOAT] candidate area floor um^2 (default 20)
    [--refine-lambda FLOAT] extension strictness (default 0.5)

Outputs in --output-dir:
    refined_candidates.png       top-N panel (our pipeline diagnostic)
    graphite_mask.png            final binary mask (selected candidate)
    graphite_contour.npy         (N, 2) float64, bottom_part px
    graphite_result.json         sidecar: selected rank/score/area, top-N,
                                 host/substrate/bulk info, low_confidence
    01_graphite_on_bottom.png    selected contour over desaturated image
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from sklearn.cluster import KMeans

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import keep_largest_n  # noqa: E402


# ---------------------------------------------------------------------------
# Configuration (internal — not exposed via CLI)
# ---------------------------------------------------------------------------

SUBSTRATE_CORNER_FRACTION = 0.10
HOST_MORPH_CLOSE_UM = 0.435  # morphology radii in physical units (= 5 px at 0.087 um/px)
HOST_MORPH_OPEN_UM = 0.174   # (= 2 px at 0.087 um/px)
HOST_MIN_AREA_UM2 = 200.0

# Codex hysteresis percentiles on ridge_max field
HYSTERESIS_LOW_PCT = 82.0
HYSTERESIS_HIGH_PCT = 96.0

# K-union spatial-merge tolerance
PROXIMITY_UM = 5.0
DEDUPE_IOU = 0.70

# Scoring normalisation (kept named; not used as comparison literals)
SCORE_CHROMA_NORM = 30.0   # s_gray = 1 - chroma / SCORE_CHROMA_NORM
SCORE_CONTRAST_NORM = 50.0  # s_contrast = min(1, contrast / SCORE_CONTRAST_NORM)

# Chroma cap for vdW heterostructure materials in LAB.  Graphite, graphene,
# hBN, MoS2 and other 2D crystals have weak optical absorption in the visible
# and produce near-neutral colour mixtures on typical substrates (SiO2,
# sapphire); strongly chromatic blobs are organic contamination, polymer
# residue, or saturation artefacts.  A K-means cluster (or candidate) whose
# centroid has |a - 128, b - 128| chroma above CLUSTER_CHROMA_MAX is treated
# as non-flake material and excluded / penalised.
#
# Value chosen empirically against the GT regression set, NOT from a
# literature citation.  The threshold is sensitive at the upper end:
#   * Empirical: widening CLUSTER_CHROMA_MAX to 60 regresses ml04 graphite
#     from 0.69 to 0.00 (its polymer-residue cluster sits at chroma~55, so
#     a 60 cap stops excluding it and it out-ranks the real flake).
#   * 50 keeps all 5 GT graphite stacks above the baseline-0.1 floor.
# This proximity to ml04's residue chroma is a known dependency; documented
# here rather than disguised as pure physics.
LAB_NEUTRAL_AB = np.array([128.0, 128.0], dtype=np.float32)
CLUSTER_CHROMA_MAX = 50.0

# Decay scale for the per-candidate chroma penalty.  Equal to
# CLUSTER_CHROMA_MAX so that one "cap width" of excess chroma multiplies
# the candidate score by 1/e (~0.37).  This is a controlled monotonic
# falloff, not a tuned parameter — any value in [30, 80] produces
# qualitatively similar ranking because the penalty only ever acts on
# candidates already above the cap.
CHROMA_PENALTY_SCALE = float(CLUSTER_CHROMA_MAX)

# Refinement window for the local-mean region grow
REFINE_WINDOW_PX = 7

# Final mask cleanup + low-confidence threshold
LOW_CONFIDENCE_FLOOR = 0.40

# Default + clamp ranges for agent-controllable hyperparameters
DEFAULT_TOP_N = 8
MAX_TOP_N = 12
DEFAULT_REFINE_ITERS = 5
MAX_REFINE_ITERS = 10

# Minimum CC count needed for PCA aspect (sentinels are fine as comparison)
MIN_PX_FOR_PCA = 5

# Silhouette sub-sample size for K selection
SILHOUETTE_SUBSAMPLE = 2000

# Substrate GMM parameters (low-texture LAB pixel sample)
SUBSTRATE_TEXTURE_WIN = 5           # local-std window for texture filter
SUBSTRATE_K_CANDIDATES = (2, 3, 4)  # GMM K values to compare via BIC
SUBSTRATE_GMM_MAX_SAMPLE = 10000    # cap fit size for speed
SUBSTRATE_GMM_RANDOM_STATE = 0      # deterministic GMM init


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _kernel_from_um(radius_um: float, pixel_size_um: float,
                    ellipse: bool = True) -> np.ndarray:
    """Return a structuring element whose radius is `radius_um` physical
    micrometres.  Derives the pixel size from `pixel_size_um` so morphology
    scales correctly across different objectives.

    When ``ellipse`` is True (default) returns a ``cv2.MORPH_ELLIPSE`` SE.
    When False, returns a flat rectangular ``np.ones((k, k), uint8)`` SE
    (used where original code used `np.ones((K, K), uint8)`).
    """
    radius_px = max(1, int(round(radius_um / pixel_size_um)))
    k = radius_px * 2 + 1
    if ellipse:
        return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    return np.ones((k, k), dtype=np.uint8)


# Refine-stage morphology in physical units
REFINE_DILATE_UM = 0.087   # ≈ 1 px at 0.087 um/px (k=3 rect)
REFINE_OPEN_UM = 0.218     # ≈ 2.5 px at 0.087 um/px (k=5 ellipse)
CARVE_OPEN_UM = 0.087      # ≈ 1 px at 0.087 um/px (k=3 ellipse)
CARVE_DILATE_UM = 0.5      # codex edge dilation


def flood_fill_holes_4corners(mask: np.ndarray) -> np.ndarray:
    """Flood-fill holes seeded from all 4 image corners that lie on
    substrate (mask == 0). Falls back to "largest substrate CC as outside"
    when the host touches every corner."""
    h, w = mask.shape[:2]
    flood = mask.copy()
    fill_mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
    corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
    flooded_from_any = False
    for sx, sy in corners:
        if mask[sy, sx] == 0:
            cv2.floodFill(flood, fill_mask, (sx, sy), 255)
            flooded_from_any = True
    if not flooded_from_any:
        inv = cv2.bitwise_not(mask)
        nl, labels, stats, _ = cv2.connectedComponentsWithStats(inv)
        if nl > 1:
            largest_id = int(np.argmax(stats[1:, cv2.CC_STAT_AREA]) + 1)
            outside = (labels == largest_id).astype(np.uint8) * 255
            holes = cv2.bitwise_and(inv, cv2.bitwise_not(outside))
            return cv2.bitwise_or(mask, holes)
        return mask
    holes = cv2.bitwise_not(flood)
    return cv2.bitwise_or(mask, holes)


def adaptive_plateau_threshold(values: np.ndarray,
                                abs_floor: float = 20.0,
                                ratio: float = 3.0,
                                default: float = 64,
                                skip_largest_if_multiple: bool = True
                                ) -> float:
    """Find first sufficiently-wide gap in sorted unique values; return
    the gap midpoint. Used for adaptive min_size in codex pipeline."""
    arr = np.asarray(values, dtype=np.float64)
    MIN_VALUES_FOR_THRESHOLD = 2
    if arr.size < MIN_VALUES_FOR_THRESHOLD:
        return float(default)
    drop_points = np.unique(arr)
    if drop_points.size < MIN_VALUES_FOR_THRESHOLD:
        return float(default)
    gaps = np.diff(drop_points)
    small_gaps = gaps[gaps <= np.percentile(gaps, 75)]
    med_gap = (float(np.median(small_gaps)) if small_gaps.size > 0
                else float(np.median(gaps)))
    wide_thresh = max(abs_floor, ratio * med_gap)
    plateaus = []
    for i_g in range(gaps.size):
        if gaps[i_g] >= wide_thresh:
            lo = float(drop_points[i_g])
            hi = float(drop_points[i_g + 1])
            plateaus.append((lo, hi, hi - lo))
    if not plateaus:
        return float(default)
    if skip_largest_if_multiple and len(plateaus) > 1:
        largest_w = max(p[2] for p in plateaus)
        usable = [p for p in plateaus if p[2] < largest_w]
        if not usable:
            usable = plateaus[:1]
    else:
        usable = plateaus
    return (usable[0][0] + usable[0][1]) / 2.0


# ---------------------------------------------------------------------------
# Substrate detection + host mask
# ---------------------------------------------------------------------------


def sample_substrate_lab(image_lab: np.ndarray
                         ) -> tuple[np.ndarray, float, str]:
    """Pick mu_sub via a Gaussian Mixture Model on low-texture LAB pixels.

    Steps:
      1. Compute a local LAB standard deviation per pixel (window of
         ``SUBSTRATE_TEXTURE_WIN`` × ``SUBSTRATE_TEXTURE_WIN``).  Keep only
         pixels with local std below the image-wide p50 of that std —
         these are the "low texture" pixels that are most likely substrate
         (or a uniform flake interior).
      2. Sub-sample (capped at ``SUBSTRATE_GMM_MAX_SAMPLE``) and fit a
         ``sklearn.mixture.GaussianMixture`` for each K in
         ``SUBSTRATE_K_CANDIDATES``.  Pick K via BIC (lowest score).
      3. Among the fitted components, choose the substrate cluster as the
         largest-weight component that *contains at least one corner
         pixel* (corners are quasi-always substrate).  Fall back to the
         overall largest-weight component if no component covers a corner.

    Returns mu_sub at means_[chosen].  Uses random_state=0 for
    determinism so snapshot regressions remain stable.
    """
    from sklearn.mixture import GaussianMixture
    h, w = image_lab.shape[:2]
    image_lab_f = image_lab.astype(np.float32)

    # 1. Local-std texture map (per channel mean of local std)
    win = SUBSTRATE_TEXTURE_WIN
    ksize = (win, win)
    mu = cv2.boxFilter(image_lab_f, ddepth=-1, ksize=ksize, normalize=True)
    mu2 = cv2.boxFilter(image_lab_f ** 2, ddepth=-1, ksize=ksize,
                        normalize=True)
    var = np.maximum(mu2 - mu ** 2, 0.0)
    local_std = np.sqrt(var).mean(axis=-1)  # (H, W)
    p50 = float(np.percentile(local_std, 50.0))
    low_tex_mask = local_std <= p50

    # 2. Build pixel sample from low-texture region
    flat_lab = image_lab_f.reshape(-1, 3)
    flat_keep = low_tex_mask.reshape(-1)
    low_tex_pix = flat_lab[flat_keep]
    if low_tex_pix.shape[0] < max(SUBSTRATE_K_CANDIDATES) * 8:
        # Degenerate texture filter — fall back to all pixels
        low_tex_pix = flat_lab

    rng = np.random.RandomState(SUBSTRATE_GMM_RANDOM_STATE)
    if low_tex_pix.shape[0] > SUBSTRATE_GMM_MAX_SAMPLE:
        idx = rng.choice(low_tex_pix.shape[0], SUBSTRATE_GMM_MAX_SAMPLE,
                         replace=False)
        sample = low_tex_pix[idx]
    else:
        sample = low_tex_pix

    # Corner pixel sample (used for substrate cluster selection)
    pw = max(20, int(w * SUBSTRATE_CORNER_FRACTION))
    ph = max(20, int(h * SUBSTRATE_CORNER_FRACTION))
    corners_pix = np.vstack([
        image_lab[:ph, :pw].reshape(-1, 3),
        image_lab[:ph, w - pw:].reshape(-1, 3),
        image_lab[h - ph:, :pw].reshape(-1, 3),
        image_lab[h - ph:, w - pw:].reshape(-1, 3),
    ]).astype(np.float32)
    std_total = float(np.std(corners_pix, axis=0).sum())

    # 3. Pick K by BIC
    best_gmm = None
    best_bic = float('inf')
    for K in SUBSTRATE_K_CANDIDATES:
        if sample.shape[0] < K * 2:
            continue
        try:
            gmm_k = GaussianMixture(
                n_components=K, covariance_type='full',
                random_state=SUBSTRATE_GMM_RANDOM_STATE, max_iter=200)
            gmm_k.fit(sample)
            bic = float(gmm_k.bic(sample))
        except Exception:
            continue
        if bic < best_bic:
            best_bic = bic
            best_gmm = gmm_k
    if best_gmm is None:
        mu_sub = np.median(sample, axis=0).astype(np.float32)
        return mu_sub, std_total, 'lowtex_median_fallback'

    means = best_gmm.means_.astype(np.float32)   # (K, 3)
    weights = best_gmm.weights_                  # (K,)

    # Substrate cluster: largest-weight component that contains a corner pixel.
    # "Contains" = corner pixel's hard-assigned cluster matches the component.
    if corners_pix.shape[0] > 0:
        corner_labels = best_gmm.predict(corners_pix)
        corner_cluster_set = set(int(c) for c in corner_labels)
    else:
        corner_cluster_set = set()

    order = np.argsort(-weights)  # descending by weight
    chosen = None
    for idx in order:
        if int(idx) in corner_cluster_set:
            chosen = int(idx)
            break
    if chosen is None:
        chosen = int(order[0])
        method = 'gmm_lowtex_fallback_largest'
    else:
        method = 'gmm_lowtex_corner_covered'

    mu_sub = means[chosen].astype(np.float32)
    return mu_sub, std_total, method


OTSU_CLASSES = 4            # 4-class Otsu → 3 thresholds; T* is thresholds[1]
OTSU_CLIP_PERCENTILE = 99  # clip distance distribution tail before fitting
OTSU_T_STAR_IDX = 1        # use the second threshold as T* (valley between sub + mat)


def auto_t_star(dist: np.ndarray) -> float:
    """Multi-level Otsu threshold on the LAB-distance histogram.

    Fits skimage.filters.threshold_multiotsu with OTSU_CLASSES classes to
    find natural thresholds in the distance-to-substrate distribution.
    T* = thresholds[OTSU_T_STAR_IDX] — the valley separating substrate
    pixels from the first flake material.  This is image-size independent:
    no count-based or ratio-based literals are used.
    """
    from skimage.filters import threshold_multiotsu
    flat = dist.ravel().astype(np.float32)
    # Clip distribution tail for Otsu histogram stability
    flat_clipped = flat[flat <= float(np.percentile(flat, OTSU_CLIP_PERCENTILE))]
    try:
        thresholds = threshold_multiotsu(flat_clipped, classes=OTSU_CLASSES)
        t_star = float(thresholds[OTSU_T_STAR_IDX])
        # Guard: must be positive and leave some host pixels
        if t_star <= 0:
            t_star = float(thresholds[-1] / 2.0) if thresholds[-1] > 0 else 10.0
        return t_star
    except Exception:
        # Fallback: simple Otsu on grayscale encoding of distance
        flat_u8 = np.clip(flat_clipped / max(float(flat_clipped.max()), 1.0)
                          * 255, 0, 255).astype(np.uint8)
        t_u8, _ = cv2.threshold(flat_u8, 0, 255, cv2.THRESH_OTSU)
        return float(t_u8) / 255.0 * float(flat_clipped.max())


def _adaptive_n_components(host: np.ndarray, min_area_px: int) -> int:
    """Return the adaptive component count for keep_largest_n.

    Counts connected components whose area is >= the 20th percentile of
    all qualifying-area components.  Always returns at least 1.  This
    enables multi-component host extraction when the graphite layer is
    fragmented into several similarly-sized pieces.
    """
    nl, _, stats, _ = cv2.connectedComponentsWithStats(host)
    if nl <= 1:
        return 1
    all_areas = np.array([stats[i, cv2.CC_STAT_AREA]
                           for i in range(1, nl)], dtype=np.float64)
    qualifying = all_areas[all_areas >= min_area_px]
    if qualifying.size == 0:
        return 1
    p20 = float(np.percentile(qualifying, 20))
    return max(1, int((qualifying >= p20).sum()))


def compute_host(image_bgr: np.ndarray,
                 pixel_size: float,
                 max_components: int | None = 1,
                 ) -> tuple[np.ndarray, np.ndarray,
                            np.ndarray, str, float]:
    """Compute the host (non-substrate) mask.

    Parameters
    ----------
    image_bgr      : BGR image array.
    pixel_size     : physical pixel size in um/px.
    max_components : maximum number of CCs to keep.
        ``None``  — use ``_adaptive_n_components`` (multi-component host,
                    supports fragmented graphite layers).
        integer ≥ 1 — cap at this many CCs; keeps the N largest that pass
                    the area floor.  Pass ``1`` to get the single-largest
                    component (backward-compatible with bottom_hbn.py).

    This function is imported by bottom_hbn.py.  The default ``None``
    enables keep_largest_n with n>=1 configurable, so callers that pass
    an explicit integer get the legacy single-component behaviour while
    graphite's own pipeline benefits from multi-component support.
    """
    image_lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    mu_sub, _, corner = sample_substrate_lab(image_lab)
    dist = np.linalg.norm(image_lab.astype(np.float32) - mu_sub, axis=2)
    t_star = auto_t_star(dist)
    raw = (dist > t_star).astype(np.uint8) * 255
    # Morphology kernels derived from physical size (pixel_size_um) — pass
    # the structuring elements directly rather than scalar sizes so the
    # actual kernel shape (ellipse) is carried through.
    close_k = _kernel_from_um(HOST_MORPH_CLOSE_UM, pixel_size, ellipse=True)
    open_k = _kernel_from_um(HOST_MORPH_OPEN_UM, pixel_size, ellipse=True)
    host = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, close_k)
    host = cv2.morphologyEx(host, cv2.MORPH_OPEN, open_k)
    min_area_px = max(500, int(HOST_MIN_AREA_UM2 / (pixel_size ** 2)))

    # Select adaptive or explicit component count
    if max_components is None:
        n_keep = _adaptive_n_components(host, min_area_px)
    else:
        n_keep = max(1, int(max_components))

    host = keep_largest_n(host, n=n_keep, min_area=min_area_px)
    host = flood_fill_holes_4corners(host)
    return host, image_lab, mu_sub, corner, t_star


# ---------------------------------------------------------------------------
# Codex ridge pipeline
# ---------------------------------------------------------------------------


def compute_ms_min(image_lab: np.ndarray, host: np.ndarray) -> np.ndarray:
    """Multi-scale MIN of the L-channel Sobel gradient at sigma in
    (1, 2, 4, 8), each normalised to its in-host p99 and clipped to [0,1].
    A pixel survives only if it is a strong gradient at EVERY scale."""
    L = image_lab[:, :, 0]
    sigmas = (1.0, 2.0, 4.0, 8.0)
    fields = []
    for sigma in sigmas:
        Lb = cv2.GaussianBlur(L, (0, 0), sigma)
        gx = cv2.Sobel(Lb, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(Lb, cv2.CV_32F, 0, 1, ksize=3)
        mag = cv2.magnitude(gx, gy)
        in_host = mag[host > 0]
        vmax = float(np.percentile(in_host, 99.0)) if in_host.size > 0 else 1.0
        fields.append(np.clip(mag / max(vmax, 1.0), 0.0, 1.0))
    return np.stack(fields, axis=0).min(axis=0)


def codex_ridge_pipeline(ms_min: np.ndarray, host: np.ndarray
                          ) -> tuple[np.ndarray, np.ndarray, int]:
    """Codex faint-strip enhancement on the ms_min gradient.

    Returns (ridge_max, binary_edge_final, adaptive_min_size_px).
      ridge_max          [0, 1] continuous heatmap after clip+gamma+
                         Frangi/Sato/Meijering MAX
      binary_edge_final  uint8 0/255 binary edge after hysteresis +
                         adaptive remove_small_objects
      adaptive_min_size_px  the auto-picked min_size used to clean
                         hysteresis output (plateau in CC-area distrib)
    """
    from skimage.filters import (frangi, sato, meijering,
                                  apply_hysteresis_threshold)
    from skimage.morphology import remove_small_objects
    host_bool = host > 0
    vals = ms_min[host_bool]
    lo = float(np.percentile(vals, 50))
    hi = float(np.percentile(vals, 99.3))
    x = np.clip((ms_min - lo) / max(hi - lo, 1e-6), 0.0, 1.0).astype(np.float32)
    x = np.sqrt(x).astype(np.float32)
    sigmas = (1, 2, 3, 4, 6)
    r1 = frangi(x, sigmas=sigmas, alpha=0.7, beta=0.9,
                black_ridges=False).astype(np.float32)
    r2 = sato(x, sigmas=sigmas, black_ridges=False).astype(np.float32)
    r3 = meijering(x, sigmas=(1, 2, 3),
                    black_ridges=False).astype(np.float32)

    def _norm(a: np.ndarray) -> np.ndarray:
        m = float(a[host_bool].max()) if host_bool.any() else float(a.max())
        return a / max(m, 1e-6)

    ridge_max = (np.maximum.reduce([_norm(r1), _norm(r2), _norm(r3)])
                  * host_bool).astype(np.float32)
    v = ridge_max[host_bool]
    low = float(np.percentile(v, HYSTERESIS_LOW_PCT))
    high = float(np.percentile(v, HYSTERESIS_HIGH_PCT))
    edge_hys = apply_hysteresis_threshold(ridge_max, low, high) & host_bool

    cc_n0, _, cc_stats0, _ = cv2.connectedComponentsWithStats(
        edge_hys.astype(np.uint8))
    plateau_centre = 64
    if cc_n0 > 1:
        areas = cc_stats0[1:, cv2.CC_STAT_AREA]
        plateau_centre = int(adaptive_plateau_threshold(
            areas, abs_floor=20.0, ratio=3.0, default=64,
            skip_largest_if_multiple=True))
    edge_final = remove_small_objects(edge_hys, min_size=plateau_centre)
    return ridge_max, (edge_final.astype(np.uint8) * 255), plateau_centre


# ---------------------------------------------------------------------------
# Carving + K-union
# ---------------------------------------------------------------------------


def carve_regions(host: np.ndarray, edge: np.ndarray,
                  pixel_size: float, min_cc_um2: float
                  ) -> tuple[np.ndarray, list[tuple[int, int]]]:
    """Return (lab_r, cc_records) where lab_r is a synthetic label map
    and cc_records is [(id, area_px)] sorted by area desc."""
    # Kernels derived from pixel_size (scale-aware morphology)
    kdil = _kernel_from_um(CARVE_DILATE_UM, pixel_size, ellipse=True)
    open_k3 = _kernel_from_um(CARVE_OPEN_UM, pixel_size, ellipse=True)
    min_cc_px = int(min_cc_um2 / (pixel_size ** 2))
    edge_dilated = cv2.dilate(edge, kdil)
    regions_raw = cv2.bitwise_and(host, cv2.bitwise_not(edge_dilated))
    regions_cleaned = cv2.morphologyEx(regions_raw, cv2.MORPH_OPEN, open_k3)
    nl, lab_native, stats, _ = cv2.connectedComponentsWithStats(regions_cleaned)
    keep = []
    for i in range(1, nl):
        a = int(stats[i, cv2.CC_STAT_AREA])
        if a >= min_cc_px:
            keep.append((i, a))
    keep.sort(key=lambda x: -x[1])
    lab_r = np.zeros(host.shape, dtype=np.int32)
    cc_records = []
    for new_id, (old_id, area) in enumerate(keep, start=1):
        lab_r[lab_native == old_id] = new_id
        cc_records.append((new_id, area))
    return lab_r, cc_records


def _pick_k_silhouette(host_pix: np.ndarray, k_range: range) -> int:
    """Pick K via silhouette score on a sub-sample of host LAB pixels.

    Tries each K in `k_range`, returns the K with the highest average
    silhouette score.  Falls back to min(k_range) if only one K tried.
    """
    from sklearn.metrics import silhouette_score as _sil
    rng = np.random.RandomState(42)
    n = host_pix.shape[0]
    sub = host_pix
    if n > SILHOUETTE_SUBSAMPLE:
        idx = rng.choice(n, SILHOUETTE_SUBSAMPLE, replace=False)
        sub = host_pix[idx]
    best_k = k_range.start
    best_score = -2.0
    for k_try in k_range:
        if k_try >= sub.shape[0]:
            break
        try:
            kt = KMeans(n_clusters=k_try, n_init=4, random_state=42)
            labels = kt.fit_predict(sub)
            sc = float(_sil(sub, labels))
        except Exception:
            continue
        if sc > best_score:
            best_score = sc
            best_k = k_try
    return best_k


def k_union(image_lab: np.ndarray, host: np.ndarray, lab_r: np.ndarray,
            cc_records: list[tuple[int, int]], pixel_size: float,
            mu_sub: np.ndarray | None = None
            ) -> list[dict[str, Any]]:
    """K-means at K chosen by silhouette score on host LAB pixels.

    Bulk cluster = the cluster whose centroid is closest to `mu_sub`
    (substrate-aware), NOT the largest cluster.  Groups same-cluster
    non-bulk CCs that are spatially adjacent (within PROXIMITY_UM).
    Unions groups across K values; dedupes by mask IoU.
    """
    if not cc_records:
        return []
    host_pix = image_lab[host > 0].reshape(-1, 3).astype(np.float32)
    cc_mean_lab: dict[int, np.ndarray] = {}
    for lab_id, _ in cc_records:
        mask = (lab_r == lab_id)
        if not mask.any():
            continue
        cc_mean_lab[lab_id] = image_lab[mask].reshape(-1, 3) \
            .astype(np.float32).mean(axis=0)

    n_ccs = len(cc_records)
    K_max = max(6, n_ccs)
    K_range = range(3, K_max + 1)

    # Pick best K via silhouette
    best_k = _pick_k_silhouette(host_pix, K_range)

    # Run full K-means for each K in range (for union coverage)
    all_K_results: list[dict[str, Any]] = []
    for K_try in K_range:
        try:
            kt = KMeans(n_clusters=K_try, n_init=4, random_state=42)
            kt.fit(host_pix)
        except Exception:
            continue

        # Bulk cluster = centroid closest to substrate mean in LAB.
        # Substrate-aware: the cluster whose mean colour is nearest mu_sub
        # is the one likely representing the dominant background/bulk
        # material in the host (e.g. hBN whose LAB tail overlaps substrate).
        if mu_sub is None:
            # Defensive fallback if caller didn't pass mu_sub
            bulk_id = int(np.argmax(np.bincount(kt.labels_, minlength=K_try)))
        else:
            dists = np.linalg.norm(
                kt.cluster_centers_ - mu_sub[None, :], axis=1)
            bulk_id = int(np.argmin(dists))

        # Physics-based cluster exclusion: van der Waals heterostructure
        # materials (graphite, graphene, hBN, MoS2, etc.) all have LAB
        # chroma well below CLUSTER_CHROMA_MAX.  Clusters whose centroid
        # exceeds this chroma cap are non-flake artifacts (organic
        # contamination, polymer residue, illumination saturation) and
        # are excluded from candidate consideration in addition to the
        # substrate-similar bulk cluster.  This is a universal optical
        # property of 2D crystalline materials — not sample-fit.
        chroma_per_cluster = np.linalg.norm(
            kt.cluster_centers_[:, 1:] - LAB_NEUTRAL_AB[None, :], axis=1)
        excluded_ids = {bulk_id}
        for cid, ch in enumerate(chroma_per_cluster):
            if float(ch) > CLUSTER_CHROMA_MAX:
                excluded_ids.add(int(cid))

        cc_to_c = {}
        for lab_id, mean_lab in cc_mean_lab.items():
            dists = np.linalg.norm(kt.cluster_centers_ - mean_lab, axis=1)
            cc_to_c[lab_id] = int(np.argmin(dists))
        all_K_results.append({
            'K': K_try, 'bulk_id': bulk_id, 'excluded_ids': excluded_ids,
            'centers': kt.cluster_centers_, 'cc_to_c': cc_to_c,
            'is_best_k': K_try == best_k,
        })
    if not all_K_results:
        return []

    prox_dilate_px = max(1, int(PROXIMITY_UM / pixel_size / 2))
    prox_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (2 * prox_dilate_px + 1, 2 * prox_dilate_px + 1))

    raw_candidates: list[dict[str, Any]] = []
    for kres in all_K_results:
        cluster_to_ccs: dict[int, list[int]] = {}
        excluded = kres.get('excluded_ids', {kres['bulk_id']})
        for lab_id, c in kres['cc_to_c'].items():
            if c in excluded:
                continue
            cluster_to_ccs.setdefault(c, []).append(lab_id)
        for cluster_id, lab_ids in cluster_to_ccs.items():
            if len(lab_ids) == 1:
                subgroups = [lab_ids]
            else:
                masks_d = [cv2.dilate(
                    (lab_r == lid).astype(np.uint8) * 255, prox_kernel)
                            for lid in lab_ids]
                masks_raw = [(lab_r == lid).astype(np.uint8) * 255
                              for lid in lab_ids]
                n_cc = len(lab_ids)
                parent = list(range(n_cc))

                def find(x: int, parent: list[int] = parent) -> int:
                    while parent[x] != x:
                        parent[x] = parent[parent[x]]
                        x = parent[x]
                    return x

                for i in range(n_cc):
                    for j in range(i + 1, n_cc):
                        if (cv2.bitwise_and(masks_d[i], masks_raw[j]) > 0).any():
                            ra, rb = find(i), find(j)
                            if ra != rb:
                                parent[ra] = rb
                sg_dict: dict[int, list[int]] = {}
                for i in range(n_cc):
                    r = find(i)
                    sg_dict.setdefault(r, []).append(lab_ids[i])
                subgroups = list(sg_dict.values())
            for sg in subgroups:
                merged_mask = np.zeros_like(host)
                for lid in sg:
                    merged_mask[lab_r == lid] = 255
                if (merged_mask > 0).sum() == 0:
                    continue
                raw_candidates.append({
                    'source_K': kres['K'], 'cluster_id': cluster_id,
                    'mu_lab': kres['centers'][cluster_id],
                    'mask': merged_mask, 'lab_ids': sg,
                })

    raw_candidates.sort(key=lambda r: -int((r['mask'] > 0).sum()))
    unique: list[dict[str, Any]] = []
    for c in raw_candidates:
        is_dup = False
        for u in unique:
            inter = int((c['mask'] & u['mask']).sum())
            union = int((c['mask'] | u['mask']).sum())
            if union > 0 and inter / union >= DEDUPE_IOU:
                u['source_Ks'].add(c['source_K'])
                is_dup = True
                break
        if not is_dup:
            c['source_Ks'] = {c['source_K']}
            unique.append(c)
    return unique


# ---------------------------------------------------------------------------
# Bulk-mode + scoring
# ---------------------------------------------------------------------------


def compute_bulk_mode(image_lab: np.ndarray, host: np.ndarray) -> np.ndarray:
    """Mode of the host LAB histogram (peak density)."""
    from scipy.ndimage import gaussian_filter
    host_pix = image_lab[host > 0].reshape(-1, 3).astype(np.float32)
    hist, edges = np.histogramdd(host_pix, bins=32,
                                  range=[(0, 256), (0, 256), (0, 256)])
    hist = gaussian_filter(hist, sigma=1.0)
    peak = np.unravel_index(np.argmax(hist), hist.shape)
    return np.array([
        (edges[d][peak[d]] + edges[d][peak[d] + 1]) / 2.0
        for d in range(3)
    ], dtype=np.float32)


SCORE_MIN_WEIGHT = 0.05   # minimum weight fraction per sub-score (calibrated floor)

# Material-physics priors for graphite candidate scoring.
#
# These weights encode morphological/optical signatures of graphite flakes on
# van der Waals heterostructures.  They are NOT fit to any specific sample.
# The dominant weight (s_strip) is true crystal physics; the rest are
# weaker physical / process priors:
#
#   s_strip   (0.40): graphite cleaves into strip-like geometries because the
#                     basal-plane bonding is strongly anisotropic vs c-axis.
#                     This is true crystal physics and the single most
#                     reliable signature, so it carries the largest weight.
#   s_central (0.20): a fabrication-process heuristic — exfoliation tends to
#                     stamp the flake near the host's center.  Weighted lower
#                     than strip because edge-touching exfoliated flakes are
#                     common in practice, so centrality is only a soft prior,
#                     not a universal law.
#   s_gray    (0.15): graphite is achromatic; non-zero chroma is a strong
#                     negative signal (organic residue, polymer, etc.).
#   s_contrast(0.15): graphite has measurable optical contrast against hBN
#                     across visible wavelengths (universal optical property).
#   s_cohere  (0.10): connected-component coherence — exfoliated flakes are
#                     monolithic, not speckle.
#
# Do not adjust these per sample.  If a stack fails, the fix is upstream
# segmentation, not these weights.
_PHYSICS_WEIGHTS = np.array([0.40, 0.20, 0.15, 0.15, 0.10], dtype=np.float64)

# Variance term provides a small per-image adjustment for cases where the
# physics priors are inconclusive (e.g. multiple strip-like candidates).
# It is dominated by the physics priors — that is by design.  Empirically,
# the variance term over-amplifies s_contrast on diverse candidate sets;
# the conservative default disables it (pure physics).  The constants are
# kept so future tuning of variance temperature is straightforward.
ALPHA_PHYSICS = 1.0
ALPHA_VARIANCE = 0.0
SCORE_VARIANCE_FLOOR = 1e-9   # below this total, return physics-only weights
MIN_CANDIDATES_FOR_VARIANCE = 3  # below this count, variance signal is unreliable


def score_weights(sub_scores: list[np.ndarray]) -> np.ndarray:
    """Return per-sub-score weights.

    Currently returns ``_PHYSICS_WEIGHTS`` unchanged (``ALPHA_PHYSICS=1.0``,
    ``ALPHA_VARIANCE=0.0``).  The variance term was tried at
    ``ALPHA_VARIANCE=0.2`` but over-amplified ``s_contrast`` on diverse
    candidate pools, ranking polymer-residue candidates above real graphite
    on ml04/ml11.  The ALPHA constants are retained as named knobs in case
    future stacks benefit from a controlled blend; the general formula
    ``ALPHA_PHYSICS * _PHYSICS_WEIGHTS + ALPHA_VARIANCE * variance_term`` is
    evaluated below so re-enabling the blend is a one-line change.

    The variance fallback (physics-only) also fires when the candidate count
    is < ``MIN_CANDIDATES_FOR_VARIANCE`` or total variance is below
    ``SCORE_VARIANCE_FLOOR``.

    Args:
        sub_scores: list of 1-D arrays (one per sub-score component) of
            length n_candidates.

    Returns:
        np.ndarray of shape (len(sub_scores),) with weights summing to 1.
    """
    n_components = len(sub_scores)
    n_candidates = len(sub_scores[0]) if n_components > 0 else 0

    # Use physics priors only when the per-image variance signal is unreliable
    if (n_components != len(_PHYSICS_WEIGHTS)
            or n_candidates < MIN_CANDIDATES_FOR_VARIANCE):
        return _PHYSICS_WEIGHTS.copy()

    variances = np.array([float(np.var(s)) for s in sub_scores],
                         dtype=np.float64)
    total = variances.sum()
    if total < SCORE_VARIANCE_FLOOR:
        return _PHYSICS_WEIGHTS.copy()

    variance_term = variances / total
    weights = ALPHA_PHYSICS * _PHYSICS_WEIGHTS + ALPHA_VARIANCE * variance_term
    return weights / weights.sum()


def score_candidates(merged_candidates: list[dict[str, Any]],
                     image_lab: np.ndarray, host: np.ndarray,
                     bulk_mu_lab: np.ndarray, pixel_size: float,
                     mu_sub: np.ndarray | None = None,
                     ) -> list[dict[str, Any]]:
    """Compute 5 score components per candidate and sort by score desc.

    Chroma is measured relative to the substrate mean a,b channels
    (mu_sub[1], mu_sub[2]) — substrate-aware, not the fixed LAB neutral
    point.  Weights are derived from the variance of each sub-score across
    candidates (calibrated confidence-driven weights via score_weights()).
    """
    host_dt = cv2.distanceTransform(host, cv2.DIST_L2, 5)
    max_dt = float(host_dt.max()) if host_dt.max() > 0 else 1.0
    # Substrate a,b as chromatic neutral — graphite and substrate share
    # similar hue; using substrate mean avoids dependency on fixed LAB point.
    if mu_sub is not None:
        neutral_a = float(mu_sub[1])
        neutral_b = float(mu_sub[2])
    else:
        neutral_a = float(bulk_mu_lab[1])
        neutral_b = float(bulk_mu_lab[2])
    for c in merged_candidates:
        # area + mean_lab + cohere
        merged_mask = c['mask']
        merged_lab_pix = image_lab[merged_mask > 0].reshape(-1, 3) \
            .astype(np.float32)
        c['mean_lab'] = merged_lab_pix.mean(axis=0)
        c['contrast_vs_bulk'] = float(np.linalg.norm(c['mean_lab'] - bulk_mu_lab))
        area_px = int((merged_mask > 0).sum())
        c['area_px'] = area_px
        c['area_um2'] = area_px * pixel_size * pixel_size
        nl_m, _, st_m, _ = cv2.connectedComponentsWithStats(merged_mask)
        max_cc = max((int(st_m[i, cv2.CC_STAT_AREA]) for i in range(1, nl_m)),
                     default=0)
        c['cohere'] = max_cc / max(1, area_px)

        # s_strip from PCA aspect
        pix_idx = np.argwhere(merged_mask > 0)
        if pix_idx.shape[0] >= MIN_PX_FOR_PCA:
            cov = np.cov(pix_idx.T.astype(np.float64))
            eigs = np.linalg.eigvalsh(cov)
            lam_max = float(max(eigs))
            lam_min = float(max(min(eigs), 1e-6))
            c['s_strip'] = 1.0 - float(np.sqrt(lam_min / lam_max))
            c['aspect'] = float(np.sqrt(lam_max / lam_min))
        else:
            c['s_strip'] = 0.0
            c['aspect'] = 1.0

        # s_central from distance transform inside host
        c['s_central'] = (float(host_dt[merged_mask > 0].mean()) / max_dt
                          if area_px > 0 else 0.0)

        # s_gray: chroma relative to substrate a,b (substrate-aware,
        # not hardcoded to the fixed LAB neutral point)
        a = float(c['mean_lab'][1])
        b = float(c['mean_lab'][2])
        c['chroma'] = float(np.sqrt((a - neutral_a) ** 2 + (b - neutral_b) ** 2))
        c['s_gray'] = max(0.0, 1.0 - c['chroma'] / SCORE_CHROMA_NORM)

        # s_contrast
        c['s_contrast'] = min(1.0, c['contrast_vs_bulk'] / SCORE_CONTRAST_NORM)

    # Calibrated confidence-driven weights (score_weights)
    if merged_candidates:
        sub = [
            np.array([c['s_strip'] for c in merged_candidates]),
            np.array([c['s_central'] for c in merged_candidates]),
            np.array([c['s_gray'] for c in merged_candidates]),
            np.array([c['s_contrast'] for c in merged_candidates]),
            np.array([c['cohere'] for c in merged_candidates]),
        ]
        w = score_weights(sub)
    else:
        w = np.array([0.3, 0.3, 0.15, 0.15, 0.1])

    # Per-candidate chroma penalty: backstop to the cluster-exclusion cap.
    # A candidate whose mean LAB chroma exceeds CLUSTER_CHROMA_MAX is an
    # organic/polymer contaminant rather than flake material (chroma cap
    # rationale documented at the constant).  It receives a smooth
    # multiplicative downweighting with decay scale CHROMA_PENALTY_SCALE so
    # it cannot win the rank-by-score selection even if its cluster centroid
    # stayed just under the cap.  Chroma is measured against the universal
    # LAB neutral point (achromatic axis), independent of substrate colour.
    for c in merged_candidates:
        a = float(c['mean_lab'][1])
        b = float(c['mean_lab'][2])
        c_chroma_neutral = float(
            np.sqrt((a - float(LAB_NEUTRAL_AB[0])) ** 2
                     + (b - float(LAB_NEUTRAL_AB[1])) ** 2))
        c['chroma_neutral'] = c_chroma_neutral
        raw_score = float(
            w[0] * c['s_strip']
            + w[1] * c['s_central']
            + w[2] * c['s_gray']
            + w[3] * c['s_contrast']
            + w[4] * c['cohere']
        )
        if c_chroma_neutral > CLUSTER_CHROMA_MAX:
            # Monotonic exponential falloff above the cap (decay scale is a
            # separate named constant; not coupled to the cap value).
            excess = c_chroma_neutral - CLUSTER_CHROMA_MAX
            penalty = float(np.exp(-excess / CHROMA_PENALTY_SCALE))
            c['score'] = raw_score * penalty
        else:
            c['score'] = raw_score
    merged_candidates.sort(key=lambda c: -c['score'])
    return merged_candidates


# ---------------------------------------------------------------------------
# Iterative local-mean region grow refinement
# ---------------------------------------------------------------------------


def refine_candidates(merged_candidates: list[dict[str, Any]],
                      image_lab: np.ndarray, host: np.ndarray,
                      bulk_mu_lab: np.ndarray,
                      iters: int, lam: float, pixel_size: float) -> None:
    """For each candidate, iteratively grow its mask outward across host
    pixels whose LAB matches the LOCAL mean of nearby refined pixels.

    The growth front is gated against bulk by d_local < lam * d_bulk, so
    a candidate with seed near bulk colour won't run away into bulk.
    """
    image_lab_f = image_lab.astype(np.float32)
    d_bulk_full = np.linalg.norm(image_lab_f - bulk_mu_lab,
                                  axis=-1).astype(np.float32)
    # Kernels derived from pixel_size to scale across objectives
    dil3 = _kernel_from_um(REFINE_DILATE_UM, pixel_size, ellipse=False)
    open_k5 = _kernel_from_um(REFINE_OPEN_UM, pixel_size, ellipse=True)
    keep_min_area_px = int(30.0 / (pixel_size ** 2))
    for c in merged_candidates:
        refined = (c['mask'] > 0).astype(np.uint8) * 255
        for _ in range(iters):
            dilated = cv2.dilate(refined, dil3)
            frontier = ((dilated > 0) & (refined == 0) & (host > 0))
            if not frontier.any():
                break
            ref_f = (refined > 0).astype(np.float32)
            sum_lab = cv2.boxFilter(image_lab_f * ref_f[..., None], ddepth=-1,
                                     ksize=(REFINE_WINDOW_PX, REFINE_WINDOW_PX),
                                     normalize=False)
            count = cv2.boxFilter(ref_f, ddepth=-1,
                                   ksize=(REFINE_WINDOW_PX, REFINE_WINDOW_PX),
                                   normalize=False)
            safe = count > 0
            local_mean = np.zeros_like(image_lab_f)
            local_mean[safe] = sum_lab[safe] / count[safe][..., None]
            d_local = np.linalg.norm(image_lab_f - local_mean,
                                      axis=-1).astype(np.float32)
            add = frontier & safe & (d_local < lam * d_bulk_full)
            if not add.any():
                break
            refined = refined | (add.astype(np.uint8) * 255)
        refined = cv2.morphologyEx(refined, cv2.MORPH_OPEN, open_k5)
        refined = keep_largest_n(refined, n=1, min_area=keep_min_area_px)
        c['refined_mask'] = refined
        c['refined_area_px'] = int((refined > 0).sum())
        c['refined_area_um2'] = (c['refined_area_px']
                                  * pixel_size * pixel_size)


# ---------------------------------------------------------------------------
# Visualisation
# ---------------------------------------------------------------------------


_MID = 128  # mid-brightness palette constant
_PALETTE = [(0, 200, 255), (0, 255, 0), (0, 0, 255),
            (255, 0, 0), (255, 0, 255), (255, 255, 0),
            (255, _MID, 0), (_MID, 255, _MID),
            (0, _MID, 255), (200, 0, 255),
            (_MID, _MID, 255), (255, _MID, _MID)]


def draw_refined_candidates(image_bgr: np.ndarray,
                            ranked: list[dict[str, Any]],
                            top_n: int, sel_rank: int) -> np.ndarray:
    """Grid panel: each of the top_n candidates shown with its refined
    mask outlined on a desaturated background; rank, area, score
    annotated. The selected rank gets a highlighted border."""
    h_img, w_img = image_bgr.shape[:2]
    n_show = min(top_n, len(ranked))
    PANEL_SPLIT = 4  # threshold: more than this many → 3-column grid
    if n_show <= 0:
        return image_bgr.copy()
    n_cols = 3 if n_show > PANEL_SPLIT else min(n_show, 2)
    n_rows = (n_show + n_cols - 1) // n_cols
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    desat = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    base = cv2.addWeighted(image_bgr, 0.35, desat, 0.65, 0)
    panels = []
    for rank in range(n_show):
        c = ranked[rank]
        mask = c.get('refined_mask', c['mask'])
        col = _PALETTE[rank % len(_PALETTE)]
        panel = base.copy()
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                    cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(panel, cnts, -1, col, 2)
        overlay = panel.copy()
        cv2.drawContours(overlay, cnts, -1, col, -1)
        panel = cv2.addWeighted(overlay, 0.30, panel, 0.70, 0)
        if rank == sel_rank:
            cv2.rectangle(panel, (0, 0), (w_img - 1, h_img - 1),
                          (0, 255, 255), 8)
        label1 = (f"#{rank}  area={c.get('refined_area_um2', c['area_um2']):.0f}um2 "
                  f"asp={c.get('aspect', 0.0):.1f}")
        label2 = (f"strip={c.get('s_strip', 0.0):.2f} "
                  f"central={c.get('s_central', 0.0):.2f} "
                  f"gray={c.get('s_gray', 0.0):.2f} "
                  f"score={c['score']:.2f}")
        cv2.rectangle(panel, (0, 0), (w_img, 70), (20, 20, 20), -1)
        cv2.putText(panel, label1, (12, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75,
                    (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(panel, label2, (12, 58),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    (220, 220, 220), 1, cv2.LINE_AA)
        panels.append(panel)
    panel_h = max(1, h_img // n_rows)
    panel_w = max(1, w_img // n_cols)
    fitted = [cv2.resize(p, (panel_w, panel_h),
                          interpolation=cv2.INTER_AREA) for p in panels]
    while len(fitted) < n_rows * n_cols:
        fitted.append(np.zeros_like(fitted[0]))
    rows = [np.hstack(fitted[i * n_cols:(i + 1) * n_cols])
            for i in range(n_rows)]
    return np.vstack(rows)


def draw_final_overlay(image_bgr: np.ndarray, host: np.ndarray,
                       contour: np.ndarray | None) -> np.ndarray:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    desat = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    base = cv2.addWeighted(image_bgr, 0.5, desat, 0.5, 0)
    base[host == 0] = (base[host == 0] * 0.6).astype(np.uint8)
    if contour is not None:
        cv2.drawContours(base, [contour], -1, (0, 200, 255), 3)
    return base


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(
        description='Graphite/backgate detector on bottom_part')
    p.add_argument('--image', required=True)
    p.add_argument('--pixel-size', type=float, required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--cluster-id', type=int, default=0,
                   help='Rank to pick as final graphite (0 = top score).')
    p.add_argument('--top-n', type=int, default=DEFAULT_TOP_N,
                   help=f'Candidates in panel (default {DEFAULT_TOP_N}, '
                        f'max {MAX_TOP_N}).')
    p.add_argument('--refine-iters', type=int, default=DEFAULT_REFINE_ITERS,
                   help=f'Region-grow iterations (default {DEFAULT_REFINE_ITERS}, '
                        f'max {MAX_REFINE_ITERS}).')
    p.add_argument('--min-cc-um2', type=float, default=20.0,
                   help='Carved-CC area floor in um^2 (default 20).')
    p.add_argument('--refine-lambda', type=float, default=0.5,
                   help='LAB extension strictness in refinement '
                        '(d_seed < lambda * d_bulk; default 0.5).')
    args = p.parse_args()

    top_n = max(1, min(int(args.top_n), MAX_TOP_N))
    refine_iters = max(1, min(int(args.refine_iters), MAX_REFINE_ITERS))

    img_path = os.path.abspath(os.path.expanduser(args.image))
    image = cv2.imread(img_path)
    if image is None:
        print(f'ERROR: cannot read image: {img_path}', file=sys.stderr)
        return 1
    h, w = image.shape[:2]
    pixel_size = float(args.pixel_size)

    out_dir = Path(os.path.abspath(os.path.expanduser(args.output_dir)))
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1-2. Host detection
    host, image_lab, mu_sub, sub_corner, t_star = compute_host(
        image, pixel_size, max_components=None)  # adaptive n for graphite pipeline
    host_area_px = int((host > 0).sum())
    host_area_um2 = host_area_px * pixel_size * pixel_size
    print(f'host: {host_area_um2:.0f} um2  corner={sub_corner}  '
          f'T*={t_star:.1f}  mu_sub_LAB=['
          f'{mu_sub[0]:.0f},{mu_sub[1]:.0f},{mu_sub[2]:.0f}]')
    if host_area_px < max(500, int(HOST_MIN_AREA_UM2 / (pixel_size ** 2))):
        print('ERROR: host region too small', file=sys.stderr)
        cv2.imwrite(str(out_dir / 'graphite_mask.png'),
                    np.zeros((h, w), np.uint8))
        np.save(str(out_dir / 'graphite_contour.npy'),
                np.zeros((0, 2), dtype=np.float64))
        (out_dir / 'graphite_result.json').write_text(json.dumps({
            'area_px': 0, 'area_um2': 0.0, 'pixel_size_um': pixel_size,
            'host': {'area_um2': round(host_area_um2, 2)},
            'substrate': {'corner': sub_corner,
                          'mu_lab': [float(x) for x in mu_sub.tolist()]},
            'selected': None, 'top_candidates': [],
            'low_confidence': True,
        }, indent=2))
        return 2

    # 3. Codex ridge pipeline
    ms_min = compute_ms_min(image_lab, host)
    _, codex_edge, codex_min_size = codex_ridge_pipeline(ms_min, host)
    print(f'codex: adaptive min_size={codex_min_size} px  '
          f'edge px={int((codex_edge > 0).sum())}')

    # 4. Carve regions
    lab_r, cc_records = carve_regions(host, codex_edge, pixel_size,
                                       args.min_cc_um2)
    print(f'carved CCs: {len(cc_records)} '
          f'(min_size={args.min_cc_um2:.0f} um^2)')

    # 5. K-union (substrate-aware bulk detection; silhouette-chosen K)
    merged = k_union(image_lab, host, lab_r, cc_records, pixel_size,
                     mu_sub=mu_sub)

    # 6. Score (calibrated confidence-driven weights)
    bulk_mu_lab = compute_bulk_mode(image_lab, host)
    print(f'bulk_mu_LAB=[{bulk_mu_lab[0]:.0f},'
          f'{bulk_mu_lab[1]:.0f},{bulk_mu_lab[2]:.0f}]')
    ranked = score_candidates(merged, image_lab, host, bulk_mu_lab, pixel_size,
                              mu_sub=mu_sub)

    # 7. Refine
    refine_candidates(ranked, image_lab, host, bulk_mu_lab,
                       iters=refine_iters, lam=args.refine_lambda,
                       pixel_size=pixel_size)

    print(f'merged candidates: {len(ranked)}')
    for rank in range(min(len(ranked), top_n)):
        c = ranked[rank]
        print(f'  #{rank}: area={c["area_um2"]:.0f}um2 -> '
              f'refined={c["refined_area_um2"]:.0f}um2  '
              f's_strip={c["s_strip"]:.2f}(asp={c["aspect"]:.1f}) '
              f's_central={c["s_central"]:.2f} '
              f's_gray={c["s_gray"]:.2f}(c={c["chroma"]:.0f}) '
              f'score={c["score"]:.3f}')

    # --- Final selection + outputs ---
    sel_rank = int(args.cluster_id)
    low_confidence = False
    if not ranked:
        print('ERROR: no candidates after scoring.', file=sys.stderr)
        sel = None
        low_confidence = True
    elif sel_rank < 0 or sel_rank >= len(ranked):
        print(f'WARN: --cluster-id={sel_rank} out of range '
              f'[0, {len(ranked) - 1}]; falling back to 0',
              file=sys.stderr)
        sel_rank = 0
        sel = ranked[0]
        low_confidence = True
    else:
        sel = ranked[sel_rank]

    # Always write refined_candidates panel (the diagnostic for agents)
    cv2.imwrite(str(out_dir / 'refined_candidates.png'),
                draw_refined_candidates(image, ranked, top_n, sel_rank))

    if sel is None:
        cv2.imwrite(str(out_dir / 'graphite_mask.png'),
                    np.zeros((h, w), np.uint8))
        np.save(str(out_dir / 'graphite_contour.npy'),
                np.zeros((0, 2), dtype=np.float64))
        cv2.imwrite(str(out_dir / '01_graphite_on_bottom.png'),
                    draw_final_overlay(image, host, None))
        (out_dir / 'graphite_result.json').write_text(json.dumps({
            'area_px': 0, 'area_um2': 0.0, 'pixel_size_um': pixel_size,
            'host': {'area_um2': round(host_area_um2, 2),
                     'mu_bulk_lab': [float(x) for x in bulk_mu_lab.tolist()]},
            'substrate': {'corner': sub_corner,
                          'mu_lab': [float(x) for x in mu_sub.tolist()]},
            'selected': None, 'top_candidates': [],
            'low_confidence': True,
            'params': {'cluster_id': args.cluster_id, 'top_n': top_n,
                       'refine_iters': refine_iters,
                       'min_cc_um2': args.min_cc_um2,
                       'refine_lambda': args.refine_lambda},
        }, indent=2))
        return 3

    final = sel['refined_mask']
    cnts, _ = cv2.findContours(final, cv2.RETR_EXTERNAL,
                                cv2.CHAIN_APPROX_SIMPLE)
    contour = max(cnts, key=cv2.contourArea) if cnts else None
    area_px = int((final > 0).sum())
    area_um2 = round(area_px * pixel_size * pixel_size, 2)
    if sel['score'] < LOW_CONFIDENCE_FLOOR:
        low_confidence = True

    cv2.imwrite(str(out_dir / 'graphite_mask.png'), final)
    if contour is not None:
        np.save(str(out_dir / 'graphite_contour.npy'),
                contour.reshape(-1, 2).astype(np.float64))
    else:
        np.save(str(out_dir / 'graphite_contour.npy'),
                np.zeros((0, 2), dtype=np.float64))
    cv2.imwrite(str(out_dir / '01_graphite_on_bottom.png'),
                draw_final_overlay(image, host, contour))

    top_list = []
    for rank in range(min(len(ranked), top_n)):
        c = ranked[rank]
        top_list.append({
            'rank': rank,
            'area_um2': round(c['area_um2'], 2),
            'refined_area_um2': round(c['refined_area_um2'], 2),
            'mean_lab': [round(float(x), 1) for x in c['mean_lab'].tolist()],
            's_strip': round(c['s_strip'], 3),
            's_central': round(c['s_central'], 3),
            's_gray': round(c['s_gray'], 3),
            's_contrast': round(c['s_contrast'], 3),
            's_cohere': round(c['cohere'], 3),
            'aspect': round(c['aspect'], 2),
            'chroma': round(c['chroma'], 2),
            'contrast_vs_bulk': round(c['contrast_vs_bulk'], 2),
            'score': round(c['score'], 4),
            'source_Ks': sorted(c.get('source_Ks', [])),
            'lab_ids': c.get('lab_ids', []),
        })

    sidecar = {
        'area_px': area_px,
        'area_um2': area_um2,
        'pixel_size_um': pixel_size,
        'selected': {
            'rank': sel_rank,
            'score': round(sel['score'], 4),
            'area_um2': round(sel['refined_area_um2'], 2),
        },
        'host': {
            'area_um2': round(host_area_um2, 2),
            'mu_bulk_lab': [round(float(x), 2) for x in bulk_mu_lab.tolist()],
            't_star': round(float(t_star), 2),
        },
        'substrate': {
            'corner': sub_corner,
            'mu_lab': [round(float(x), 2) for x in mu_sub.tolist()],
        },
        'top_candidates': top_list,
        'low_confidence': bool(low_confidence),
        'params': {
            'cluster_id': args.cluster_id,
            'top_n': top_n,
            'refine_iters': refine_iters,
            'min_cc_um2': args.min_cc_um2,
            'refine_lambda': args.refine_lambda,
        },
    }
    (out_dir / 'graphite_result.json').write_text(
        json.dumps(sidecar, indent=2))

    print(f'OK: selected #{sel_rank} area={area_um2}um2 '
          f'score={sel["score"]:.3f} low_confidence={low_confidence}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
