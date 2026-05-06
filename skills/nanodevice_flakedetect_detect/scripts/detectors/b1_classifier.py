"""B1: 8-feature logistic regression on per-pixel features (LAB + bg-subtracted + Sobel + dist-um).

Adapted from round-2 cand-B1 graphite.py / graphene.py. Threshold + region-grow
unchanged. Returns the cleaned candidate mask within the host region (hBN for
graphite, top-flake for graphene).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import distance_transform_edt

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import morph_clean, flood_fill_holes, keep_largest_n  # noqa: E402


def _load_classifier(path: Path) -> dict:
    with open(path) as f:
        m = json.load(f)
    return {
        "mean": np.asarray(m["mean"], dtype=np.float64),
        "std": np.asarray(m["std"], dtype=np.float64),
        "coef": np.asarray(m["coef"], dtype=np.float64),
        "intercept": float(m["intercept"]),
        "bg_sigma": float(m.get("bg_sigma", 80.0)),
    }


def _compute_features(image: np.ndarray, region_mask: np.ndarray,
                      pixel_size_um: float, bg_sigma: float) -> np.ndarray:
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


def _predict_proba(feat: np.ndarray, model: dict) -> np.ndarray:
    h, w, c = feat.shape
    X = feat.reshape(-1, c).astype(np.float64)
    Xs = (X - model["mean"]) / model["std"]
    z = Xs @ model["coef"] + model["intercept"]
    p = 1.0 / (1.0 + np.exp(-z))
    return p.reshape(h, w)


def _region_grow_prob(mask: np.ndarray, prob: np.ndarray,
                     dilate_px: int = 5, prob_thresh: float = 0.05,
                     iters: int = 2) -> np.ndarray:
    out = mask.copy()
    for _ in range(iters):
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                           (2 * dilate_px + 1, 2 * dilate_px + 1))
        dilated = cv2.dilate(out, kernel)
        out = np.where((dilated > 0) & (prob >= prob_thresh), 255, out).astype(np.uint8)
    return out


def detect(image: np.ndarray, host_mask: np.ndarray, pixel_size_um: float,
           classifier_path: Path, *, prob_thresh: float = 0.15,
           grow_thresh: float = 0.05, min_area_px: int = 200) -> dict:
    """Run B1 detector, return {'mask', 'prob'}."""
    h, w = image.shape[:2]
    if host_mask.sum() == 0 or not classifier_path.exists():
        return {"mask": np.zeros((h, w), np.uint8),
                "prob": np.zeros((h, w), np.float32)}
    model = _load_classifier(classifier_path)
    feat = _compute_features(image, host_mask, pixel_size_um, model["bg_sigma"])
    prob = _predict_proba(feat, model).astype(np.float32)
    prob_in = prob.copy()
    prob_in[host_mask == 0] = 0.0

    mask = (prob_in >= prob_thresh).astype(np.uint8) * 255
    mask = morph_clean(mask, close_k=7, open_k=3)
    mask = keep_largest_n(mask, n=1, min_area=min_area_px)
    if mask.sum() == 0:
        return {"mask": mask, "prob": prob_in}

    grown = _region_grow_prob(mask, prob_in, dilate_px=5,
                              prob_thresh=grow_thresh, iters=2)
    grown[host_mask == 0] = 0
    grown = morph_clean(grown, close_k=7, open_k=3)
    grown = keep_largest_n(grown, n=1, min_area=min_area_px)
    grown = flood_fill_holes(grown)
    return {"mask": grown, "prob": prob_in}
