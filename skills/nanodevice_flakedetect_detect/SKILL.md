---
name: nanodevice_flakedetect_detect
description: Detect individual material layers (graphite, graphene, bottom hBN, top hBN) from their optimal source images. Use when segmenting specific materials in a van der Waals heterostructure stack from microscope images.
---

# nanodevice_flakedetect_detect — Per-Material Detection

Detect each material from its optimal source image. Four independent scripts, one per material.

- **graphite** (or backgate-metal) — three first-class candidate detectors. The agent picks one based on stack appearance and upstream artifacts:
  - `graphite.py` — **physics-driven** (default): search inside `bottom_hBN` (P1), seed from `bottom_hBN ∩ graphene-projection` or from agent-supplied seed points (P2), grow by LAB Mahalanobis. No fitted priors.
  - `graphite_c3.py` — **priors ensemble**: B1 logistic + B2 multi-K K-means + B3 threshold sweep, scored against fitted shape priors. Sample-tuned. Use when the stack matches the AH/ml training distribution.
  - `graphite_baseline.py` — **legacy K-means darkest cluster** with `--cluster-id` agent override. Sanity-check baseline.
- **graphene** — K-means sub-clustering inside the top-flake mask, brightest cluster.
- **bottom_hBN** — multi-K (4/6/8) K-means + HSV-gate union candidates over GT-fitted priors. Picks the highest-scoring candidate.
- **top_hBN** — copies the footprint from the align step.

`graphite.py` (physics-driven) requires `--bottom-hbn-mask` and accepts `--graphene-mask` (auto-seed) and/or `--seed-points` (agent override). The legacy `--cluster-id` / `--n-sub-clusters` / `--n-clusters` flags are kept for CLI compatibility but **ignored** by `graphite_c3.py` and `bottom_hbn.py`; the ensemble / scorer selects automatically. `graphene.py` and `graphite_baseline.py` still respect `--cluster-id`.

### Never-empty fallback

All three graphite candidate scripts always emit a real-sized blob. When all internal scoring gates reject every candidate (or when the physics seed produces no connected region), the script falls back: physics→ uses the supplied seed mask (or whole bottom_hBN) as a low-confidence guess; C3 → highest-scored non-empty mask; bottom_hbn → largest CC of the loose color gate. All set `low_confidence: true` in the result JSON. This replaces the old behaviour of writing a 5×5 px placeholder / empty mask, which silently broke downstream combine on stacks like HM05 / HM06 / HM07. Orchestrators should treat `low_confidence: true` as a signal to escalate to vision-review rather than as a hard failure.

## Prerequisites

- Conda env with opencv, numpy, scikit-learn
- Source images for each material
- For `graphite.py` (physics-driven): `bottom_hbn_mask_bp.png` from a *prior* `bottom_hbn.py` run (it now writes both full-stack and bottom-part-coords masks). Optional but recommended: `graphene_mask.png` + `warp_top.npy` + `warp_sift_bottom.npy` + `full_stack_raw.jpg` for the P2 auto-seed.
- For `graphite_c3.py` and `graphite_baseline.py`: just `bottom_part.jpg` (each runs its own host-region segmentation).
- For `bottom_hbn.py`: `warp_sift_bottom.npy` from the align step + `full_stack_raw.jpg` for warp target.
- For `top_hbn.py`: `footprint_mask.png` from the align step.
- All scripts: `conda run -n instrMCPdev python <script>`

---

## Agent Workflow

**Pipeline ordering changed**: `graphite.py` (physics) depends on the bottom_hbn output and (optionally) on the graphene + top-alignment outputs. Run order:

```
1. Run bottom_hbn.py on bottom_part (needs warp_sift_bottom.npy + full_stack_raw)
   → Writes BOTH bottom_hbn_mask.png (full_stack coords) and
     bottom_hbn_mask_bp.png (bottom_part coords; consumed by graphite.py).
   → Inspect bottom_hbn_result.json: check `low_confidence`, `fallback_source`.

2. Run graphene.py on top_part [--mirror]
   → Review 00_graphene_candidates.png; override with --cluster-id <N> if needed.

3. Run top_hbn.py (copies footprint from align) → 04_top_hbn_footprint.png.

4. Run graphite.py on bottom_part — pick a candidate detector:
   ├─ graphite.py (physics, default): pass --bottom-hbn-mask and (preferred)
   │  --graphene-mask + warps so the auto-seed via P2 works. If outline
   │  looks wrong, re-run with --seed-points "X,Y" (agent visual judgement).
   ├─ graphite_c3.py: priors-based ensemble. Use as a second opinion or
   │  when stack matches AH/ml training distribution.
   └─ graphite_baseline.py: legacy K-means darkest cluster + --cluster-id.
   → Inspect graphite_result.json: low_confidence flag, seed_source,
     lab_separation. Treat low_confidence outputs as hints, not authoritative.

5. Assemble detections.json (see template below).
```

