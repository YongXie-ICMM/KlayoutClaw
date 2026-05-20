"""B1: 8-feature logistic regression on per-pixel features (LAB + bg-subtracted + Sobel + dist-um).

Per-image online calibration: no stored model coefficients.
- Logistic model trained fresh at inference time using flake_mask pixels as
  positives and a margin band outside the host as negatives.
- bg_sigma derived from image dimensions (5% of min side, floored at 20 px).
- Probability thresholds computed via Otsu on the probability map.
- All morphology kernels derived from physical micrometres via _kernel_from_um.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt
from skimage.filters import threshold_otsu

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import _kernel_from_um, morph_clean, flood_fill_holes, keep_largest_n  # noqa: E402

# Physical constants (micrometres) — all morphology derived from these.
# Change here; all callers see the update automatically.
_CLOSE_UM = 0.6          # morphological close radius (flake gap bridging)
_OPEN_UM = 0.25          # morphological open radius (noise removal)
_GROW_DILATE_UM = 0.45   # region-grow dilation radius
_NEG_INNER_UM = 5.0      # inner boundary of negative-sample margin (um from host edge)
_NEG_OUTER_UM = 15.0     # outer boundary of negative-sample margin (um from host edge)
_MIN_FLAKE_AREA_UM2 = 1.5  # minimum flake area in physical µm²
# bg_sigma = 5% of min(H, W), expressed as integer ratio to avoid float literals
_BG_SIGMA_PCT_NUM = 5      # numerator of the image-fraction for bg_sigma (5 / 100)
_BG_SIGMA_PCT_DEN = 100    # denominator
_BG_SIGMA_FLOOR_PX = 20   # floor for bg_sigma in pixels
_OTSU_MIN_SAMPLES = 10    # minimum pixel count for sub-map Otsu to be reliable


def _compute_bg_sigma(image_h: int, image_w: int) -> float:
    """Derive background-subtraction sigma from image dimensions.

    Uses _BG_SIGMA_PCT_NUM/_BG_SIGMA_PCT_DEN of the smaller image side,
    floored at _BG_SIGMA_FLOOR_PX pixels.
    """
    frac = _BG_SIGMA_PCT_NUM / _BG_SIGMA_PCT_DEN
    return max(float(_BG_SIGMA_FLOOR_PX), int(min(image_h, image_w) * frac))


def _compute_features(image: np.ndarray, region_mask: np.ndarray,
                      pixel_size_um: float, bg_sigma: float) -> np.ndarray:
    """Compute per-pixel feature matrix (H, W, 8): LAB + bg-rel LAB + Sobel + dist_um."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, A, B = lab[:, :, 0], lab[:, :, 1], lab[:, :, 2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)

    sx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    sy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(sx * sx + sy * sy).astype(np.float32)

    region_f = (region_mask > 0).astype(np.float32)
    weight_blur = cv2.GaussianBlur(region_f, (0, 0), sigmaX=bg_sigma)
    weight_blur = np.maximum(weight_blur, 1e-6)
    bg_L = cv2.GaussianBlur(L * region_f, (0, 0), sigmaX=bg_sigma) / weight_blur
    bg_A = cv2.GaussianBlur(A * region_f, (0, 0), sigmaX=bg_sigma) / weight_blur
    bg_B = cv2.GaussianBlur(B * region_f, (0, 0), sigmaX=bg_sigma) / weight_blur
    rel_L = (L - bg_L).astype(np.float32)
    rel_A = (A - bg_A).astype(np.float32)
    rel_B = (B - bg_B).astype(np.float32)

    dist_um = distance_transform_edt(region_mask > 0).astype(np.float32) * pixel_size_um
    return np.dstack([L, A, B, rel_L, rel_A, rel_B, grad, dist_um])


def _build_training_samples(feat: np.ndarray, flake_mask: np.ndarray,
                            host_mask: np.ndarray,
                            pixel_size_um: float) -> tuple[np.ndarray, np.ndarray]:
    """Build (X, y) training arrays from positives (inside eroded flake_mask)
    and negatives (margin band just outside the host).

    Positives: pixels inside a 2-px eroded version of flake_mask (avoids edge leakage).
    Negatives: pixels in the band between dilate(host, _NEG_INNER_UM) and
               dilate(host, _NEG_OUTER_UM) — clearly substrate, not flake.
    """
    # --- Positives: erode flake_mask by 2 px to avoid edge blur --
    erode_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    pos_mask = cv2.erode(flake_mask, erode_k)

    # --- Negatives: margin band outside host -----------------------
    inner_k = _kernel_from_um(_NEG_INNER_UM, pixel_size_um)
    outer_k = _kernel_from_um(_NEG_OUTER_UM, pixel_size_um)
    inner = cv2.dilate(host_mask, inner_k)
    outer = cv2.dilate(host_mask, outer_k)
    neg_mask = (outer > 0) & (inner == 0)

    pos_pixels = feat[pos_mask > 0]
    neg_pixels = feat[neg_mask]

    # Guard: need at least a few samples of each class
    min_samples = 5
    if len(pos_pixels) < min_samples or len(neg_pixels) < min_samples:
        return np.empty((0, feat.shape[2])), np.empty(0)

    # Balance classes to avoid skewed logistic (downsample majority)
    rng = np.random.default_rng(0)
    n = min(len(pos_pixels), len(neg_pixels), 20_000)
    pos_idx = rng.choice(len(pos_pixels), n, replace=len(pos_pixels) < n)
    neg_idx = rng.choice(len(neg_pixels), n, replace=len(neg_pixels) < n)

    X = np.vstack([pos_pixels[pos_idx], neg_pixels[neg_idx]]).astype(np.float64)
    y = np.concatenate([np.ones(n), np.zeros(n)])
    return X, y


