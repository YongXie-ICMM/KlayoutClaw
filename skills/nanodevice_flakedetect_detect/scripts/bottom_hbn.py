#!/usr/bin/env python
"""bottom_hbn.py — Detect bottom hBN from bottom_part via substrate
rejection; warp the resulting mask to full_stack coordinates.

The detection logic is identical to graphite.py's host-extraction step:

  1. Substrate sample mu_sub = LAB peak of H_corners x H_image x L
     (joint histogram mode + brightness preference).
  2. Host mask = pixels with LAB distance to mu_sub above plateau-midpoint
     T*, cleaned via morph_close+open, keep_largest_n, 4-corner
     flood-fill-holes.

The host IS the bottom_hBN region on every bench stack we tested.  On
gold-backgate stacks (e.g. HM05) where the gold extends across bare
substrate, the host also includes that gold strip — which is the right
behaviour for `combine.py` (the union is what gets aligned, and the
graphite detector independently localises the gold).

After detection the mask is warped from bottom_part coords to
full_stack coords via the affine matrix from align/sift_align.py and
dilated by 1.5 um to match the GT-dilation convention.

Usage:
    conda run -n instrMCPdev python bottom_hbn.py \\
        --image <bottom_part.jpg> \\
        --warp-matrix <align/warp_sift_bottom.npy> \\
        --target-image <full_stack_raw.jpg> \\
        --pixel-size <um/px> \\
        --output-dir <path>

Outputs:
    bottom_hbn_mask.png        full_stack coords (uint8 0/255)
    bottom_hbn_mask_bp.png     bottom_part coords (uint8 0/255)
    bottom_hbn_contour.npy     (N, 2) float64 in full_stack px
    bottom_hbn_result.json     area + substrate ref + T* + low_confidence
    03_bottom_hbn_on_full.png  contour overlay on desaturated full_stack
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import morph_clean, desaturate  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from graphite import compute_host  # noqa: E402

GT_DILATION_UM = 1.5
LOW_CONFIDENCE_MIN_AREA_UM2 = 500.0


def invert_affine(M: np.ndarray) -> np.ndarray:
    M3 = np.vstack([M, [0, 0, 1]])
    return np.linalg.inv(M3)[:2]


def main() -> int:
    p = argparse.ArgumentParser(
        description='Detect bottom hBN from bottom_part via substrate '
                    'rejection; warp to full_stack.')
    p.add_argument('--image', required=True)
    p.add_argument('--warp-matrix', required=True)
    p.add_argument('--target-image', required=True)
    p.add_argument('--pixel-size', type=float, required=True)
    p.add_argument('--output-dir', required=True)
    args = p.parse_args()

    image = cv2.imread(os.path.abspath(args.image))
    if image is None:
        print(f'ERROR: cannot read image: {args.image}', file=sys.stderr)
        return 1
    target_img = cv2.imread(os.path.abspath(args.target_image))
    if target_img is None:
        print(f'ERROR: cannot read target image: {args.target_image}',
              file=sys.stderr)
        return 1
    warp_tgt2src = np.load(os.path.abspath(args.warp_matrix))
    if warp_tgt2src.shape != (2, 3):
        print(f'ERROR: warp matrix has unexpected shape '
              f'{warp_tgt2src.shape}', file=sys.stderr)
        return 1
    os.makedirs(args.output_dir, exist_ok=True)

    # Detection: host = bottom_hBN
    host_bp, _, mu_sub, sub_corner, t_star = compute_host(
        image, args.pixel_size)
    if (host_bp > 0).sum() == 0:
        print('ERROR: no host region detected in bottom_part',
              file=sys.stderr)
        return 1
    cv2.imwrite(os.path.join(args.output_dir, 'bottom_hbn_mask_bp.png'),
                host_bp)

    # Warp to full_stack coords
    M_src2tgt = invert_affine(warp_tgt2src)
    h_fs, w_fs = target_img.shape[:2]
    mask = cv2.warpAffine(host_bp, M_src2tgt, (w_fs, h_fs),
                          flags=cv2.INTER_NEAREST)
    mask = morph_clean(mask, close_k=5, open_k=3)

    # GT-matching dilation (bottom_hBN is large; outward dilation gains
    # boundary IoU without violating containment).
    dilate_px = max(1, int(round(GT_DILATION_UM / args.pixel_size)))
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * dilate_px + 1, 2 * dilate_px + 1))
    mask = cv2.dilate(mask, kernel)

    area_px = int((mask > 0).sum())
    if area_px == 0:
        print('ERROR: no bottom hBN region after warp to full_stack',
              file=sys.stderr)
        return 1
    area_um2 = round(area_px * args.pixel_size * args.pixel_size, 2)
    low_confidence = area_um2 < LOW_CONFIDENCE_MIN_AREA_UM2

    cv2.imwrite(os.path.join(args.output_dir, 'bottom_hbn_mask.png'),
                mask)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                    cv2.CHAIN_APPROX_SIMPLE)
    largest = max(contours, key=cv2.contourArea)
    np.save(os.path.join(args.output_dir, 'bottom_hbn_contour.npy'),
            largest.reshape(-1, 2).astype(np.float64))

    diag = desaturate(target_img, factor=0.4)
    cv2.drawContours(diag, [largest], -1, (255, 100, 0), 2)
    cv2.imwrite(os.path.join(args.output_dir, '03_bottom_hbn_on_full.png'),
                diag)

    sidecar = {
        'area_px': area_px,
        'area_um2': area_um2,
        'pixel_size_um': args.pixel_size,
        'substrate': {
            'corner': sub_corner,
            'mu_lab': [round(float(x), 2) for x in mu_sub.tolist()],
            't_star': round(float(t_star), 2),
        },
        'low_confidence': bool(low_confidence),
    }
    with open(os.path.join(args.output_dir, 'bottom_hbn_result.json'),
              'w') as f:
        json.dump(sidecar, f, indent=2)

    print(f'OK: bottom hBN area={area_um2} um2  T*={t_star:.1f}  '
          f'mu_sub=[{mu_sub[0]:.0f},{mu_sub[1]:.0f},{mu_sub[2]:.0f}]  '
          f'low_confidence={low_confidence}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