`bottom_hbn`, `graphene`, `top_hbn` can still run in parallel; only `graphite.py` (physics) is sequential because it consumes their outputs.

---

## Graphite Detection — Three Candidate Detectors

The graphite (or backgate-metal) detection problem has three first-class candidate scripts. **The agent picks which to run** based on the stack's appearance and what upstream artifacts are available. All three live in `skills/nanodevice_flakedetect_detect/scripts/` and share the same output filenames so they're drop-in compatible with the rest of the pipeline.

| Script | Approach | When to pick |
|--------|---------|--------------|
| `graphite.py` (default) | **Physics-driven**, principle-based: search inside `bottom_hBN` (P1), seed from `bottom_hBN ∩ graphene-projection` or from agent-supplied seed points (P2), grow by relative LAB-Mahalanobis. No fitted priors. | First choice. Works without any sample-tuned thresholds; graphite shape & area are unconstrained. |
| `graphite_c3.py` | **Priors ensemble**: three sub-detectors (B1 logistic regression, B2 multi-K K-means, B3 threshold sweep) scored against `graphite_shape_priors.json` / `graphite_priors.json` / `graphite_classifier.json`. Hard gates `aspect ≥ 3.5` and `area ∈ [145, 3577] µm²`. | When the stack matches the priors training set (ML/AH/QH stacks where graphite is a thin elongated dark strip ≤3000 µm² inside cyan hBN). Fastest to run; deterministic per-image. |
| `graphite_baseline.py` | Original simple K-means: HSV-cyan host region, k=4 sub-clusters in LAB, pick darkest. Two-pass with `--cluster-id` agent override. | Sanity-check baseline. Useful when the other two disagree and you need a third opinion. |

### Picking between candidates

```
Is bottom_hBN_mask available (always)? Is graphene mask + warps available (post-detect/align)?
  ├─ Yes to both → run graphite.py with --bottom-hbn-mask + --graphene-mask + --warp-top + --warp-bottom + --full-stack-image. Inspect graphite_result.json: low_confidence=false + winner_score absent (physics has no score). If outline looks correct → DONE.
  ├─ Outline wrong → re-run graphite.py with --seed-points "X,Y" (agent visual judgement, bottom_part px coords). The manual seed always overrides graphene auto-seed.
  └─ Both auto AND manual seed produce poor outline → run graphite_c3.py as a second opinion. If C3's winner_score > 0.5 and the outline is plausible, accept it.
```

When the agent disagrees with all three candidates, it's expected to commit a manual mask via `skills/nanodevice_flakedetect_detect/scripts/commit_mask.py` (manual override path).

### `graphite.py` — physics-driven (default)

**Principles encoded**:

- **P1.** `graphite_polygon ⊆ bottom_hBN_polygon` — search domain is the bottom_hBN footprint.
- **P2.** `graphite_polygon ∩ graphene_polygon ≠ ∅` — seed at `bottom_hBN ∩ graphene-projection` (or agent-supplied points).

**Algorithm**: build a per-image Gaussian colour model from the seed disk (initial 5 µm), then grow the connected component of pixels with LAB-Mahalanobis distance to the *fixed initial seed model* below 9.0 (3-sigma). No iterative re-fit (prevents the model from widening into bare bottom_hBN). No absolute LAB / area / aspect thresholds. Final dilation 0.5 µm.

```bash
# Auto-seed via graphene projection
conda run -n instrMCPdev python graphite.py \
    --image <bottom_part.jpg> --pixel-size <um/px> --output-dir <path> \
    --bottom-hbn-mask <align/bottom_hbn_mask_bp.png> \
    --graphene-mask <detect/graphene_mask.png> --graphene-mirror \
    --warp-top <align/warp_top.npy> \
    --warp-bottom <align/warp_sift_bottom.npy> \
    --full-stack-image <input/full_stack_raw.jpg>

# Agent-supplied seed point(s) — overrides auto-seed
conda run -n instrMCPdev python graphite.py \
    --image <bottom_part.jpg> --pixel-size <um/px> --output-dir <path> \
    --bottom-hbn-mask <align/bottom_hbn_mask_bp.png> \
    --seed-points "1234,567"
```

**Key result fields** (`graphite_result.json`):
- `seed_source` — `bottom_hbn_intersect_graphene`, `manual_points`, `manual_points_fallback_to_search_region`, etc.
- `low_confidence: true` — auto-seed was empty / the colour model couldn't separate graphite from bg / classification produced no CC connected to the seed. Spawn vision-review and consider supplying `--seed-points` manually.
- `lab_separation` — Euclidean distance between seed_mu and bg_mu in LAB. < 3.0 means graphite & bottom_hBN colours are effectively indistinguishable in this image; treat output as a hint only.

