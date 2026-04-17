#!/usr/bin/env python
"""Build target footprint via shape-guided K-means + GrabCut.

SIFT-aligns bottom_part to target, computes LAB diff image, K-means on
intensity, filters by brightness to isolate the top-placed flake from
the substrate. Cluster subsets are enumerated and ranked by shape
similarity to the source flake. GrabCut refines edges on the original
color target image.

Usage:
    conda run -n instrMCPdev python footprint.py \
        --source <source_image> --target <target_image> \
        --bottom <bottom_part_image> \
        [--mirror] --pixel-size <um/px> --output-dir <path>
"""

import argparse
import json
import math
import os
import sys
from itertools import combinations

import cv2
import numpy as np
from sklearn.cluster import KMeans

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "nanodevice_flakedetect", "scripts"))
from core import morph_clean, flood_fill_holes, keep_largest_n, mask_centroid


# ---------------------------------------------------------------------------
# SIFT alignment (from sift_align.py)
# ---------------------------------------------------------------------------

def sift_align(bottom_img, target_img, n_features=5000, ratio_thresh=0.7):
    """SIFT-align bottom_part to target (same-substrate).

    Returns:
        warp_matrix: 2x3 affine matrix (bottom→target), or None on failure.
        n_inliers: number of RANSAC inliers.
    """
    gray_bot = cv2.cvtColor(bottom_img, cv2.COLOR_BGR2GRAY) if bottom_img.ndim == 3 else bottom_img
    gray_tgt = cv2.cvtColor(target_img, cv2.COLOR_BGR2GRAY) if target_img.ndim == 3 else target_img

    sift = cv2.SIFT_create(nfeatures=n_features)
    kp1, des1 = sift.detectAndCompute(gray_bot, None)
    kp2, des2 = sift.detectAndCompute(gray_tgt, None)

    if des1 is None or des2 is None or len(kp1) < 4 or len(kp2) < 4:
        return None, 0

    bf = cv2.BFMatcher(cv2.NORM_L2)
    raw_matches = bf.knnMatch(des1, des2, k=2)
    good = [m for m, n in raw_matches if len([m, n]) == 2 and m.distance < ratio_thresh * n.distance]

    if len(good) < 10:
        return None, len(good)

    src_pts = np.float32([kp1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst_pts = np.float32([kp2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    M, mask = cv2.estimateAffinePartial2D(src_pts, dst_pts, method=cv2.RANSAC,
                                           ransacReprojThreshold=5.0)
    n_inliers = int(mask.sum()) if mask is not None else 0
    return M, n_inliers


def compute_diff_image(target_bgr, bottom_bgr, warp_matrix):
    """Compute raw LAB magnitude diff: target - warped_bottom.

    Returns:
        diff_gray: uint8 image, LAB Euclidean distance per pixel.
    """
    h, w = target_bgr.shape[:2]
    warped = cv2.warpAffine(bottom_bgr, warp_matrix, (w, h))

    target_lab = cv2.cvtColor(target_bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    warped_lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB).astype(np.float32)

    diff = target_lab - warped_lab
    mag = np.sqrt((diff ** 2).sum(axis=2))
    return np.clip(mag, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Shape descriptors
# ---------------------------------------------------------------------------

def compute_shape_descriptors(contour):
    """Compute shape descriptors for a contour.

    Returns dict with: hu_moments, convexity, solidity, aspect_ratio, area.
    """
    area = cv2.contourArea(contour)
    if area < 10:
        return None

    hull = cv2.convexHull(contour)
    hull_area = cv2.contourArea(hull)
    perimeter = cv2.arcLength(contour, closed=True)
    hull_perimeter = cv2.arcLength(hull, closed=True)

    # Hu moments (log-transformed, scale/rotation invariant)
    moments = cv2.moments(contour)
    hu = cv2.HuMoments(moments).flatten()

    # Bounding rect for aspect ratio
    _, _, bw, bh = cv2.boundingRect(contour)
    aspect = max(bw, bh) / max(min(bw, bh), 1)

    return {
        "hu_moments": hu,
        "convexity": hull_perimeter / max(perimeter, 1),
        "solidity": area / max(hull_area, 1),
        "aspect_ratio": aspect,
        "area": area,
    }


# ---------------------------------------------------------------------------
# Source segmentation
# ---------------------------------------------------------------------------

def segment_source_flake(image):
    """Segment the source flake for shape reference.

    Uses OR(gray_otsu, sat_otsu) to capture both thick (dark, high-sat)
    and thin (bright, low-sat) regions of multi-thickness hBN flakes.
    GrabCut refines edges to crystallographic facets.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]

    _, mask_gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    _, mask_sat = cv2.threshold(sat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.bitwise_or(mask_gray, mask_sat)

    mask = morph_clean(mask, close_k=5, open_k=3)
    mask = keep_largest_n(mask, n=1, min_area=5000)
    mask = flood_fill_holes(mask)

    # GrabCut refinement for clean crystallographic edges
    mask = grabcut_refine(image, mask)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, None
    contour = max(contours, key=cv2.contourArea)
    return contour, mask


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def cluster_target_diff(diff_gray, n_clusters=12):
    """K-means clustering on grayscale diff intensity."""
    h, w = diff_gray.shape[:2]
    pixels = diff_gray.reshape(-1, 1).astype(np.float32)

    km = KMeans(n_clusters=n_clusters, n_init=30, random_state=42)
    labels = km.fit_predict(pixels)
    label_map = labels.reshape(h, w)

    return label_map, km


def filter_clusters_diff(label_map, diff_gray, n_clusters):
    """Filter clusters by brightness in the diff image.

    High-diff clusters = regions where target differs from bottom
    = the top-placed flake.
    """
    h, w = label_map.shape
    total_px = h * w
    candidates = []

    for cid in range(n_clusters):
        cluster_mask = (label_map == cid)
        area_frac = cluster_mask.sum() / total_px
        mean_intensity = diff_gray[cluster_mask].mean() if cluster_mask.any() else 0

        if mean_intensity < 15:
            continue
        if area_frac < 0.003:
            continue
        if area_frac > 0.60:
            continue

        candidates.append(cid)

    return candidates


# ---------------------------------------------------------------------------
# Cluster splitting
# ---------------------------------------------------------------------------

def split_clusters(label_map, candidate_ids, source_area):
    """Split disconnected blobs within each cluster into sub-clusters.

    Only splits components larger than source_area / 16. Small fragments
    are absorbed into the nearest large blob by centroid distance.

    Returns:
        new_label_map: updated label map with split sub-cluster IDs
        new_candidate_ids: updated list of candidate sub-cluster IDs
    """
    min_split_area = source_area / 16
    new_label_map = label_map.copy()
    new_candidates = []
    next_id = int(label_map.max()) + 1

    for cid in candidate_ids:
        cluster_mask = (label_map == cid).astype(np.uint8) * 255
        num_labels, comp_labels, stats, centroids = cv2.connectedComponentsWithStats(
            cluster_mask, connectivity=8
        )

        large_comps = []
        small_comps = []
        for i in range(1, num_labels):
            area = stats[i, cv2.CC_STAT_AREA]
            if area >= min_split_area:
                large_comps.append(i)
            else:
                small_comps.append(i)

        if len(large_comps) <= 1:
            new_candidates.append(cid)
            continue

        # Assign each large component a new sub-cluster ID
        comp_to_subcid = {}
        for comp_i in large_comps:
            sub_id = next_id
            next_id += 1
            comp_to_subcid[comp_i] = sub_id
            new_label_map[comp_labels == comp_i] = sub_id
            new_candidates.append(sub_id)

        # Absorb small fragments into nearest large blob
        for comp_i in small_comps:
            cy, cx = centroids[comp_i][1], centroids[comp_i][0]
            best_dist = float('inf')
            best_sub = large_comps[0]
            for lc in large_comps:
                lcy, lcx = centroids[lc][1], centroids[lc][0]
                d = (cy - lcy)**2 + (cx - lcx)**2
                if d < best_dist:
                    best_dist = d
                    best_sub = lc
            new_label_map[comp_labels == comp_i] = comp_to_subcid[best_sub]

    return new_label_map, new_candidates


# ---------------------------------------------------------------------------
# Shape matching & enumeration
# ---------------------------------------------------------------------------

def shape_distance(desc_a, desc_b, contour_a, contour_b, area_weight=0.45):
    """Compute shape distance between two contours using multiple metrics."""
    hu_dist = cv2.matchShapes(contour_a, contour_b, cv2.CONTOURS_MATCH_I1, 0)

    conv_diff = abs(desc_a["convexity"] - desc_b["convexity"])
    sol_diff = abs(desc_a["solidity"] - desc_b["solidity"])

    area_a = max(desc_a["area"], 1)
    area_b = max(desc_b["area"], 1)
    area_ratio = max(area_a, area_b) / min(area_a, area_b)
    area_penalty = np.log(area_ratio) * area_weight

    return hu_dist + conv_diff + sol_diff + area_penalty


def enumerate_footprint_candidates(label_map, candidate_ids, source_desc,
                                   source_contour, source_area, scale_range=(0.3, 2.0)):
    """Enumerate subsets of 1-5 clusters and rank by shape similarity to source."""
    h, w = label_map.shape
    results = []

    min_area = source_area * scale_range[0] ** 2
    max_area = source_area * scale_range[1] ** 2

    for size in range(1, min(6, len(candidate_ids) + 1)):
        for subset in combinations(candidate_ids, size):
            merged = np.zeros((h, w), dtype=np.uint8)
            for cid in subset:
                merged[label_map == cid] = 255

            merged = morph_clean(merged, close_k=10, open_k=5)
            merged = keep_largest_n(merged, n=1, min_area=5000)
            merged = flood_fill_holes(merged)

            area = (merged > 0).sum()
            if area < min_area or area > max_area:
                continue

            contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL,
                                           cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue
            contour = max(contours, key=cv2.contourArea)

            desc = compute_shape_descriptors(contour)
            if desc is None:
                continue

            dist = shape_distance(source_desc, desc, source_contour, contour)
            results.append((dist, list(subset), contour, merged))

    results.sort(key=lambda x: x[0])
    return results


# ---------------------------------------------------------------------------
# GrabCut refinement
# ---------------------------------------------------------------------------

def grabcut_refine(image, kmeans_mask):
    """Refine a K-means footprint mask using GrabCut.

    The K-means mask provides object identity; GrabCut refines edges.
    Eroded region = definite foreground, as-is = probable foreground,
    dilated = probable background, rest = definite background.
    """
    h, w = image.shape[:2]
    erode_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
    dilate_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (35, 35))

    gc_mask = np.full((h, w), cv2.GC_BGD, dtype=np.uint8)
    gc_mask[cv2.dilate(kmeans_mask, dilate_k) > 0] = cv2.GC_PR_BGD
    gc_mask[kmeans_mask > 0] = cv2.GC_PR_FGD
    gc_mask[cv2.erode(kmeans_mask, erode_k) > 0] = cv2.GC_FGD

    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)

    try:
        cv2.grabCut(image, gc_mask, None, bgd, fgd, 8, cv2.GC_INIT_WITH_MASK)
    except cv2.error as e:
        print(f"WARNING: GrabCut failed ({e}), using K-means mask directly",
              file=sys.stderr)
        return kmeans_mask

    result = np.where(
        (gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD), 255, 0
    ).astype(np.uint8)

    result = morph_clean(result, close_k=15, open_k=7)
    result = keep_largest_n(result, n=1, min_area=5000)
    result = flood_fill_holes(result)

    return result


# ---------------------------------------------------------------------------
# Visualization helpers
# ---------------------------------------------------------------------------

def draw_cluster_map(label_map, n_clusters):
    """Draw a colored visualization of K-means clusters."""
    np.random.seed(42)
    colors = np.random.randint(50, 255, size=(n_clusters, 3), dtype=np.uint8)
    h, w = label_map.shape
    vis = np.zeros((h, w, 3), dtype=np.uint8)
    for cid in range(n_clusters):
        vis[label_map == cid] = colors[cid]
    return vis


def draw_candidates(image, candidates, source_contour, top_n=3):
    """Draw top N footprint candidates side by side."""
    h, w = image.shape[:2]
    n = min(top_n, len(candidates))
    if n == 0:
        return np.zeros((h, w, 3), dtype=np.uint8)

    panels = []
    for i in range(n):
        dist, cluster_ids, contour, mask = candidates[i]
        panel = image.copy()
        cv2.drawContours(panel, [contour], -1, (0, 255, 0), 2)
        cv2.putText(panel, f"#{i+1} dist={dist:.3f} cl={cluster_ids}",
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        panels.append(panel)

    scale = min(1.0, 1200.0 / (w * n))
    resized = [cv2.resize(p, None, fx=scale, fy=scale) for p in panels]
    return np.hstack(resized)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Build target footprint via shape-guided K-means + GrabCut."
    )
    parser.add_argument("--source", required=True,
                        help="Source image (for shape reference)")
    parser.add_argument("--target", required=True,
                        help="Target image (full_stack_raw)")
    parser.add_argument("--bottom", required=True,
                        help="Bottom part image (SIFT-aligned and subtracted from target)")
    parser.add_argument("--source-contour", default=None,
                        help="Pre-computed source contour .npy (from source_contour.py)")
    parser.add_argument("--source-mask", default=None,
                        help="Pre-computed source mask .png (from source_contour.py)")
    parser.add_argument("--mirror", action="store_true",
                        help="Mirror source before shape extraction")
    parser.add_argument("--pixel-size", type=float, required=True,
                        help="Microns per pixel")
    parser.add_argument("--n-clusters", type=int, default=12,
                        help="Number of K-means clusters (default: 12)")
    parser.add_argument("--candidate-rank", type=int, default=1,
                        help="Which ranked candidate to use (1=best, 2=second-best, etc.)")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    args = parser.parse_args()

    # Load images
    source_img = cv2.imread(args.source)
    target_img = cv2.imread(args.target)
    bottom_img = cv2.imread(args.bottom)
    if source_img is None:
        print(f"ERROR: Cannot read source: {args.source}", file=sys.stderr)
        sys.exit(1)
    if target_img is None:
        print(f"ERROR: Cannot read target: {args.target}", file=sys.stderr)
        sys.exit(1)
    if bottom_img is None:
        print(f"ERROR: Cannot read bottom: {args.bottom}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    # ── Step 1: Get source flake shape reference ──
    if args.source_contour and args.source_mask:
        source_contour = np.load(args.source_contour).astype(np.int32)
        source_mask = cv2.imread(args.source_mask, cv2.IMREAD_GRAYSCALE)
        if source_contour is None or source_mask is None:
            print("ERROR: Cannot read pre-computed source contour/mask.", file=sys.stderr)
            sys.exit(1)
        source_contour = source_contour.reshape(-1, 1, 2)
    else:
        if args.mirror:
            source_img = cv2.flip(source_img, 1)
        source_contour, source_mask = segment_source_flake(source_img)
        if source_contour is None:
            print("ERROR: Cannot segment source flake.", file=sys.stderr)
            sys.exit(1)

    source_desc = compute_shape_descriptors(source_contour)
    if source_desc is None:
        print("ERROR: Source flake too small for shape descriptors.", file=sys.stderr)
        sys.exit(1)

    source_area = source_desc["area"]
    print(f"Source flake: area={source_area:.0f}px, "
          f"convexity={source_desc['convexity']:.3f}, "
          f"solidity={source_desc['solidity']:.3f}")

    # ── Step 2: SIFT-align bottom to target, compute diff, cluster ──
    n_clusters = args.n_clusters
    print(f"SIFT-aligning bottom to target...")
    warp_matrix, n_inliers = sift_align(bottom_img, target_img)
    if warp_matrix is None:
        print(f"ERROR: SIFT alignment failed ({n_inliers} matches).", file=sys.stderr)
        sys.exit(1)
    print(f"SIFT: {n_inliers} inliers")

    diff_gray = compute_diff_image(target_img, bottom_img, warp_matrix)
    cv2.imwrite(os.path.join(args.output_dir, "02_diff_image.png"), diff_gray)

    print(f"K-means clustering on diff (n={n_clusters})...")
    label_map, km = cluster_target_diff(diff_gray, n_clusters=n_clusters)
    candidate_ids = filter_clusters_diff(label_map, diff_gray, n_clusters)

    cluster_vis = draw_cluster_map(label_map, n_clusters)
    cv2.imwrite(os.path.join(args.output_dir, "02_cluster_map.png"), cluster_vis)

    print(f"Candidate clusters: {candidate_ids} ({len(candidate_ids)} of {n_clusters})")

    if len(candidate_ids) < 1:
        print("ERROR: Too few candidate clusters for footprint construction.",
              file=sys.stderr)
        sys.exit(1)

    # ── Step 3: Split disconnected blobs within clusters ──
    label_map, candidate_ids = split_clusters(label_map, candidate_ids, source_area)
    print(f"After split: {len(candidate_ids)} sub-clusters")

    # ── Step 4: Enumerate and rank candidates ──
    print("Enumerating cluster subsets...")
    candidates = enumerate_footprint_candidates(
        label_map, candidate_ids, source_desc,
        source_contour, source_area
    )

    if not candidates:
        print("ERROR: No viable footprint candidates found.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(candidates)} candidates. Best shape_distance={candidates[0][0]:.4f}")

    cand_vis = draw_candidates(target_img, candidates, source_contour, top_n=3)
    cv2.imwrite(os.path.join(args.output_dir, "03_footprint_candidates.png"), cand_vis)

    # ── Step 5: GrabCut refinement on selected candidate ──
    rank = args.candidate_rank - 1
    if rank >= len(candidates):
        print(f"ERROR: Requested candidate rank {args.candidate_rank} but only "
              f"{len(candidates)} candidates available.", file=sys.stderr)
        sys.exit(1)
    best_dist, best_ids, best_contour, best_mask = candidates[rank]
    print(f"Selected candidate #{args.candidate_rank}: clusters={best_ids}, "
          f"shape_distance={best_dist:.4f}")
    print("Running GrabCut refinement...")

    fp_mask = grabcut_refine(target_img, best_mask)
    fp_area = int((fp_mask > 0).sum())

    fp_contours, _ = cv2.findContours(fp_mask, cv2.RETR_EXTERNAL,
                                      cv2.CHAIN_APPROX_SIMPLE)
    if not fp_contours:
        print("ERROR: GrabCut produced empty mask.", file=sys.stderr)
        sys.exit(1)

    fp_contour = max(fp_contours, key=cv2.contourArea)
    fp_pts = fp_contour.reshape(-1, 2).astype(np.float64)

    # ── Save outputs ──
    mask_path = os.path.join(args.output_dir, "footprint_mask.png")
    cv2.imwrite(mask_path, fp_mask)

    contour_path = os.path.join(args.output_dir, "footprint_contour.npy")
    np.save(contour_path, fp_pts)

    # GrabCut diagnostic
    diag = target_img.copy()
    cv2.drawContours(diag, [fp_contour], -1, (0, 255, 0), 2)
    cv2.drawContours(diag, [best_contour], -1, (0, 255, 255), 1)
    km_area = int((best_mask > 0).sum())
    pct_change = (fp_area - km_area) / km_area * 100 if km_area > 0 else 0
    cv2.putText(diag, f"GrabCut area={fp_area}px  clusters={best_ids}  dist={best_dist:.3f}",
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
    cv2.imwrite(os.path.join(args.output_dir, "04_footprint_grabcut.png"), diag)

    # Update alignment_report.json
    report_path = os.path.join(args.output_dir, "alignment_report.json")
    if os.path.exists(report_path):
        with open(report_path) as f:
            report = json.load(f)
    else:
        report = {}

    report["footprint"] = {
        "mode": "diff",
        "cluster_ids": best_ids,
        "shape_distance": round(best_dist, 4),
        "grabcut_area_px": fp_area,
        "kmeans_area_px": km_area,
        "mask_file": "footprint_mask.png",
        "contour_file": "footprint_contour.npy",
        "n_points": len(fp_pts),
    }
    report["target_image"] = os.path.abspath(args.target)
    report["pixel_size_um"] = args.pixel_size

    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    # Summary
    print(f"Footprint: {len(fp_pts)} pts, {fp_area} px "
          f"(GrabCut {pct_change:+.1f}% vs K-means {km_area} px)")
    print(f"shape_distance={best_dist:.4f}, clusters={best_ids}")


if __name__ == "__main__":
    main()
