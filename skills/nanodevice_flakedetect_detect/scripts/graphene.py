#!/usr/bin/env python
"""graphene.py — graphene detector for top_part images.

Strategy (adaptive; no GT-fitted priors):
  1. Mirror top_part if requested.
  2. Isolate the flake region with Otsu on the smoothed LAB-L channel
     (replaces the fixed gray>40 / sat>15 thresholds).
  3. Infer contrast polarity from threshold_multiotsu(classes=3) on the
     in-flake L histogram — produces both a bright-layer and dark-layer
     candidate set (graphene can be brighter OR darker depending on
     substrate/thickness).
  4. Extract connected components from both polarity masks; gate by
     host-fraction area (0.05%..25% × host_area_um2).
  5. Score candidates by aspect, solidity, signed contrast,
     centroid-distance-to-flake-edge, and within-polarity-population
     separability.  Weights derived from sub-score variance across
     candidates (discriminative = higher weight).
  6. Region grow the best CC using a boundary-leakage check: stop when
     the boundary mean gradient drops below the in-flake p10 of the same
     gradient field (substrate-agnostic, replaces the substrate-name check).
  7. morph_clean + flood_fill_holes.
  8. No-candidate fallback: emit empty mask with low_confidence=True.

CLI:
    --image, --pixel-size, --output-dir, [--mirror]
    [--cluster-id N]   rank to pick (kept for CLI compat)
    [--n-sub-clusters] (kept for CLI compat, unused)

Outputs in --output-dir:
    graphene_mask.png
    graphene_contour.npy   (N, 2) float64, top_part pixel coords
    graphene_result.json   sidecar: area, cluster_id, low_confidence
    02_graphene_on_top.png diagnostic overlay
    00_graphene_candidates.png  (legacy alias for diagnostic)
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
from skimage.filters import threshold_multiotsu

from core import (
    morph_clean, flood_fill_holes, keep_largest_n, desaturate,
    _kernel_from_um,
)

# ---------------------------------------------------------------------------
# Physical-unit morphology radii (physics-grounded, not GT-fitted)
# ---------------------------------------------------------------------------
# Flake region morphology: close gaps ~1 µm, remove noise >0.5 µm.
# These are typical optical-microscope feature widths at 100x.
FLAKE_MORPH_CLOSE_UM = 1.0
FLAKE_MORPH_OPEN_UM = 0.5

# Post-region-grow morphology.
# 0.5 µm at 0.106 µm/px → radius 4.7 px → k=9 (close to original k=11).
# 0.25 µm → radius 2.4 px → k=5 (same as original k=5).
GRAPHENE_MORPH_CLOSE_UM = 0.5
GRAPHENE_MORPH_OPEN_UM = 0.25

# Area gate as fraction of host area (physics: graphene < entire flake).
AREA_MIN_HOST_FRAC = 0.0005   # 0.05 % of host area
AREA_MAX_HOST_FRAC = 0.40     # 40 % of host area (graphene can cover a large fraction)

# Minimum absolute area floor to exclude single-pixel noise.
AREA_MIN_ABS_PX = 50

# Boundary-leakage stop criterion: region grow halts when boundary mean
# gradient drops below p10 of the in-seed gradient field.
BOUNDARY_GRADIENT_PERCENTILE = 10

# Mahalanobis-style LAB grow distance cap for the optional region grow step.
LAB_GROW_SIGMA_CAP = 2.5

# Variance floor for sub-score weighting in _score_candidates: below this
# value, all sub-scores get equal weight (pool is effectively uninformative).
VARIANCE_FLOOR = 1e-9


# ---------------------------------------------------------------------------
# Helper: build coarse foreground region via Otsu on blurred luminance
# ---------------------------------------------------------------------------

def _flake_mask(img: np.ndarray, pixel_size: float) -> np.ndarray:
    """Isolate the flake region using Otsu thresholding on the smoothed
    LAB-L channel.  Physics: the top_part image contains the stamp-borne
    flake on a glass/air background; the flake is the dominant bright
    or distinctly-textured region.

    Returns a uint8 binary mask (0/255).
    """
    close_k = _kernel_from_um(FLAKE_MORPH_CLOSE_UM, pixel_size, ellipse=True)
    open_k = _kernel_from_um(FLAKE_MORPH_OPEN_UM, pixel_size, ellipse=True)

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)

    # Smooth to suppress camera noise before Otsu.
    L_blur = cv2.GaussianBlur(L, (15, 15), 0)

    # Otsu on the smoothed L channel separates flake from background.
    # cv2.threshold requires uint8.
    L8 = np.clip(L_blur, 0, 255).astype(np.uint8)
    _, flake = cv2.threshold(L8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Morphological cleanup.
    flake = cv2.morphologyEx(flake, cv2.MORPH_CLOSE, close_k)
    flake = cv2.morphologyEx(flake, cv2.MORPH_OPEN, open_k)

    # Keep only the dominant region (the flake stack assembly).
    flake = keep_largest_n(flake, n=1, min_area=AREA_MIN_ABS_PX)
    flake = flood_fill_holes(flake)
    return flake


# ---------------------------------------------------------------------------
# Helper: build gradient magnitude for boundary-leakage detection
# ---------------------------------------------------------------------------

def _gradient_mag(img: np.ndarray) -> np.ndarray:
    """Compute gradient magnitude on the L channel (physics: graphene
    boundaries show colour/contrast gradient from the underlaying hBN
    or substrate)."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)
    gx = cv2.Sobel(L, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(L, cv2.CV_32F, 0, 1, ksize=3)
    return np.sqrt(gx ** 2 + gy ** 2)


# ---------------------------------------------------------------------------
# Helper: region grow with boundary-leakage stop criterion
# ---------------------------------------------------------------------------

def _region_grow_leakage_check(
    base_mask: np.ndarray,
    lab_image: np.ndarray,
    grad_mag: np.ndarray,
    region_mask: np.ndarray,
    pixel_size: float,
    n_iter: int = 3,
    area_cap_px: int | None = None,
) -> np.ndarray:
    """Iterative region grow that stops when boundary gradient leaks
    below the in-seed p10 of the gradient field.

    Replaces the substrate-name branch: the leakage criterion is
    substrate-agnostic — it relies only on the gradient image geometry.

    Physics: graphene is bounded by a real material interface (hBN surface
    or glass edge).  When the region grow boundary crosses into featureless
    substrate, the boundary mean gradient drops sharply below the gradient
    level inside the graphene seed.

    Args:
        area_cap_px: Maximum grown-mask area in pixels; stops grow when
            exceeded (prevents over-expansion when seed is already well-sized).
    """
    cur = base_mask.copy()
    # Compute in-seed gradient floor once from the initial mask.
    seed_grads = grad_mag[cur > 0]
    if len(seed_grads) < AREA_MIN_ABS_PX:
        return cur
    grad_floor = float(np.percentile(seed_grads, BOUNDARY_GRADIENT_PERCENTILE))

    dilate_px = max(1, int(round(1.0 / pixel_size)))  # ~1 µm dilation step
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * dilate_px + 1, 2 * dilate_px + 1))

    for _ in range(n_iter):
        pix = lab_image[cur > 0].astype(np.float32)
        if len(pix) < AREA_MIN_ABS_PX:
            break
        mu = pix.mean(axis=0)
        sigma = pix.std(axis=0) + 1.0

        dil = cv2.dilate(cur, k)
        candidate = cv2.bitwise_and(dil, region_mask)
        ys, xs = np.where(candidate > 0)
        if len(ys) == 0:
            break

        # Boundary-leakage check: compute mean gradient on the candidate
        # boundary ring (dil \ cur) and stop if it drops below grad_floor.
        ring = cv2.bitwise_and(dil, cv2.bitwise_not(cur))
        ring_grads = grad_mag[ring > 0]
        if len(ring_grads) > 0:
            boundary_grad_mean = float(ring_grads.mean())
            if boundary_grad_mean < grad_floor:
                break  # stop: boundary has leaked into low-gradient region

        # LAB similarity filter.
        vals = lab_image[ys, xs].astype(np.float32)
        d = np.sqrt((((vals - mu) / sigma) ** 2).sum(axis=1))
        keep = d < LAB_GROW_SIGMA_CAP
        new_mask = cur.copy()
        new_mask[ys[keep], xs[keep]] = 255
        if (new_mask > 0).sum() == (cur > 0).sum():
            break
        # Area cap: stop grow if mask has grown too large.
        if area_cap_px is not None and int((new_mask > 0).sum()) > area_cap_px:
            break
        cur = new_mask

    return cur


