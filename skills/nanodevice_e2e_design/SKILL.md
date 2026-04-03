---
name: nanodevice_e2e_design
description: Orchestrate the full end-to-end nanodevice design pipeline, from user query through flake detection, GDS alignment, contour commit, Hall bar design, and final save. Sequences sub-skills with gate conditions and retry logic.
---

# nanodevice_e2e_design -- End-to-End Device Design Pipeline

Orchestrate the complete autonomous nanodevice design workflow. This skill sequences 7 pipeline steps, each gated by verification conditions. Sub-skills handle the domain-specific work; this orchestrator manages sequencing, gate checks, and retries.

**This is a pure-text orchestrator skill.** No scripts directory. The agent dispatches sub-skills and tools at each step.

---

## Pipeline Overview

| # | Step | Tool / Skill | Gate |
|---|------|-------------|------|
| 1 | QUERY | nanodevice_hallbar Step 0 | All parameters confirmed |
| 2 | VALIDATE | validate_pixel_size | Pixel size verified |
| 3 | DETECT | nanodevice_flakedetect | traces.json with 4 materials |
| 4 | ALIGN | nanodevice_gdsalign | mean_residual < 5 um |
| 5 | CONTOUR | nanodevice_flakedetect_commit | Polygons on L10-L13 |
| 6 | HALLBAR | nanodevice_hallbar | evaluate_design score >= 0.80 |
| 7 | SAVE | save_layout + result.json | Files written |

Each step has a gate condition that must pass before proceeding to the next step. Maximum of 2 retries per step. If a step fails after 2 retries, report to the user for manual intervention.

---

## Step 1: QUERY -- Gather User Requirements

Read the `nanodevice_hallbar` skill and execute its Step 0 (Query User) to collect:
- Device type, shape, pin count
- Topgate / backgate preferences
- Pixel size (with objective-based guide)
- Source image paths (bottom_part, top_part, full_stack)
- Output directory
- Layer assignments

**Gate condition for QUERY:** All required parameters have been provided by the user. Proceed only if device type, pixel_size, and source image paths are confirmed.

---

## Step 2: VALIDATE -- Confirm Pixel Size

Call the `validate_pixel_size` tool to verify the pixel_size value is consistent with the source images and objective metadata.

**Gate condition for VALIDATE:** validate_pixel_size returns a confirmed pixel_size value. If the tool reports a mismatch, ask the user to verify before proceeding. Proceed only if pixel_size is validated.

---

## Step 3: DETECT -- Flake Detection

Dispatch a subagent to read and follow the `nanodevice_flakedetect` skill. This runs the full stack detection pipeline (align, detect, combine) on the source microscope images.

Pass to the subagent:
- Source image paths (bottom_part, top_part, full_stack_raw, full_stack_lut)
- pixel_size
- mirror setting
- Output directory

**Gate condition for DETECT:** The detection pipeline produces `traces.json` with contours for all 4 materials (graphene, graphite, bottom_hBN, top_hBN). Check that `combine_report.json` status is complete. Proceed only if all materials are detected.

---

## Step 4: ALIGN -- GDS Template Alignment

Dispatch a subagent to read and follow the `nanodevice_gdsalign` skill. This aligns the microscope stack images to the GDS fabrication template using lithographic marker detection.

Pass to the subagent:
- full_stack image path
- Template GDS path
- pixel_size
- Output directory

**Gate condition for ALIGN:** `gds_alignment_report.json` exists with `mean_residual < 5 um`. The image-to-GDS transform must be valid. Proceed only if alignment quality meets the prerequisite threshold.

---

## Step 5: CONTOUR -- Commit Polygons to KLayout

Dispatch a subagent to read and follow the `nanodevice_flakedetect_commit` skill. This inserts the detected material polygons into KLayout on their designated layers (L10-L13).

Pass to the subagent:
- traces.json path (from DETECT step output)
- full_stack image path (for background)
- pixel_size
- GDS transform (from ALIGN step)

**Gate condition for CONTOUR:** Polygons are visible on layers L10/0 through L13/0 in KLayout. Verify via `get_layout_info` that at least graphene (L11/0) and graphite (L13/0) have shapes. Proceed only if material contours are committed.

---

## Step 6: HALLBAR -- Design Hall Bar Device

Follow the `nanodevice_hallbar` skill Steps 1-8 to design the Hall bar on the committed material regions. This includes:
- Analyze material overlap (Step 1)
- Design adaptive mesa (Step 2)
- Place contacts (Step 3)
- Place topgate (Step 4)
- Place pin markers (Step 5)
- Route to bonding pads (Step 6)
- DRC check (Step 7)
- Evaluate and iterate (Step 8)

**Gate condition for HALLBAR:** `evaluate_design` with mode=score returns a score >= 0.80. Check that all design components are present before proceeding to save.

---

## Step 7: SAVE -- Save Final Design

Save the completed layout and write a summary:

1. Call `save_layout` to export the GDS file
2. Write `result.json` containing:
   - `layer_map`: all layer assignments used
   - `score`: final evaluation score
   - `pixel_size`: validated pixel size
   - `device_type`: from QUERY step
   - `pipeline_status`: per-step pass/fail/retry counts
   - `feedback`: design notes and any user interventions

**Gate condition for SAVE:** GDS file written successfully and result.json contains all required fields. Verify the output file exists.

---

## Retry Protocol

Maximum of 2 retries per step. When a gate condition fails:

| Failed Step | Retry Action |
|-------------|-------------|
| VALIDATE | Re-ask user for pixel_size, re-run validation |
| DETECT | Re-run flakedetect with adjusted parameters (cluster selection, thresholds) |
| ALIGN | Re-run gdsalign with wider search range or different marker set |
| CONTOUR | Re-run commit with corrected transform |
| HALLBAR | Re-run failing sub-step (mesa, contacts, routing) per evaluate_design feedback |

If any step exhausts its 2 retries, stop the pipeline and report the failure to the user with diagnostic information. Do not proceed to subsequent steps with a failed prerequisite.

---

## Conventions

- **Conda env:** `base` (has opencv, numpy, scipy, sklearn)
- **Pixel coordinates:** image origin at top-left; KLayout uses center origin with Y-flip
- **Layer references:** always as `layer/datatype` (e.g., `11/0`)
- **Output directory:** defaults to `<source_image_dir>/output/` if not specified
- **Sub-skill dispatch:** each sub-skill runs as a subagent reading its own SKILL.md