### `graphite_c3.py` — priors ensemble (alternate)

Method, hard gates, and confidence score as in §"C3 Ensemble" of the previous design (preserved here for orthogonal-comparison runs). Same CLI as `graphite.py` minus the `--bottom-hbn-mask` / `--graphene-mask` / `--warp-*` arguments — C3 derives its own host-region HSV gate from `bottom_part.jpg` directly. Uses `graphite_shape_priors.json` etc. at the repo root. **Strictly sample-tuned** — fails on stacks outside the AH/ml training distribution.

```bash
conda run -n instrMCPdev python graphite_c3.py \
    --image <bottom_part.jpg> --pixel-size <um/px> --output-dir <path>
```

**Outputs (all three candidates)**: `graphite_mask.png`, `graphite_contour.npy`, `graphite_result.json`, `00_graphite_candidates.png`, `01_graphite_on_bottom.png`

---

## Graphene Detection — Tuning Guide

**Method**: Isolates the flake on PDMS via brightness+saturation thresholding, then K-means sub-clusters (default 3) within the flake in LAB space. Auto-selects the brightest sub-cluster.

**Key insight**: On PDMS, the flake has multiple brightness zones. Graphene is the brightest, but the auto-selection can grab overexposed artifacts or bright hBN instead. Always review the candidates.

### What to look for in 00_graphene_candidates.png

| What you see | What's wrong | Action |
|-------------|-------------|--------|
| One panel highlights the graphene region within the flake | Correct | Use `--cluster-id <N>` if not auto-selected |
| Auto-selected panel includes bright artifacts/reflections along with graphene | Brightest cluster includes non-graphene | Override with a panel that shows just the graphene region |
| Graphene region is split or partial | Sub-clusters too fine | Re-run with `--n-sub-clusters 2` |
| No panel clearly isolates graphene | Sub-clusters too coarse or graphene too subtle | Re-run with `--n-sub-clusters 5` for finer segmentation |

### Important: --mirror flag

If the align step used `--mirror` for the top_part, **you must also pass --mirror here**. The graphene detection must operate in the same coordinate system as the alignment warp.

```bash
# Pass 1: auto-detect + review
conda run -n instrMCPdev python graphene.py \
    --image <top_part.jpg> --pixel-size <um/px> --mirror --output-dir <path>

# Pass 2: override after reviewing 00_graphene_candidates.png
conda run -n instrMCPdev python graphene.py \
    --image <top_part.jpg> --pixel-size <um/px> --mirror \
    --cluster-id 0 --output-dir <path>
```

**Outputs**: `graphene_mask.png`, `graphene_contour.npy`, `graphene_result.json`, `00_graphene_candidates.png`, `02_graphene_on_top.png`

---

## Bottom hBN Detection

**Method**: Detects the bottom hBN directly from the `bottom_part` image (where it is the only hBN visible on the substrate), then warps the detection into full_stack coordinates using the SIFT warp matrix from the align step.

Each `bottom_part` image generates several candidate masks:

1. `union_tight` — HSV gate `(s>80) & (80<h<130)` + `morph_clean(close_k=7, open_k=7)` + `keep_largest_n`.
2. `union_filled` — same as above plus flood-fill (re-incorporates dark interior holes such as the graphite tongue).
3. `kmeans_K{4,6,8}_c<i>` — K-means clusters in LAB at K∈{4,6,8} masked by the loose color gate, broken into connected components.
4. `kmeans_union_K{4,6,8}_top1` — union of the top-1 saturated cluster only (the legacy `top2` / `top3` unions were removed because they over-merged neighboring blue debris on AH stacks).

Every candidate is scored by `_score_cc` against `bottom_hbn_shape_priors.json` (Gaussian likelihood over area / aspect / solidity / LAB / HSV). The highest-scoring candidate wins. Final post-process: `morph_clean(close_k=11, open_k=5)`, `keep_largest_n`, `flood_fill_holes`, then a 1.5 µm dilation to match the GT-dilation convention.

### Never-empty fallback

If *every* candidate is rejected by the score gate (typical when GT bottom_hBN is unusually small / unusually colored — e.g. HM05 GT=742 µm² is below `0.4 × area_um2_min = 2644 µm²`), the script no longer returns an empty mask. It falls back to the largest connected component of the loose color gate (filled), and sets `low_confidence: true` in `bottom_hbn_result.json`. This replaces the silent EMPTY behaviour that was breaking HM05 in the bench.

### When it still fails — known limitations