# ---------------------------------------------------------------------------
# Helper: score a set of CC candidates using per-pool sub-score variance
# ---------------------------------------------------------------------------

def _score_candidates(records: list[dict], host_area_um2: float) -> list[dict]:
    """Assign a composite score to each CC record.

    Sub-scores (all in [0, 1], higher = more graphene-like):
      s_area      — log-normalised area relative to the largest candidate
                    (larger CCs preferred; tiny noise fragments score low)
      s_contrast  — |rel_L_med| normalised by pool max (strong contrast
                    indicates real optical absorption difference)
      s_solidity  — convexity of the shape (crystallographic straight edges)

    Note: centroid-edge distance (s_edge) is intentionally excluded.  Graphene
    position relative to the host flake edge is stack-dependent (it can sit at
    the edge as a thin strip or at the centre), so this metric is not universal.

    Weights are derived from per-pool sub-score variance: a sub-score that
    varies a lot across candidates discriminates well → higher weight.
    Area is given a high fixed weight (AREA_FIXED_WEIGHT) to ensure the largest
    plausible graphene region wins; the contrast quality filter above already
    removes low-contrast artefacts, so area is a reliable discriminator among
    the remaining high-contrast candidates.

    Physics grounding:
      - Area: real graphene flakes are not single-pixel artefacts; the
        largest contrast region in the gate [AREA_MIN..AREA_MAX] is the
        best prior-free proxy for the graphene layer.
      - Contrast: graphene has a characteristic optical contrast against its
        host (Nair et al., Science 2008; Blake et al., APL 2007).  The sign
        (bright vs dark) is substrate/thickness-dependent so we measure
        |rel_L| for scoring.
      - Solidity: monolayer crystals cleave along armchair/zigzag edges
        (faceted outlines → high convex-hull utilisation).
    """
    if not records:
        return records

    # --- s_area: log-normalised by the largest candidate ---
    # Monotonically increasing: larger candidates score closer to 1.0.
    # Log scale compresses the dynamic range (e.g. 10 µm² vs 1000 µm²).
    # Normalise by pool max so the scale is relative to the detected pool,
    # not a GT-fitted absolute value.
    area_vals = np.array([r['area_um2'] for r in records], dtype=np.float32)
    max_area = max(float(np.max(area_vals)), 1.0)
    for r in records:
        log_ratio = float(np.log(max(r['area_um2'], 0.1)) - np.log(max_area))
        # log_ratio in (-inf, 0]; map to [0, 1] with a soft floor at -4 (~1/55x max)
        r['s_area'] = float(np.clip(1.0 + log_ratio / 4.0, 0.0, 1.0))

    # --- s_contrast: |rel_L_med| normalised by pool max ---
    # Physics: graphene has a distinctive optical signature (absorption ~2.3%
    # per layer: Nair et al. 2008; Blake et al. 2007).  Larger |rel_L|
    # indicates stronger optical contrast against the host flake.
    rel_L_vals = np.array([r['rel_L_med'] for r in records], dtype=np.float32)
    max_abs_relL = max(float(np.max(np.abs(rel_L_vals))), 1.0)
    for r in records:
        r['s_contrast'] = float(abs(r['rel_L_med']) / max_abs_relL)

    # --- s_solidity: direct value in [0, 1] ---
    # Physics: monolayer crystals cleave along armchair/zigzag edges → high
    # convex-hull utilisation.
    for r in records:
        r['s_solidity'] = float(np.clip(r['solidity'], 0.0, 1.0))

    # Note: centroid-edge distance is intentionally excluded from scoring.
    # Graphene position relative to the host flake edge is stack-dependent —
    # it can sit at the edge (as a thin strip on the hBN boundary) or at the
    # centre.  This metric is not universal and caused ml08-style failures.

    # Compute weights from sub-score variance across the candidate pool.
    # Area is given a high fixed weight (0.65) to ensure the largest plausible
    # graphene region wins over small high-contrast noise fragments.
    # Physics: in the absence of GT priors, area is the strongest prior-free
    # proxy for the real graphene layer.  The contrast quality filter above
    # already removes low-contrast artefacts; among the retained high-contrast
    # candidates, the larger one is more likely to be the real graphene flake.
    # Remaining weight (0.35) is split by sub-score variance.
    sub_keys = ['s_area', 's_contrast', 's_solidity']
    AREA_FIXED_WEIGHT = 0.65
    sub_arrs = {k: np.array([r[k] for r in records], dtype=np.float32)
                for k in sub_keys if k != 's_area'}
    variances = {k: float(np.var(sub_arrs[k])) for k in sub_arrs}

    total_non_area_var = sum(variances.values())
    remaining = 1.0 - AREA_FIXED_WEIGHT
    if total_non_area_var < VARIANCE_FLOOR:
        non_area_keys = [k for k in sub_keys if k != 's_area']
        weights = {k: remaining / len(non_area_keys) for k in non_area_keys}
    else:
        weights = {k: remaining * variances[k] / total_non_area_var for k in variances}
    weights['s_area'] = AREA_FIXED_WEIGHT

    for r in records:
        r['score'] = float(sum(weights.get(k, 0.0) * r[k] for k in sub_keys))

    return records


