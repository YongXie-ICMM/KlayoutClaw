#!/usr/bin/env python
"""Detect bottom hBN from bottom_part image and warp to full_stack coordinates.

Detects the bottom hBN flake directly from the bottom_part image (where it
is the only hBN visible on SiO2 substrate), then warps the detection into
full_stack coordinates using the SIFT warp matrix from the align step.

Usage:
    conda run -n base python bottom_hbn.py \
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

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'nanodevice_flakedetect', 'scripts'))

import cv2
import numpy as np
from sklearn.cluster import KMeans

from core import morph_clean, flood_fill_holes, keep_largest_n, desaturate


def detect_bottom_hbn(image, n_clusters=8):
    """Detect bottom hBN from bottom_part image via K-means.

    The bottom_part image shows only the bottom hBN on SiO2 substrate
    (no top flake), so simple HSV color selection works reliably.

    Args:
        image: BGR image of bottom_part.
        n_clusters: Number of K-means clusters.

    Returns:
        dict with bottom_hbn_mask, cluster_stats, bottom_hbn_ids.
    """
    h, w = image.shape[:2]

    # K-means in LAB space
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    pixels = lab.reshape(-1, 3).astype(np.float32)
    km = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
    labels = km.fit_predict(pixels)
    label_map = labels.reshape(h, w)

    # Compute per-cluster HSV stats
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

    cluster_stats = []
    bottom_hbn_ids = []
    for i in range(n_clusters):
        pix_mask = (label_map == i)
        count = pix_mask.sum()
        if count == 0:
            cluster_stats.append({
                "label": i, "H": 0, "S": 0, "V": 0, "area_frac": 0,
            })
            continue

        h_mean = float(hsv[:, :, 0][pix_mask].astype(np.float64).mean())
        s_mean = float(hsv[:, :, 1][pix_mask].astype(np.float64).mean())
        v_mean = float(hsv[:, :, 2][pix_mask].astype(np.float64).mean())
        area_frac = float(count / (h * w))

        cluster_stats.append({
            "label": i, "H": h_mean, "S": s_mean,
            "V": v_mean, "area_frac": area_frac,
        })

        # Select hBN clusters: high saturation, blue hue
        if s_mean > 80 and 80 <= h_mean <= 130:
            bottom_hbn_ids.append(i)

    # Build mask from selected clusters
    bhbn_mask = np.zeros((h, w), dtype=np.uint8)
    for cid in bottom_hbn_ids:
        bhbn_mask[label_map == cid] = 255

    bhbn_mask = morph_clean(bhbn_mask, close_k=15, open_k=7)
    bhbn_mask = keep_largest_n(bhbn_mask, n=1, min_area=5000)
    bhbn_mask = flood_fill_holes(bhbn_mask)

    return {
        "bottom_hbn_mask": bhbn_mask,
        "cluster_stats": cluster_stats,
        "bottom_hbn_ids": bottom_hbn_ids,
    }


def invert_affine(M):
    """Invert a 2x3 affine matrix."""
    M3 = np.vstack([M, [0, 0, 1]])
    return np.linalg.inv(M3)[:2]


def main():
    parser = argparse.ArgumentParser(
        description="Detect bottom hBN from bottom_part image, "
                    "warp to full_stack coordinates")
    parser.add_argument("--image", required=True,
                        help="Source image (bottom_part)")
    parser.add_argument("--warp-matrix", required=True,
                        help="SIFT warp matrix .npy from align step "
                             "(maps target->source)")
    parser.add_argument("--target-image", required=True,
                        help="Target image (full_stack_raw) for dimensions "
                             "and overlay")
    parser.add_argument("--pixel-size", type=float, required=True,
                        help="Microns per pixel")
    parser.add_argument("--output-dir", required=True,
                        help="Output directory")
    parser.add_argument("--n-clusters", type=int, default=8,
                        help="K-means cluster count (default: 8)")
    args = parser.parse_args()

    image_path = os.path.abspath(os.path.expanduser(args.image))
    image = cv2.imread(image_path)
    if image is None:
        print(f"ERROR: cannot read image: {image_path}", file=sys.stderr)
        sys.exit(1)

    target_img = cv2.imread(os.path.abspath(args.target_image))
    if target_img is None:
        print(f"ERROR: cannot read target image: {args.target_image}",
              file=sys.stderr)
        sys.exit(1)

    warp_tgt2src = np.load(os.path.abspath(args.warp_matrix))
    if warp_tgt2src.shape != (2, 3):
        print(f"ERROR: warp matrix has unexpected shape {warp_tgt2src.shape}",
              file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    # Detect bottom hBN from bottom_part
    result = detect_bottom_hbn(image, n_clusters=args.n_clusters)
    mask_bottom = result["bottom_hbn_mask"]

    if (mask_bottom > 0).sum() == 0:
        print("ERROR: no bottom hBN region found in bottom_part",
              file=sys.stderr)
        sys.exit(1)

    # Warp mask to full_stack coordinates
    # Stored matrix maps target->source; invert for source->target
    M_src2tgt = invert_affine(warp_tgt2src)
    h_fs, w_fs = target_img.shape[:2]
    mask = cv2.warpAffine(mask_bottom, M_src2tgt, (w_fs, h_fs),
                          flags=cv2.INTER_NEAREST)
    mask = morph_clean(mask, close_k=5, open_k=3)

    area_px = int((mask > 0).sum())

    if area_px == 0:
        print("ERROR: no bottom hBN region after warp to full_stack",
              file=sys.stderr)
        sys.exit(1)

    area_um2 = round(area_px * args.pixel_size * args.pixel_size, 2)

    # Save mask
    cv2.imwrite(os.path.join(args.output_dir, "bottom_hbn_mask.png"), mask)

    # Save contour
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
    largest = max(contours, key=cv2.contourArea)
    contour_2d = largest.reshape(-1, 2).astype(np.float64)
    np.save(os.path.join(args.output_dir, "bottom_hbn_contour.npy"),
            contour_2d)

    # Diagnostic overlay on full_stack
    diag = desaturate(target_img, factor=0.4)
    cv2.drawContours(diag, [largest], -1, (255, 100, 0), 2)  # blue-ish BGR
    cv2.imwrite(os.path.join(args.output_dir, "03_bottom_hbn_on_full.png"),
                diag)

    # Result sidecar
    with open(os.path.join(args.output_dir, "bottom_hbn_result.json"),
              "w") as f:
        json.dump({"area_px": area_px, "area_um2": area_um2}, f, indent=2)

    print(f"OK: bottom hBN detected")
    print(f"  Area: {area_px} px ({area_um2} um2)")
    print(f"  Contour points: {len(contour_2d)}")
    print(f"  Selected clusters: {result['bottom_hbn_ids']}")
    print(f"  Outputs: {args.output_dir}")


if __name__ == "__main__":
    main()
