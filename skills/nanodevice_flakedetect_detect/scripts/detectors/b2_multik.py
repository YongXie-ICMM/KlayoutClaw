"""B2: Multi-K K-means + connected-component split + GT-fitted priors + Mahalanobis region-grow.

Adapted from round-2 cand-B2 graphite.py / graphene.py. The score function is
B2's joint log-likelihood (LAB + area + aspect + dist-to-host-edge for graphite).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from sklearn.cluster import KMeans

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import morph_clean, flood_fill_holes, keep_largest_n  # noqa: E402


GRAPHITE_K_CHOICES = (5, 8, 12, 16, 20)
GRAPHENE_K_CHOICES = (3, 5, 8, 12)
HARD_AREA_LO_MULT = 0.3
HARD_AREA_HI_MULT = 3.0
MIN_CANDIDATE_AREA_PX = 200


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


def _multi_k_cluster_masks(image: np.ndarray, region_mask: np.ndarray,
                           ks=GRAPHITE_K_CHOICES, random_state: int = 42,
                           min_cc_area_px: int = 200,
                           max_cc_per_cluster: int = 4) -> list[dict]:
    h, w = image.shape[:2]
    if (region_mask > 0).sum() < 100:
        return []
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    coords = np.argwhere(region_mask > 0)
    pixels = lab[coords[:, 0], coords[:, 1]].astype(np.float32)

    out = []
    for K in ks:
        if len(pixels) < K:
            continue
        km = KMeans(n_clusters=K, n_init=10, random_state=random_state)
        labels = km.fit_predict(pixels)
        for cid in range(K):
            sel = labels == cid
            if sel.sum() < 30:
                continue
            mask_k = np.zeros((h, w), dtype=np.uint8)
            sub_coords = coords[sel]
            mask_k[sub_coords[:, 0], sub_coords[:, 1]] = 255
            mask_closed = cv2.morphologyEx(
                mask_k, cv2.MORPH_CLOSE,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
            lab_center = km.cluster_centers_[cid].astype(np.float64)
            num, lbl, stats, _ = cv2.connectedComponentsWithStats(
                mask_closed, connectivity=8)
            comp_ids = list(range(1, num))
            comp_ids.sort(key=lambda i: stats[i, cv2.CC_STAT_AREA], reverse=True)
            for rank, i in enumerate(comp_ids[:max_cc_per_cluster]):
                if stats[i, cv2.CC_STAT_AREA] < min_cc_area_px:
                    continue
                cc_mask = ((lbl == i).astype(np.uint8)) * 255
                out.append({"K": K, "sub_id": cid, "cc_rank": rank,
                            "mask": cc_mask, "lab_center": lab_center})
    return out


def _score_graphite(cand: dict, priors: dict, hbn_mask: np.ndarray,
                    sdt_um: np.ndarray, pixel_size_um: float) -> dict:
    cleaned = morph_clean(cand["mask"].copy(), close_k=3, open_k=2)
    cleaned = keep_largest_n(cleaned, n=1, min_area=MIN_CANDIDATE_AREA_PX)
    cleaned = flood_fill_holes(cleaned)
    area_px = int((cleaned > 0).sum())
    if area_px < MIN_CANDIDATE_AREA_PX:
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": 0.0, "aspect": 0.0}
    area_um2 = area_px * pixel_size_um * pixel_size_um
    a_lo = priors["area_um2"]["min"] * HARD_AREA_LO_MULT
    a_hi = priors["area_um2"]["max"] * HARD_AREA_HI_MULT
    if area_um2 < a_lo or area_um2 > a_hi:
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": area_um2, "aspect": 0.0}
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
    if m["m00"] > 1e-3:
        cx, cy = m["m10"] / m["m00"], m["m01"] / m["m00"]
        cy_i = int(round(min(max(cy, 0), sdt_um.shape[0] - 1)))
        cx_i = int(round(min(max(cx, 0), sdt_um.shape[1] - 1)))
        d_um = float(sdt_um[cy_i, cx_i])
    else:
        d_um = 0.0
    log_area = _log_gauss(area_um2, priors["area_um2"]["mean"],
                          max(priors["area_um2"]["std"], 100.0))
    log_aspect = _log_gauss(aspect, priors["aspect"]["mean"],
                            max(priors["aspect"]["std"], 1.0))
    cov = np.asarray(priors["lab_centroid"]["cov"])
    cov_inv = np.linalg.inv(cov + np.eye(3) * 1e-3)
    lab_mean = np.asarray(priors["lab_centroid"]["mean"])
    log_lab = _log_mvn(lab_full, lab_mean, cov_inv)
    log_dist = _log_gauss(d_um, priors["centroid_signed_dist_um"]["mean"],
                          max(priors["centroid_signed_dist_um"]["std"], 5.0))
    score = 1.0 * log_lab + 0.3 * log_area + 2.0 * log_aspect + 0.5 * log_dist
    return {**cand, "valid": True, "cleaned_mask": cleaned, "area_um2": area_um2,
            "aspect": aspect, "score": score}


def _score_graphene(cand: dict, priors: dict, pixel_size_um: float) -> dict:
    cleaned = morph_clean(cand["mask"].copy(), close_k=5, open_k=2)
    cleaned = keep_largest_n(cleaned, n=1, min_area=MIN_CANDIDATE_AREA_PX)
    cleaned = flood_fill_holes(cleaned)
    area_px = int((cleaned > 0).sum())
    if area_px < MIN_CANDIDATE_AREA_PX:
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": 0.0, "aspect": 0.0}
    area_um2 = area_px * pixel_size_um * pixel_size_um
    a_lo = priors["area_um2"]["min"] * HARD_AREA_LO_MULT
    a_hi = priors["area_um2"]["max"] * HARD_AREA_HI_MULT
    if area_um2 < a_lo or area_um2 > a_hi:
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": area_um2, "aspect": 0.0}
    contours, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return {**cand, "valid": False, "score": -1e9, "cleaned_mask": cleaned,
                "area_um2": area_um2, "aspect": 0.0}
    largest = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(largest)
    (_, _), (rw, rh), _ = rect
    aspect = max(rw, rh) / max(min(rw, rh), 1.0)
    lab_full = cand["lab_center"]
    log_area = _log_gauss(area_um2, priors["area_um2"]["mean"],
                          max(priors["area_um2"]["std"], 100.0))
    log_aspect = _log_gauss(aspect, priors["aspect"]["mean"],
                            max(priors["aspect"]["std"], 1.0))
    cov = np.asarray(priors["lab_centroid"]["cov"])
    cov_inv = np.linalg.inv(cov + np.eye(3) * 1e-3)
    lab_mean = np.asarray(priors["lab_centroid"]["mean"])
    log_lab = _log_mvn(lab_full, lab_mean, cov_inv)
    score = 3.0 * log_lab + 0.5 * log_area + 0.3 * log_aspect
    return {**cand, "valid": True, "cleaned_mask": cleaned, "area_um2": area_um2,
            "aspect": aspect, "score": score}


def _region_grow_mahalanobis(image: np.ndarray, seed_mask: np.ndarray,
                              mahal_thresh: float, region_mask: np.ndarray,
                              iters: int = 3, dilate_px: int = 3) -> np.ndarray:
    if (seed_mask > 0).sum() < 30:
        return seed_mask
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    grown = seed_mask.copy()
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                     (2 * dilate_px + 1, 2 * dilate_px + 1))
    for _ in range(iters):
        seed_pixels = lab[grown > 0]
        if seed_pixels.shape[0] < 10:
            break
        mu = seed_pixels.mean(axis=0)
        cov = np.cov(seed_pixels.T) + np.eye(3) * 1e-2
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
                    pixel_size_um: float, priors_path: Path) -> dict:
    """B2 graphite detector. Returns {'mask': cleaned_mask}."""
    h, w = image.shape[:2]
    if hbn_mask.sum() == 0 or not priors_path.exists():
        return {"mask": np.zeros((h, w), np.uint8)}
    priors = json.loads(priors_path.read_text())
    # Region: hBN + 50 um annulus
    dilate_um = 50.0
    dilate_px = max(1, int(round(dilate_um / pixel_size_um)))
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                     (2 * dilate_px + 1, 2 * dilate_px + 1))
    region = cv2.dilate(hbn_mask, kern)
    sdt_um = signed_dist_to_boundary(hbn_mask) * pixel_size_um
    cands = _multi_k_cluster_masks(image, region, ks=GRAPHITE_K_CHOICES)
    scored = [_score_graphite(c, priors, hbn_mask, sdt_um, pixel_size_um) for c in cands]
    valid = [s for s in scored if s["valid"]]
    if not valid:
        return {"mask": np.zeros((h, w), np.uint8)}
    valid.sort(key=lambda s: s["score"], reverse=True)
    chosen = valid[0]
    seed = chosen["cleaned_mask"]
    mahal = min(float(priors["region_grow"]["mahalanobis_threshold"]), 3.0)
    grown = _region_grow_mahalanobis(image, seed, mahal_thresh=mahal,
                                     region_mask=region)
    final = morph_clean(grown, close_k=5, open_k=2)
    final = keep_largest_n(final, n=1, min_area=MIN_CANDIDATE_AREA_PX)
    final = flood_fill_holes(final)
    return {"mask": final}


def detect_graphene(image: np.ndarray, flake_mask: np.ndarray,
                    pixel_size_um: float, priors_path: Path) -> dict:
    """B2 graphene detector. Returns {'mask': cleaned_mask}."""
    h, w = image.shape[:2]
    if flake_mask.sum() == 0 or not priors_path.exists():
        return {"mask": np.zeros((h, w), np.uint8)}
    priors = json.loads(priors_path.read_text())
    cands = _multi_k_cluster_masks(image, flake_mask, ks=GRAPHENE_K_CHOICES)
    scored = [_score_graphene(c, priors, pixel_size_um) for c in cands]
    valid = [s for s in scored if s["valid"]]
    if not valid:
        return {"mask": np.zeros((h, w), np.uint8)}
    valid.sort(key=lambda s: s["score"], reverse=True)
    chosen = valid[0]
    seed = chosen["cleaned_mask"]
    seed_area_um2 = (seed > 0).sum() * pixel_size_um * pixel_size_um
    prior_area_mean = priors["area_um2"]["mean"]
    if seed_area_um2 < 0.7 * prior_area_mean:
        mahal = float(priors["region_grow"]["mahalanobis_threshold"])
        grown = _region_grow_mahalanobis(image, seed, mahal_thresh=mahal,
                                         region_mask=flake_mask)
    else:
        grown = seed
    final = morph_clean(grown, close_k=7, open_k=3)
    final = keep_largest_n(final, n=1, min_area=MIN_CANDIDATE_AREA_PX)
    final = flood_fill_holes(final)
    return {"mask": final}