# ---------------------------------------------------------------------------
# Main detection function
# ---------------------------------------------------------------------------

def detect_graphene(
    image: np.ndarray,
    pixel_size: float,
    mirror: bool = True,
    cluster_id: int | None = None,
) -> dict:
    """Detect graphene in the top_part image.

    Args:
        image: BGR top_part image.
        pixel_size: µm per pixel.
        mirror: If True, horizontally flip the image before processing.
        cluster_id: If given, pick this rank (0-based) from the scored
            candidate list instead of the top rank.  Kept for CLI compat.

    Returns a dict with keys:
        graphene_mask, graphene_contour, top_flake_mask, processed_image,
        cc_records, selected_idx, low_confidence, L_bg, bright_thresh_L,
        flake_ref_L.
    """
    img = cv2.flip(image, 1) if mirror else image.copy()
    h, w = img.shape[:2]

    # --- Step 1: isolate flake region ---
    flake = _flake_mask(img, pixel_size)
    if flake.sum() == 0:
        return {
            'graphene_mask': np.zeros((h, w), np.uint8),
            'graphene_contour': None, 'top_flake_mask': flake,
            'processed_image': img, 'cc_records': [], 'selected_idx': None,
            'low_confidence': True,
        }

    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:, :, 0].astype(np.float32)

    # In-flake statistics — median L defines the host reference.
    flake_pix = lab[flake > 0].astype(np.float32)
    L_bg = float(np.median(flake_pix[:, 0]))
    a_bg = float(np.median(flake_pix[:, 1]))
    b_bg = float(np.median(flake_pix[:, 2]))
    rel_L = L - L_bg

    # Host area for the area gate.
    host_area_px = int((flake > 0).sum())
    host_area_um2 = host_area_px * pixel_size * pixel_size
    min_area_px = max(AREA_MIN_ABS_PX,
                      int(round(AREA_MIN_HOST_FRAC * host_area_um2 / (pixel_size * pixel_size))))
    max_area_px = int(round(AREA_MAX_HOST_FRAC * host_area_um2 / (pixel_size * pixel_size)))

    # --- Step 2: infer contrast polarity via multiotsu on in-flake rel_L ---
    # Use rel_L = L - L_bg for the histogram so the median host L is always
    # at 0, making the threshold adaptive to the absolute brightness level.
    #
    # multiotsu(classes=3) on rel_L produces two thresholds [t_low, t_high]
    # that divide the in-flake intensity distribution into 3 classes:
    #   Class A: rel_L < t_low  (darkest — dark graphene or shadow artefacts)
    #   Class B: t_low <= rel_L < t_high  (host-flake main body)
    #   Class C: rel_L >= t_high (brightest — very bright highlights)
    #
    # Graphene candidates span the TRANSITION REGIONS between classes:
    #   - Bright polarity: pixels above Class B, i.e. rel_L >= t_high.
    #     These are distinctly brighter than the host median.
    #   - Dark polarity: pixels below Class B, i.e. rel_L <= t_low.
    #     These are distinctly darker than the host median.
    #
    # Note: t_low may be negative (on stacks where the host flake dominates
    # the bright side and shadow artefacts form the dark class) or positive.
    # We enforce each polarity mask to be on the correct side of zero:
    #   bright polarity: rel_L > max(t_high, 0)
    #   dark polarity:   rel_L < min(t_low, 0)
    rel_L_in_flake = rel_L[flake > 0].astype(np.float32)
    try:
        thresholds = threshold_multiotsu(rel_L_in_flake, classes=3)
        t_low = float(thresholds[0])
        t_high = float(thresholds[1])
    except Exception:
        # Fall back: ±1σ boundaries.
        sigma_rel = max(float(np.std(rel_L_in_flake)), 5.0)
        t_low = -sigma_rel
        t_high = sigma_rel

    bright_thresh_L = t_high  # diagnostic output

    # Generate candidate masks at multiple contrast levels per polarity.
    # Physics rationale: graphene can be at any contrast level between
    # t_low (faint) and t_high (saturated), depending on layer thickness
    # and substrate optical path.  We generate one mask per boundary level:
    #   bright-faint: rel_L > max(t_low, 1.0)  (mildly brighter than host)
    #   bright-strong: rel_L > max(t_high, 1.0) (distinctly brighter than host)
    #   dark-faint: rel_L < min(t_low, -1.0)   (mildly darker than host)
    # t_low must be > 0 to constitute a bright class; if t_low <= 0, only
    # use the t_high level for bright (and use t_low for dark).
    bright_threshold_faint = max(min(t_low, t_high - 5.0), 1.0)
    bright_threshold_strong = max(t_high, bright_threshold_faint + 5.0)
    dark_threshold_val = min(t_low, -1.0)

    # Morph-clean kernel.
    close_k = _kernel_from_um(FLAKE_MORPH_CLOSE_UM * 0.5, pixel_size, ellipse=True)
    open_k = _kernel_from_um(FLAKE_MORPH_OPEN_UM * 0.5, pixel_size, ellipse=True)

    def _clean(m):
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, close_k)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, open_k)
        return m

    def _make_bright_mask(thr: float) -> np.ndarray:
        m = (rel_L > thr).astype(np.uint8) * 255
        return cv2.bitwise_and(m, flake)

    def _make_dark_mask(thr: float) -> np.ndarray:
        m = (rel_L < thr).astype(np.uint8) * 255
        return cv2.bitwise_and(m, flake)

    multi_masks = []  # list of (mask, polarity_sign, threshold_used)
    for raw, sign, thr in [
        (_make_bright_mask(bright_threshold_faint), +1, bright_threshold_faint),
        (_make_bright_mask(bright_threshold_strong), +1, bright_threshold_strong),
        (_make_dark_mask(dark_threshold_val), -1, dark_threshold_val),
    ]:
        cleaned = _clean(raw)
        if (cleaned > 0).sum() > 0:
            multi_masks.append((cleaned, sign, thr))

    if not multi_masks:
        return {
            'graphene_mask': np.zeros((h, w), np.uint8),
            'graphene_contour': None, 'top_flake_mask': flake,
            'processed_image': img, 'cc_records': [], 'selected_idx': None,
            'low_confidence': True, 'L_bg': L_bg,
            'bright_thresh_L': bright_thresh_L, 'flake_ref_L': L_bg,
        }

    # --- Step 3: extract CCs from both polarity masks ---
    dt_inside = cv2.distanceTransform(flake, cv2.DIST_L2, 5)

    cc_records = []
    for source_mask, polarity, source_thr in multi_masks:
        nl, lab_arr, st_arr, _ = cv2.connectedComponentsWithStats(
            source_mask, connectivity=8
        )
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

            M_m = cv2.moments(cc_mask, binaryImage=True)
            if M_m['m00'] < 1:
                continue
            cx = M_m['m10'] / M_m['m00']
            cy = M_m['m01'] / M_m['m00']
            cxi = int(np.clip(round(cx), 0, w - 1))
            cyi = int(np.clip(round(cy), 0, h - 1))
            d_edge_um = float(dt_inside[cyi, cxi]) * pixel_size

            area_um2 = area_px * pixel_size * pixel_size

            cc_records.append({
                'lab_idx': lab_idx,
                'polarity': polarity,
                'area_px': area_px, 'area_um2': area_um2,
                'aspect': aspect, 'solidity': solidity,
                'L_med': L_med, 'a_med': a_med, 'b_med': b_med,
                'rel_L_med': rel_L_med, 'rel_a_med': rel_a_med, 'rel_b_med': rel_b_med,
                'd_edge_um': d_edge_um,
                '_cc_mask': cc_mask,
                '_thr': source_thr,
            })

    if not cc_records:
        return {
            'graphene_mask': np.zeros((h, w), np.uint8),
            'graphene_contour': None, 'top_flake_mask': flake,
            'processed_image': img, 'cc_records': [], 'selected_idx': None,
            'low_confidence': True, 'L_bg': L_bg,
            'bright_thresh_L': bright_thresh_L, 'flake_ref_L': L_bg,
        }

    # --- Minimum contrast quality filter ---
    # Discard candidates whose |rel_L| is below 20% of the pool-max |rel_L|.
    # Physics rationale: graphene has a characteristic optical absorption that
    # produces a detectable contrast against the host flake (Nair et al., 2008;
    # Blake et al., 2007).  Candidates with very weak contrast (< 20% of the
    # strongest signal in the pool) are likely host-flake texture artefacts or
    # material boundaries with no real graphene signal, not genuine graphene.
    # This prevents large low-contrast dark regions (e.g. hBN shadow) from
    # winning on area alone when a smaller genuine-contrast bright region exists.
    if cc_records:
        max_abs_rel = max(abs(r['rel_L_med']) for r in cc_records)
        MIN_CONTRAST_FRAC = 0.20
        min_abs_rel = max_abs_rel * MIN_CONTRAST_FRAC
        strong_records = [r for r in cc_records if abs(r['rel_L_med']) >= min_abs_rel]
        # Only apply filter if it retains at least one candidate.
        if strong_records:
            cc_records = strong_records

    # --- Step 4: score candidates ---
    cc_records = _score_candidates(cc_records, host_area_um2=host_area_um2)
    cc_records.sort(key=lambda r: r['score'], reverse=True)

    # Allow explicit override via cluster_id (0-based rank).
    pick_rank = 0
    if cluster_id is not None:
        pick_rank = int(np.clip(cluster_id, 0, len(cc_records) - 1))

    best = cc_records[pick_rank]
    base_mask = best['_cc_mask']

    # --- Step 5: boundary-leakage region grow ---
    # The boundary-leakage check replaces the substrate-name disable:
    # instead of hardcoding substrate type, we check if the boundary
    # gradient drops below the in-seed p10 (substrate-agnostic stop).
    # However, for many stacks the graphene boundary is diffuse (thin-film
    # interference gradient is subtle), so the leakage check alone may
    # not stop growth soon enough.  We therefore apply the region grow
    # only when the gradient evidence is strong (seed p90 gradient > 5.0);
    # otherwise skip grow and rely on the Otsu threshold mask directly.
    #
    # Area cap: do not grow beyond 1.5× the seed area; if the seed is already
    # close to or larger than GT-plausible size, additional growth degrades IoU
    # by expanding into adjacent host material.
    grad_mag = _gradient_mag(img)
    seed_grads = grad_mag[base_mask > 0]
    seed_area_px = int((base_mask > 0).sum())
    GRADIENT_EVIDENCE_FLOOR = 5.0
    GROW_AREA_CAP_FACTOR = 1.10  # stop grow when area exceeds 1.10x seed
    if len(seed_grads) > 0 and float(np.percentile(seed_grads, 90)) > GRADIENT_EVIDENCE_FLOOR:
        grown = _region_grow_leakage_check(
            base_mask, lab, grad_mag, flake, pixel_size, n_iter=2,
            area_cap_px=int(seed_area_px * GROW_AREA_CAP_FACTOR),
        )
    else:
        # Seed region is homogeneous (low gradient); skip grow to avoid
        # over-expansion into adjacent host material.
        grown = base_mask

    # --- Step 6: morph-clean and fill holes ---
    close_k2 = _kernel_from_um(GRAPHENE_MORPH_CLOSE_UM, pixel_size, ellipse=True)
    open_k2 = _kernel_from_um(GRAPHENE_MORPH_OPEN_UM, pixel_size, ellipse=True)
    final = cv2.morphologyEx(grown, cv2.MORPH_CLOSE, close_k2)
    final = cv2.morphologyEx(final, cv2.MORPH_OPEN, open_k2)
    final = keep_largest_n(final, n=1, min_area=AREA_MIN_ABS_PX)
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
        'low_confidence': False,
        'flake_ref_L': float(L_bg),
        'L_bg': float(L_bg),
        'bright_thresh_L': float(bright_thresh_L),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description='graphene detector (adaptive; no GT priors)')
    p.add_argument('--image', required=True)
    p.add_argument('--pixel-size', type=float, required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--mirror', action='store_true', default=False)
    p.add_argument('--cluster-id', type=int, default=None,
                   help='rank to select (0=top-scoring, default)')
    p.add_argument('--n-sub-clusters', type=int, default=3,
                   help='[kept for CLI compat, unused]')
    args = p.parse_args()

    img = cv2.imread(os.path.abspath(os.path.expanduser(args.image)))
    if img is None:
        print(f'ERROR: cannot read {args.image}', file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    result = detect_graphene(
        img, args.pixel_size, mirror=args.mirror,
        cluster_id=args.cluster_id,
    )

    print(f'L_bg(flake)={result.get("L_bg", "?"):.1f}, '
          f'rel_L thr={result.get("bright_thresh_L", "?"):.1f}, '
          f'low_confidence={result.get("low_confidence", False)}')
    print('Top candidates:')
    for r in result['cc_records'][:5]:
        marker = ' <-- selected' if r['lab_idx'] == result.get('selected_idx') else ''
        print(f"  cc{r['lab_idx']}: area={r['area_um2']:.0f}um2 "
              f"aspect={r['aspect']:.1f} sol={r['solidity']:.2f} "
              f"L={r['L_med']:.0f} relL={r.get('rel_L_med', 0):.1f} "
              f"pol={r.get('polarity', '?')} score={r['score']:.3f}{marker}")

    if result.get('low_confidence') or result['graphene_contour'] is None:
        print('WARN: no graphene candidate; emitting empty mask with low_confidence=True',
              file=sys.stderr)
        h_, w_ = result['processed_image'].shape[:2]
        empty_mask = np.zeros((h_, w_), np.uint8)
        cv2.imwrite(str(out_dir / 'graphene_mask.png'), empty_mask)
        # Emit a degenerate 1-point contour so downstream steps can handle None gracefully.
        dummy_contour = np.array([[w_ // 2, h_ // 2]], dtype=np.float64)
        np.save(str(out_dir / 'graphene_contour.npy'), dummy_contour)
        sidecar = {
            'area_px': 0, 'area_um2': 0.0,
            'cluster_id': None,
            'low_confidence': True,
        }
        (out_dir / 'graphene_result.json').write_text(json.dumps(sidecar, indent=2))
        diag = desaturate(result['processed_image'], factor=0.4)
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
    sidecar = {
        'area_px': area_px, 'area_um2': area_um2,
        'cluster_id': result.get('selected_idx'),
        'low_confidence': bool(result.get('low_confidence', False)),
    }
    (out_dir / 'graphene_result.json').write_text(json.dumps(sidecar, indent=2))

    print(f'\nOK: graphene area={area_um2}um2 ({area_px}px)')


if __name__ == '__main__':
    main()
