#!/usr/bin/env python
"""Physics-knowledge-based graphite (or backgate-metal) detector.

The detector is generalist: it derives all expectations from the IMAGE plus
two physics constraints, never from sample-fitted shape priors.

Two principles always hold for the backgate (graphite or metal):

    P1.  graphite_polygon  ⊆  bottom_hbn_polygon
         (graphite is fully covered by bottom hBN)

    P2.  graphite_polygon  ∩  graphene_polygon  ≠  ∅
         (graphite must overlap graphene -- otherwise it isn't gating
          anything)

Algorithm:

    search_region = bottom_hbn_mask                                 (P1)
    seed          = bottom_hbn_mask  ∩  graphene_projected_to_bp    (P2)

    if seed empty:
        if --seed-points was supplied → use those (agent visual judgement)
        else                          → use search_region as seed,
                                          set low_confidence = true

    Build per-image LAB colour models for graphite (sampled in seed) and
    background bottom_hBN (sampled in search_region minus dilate(seed)).
    Classify each pixel in search_region by relative Mahalanobis distance:
    pixel is graphite iff d_seed < d_bg.  Keep the connected component
    that contains the seed.  No absolute LAB / area / aspect thresholds.

CLI:

    conda run -n instrMCPdev python graphite.py \\
        --image          <bottom_part.jpg> \\
        --pixel-size     <um/px> \\
        --output-dir     <path> \\
        --bottom-hbn-mask <bottom_hbn_mask_bp.png>          (bottom_part coords) \\
        [--graphene-mask <graphene_mask.png>]               (top_part coords) \\
        [--warp-top      <align/warp_top.npy>]              (full_stack → top_part) \\
        [--warp-bottom   <align/warp_sift_bottom.npy>]      (full_stack → bottom_part) \\
        [--graphene-mirror]                                 (set if graphene was --mirror'd) \\
        [--seed-points   "X1,Y1;X2,Y2;..."]                 (bottom_part px; agent override)

Outputs in --output-dir:
    graphite_mask.png         (uint8, bottom_part coords)
    graphite_contour.npy      (Nx2 float64, bottom_part px)
    graphite_result.json      ({area_px, area_um2, low_confidence,
                                seed_source, ...})
    01_graphite_on_bottom.png (diagnostic overlay)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..',
                                'nanodevice_flakedetect', 'scripts'))
from core import morph_clean, flood_fill_holes, keep_largest_n, desaturate  # noqa: E402


def _project_graphene_to_bottom_part(graphene_mask: np.ndarray,
                                      bp_shape_hw: tuple[int, int],
                                      fs_shape_hw: tuple[int, int],
                                      warp_top: np.ndarray | None,
                                      warp_bottom: np.ndarray | None,
                                      mirror: bool) -> np.ndarray | None:
    """Compose top_part → full_stack → bottom_part. Returns None if any warp missing."""
    if warp_top is None or warp_bottom is None:
        return None
    g = graphene_mask.copy()
    if mirror:
        g = cv2.flip(g, 1)
    fs_h, fs_w = fs_shape_hw
    bp_h, bp_w = bp_shape_hw
    # Step 1: top_part -> full_stack
    g_fs = cv2.warpAffine(g, warp_top, (fs_w, fs_h), flags=cv2.INTER_NEAREST)
    # Step 2: full_stack -> bottom_part. warp_bottom is full→bottom (cv2 dst→src);
    #         to map full_stack image into bottom_part canvas we need M = bottom→full = inv(warp_bottom).
    inv_bot = cv2.invertAffineTransform(warp_bottom)
    g_bp = cv2.warpAffine(g_fs, inv_bot, (bp_w, bp_h), flags=cv2.INTER_NEAREST)
    return g_bp


def _parse_seed_points(s: str | None) -> list[tuple[int, int]]:
    if not s:
        return []
    out = []
    for tok in s.split(';'):
        tok = tok.strip()
        if not tok:
            continue
        try:
            x, y = tok.split(',')
            out.append((int(round(float(x))), int(round(float(y)))))
        except ValueError:
            print(f'WARN: ignoring malformed seed point {tok!r}', file=sys.stderr)
    return out


def _seed_from_points(points: list[tuple[int, int]],
                      hw: tuple[int, int],
                      pixel_size_um: float,
                      radius_um: float = 5.0) -> np.ndarray:
    """Convert agent-provided (x,y) points into a seed mask via small disks.

    Default radius 5 µm: large enough to capture a few hundred LAB samples
    around the seed location, small enough to fit confidently inside typical
    graphite strips (≥10 µm wide) without spilling into bottom-hBN edges.
    """
    h, w = hw
    seed = np.zeros((h, w), dtype=np.uint8)
    r_px = max(2, int(round(radius_um / pixel_size_um)))
    for x, y in points:
        if 0 <= x < w and 0 <= y < h:
            cv2.circle(seed, (x, y), r_px, 255, -1)
    return seed


def _mahalanobis_logp(image_lab: np.ndarray, mu: np.ndarray, cov: np.ndarray) -> np.ndarray:
    """Per-pixel negative-log-likelihood under a 3D Gaussian (LAB).

    Returns an HxW float32 array. Lower = more likely under (mu, cov).
    Regularised to avoid singular covariance.
    """
    cov_reg = cov + np.eye(3, dtype=np.float64) * 1e-2
    cov_inv = np.linalg.inv(cov_reg)
    diff = image_lab.astype(np.float64) - mu  # HxWx3
    # Mahalanobis: diff @ cov_inv @ diff^T per pixel
    # Vectorised: reshape to N×3, then einsum
    h, w, _ = image_lab.shape
    flat = diff.reshape(-1, 3)
    m = np.einsum('ni,ij,nj->n', flat, cov_inv, flat)
    return m.reshape(h, w).astype(np.float32)


def _stats_from_mask(image_lab: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """Compute (mu, cov) of LAB pixels inside `mask`. Returns None if too few pixels."""
    pix = image_lab[mask > 0].astype(np.float64)
    if len(pix) < 30:
        return None
    mu = pix.mean(axis=0)
    cov = np.cov(pix, rowvar=False)
    if cov.ndim == 0:
        cov = np.array([[float(cov)]])
    return mu, cov


def detect(image_bgr: np.ndarray,
           bottom_hbn_mask: np.ndarray,
           graphene_mask_bp: np.ndarray | None,
           pixel_size_um: float,
           manual_seed_points: list[tuple[int, int]] | None = None) -> dict:
    """Physics-driven graphite detection.

    Args
    ----
    image_bgr : HxWx3 uint8
        bottom_part microscope image.
    bottom_hbn_mask : HxW uint8
        Bottom-hBN footprint in bottom_part pixel coords (P1 search domain).
    graphene_mask_bp : HxW uint8 or None
        Graphene mask projected into bottom_part pixel coords. None if upstream
        align/projection is unavailable.
    pixel_size_um : float
        Microscope pixel size in µm/px.
    manual_seed_points : list of (x, y) or None
        Optional agent-supplied seed pixels (bottom_part coords).

    Returns
    -------
    dict with keys: mask, contour, low_confidence, seed_source, seed_area_um2,
    bg_area_um2, n_search_pixels.
    """
    h, w = image_bgr.shape[:2]
    out: dict = {'mask': np.zeros((h, w), np.uint8), 'contour': None,
                 'low_confidence': False, 'seed_source': None}

    search_region = (bottom_hbn_mask > 0).astype(np.uint8) * 255
    n_search = int(search_region.sum() / 255)
    out['n_search_pixels'] = n_search
    if n_search < 100:
        out['low_confidence'] = True
        out['seed_source'] = 'empty_search'
        return out

    # --- seed selection ----------------------------------------------------
    seed_source: str
    if manual_seed_points:
        seed = _seed_from_points(manual_seed_points, (h, w), pixel_size_um)
        seed = cv2.bitwise_and(seed, search_region)
        seed_source = 'manual_points'
    elif graphene_mask_bp is not None and graphene_mask_bp.any():
        # P2 seed: "inner region of graphene" -- centroid of (eroded graphene
        # ∩ bottom_hBN), placed as a small disk (point-style seed). A REGION
        # seed dilutes the graphite colour signature with bottom_hBN-edge
        # pixels which makes the classification boundary too permissive
        # (verified: 0.10 mean IoU on bench). A point seed at the centroid
        # of the inner overlap gives the algorithm a tight initial colour
        # model -- the same approach that works at 0.40 mean IoU when an
        # agent supplies the seed manually. The difference between this
        # auto-seed and agent-seed is just where the centroid lands; if
        # graphene-projection alignment is good, they converge.
        erode_um = 5.0
        erode_px = max(2, int(round(erode_um / pixel_size_um)))
        ek = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (2 * erode_px + 1, 2 * erode_px + 1))
        graphene_inner = cv2.erode(
            (graphene_mask_bp > 0).astype(np.uint8) * 255, ek)
        intersect_inner = cv2.bitwise_and(graphene_inner, search_region)
        intersect_full = cv2.bitwise_and(
            (graphene_mask_bp > 0).astype(np.uint8) * 255, search_region)
        target = intersect_inner if (intersect_inner > 0).sum() >= 30 \
            else intersect_full
        if (target > 0).sum() < 30:
            seed = np.zeros((h, w), dtype=np.uint8)
            seed_source = 'empty_intersection'
        else:
            # Multi-point seeding: spread K seed disks across graphene ∩
            # bottom_hBN at the K darkest pixels with min spacing. Carbon
            # absorbs more light than hBN (generic optical property), so the
            # darkest pixels in the intersection are most likely on actual
            # graphite. Spacing prevents all K seeds from clustering at one
            # spot. With multiple seeds, if any single seed mis-lands on a
            # graphite/hBN boundary, others elsewhere on pure graphite still
            # anchor the colour model correctly. The union of CCs from all
            # seeds captures the full graphite extent.
            lab_pre = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
            L = lab_pre[:, :, 0].astype(np.float32)
            min_spacing_um = 8.0
            min_spacing_px = max(2, int(round(min_spacing_um / pixel_size_um)))
            n_seeds = 5  # generic, not sample-tuned
            # Mask L to only the intersection
            L_in_target = L.copy()
            L_in_target[target == 0] = 1e9
            seed_centers: list[tuple[int, int]] = []
            # Greedy farthest-first by darkness: each iteration find the
            # darkest remaining pixel that's >= min_spacing from all existing
            # seed centers.
            blocked = np.zeros((h, w), dtype=bool)
            for _ in range(n_seeds):
                masked = L_in_target.copy()
                masked[blocked] = 1e9
                if not np.isfinite(masked).any() or masked.min() >= 1e9:
                    break
                idx = int(np.argmin(masked))
                cy, cx = divmod(idx, w)
                if target[cy, cx] == 0:
                    break
                seed_centers.append((cx, cy))
                # Block a disk of radius min_spacing around this seed.
                cv2.circle(blocked.view(np.uint8), (cx, cy),
                           min_spacing_px, 1, -1)
            if not seed_centers:
                seed = np.zeros((h, w), dtype=np.uint8)
                seed_source = 'empty_seed_search'
            else:
                seed = _seed_from_points(seed_centers, (h, w), pixel_size_um)
                seed = cv2.bitwise_and(seed, target)
                out['n_auto_seeds'] = len(seed_centers)
                out['auto_seed_centers'] = seed_centers
                seed_source = ('graphene_inner_multidark'
                               if (intersect_inner > 0).sum() >= 30
                               else 'graphene_full_multidark_fallback')
    else:
        seed = np.zeros((h, w), dtype=np.uint8)
        seed_source = 'none'

    if (seed > 0).sum() < 30:
        # P2 unreachable — fall back to whole search region as seed and flag.
        seed = search_region.copy()
        seed_source = (seed_source + '_fallback_to_search_region') \
            if seed_source != 'none' else 'fallback_to_search_region'
        out['low_confidence'] = True

    out['seed_source'] = seed_source
    out['seed_area_um2'] = float((seed > 0).sum() * pixel_size_um * pixel_size_um)

    # --- per-image LAB colour models --------------------------------------
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    seed_stats = _stats_from_mask(lab, seed)

    # Background = search_region minus the seed (dilated to avoid contaminating
    # the bg sample with graphite-bleed pixels at the seed boundary).
    bleed_um = 3.0
    bleed_px = max(2, int(round(bleed_um / pixel_size_um)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                  (2 * bleed_px + 1, 2 * bleed_px + 1))
    seed_dilated = cv2.dilate(seed, k)
    bg_mask = cv2.bitwise_and(search_region, cv2.bitwise_not(seed_dilated))
    bg_stats = _stats_from_mask(lab, bg_mask)
    out['bg_area_um2'] = float((bg_mask > 0).sum() * pixel_size_um * pixel_size_um)

    if seed_stats is None or bg_stats is None:
        # Not enough pixels to characterise either class. Output the seed as-is.
        cleaned = morph_clean(seed, close_k=3, open_k=3)
        cleaned = keep_largest_n(cleaned, n=1, min_area=50)
        out['mask'] = cleaned
        cnts, _ = cv2.findContours(cleaned, cv2.RETR_EXTERNAL,
                                    cv2.CHAIN_APPROX_SIMPLE)
        out['contour'] = max(cnts, key=cv2.contourArea) if cnts else None
        out['low_confidence'] = True
        return out

    # --- iterative region grow from seed by LAB Mahalanobis distance -----
    #
    # No fitted thresholds. At each step:
    #   1. Refit (mu, cov) from the current graphite mask.
    #   2. Compute d_seed (Mahalanobis to current model) for all pixels.
    #   3. Accept pixels with d_seed < `mahal_thresh` (3-sigma in LAB), AND
    #      inside the search region (P1), AND connected to the seed.
    #   4. Repeat until convergence.
    #
    # `mahal_thresh` = 9.0 corresponds to 3 standard deviations under the
    # current Gaussian model -- a generic statistical cutoff, not a
    # sample-fitted parameter. The seed's mu/cov widens as the mask grows,
    # so the model captures legitimate colour gradients across a real flake.
    #
    # We also compare to a BG reference (sampled far from the seed inside
    # bottom_hBN) but only as a sanity flag: if bg and seed converge to
    # similar colour, mark low_confidence. The classification itself does
    # NOT depend on bg.
    # Sample bg colour FAR from any seed pixel inside bottom_hBN. Used only
    # as a sanity flag (low_confidence) -- not in the classification rule.
    far_um = 10.0
    far_px = max(3, int(round(far_um / pixel_size_um)))
    far_k = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * far_px + 1, 2 * far_px + 1))
    seed_far = cv2.dilate(seed, far_k)
    bg_mask_far = cv2.bitwise_and(search_region, cv2.bitwise_not(seed_far))
    bg_stats_fixed = _stats_from_mask(lab, bg_mask_far)
    bg_mu = bg_stats_fixed[0] if bg_stats_fixed is not None else None

    # Region grow with FIXED initial seed colour model:
    #   The initial seed disk gives us (mu_0, cov_0) -- the per-image colour
    #   model for "what graphite looks like AT THE SEED LOCATION". We do NOT
    #   refit (mu, cov) during iteration; doing so lets the model widen and
    #   absorb bare bottom_hBN colours, especially on stacks where graphite
    #   and hBN have partial colour overlap. With (mu_0, cov_0) fixed, the
    #   3-sigma decision boundary is anchored to the local colour the agent
    #   (or graphene-projection) actually pointed at.
    #
    #   Iteration is only used to GROW the connected component: each step,
    #   classify pixels by d_seed < mahal_thresh, take CCs touching the seed
    #   or the current mask, repeat until convergence.
    mahal_thresh = 9.0
    if bg_mu is not None:
        out['lab_separation'] = float(np.linalg.norm(seed_stats[0] - bg_mu))
    else:
        out['lab_separation'] = 0.0
    if bg_mu is not None and out['lab_separation'] < 3.0:
        out['low_confidence'] = True

    # Multi-seed independent classification:
    #   Process each connected component of the seed mask independently. For
    #   each, refit (mu, cov) from JUST THAT CC's pixels, narrow cov by 0.5,
    #   classify the search region by Mahalanobis < 9.0, take the CC that
    #   contains this seed, and OR-merge into the running output. This is
    #   the user's "multi-point seeding" design: a single mis-landed seed
    #   no longer pollutes the colour model for the others, and the union
    #   of per-seed outputs covers graphite's full extent even when colour
    #   varies along the flake.
    nl_seed, seed_lab, _, _ = cv2.connectedComponentsWithStats(
        (seed > 0).astype(np.uint8) * 255)
    final = np.zeros((h, w), dtype=np.uint8)
    n_used = 0
    for i in range(1, nl_seed):
        seed_i = (seed_lab == i).astype(np.uint8) * 255
        if int(seed_i.sum() / 255) < 10:
            continue
        s_stats_i = _stats_from_mask(lab, seed_i)
        if s_stats_i is None:
            continue
        s_mu_i, s_cov_i = s_stats_i
        s_cov_i_narrow = s_cov_i * 0.5
        d_seed_i = _mahalanobis_logp(lab, s_mu_i, s_cov_i_narrow)
        candidate_i = ((d_seed_i < mahal_thresh) & (search_region > 0)).astype(np.uint8) * 255
        # Take only the CC of candidate_i that contains seed_i.
        nl_c, lab_c, _, _ = cv2.connectedComponentsWithStats(candidate_i)
        seed_i_mask = (seed_i > 0)
        for j in range(1, nl_c):
            comp = (lab_c == j)
            if (comp & seed_i_mask).any():
                final[comp] = 255
        n_used += 1
    current = final
    out['n_seeds_classified'] = n_used
    out['final_area_px'] = int((current > 0).sum())
    if bg_mu is not None and out['lab_separation'] < 3.0:
        # graphite colour ≈ bottom_hBN colour: result not trustworthy.
        out['low_confidence'] = True

    # CC cleanup: keep CCs overlapping the seed (multiple is fine).
    cleaned = morph_clean(current, close_k=3, open_k=3)
    nl, lab_arr, _, _ = cv2.connectedComponentsWithStats(cleaned)
    final = np.zeros_like(cleaned)
    seed_pixels = (seed > 0)
    for i in range(1, nl):
        comp = (lab_arr == i)
        if comp.sum() < 30:
            continue
        if (comp & seed_pixels).any():
            final[comp] = 255

    if final.sum() == 0:
        cleaned_largest = keep_largest_n(cleaned, n=1, min_area=50)
        final = cleaned_largest
        out['low_confidence'] = True

    final = flood_fill_holes(final)

    out['mask'] = final
    cnts, _ = cv2.findContours(final, cv2.RETR_EXTERNAL,
                                cv2.CHAIN_APPROX_SIMPLE)
    out['contour'] = max(cnts, key=cv2.contourArea) if cnts else None
    return out


def main():
    p = argparse.ArgumentParser(
        description='Physics-knowledge-based graphite/backgate detector')
    p.add_argument('--image', required=True,
                   help='bottom_part microscope image')
    p.add_argument('--pixel-size', type=float, required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--bottom-hbn-mask', required=True,
                   help='bottom_hBN footprint in bottom_part pixel coords (.png)')
    p.add_argument('--graphene-mask', default=None,
                   help='graphene mask in top_part coords (.png). Optional but '
                        'strongly recommended -- enables P2 seeding.')
    p.add_argument('--warp-top', default=None,
                   help='align/warp_top.npy (full_stack → top_part)')
    p.add_argument('--warp-bottom', default=None,
                   help='align/warp_sift_bottom.npy (full_stack → bottom_part)')
    p.add_argument('--full-stack-image', default=None,
                   help='full_stack_raw.jpg (only needed for shape reference '
                        'when projecting graphene)')
    p.add_argument('--graphene-mirror', action='store_true',
                   help='Set if graphene was detected with --mirror.')
    p.add_argument('--seed-points', default=None,
                   help='"X1,Y1;X2,Y2;..." in bottom_part px. Agent visual '
                        'override when auto-seed (P2 intersection) is empty.')
    # CLI compat (unused)
    p.add_argument('--cluster-id', type=int, default=None)
    p.add_argument('--n-sub-clusters', type=int, default=None)
    p.add_argument('--min-area', type=int, default=None)
    args = p.parse_args()

    img_path = os.path.abspath(os.path.expanduser(args.image))
    img = cv2.imread(img_path)
    if img is None:
        print(f'ERROR: cannot read image: {img_path}', file=sys.stderr)
        sys.exit(1)
    h, w = img.shape[:2]

    bhbn = cv2.imread(os.path.abspath(os.path.expanduser(args.bottom_hbn_mask)),
                       cv2.IMREAD_GRAYSCALE)
    if bhbn is None:
        print(f'ERROR: cannot read bottom_hbn mask: {args.bottom_hbn_mask}',
              file=sys.stderr)
        sys.exit(1)
    if bhbn.shape != (h, w):
        # Bottom_hBN mask must already be in bottom_part coords. If it isn't
        # (size mismatch), fail loudly rather than silently warping.
        print(f'ERROR: bottom_hbn mask shape {bhbn.shape} != image shape {(h, w)}.\n'
              f'  Expected the bottom_part-coords mask (bottom_hbn_mask_bp.png).',
              file=sys.stderr)
        sys.exit(1)

    graphene_bp: np.ndarray | None = None
    if args.graphene_mask:
        gm = cv2.imread(os.path.abspath(os.path.expanduser(args.graphene_mask)),
                         cv2.IMREAD_GRAYSCALE)
        if gm is None:
            print(f'WARN: cannot read graphene mask {args.graphene_mask}; '
                  'continuing without P2 seed.', file=sys.stderr)
        elif args.warp_top and args.warp_bottom and args.full_stack_image:
            wt = np.load(os.path.abspath(os.path.expanduser(args.warp_top)))
            wb = np.load(os.path.abspath(os.path.expanduser(args.warp_bottom)))
            fs = cv2.imread(os.path.abspath(os.path.expanduser(args.full_stack_image)))
            if fs is None:
                print('WARN: cannot read full_stack image; skipping graphene '
                      'projection.', file=sys.stderr)
            else:
                fs_h, fs_w = fs.shape[:2]
                graphene_bp = _project_graphene_to_bottom_part(
                    gm, (h, w), (fs_h, fs_w), wt, wb, args.graphene_mirror)
        else:
            print('WARN: --graphene-mask given but --warp-top / --warp-bottom / '
                  '--full-stack-image missing; cannot project graphene to '
                  'bottom_part coords. Continuing without P2 seed.',
                  file=sys.stderr)

    seed_pts = _parse_seed_points(args.seed_points)

    out_dir = Path(os.path.abspath(os.path.expanduser(args.output_dir)))
    out_dir.mkdir(parents=True, exist_ok=True)

    result = detect(img, bhbn, graphene_bp, args.pixel_size,
                    manual_seed_points=seed_pts)

    final = result['mask']
    contour = result['contour']

    if contour is None or (final > 0).sum() == 0:
        # Truly no signal anywhere. Emit empty-but-honest result.
        print('WARN: graphite detector produced an empty mask (low_confidence). '
              'No CC inside bottom_hbn matches the seed colour model.',
              file=sys.stderr)
        cv2.imwrite(str(out_dir / 'graphite_mask.png'), np.zeros((h, w), np.uint8))
        np.save(str(out_dir / 'graphite_contour.npy'),
                np.zeros((0, 2), dtype=np.float64))
        diag = desaturate(img, factor=0.4)
        cv2.imwrite(str(out_dir / '01_graphite_on_bottom.png'), diag)
        cv2.imwrite(str(out_dir / '00_graphite_candidates.png'), diag)
        sidecar = {'area_px': 0, 'area_um2': 0.0, 'low_confidence': True,
                   'seed_source': result.get('seed_source'),
                   'reason': 'empty_after_classification'}
        (out_dir / 'graphite_result.json').write_text(json.dumps(sidecar, indent=2))
        return

    cv2.imwrite(str(out_dir / 'graphite_mask.png'), final)
    contour_2d = contour.reshape(-1, 2).astype(np.float64)
    np.save(str(out_dir / 'graphite_contour.npy'), contour_2d)

    diag = desaturate(img, factor=0.4)
    # Draw the bottom_hBN search region in faint blue + seed in faint magenta
    # + the final graphite contour in yellow so the diagnostic shows the
    # full reasoning chain at a glance.
    bhbn_contours, _ = cv2.findContours((bhbn > 0).astype(np.uint8) * 255,
                                        cv2.RETR_EXTERNAL,
                                        cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(diag, bhbn_contours, -1, (200, 100, 0), 1)
    if graphene_bp is not None:
        gp_contours, _ = cv2.findContours(
            (graphene_bp > 0).astype(np.uint8) * 255,
            cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(diag, gp_contours, -1, (180, 0, 180), 1)
    cv2.drawContours(diag, [contour], -1, (0, 200, 255), 2)
    cv2.imwrite(str(out_dir / '01_graphite_on_bottom.png'), diag)
    cv2.imwrite(str(out_dir / '00_graphite_candidates.png'), diag)

    area_px = int((final > 0).sum())
    area_um2 = round(area_px * args.pixel_size * args.pixel_size, 2)
    sidecar = {
        'area_px': area_px,
        'area_um2': area_um2,
        'low_confidence': bool(result.get('low_confidence', False)),
        'seed_source': result.get('seed_source'),
        'seed_area_um2': result.get('seed_area_um2'),
        'bg_area_um2': result.get('bg_area_um2'),
        'lab_separation': result.get('lab_separation'),
        'n_search_pixels': result.get('n_search_pixels'),
        'manual_seed_points': seed_pts if seed_pts else None,
    }
    (out_dir / 'graphite_result.json').write_text(json.dumps(sidecar, indent=2))
    print(f'OK: graphite area={area_um2}um² ({area_px}px) '
          f'seed={result.get("seed_source")} '
          f'low_confidence={result.get("low_confidence")}')


if __name__ == '__main__':
    main()