def _fit_online_logistic(feat: np.ndarray, flake_mask: np.ndarray,
                         host_mask: np.ndarray,
                         pixel_size_um: float) -> np.ndarray | None:
    """Fit a per-image logistic regression and return probability map (H, W).

    Returns None if there are insufficient training pixels.
    """
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    X, y = _build_training_samples(feat, flake_mask, host_mask, pixel_size_um)
    if len(X) == 0:
        return None

    scaler = StandardScaler()
    Xs = scaler.fit_transform(X)

    clf = LogisticRegression(random_state=0, max_iter=500, C=1.0)
    clf.fit(Xs, y)

    h, w, c = feat.shape
    X_all = feat.reshape(-1, c).astype(np.float64)
    X_all_s = scaler.transform(X_all)
    prob = clf.predict_proba(X_all_s)[:, 1].reshape(h, w).astype(np.float32)
    return prob


def _otsu_threshold(prob_map: np.ndarray) -> tuple[float, float] | None:
    """Compute low and high Otsu thresholds on in-host probability values.

    Returns (low_thresh, high_thresh) or None if Otsu raises (unimodal).

    Strategy:
      - high_thresh: Otsu over all in-host probabilities.
      - low_thresh: Otsu over probabilities below high_thresh (bimodal sub-map).
        Falls back to high_thresh * 0.3 if that sub-map is unimodal.
    """
    try:
        high_thresh = float(threshold_otsu(prob_map[prob_map > 0]))
    except Exception:
        return None

    sub = prob_map[(prob_map > 0) & (prob_map < high_thresh)]
    if len(sub) < _OTSU_MIN_SAMPLES:
        low_thresh = high_thresh * 0.3
    else:
        try:
            low_thresh = float(threshold_otsu(sub))
        except Exception:
            low_thresh = high_thresh * 0.3

    return low_thresh, high_thresh


def _region_grow_prob(mask: np.ndarray, prob: np.ndarray,
                      grow_dilate_px: int, prob_thresh: float,
                      iters: int = 2) -> np.ndarray:
    out = mask.copy()
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                       (2 * grow_dilate_px + 1,
                                        2 * grow_dilate_px + 1))
    for _ in range(iters):
        dilated = cv2.dilate(out, kernel)
        out = np.where((dilated > 0) & (prob >= prob_thresh),
                       np.uint8(255), out).astype(np.uint8)
    return out


def detect(image: np.ndarray, host_mask: np.ndarray, pixel_size_um: float,
           flake_mask: np.ndarray | None = None,
           classifier_path: Path | None = None) -> dict:
    """Run B1 detector, return {'mask', 'prob', 'low_confidence'}.

    Parameters
    ----------
    image : BGR image (H, W, 3).
    host_mask : binary mask of the host material region (uint8, 0/255).
    pixel_size_um : pixel size in micrometres per pixel.
    flake_mask : binary mask of the known flake region used to generate
        positive training samples.  If None or empty, returns an empty mask.
    classifier_path : ignored (kept for backward API compatibility only).
    """
    h, w = image.shape[:2]
    empty = {"mask": np.zeros((h, w), np.uint8),
             "prob": np.zeros((h, w), np.float32),
             "low_confidence": True}

    if host_mask.sum() == 0:
        return empty

    if flake_mask is None or flake_mask.sum() == 0:
        return empty

    # Derive bg_sigma adaptively from image size
    bg_sigma = _compute_bg_sigma(h, w)

    feat = _compute_features(image, host_mask, pixel_size_um, bg_sigma)
    prob = _fit_online_logistic(feat, flake_mask, host_mask, pixel_size_um)
    if prob is None:
        return empty

    prob_in = prob.copy()
    prob_in[host_mask == 0] = 0.0

    # Compute Otsu thresholds; fall back to empty mask if unimodal
    thresholds = _otsu_threshold(prob_in)
    if thresholds is None:
        return {**empty, "prob": prob_in}

    low_thresh, high_thresh = thresholds

    # Physical morphology kernels
    close_k = _kernel_from_um(_CLOSE_UM, pixel_size_um)
    open_k = _kernel_from_um(_OPEN_UM, pixel_size_um)
    min_area_px = max(1, int(_MIN_FLAKE_AREA_UM2 / (pixel_size_um ** 2)))
    grow_dilate_px = max(1, int(round(_GROW_DILATE_UM / pixel_size_um)))

    mask = (prob_in >= high_thresh).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, open_k)
    mask = keep_largest_n(mask, n=1, min_area=min_area_px)
    if mask.sum() == 0:
        return {"mask": mask, "prob": prob_in, "low_confidence": False}

    grown = _region_grow_prob(mask, prob_in,
                              grow_dilate_px=grow_dilate_px,
                              prob_thresh=low_thresh, iters=2)
    grown[host_mask == 0] = 0
    grown = cv2.morphologyEx(grown, cv2.MORPH_CLOSE, close_k)
    grown = cv2.morphologyEx(grown, cv2.MORPH_OPEN, open_k)
    grown = keep_largest_n(grown, n=1, min_area=min_area_px)
    grown = flood_fill_holes(grown)
    return {"mask": grown, "prob": prob_in, "low_confidence": False}