| Symptom | Likely cause | Action |
|---------|-------------|--------|
| Contour traces the whole visible cyan region, but GT polygon is much smaller | Visible flake includes graphite + bottom_hBN merged in 2D, and the score function picks the larger blob | Inspect the candidate list in the priors-fit log; consider re-fitting priors with the actual stack |
| Contour is offset from visible flake | SIFT warp inaccurate | Check inliers reported by `sift_align.py`; rerun with adjusted parameters |
| Contour misses the bottom_hBN entirely (LOW ratio) | K-means split bottom_hBN across clusters AND the union path was rejected by the area gate | Confirm the loose color gate sees blue at the expected location; expand priors area band |
| Contour is much larger than expected (HIGH ratio) | `union_tight` or a K-means cluster bridges the bottom_hBN with neighboring blue debris | The `close_k=7` reduction limits this — if it persists, the visible flake genuinely is the merged region |

```bash
conda run -n instrMCPdev python bottom_hbn.py \
    --image <bottom_part.jpg> \
    --warp-matrix <align/warp_sift_bottom.npy> \
    --target-image <full_stack_raw.jpg> \
    --pixel-size <um/px> --output-dir <path>
```

The legacy `--n-clusters` flag is ignored — the multi-K sweep covers K=4/6/8.

**Outputs**: `bottom_hbn_mask.png`, `bottom_hbn_contour.npy`, `bottom_hbn_result.json` (with `low_confidence` + `fallback_source` fields), `03_bottom_hbn_on_full.png`

---

## Top hBN Detection

**Method**: Copies the footprint from the align step. No detection is performed — top hBN IS the footprint.

If the top hBN detection looks wrong, the fix is in the **align** step (re-run footprint.py or adjust Chamfer alignment), not here.

```bash
conda run -n instrMCPdev python top_hbn.py \
    --footprint-mask <align/footprint_mask.png> \
    --footprint-contour <align/footprint_contour.npy> \
    --image <full_stack_raw.jpg> \
    --pixel-size <um/px> --output-dir <path>
```

**Outputs**: `top_hbn_mask.png`, `top_hbn_contour.npy`, `top_hbn_result.json`, `04_top_hbn_footprint.png`

---

## Assembling detections.json

After all 4 scripts complete, assemble `detections.json` by reading each `*_result.json` sidecar. This file is consumed by `combine::transform.py`.

**Template** (fill in paths and values from script outputs):

```json
{
  "pixel_size_um": 0.087,
  "source_images": {
    "graphite": "/path/to/bottom_part.jpg",
    "graphene": "/path/to/top_part.jpg",
    "bottom_hBN": "/path/to/full_stack_raw.jpg",
    "top_hBN": "/path/to/full_stack_raw.jpg"
  },
  "materials": {
    "graphite": {
      "mask_file": "graphite_mask.png",
      "contour_file": "graphite_contour.npy",
      "area_px": 103546,
      "area_um2": 783.74,
      "coordinate_system": "bottom_part",
      "mirrored": false
    },
    "graphene": {
      "mask_file": "graphene_mask.png",
      "contour_file": "graphene_contour.npy",
      "area_px": 105507,
      "area_um2": 798.58,
      "coordinate_system": "top_part",
      "mirrored": true
    },
    "bottom_hBN": {
      "mask_file": "bottom_hbn_mask.png",
      "contour_file": "bottom_hbn_contour.npy",
      "area_px": 916400,
      "area_um2": 6936.23,
      "coordinate_system": "full_stack",
      "mirrored": false
    },
    "top_hBN": {
      "mask_file": "top_hbn_mask.png",
      "contour_file": "top_hbn_contour.npy",
      "area_px": 476472,
      "area_um2": 3606.42,
      "coordinate_system": "full_stack",
      "mirrored": false
    }
  }
}
```

**Assembly steps:**
1. Read `graphite_result.json`, `graphene_result.json`, `bottom_hbn_result.json`, `top_hbn_result.json` from the detect output directory
2. Copy `area_px` and `area_um2` from each sidecar into the template
3. Set `mirrored: true` for graphene if `--mirror` was used
4. All `mask_file` and `contour_file` paths are relative to the detect output directory
5. Write to `<detect_output_dir>/detections.json`

---

## Coordinate Systems

Each detect script operates in its source image's native coordinate system. The combine step handles all transforms.

| Material | Source Image | Detection Coords | Output Coords | Mirror |
|----------|-------------|-----------------|---------------|--------|
| graphite | bottom_part | bottom_part | bottom_part | no |
| graphene | top_part | top_part | top_part (mirrored if --mirror) | depends |
| bottom_hBN | bottom_part | bottom_part → warped to full_stack | full_stack | no |
| top_hBN | full_stack_raw | full_stack | full_stack | no |
