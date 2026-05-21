"""Agent-driven evaluator for detector regression tests (Phase 0.75).

This module dispatches a focused Claude Code agent to run the 4 material
detectors on a given stack, pick --cluster-id overrides where beneficial,
produce a result.gds, and then scores that result against Aligned_Stack.gds
using the canonical detect_evaluator.

Motivation
----------
The static-baseline gate in gt_evaluator.py (Phase 0.5) scores
*default-algorithm* outputs against BASELINE_SCORES that were measured from
existing result.gds files produced by the qlaybot agent using vision-in-the-
loop --cluster-id overrides. That comparison is structurally biased: the
default algorithm can never reach a baseline that was produced by an agent
who saw the microscope images and picked the right candidate. The correct gate
is: "given the new detector code, can a focused agent produce a high-quality
result.gds?" which is what this module implements.

Usage
-----
    from agent_evaluator import score_stack_with_agent
    result = score_stack_with_agent("ml04", work_dir=Path("/tmp/ml04_agent"))
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
DETECT_SCRIPTS = REPO_ROOT / "skills" / "nanodevice_flakedetect_detect" / "scripts"
COMBINE_SCRIPTS = REPO_ROOT / "skills" / "nanodevice_flakedetect_combine" / "scripts"
GDSALIGN_SCRIPTS = REPO_ROOT / "skills" / "nanodevice_gdsalign" / "scripts"

FIXTURE_ROOT = Path("/Volumes/RandomData/harbour-workspace/qlaybot/detect")

# Primary GT root: klayout-bench-bare-codex contains flake_detect_<stack>/tests/
# for all 18 bench stacks. The legacy klayout-bench-qlaybot has device_design_
# prefixes only and is kept as a fallback.
GT_SEARCH_ROOTS = [
    Path("/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench-bare-codex"),
    Path("/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench-bare-claude_code"),
    Path("/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench-qlaybot"),
    Path("/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench-coevolve"),
    Path("/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench"),
]
# Dir-name prefixes to try (in order): flake_detect_ first (canonical for this
# task), then device_design_ and e2e_device_design_ as fallbacks.
GT_DIR_PREFIXES = ["flake_detect_", "device_design_", "e2e_device_design_"]


def _resolve_gt_gds(stack: str) -> Path:
    """Locate Aligned_Stack.gds for *stack* across multiple benchmark roots.

    Searches GT_SEARCH_ROOTS × GT_DIR_PREFIXES in order.  Returns the first
    match, or raises FileNotFoundError with a descriptive message if none found.
    """
    tried = []
    for bench in GT_SEARCH_ROOTS:
        for prefix in GT_DIR_PREFIXES:
            candidate = bench / f"{prefix}{stack}" / "tests" / "Aligned_Stack.gds"
            tried.append(candidate)
            if candidate.exists():
                return candidate
    raise FileNotFoundError(
        f"Aligned_Stack.gds not found for stack '{stack}'. Tried:\n"
        + "\n".join(f"  {p}" for p in tried)
    )


def _resolve_evaluator_py(stack: str) -> Path:
    """Locate detect_evaluator.py for *stack* (same search as GT GDS)."""
    tried = []
    for bench in GT_SEARCH_ROOTS:
        for prefix in GT_DIR_PREFIXES:
            candidate = bench / f"{prefix}{stack}" / "tests" / "detect_evaluator.py"
            tried.append(candidate)
            if candidate.exists():
                return candidate
    raise FileNotFoundError(
        f"detect_evaluator.py not found for stack '{stack}'. Tried:\n"
        + "\n".join(f"  {p}" for p in tried)
    )

CONDA_PYTHON = "/Users/andrewwayne/anaconda3/envs/instrMCPdev/bin/python"

# Default pixel size for all bench stacks (100x objective)
DEFAULT_PIXEL_SIZE_UM = 0.106


# ---------------------------------------------------------------------------
# GT evaluator loader (same as gt_evaluator.py — canonical, read-only)
# ---------------------------------------------------------------------------

def _load_evaluator(stack: str):
    """Import detect_evaluator.py from the GT fixture (canonical, read-only)."""
    evaluator_path = _resolve_evaluator_py(stack)
    spec = importlib.util.spec_from_file_location("detect_evaluator", evaluator_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _compute_per_material_iou(result_gds: Path, gt_gds: Path, evaluator_mod) -> Dict[str, float]:
    """Compute per-material raw IoU for diagnostics."""
    import gdstk
    out_lib = gdstk.read_gds(str(result_gds))
    ref_lib = gdstk.read_gds(str(gt_gds))

    layer_to_mat = {
        (10, 0): "top_hbn",
        (11, 0): "graphene",
        (12, 0): "bottom_hbn",
        (13, 0): "graphite",
    }

    per_mat = {}
    for (layer, dt), mat_name in layer_to_mat.items():
        ref_geom = evaluator_mod._shapely_union(ref_lib, layer, dt)
        if ref_geom is None or ref_geom.is_empty:
            continue
        out_geom = evaluator_mod._shapely_union(out_lib, layer, dt)
        if out_geom is None or out_geom.is_empty:
            per_mat[mat_name] = 0.0
        else:
            inter = ref_geom.intersection(out_geom)
            union = ref_geom.union(out_geom)
            per_mat[mat_name] = float(inter.area / union.area) if union.area > 0 else 0.0

    return per_mat


# ---------------------------------------------------------------------------
# Task prompt builder
# ---------------------------------------------------------------------------

def _build_agent_prompt(stack: str, stack_input: Path, align_dir: Path,
                        gdsalign_dir: Path, work_dir: Path) -> str:
    """Build the tight, reproducible task prompt for the detector agent."""
    detect_dir = work_dir / "detect"
    combine_dir = work_dir / "combine"
    gdsalign_out_dir = work_dir / "gdsalign"
    result_gds = work_dir / "result.gds"

    # Read pixel size and mirror flag from alignment report if available
    align_report = align_dir / "alignment_report.json"
    pixel_size = DEFAULT_PIXEL_SIZE_UM
    graphene_mirror_flag = "--mirror"
    if align_report.exists():
        try:
            report = json.loads(align_report.read_text())
            pixel_size = float(report.get("pixel_size_um", DEFAULT_PIXEL_SIZE_UM))
            mirror = report.get("alignments", {}).get("top", {}).get("mirror", True)
            graphene_mirror_flag = "--mirror" if mirror else ""
        except Exception:
            pass

    # Paths
    bottom_part = stack_input / "bottom_part.jpg"
    top_part = stack_input / "top_part.jpg"
    full_stack = stack_input / "full_stack_raw.jpg"
    template_gds = stack_input / "Template.gds"
    warp_bottom = align_dir / "warp_sift_bottom.npy"
    footprint_mask = align_dir / "footprint_mask.png"
    gds_warp = gdsalign_dir / "gds_warp.npy"

    # Build the --footprint-mask flag for graphene.py (Phase 10a).
    # Only include the flag if footprint_mask.png AND warp_top.npy both exist —
    # graphene.py needs the warp matrix to bring the mask into top_part coords.
    footprint_flag_for_graphene = ""
    if footprint_mask.exists() and (align_dir / "warp_top.npy").exists():
        footprint_flag_for_graphene = f"--footprint-mask {footprint_mask} \\"

    prompt = f"""You are a precision detector agent for van der Waals heterostructure microscopy images.
Your task: run 4 material detectors on stack **{stack}**, inspect their outputs, pick the best candidate
for each material, produce traces.json + traces_gds.json, then build result.gds.

## Absolute paths (do NOT use relative paths)

- Python interpreter: {CONDA_PYTHON}
- bottom_part.jpg: {bottom_part}
- top_part.jpg: {top_part}
- full_stack_raw.jpg: {full_stack}
- Template.gds: {template_gds}
- warp_sift_bottom.npy: {warp_bottom}
- footprint_mask.png: {footprint_mask}
- gds_warp.npy: {gds_warp}
- Detector scripts dir: {DETECT_SCRIPTS}
- Combine scripts dir: {COMBINE_SCRIPTS}
- GDS-align scripts dir: {GDSALIGN_SCRIPTS}
- Output detect dir: {detect_dir}
- Output combine dir: {combine_dir}
- Output gdsalign dir: {gdsalign_out_dir}
- Final result.gds: {result_gds}

## Step 1 — Run all 4 detectors

Create {detect_dir} first.

**graphite** (reads bottom_part, outputs to detect dir):
```
{CONDA_PYTHON} {DETECT_SCRIPTS}/graphite.py \\
  --image {bottom_part} \\
  --pixel-size {pixel_size} \\
  --output-dir {detect_dir}
```

**graphene** (reads top_part, outputs to detect dir):
```
{CONDA_PYTHON} {DETECT_SCRIPTS}/graphene.py \\
  --image {top_part} \\
  --pixel-size {pixel_size} \\
  {graphene_mirror_flag} \\
  {footprint_flag_for_graphene}
  --output-dir {detect_dir}
```
(The `--footprint-mask` flag, if present above, enables spatial-containment scoring
 so rank-0 is the footprint-contained graphene flake. Copy the command exactly.)

**bottom_hBN** (reads bottom_part + warp matrix, outputs to detect dir):
```
{CONDA_PYTHON} {DETECT_SCRIPTS}/bottom_hbn.py \\
  --image {bottom_part} \\
  --target-image {full_stack} \\
  --warp-matrix {warp_bottom} \\
  --pixel-size {pixel_size} \\
  --output-dir {detect_dir}
```

**top_hBN** (reads full_stack + footprint mask, outputs to detect dir):
```
{CONDA_PYTHON} {DETECT_SCRIPTS}/top_hbn.py \\
  --footprint-mask {footprint_mask} \\
  --image {full_stack} \\
  --pixel-size {pixel_size} \\
  --output-dir {detect_dir}
```

## Step 2 — Inspect sidecar JSONs and candidate panels

After each detector runs:
1. Read the sidecar JSON (e.g. `{detect_dir}/graphite_result.json`).
2. If `low_confidence` is True or the area looks wrong (too small, too large, 0),
   check the candidate panel image (e.g. `{detect_dir}/refined_candidates.png`
   for graphite, `{detect_dir}/00_graphene_candidates.png` for graphene).
   - For graphite: panels are in `refined_candidates.png` showing rank #0, #1, #2, ...
   - For graphene: panels are in `00_graphene_candidates.png`
3. If rank 0 looks wrong, re-run with `--cluster-id N` (N = 1, 2, ...) to pick
   a better candidate. You may re-run each detector **at most 2 more times** (3 total).
4. Never re-run a detector more than 3 times total. Move on if no better candidate found.

**Graphene-specific guidance (Phase 10a):**
The graphene detector now uses footprint-containment scoring (--footprint-mask flag above).
Rank-0 is the graphene candidate with the highest containment within the footprint + area score.
**Prefer cluster_id=0 (the default) for graphene** — only override with --cluster-id if:
- The graphene area is 0 px (low_confidence=True), OR
- The diagnostic overlay clearly shows the selected region is on the substrate (not the flake).
Do NOT retry graphene with higher cluster-ids just because the shape looks imperfect —
the containment scoring ensures rank-0 is the most likely graphene candidate.

## Constraint

- MAXIMUM 3 detector runs per material (1 initial + 2 retries with --cluster-id).
- Do NOT read or reference any Aligned_Stack.gds or ground-truth files.
- Work only from microscope images and detector outputs.

## Step 3 — Assemble detections.json

After running all 4 detectors, assemble {detect_dir}/detections.json:
```python
import json
from pathlib import Path

detect_dir = Path("{detect_dir}")
pixel_size = {pixel_size}

def read_area(json_path, mask_path):
    if json_path.exists():
        d = json.loads(json_path.read_text())
        return int(d.get("area_px", 0)), float(d.get("area_um2", 0.0))
    import cv2, numpy as np
    m = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        return 0, 0.0
    px = int((m > 0).sum())
    return px, round(px * pixel_size * pixel_size, 2)

g_px, g_um2 = read_area(detect_dir / "graphite_result.json", detect_dir / "graphite_mask.png")
ge_px, ge_um2 = read_area(detect_dir / "graphene_result.json", detect_dir / "graphene_mask.png")
bh_px, bh_um2 = read_area(detect_dir / "bottom_hbn_result.json", detect_dir / "bottom_hbn_mask.png")
th_px, th_um2 = read_area(detect_dir / "top_hbn_result.json", detect_dir / "top_hbn_mask.png")

detections = {{
    "pixel_size_um": pixel_size,
    "source_images": {{
        "graphite":   str(Path("{bottom_part}")),
        "graphene":   str(Path("{top_part}")),
        "bottom_hBN": str(Path("{full_stack}")),
        "top_hBN":    str(Path("{full_stack}")),
    }},
    "materials": {{
        "graphite": {{
            "mask_file": "graphite_mask.png",
            "contour_file": "graphite_contour.npy",
            "area_px": g_px,
            "area_um2": g_um2,
            "coordinate_system": "bottom_part",
            "mirrored": False,
        }},
        "graphene": {{
            "mask_file": "graphene_mask.png",
            "contour_file": "graphene_contour.npy",
            "area_px": ge_px,
            "area_um2": ge_um2,
            "coordinate_system": "top_part",
            "mirrored": {"True" if graphene_mirror_flag else "False"},
        }},
        "bottom_hBN": {{
            "mask_file": "bottom_hbn_mask.png",
            "contour_file": "bottom_hbn_contour.npy",
            "area_px": bh_px,
            "area_um2": bh_um2,
            "coordinate_system": "full_stack",
            "mirrored": False,
        }},
        "top_hBN": {{
            "mask_file": "top_hbn_mask.png",
            "contour_file": "top_hbn_contour.npy",
            "area_px": th_px,
            "area_um2": th_um2,
            "coordinate_system": "full_stack",
            "mirrored": False,
        }},
    }},
}}
Path("{detect_dir}").mkdir(parents=True, exist_ok=True)
(detect_dir / "detections.json").write_text(json.dumps(detections, indent=2))
print("wrote detections.json")
```

## Step 4 — Run combine/transform.py

```
mkdir -p {combine_dir}
{CONDA_PYTHON} {COMBINE_SCRIPTS}/transform.py \\
  --detections {detect_dir}/detections.json \\
  --align-dir {align_dir} \\
  --image {full_stack} \\
  --pixel-size {pixel_size} \\
  --output-dir {combine_dir}
```

## Step 5 — Run gdsalign/commit_gds.py --warp-only

```
mkdir -p {gdsalign_out_dir}
{CONDA_PYTHON} {GDSALIGN_SCRIPTS}/commit_gds.py \\
  --warp {gds_warp} \\
  --traces {combine_dir}/traces.json \\
  --image {full_stack} \\
  --pixel-size {pixel_size} \\
  --gds {template_gds} \\
  --output-dir {gdsalign_out_dir} \\
  --warp-only
```

## Step 6 — Build result.gds from traces_gds.json

```python
import json, gdstk
from pathlib import Path

with open("{gdsalign_out_dir}/traces_gds.json") as f:
    traces = json.load(f)

LAYER_MAP = {{
    "top_hBN":    (10, 0),
    "graphene":   (11, 0),
    "bottom_hBN": (12, 0),
    "graphite":   (13, 0),
}}

lib = gdstk.Library()
cell = lib.new_cell("DETECT_OUT")

for mat_name, entries in traces.get("materials", {{}}).items():
    layer_dt = LAYER_MAP.get(mat_name)
    if layer_dt is None:
        continue
    layer, datatype = layer_dt
    for entry in entries:
        pts = entry.get("contour_gds")
        if not pts or len(pts) < 3:
            continue
        cell.add(gdstk.Polygon(pts, layer=layer, datatype=datatype))

lib.write_gds("{result_gds}")
print("wrote result.gds")
```

## Step 7 — Output contract

Once result.gds is written, print this exact line (required for the harness to find it):
```
RESULT_GDS: {result_gds}
```

That is your final output. Do not print any other lines starting with "RESULT_GDS:".
"""
    return prompt


# ---------------------------------------------------------------------------
# Agent invocation
# ---------------------------------------------------------------------------

def _count_detector_invocations(transcript: str) -> int:
    """Count how many times a detector script was invoked (rough heuristic)."""
    # Count lines that look like detector command output
    patterns = [
        r"graphite\.py",
        r"graphene\.py",
        r"bottom_hbn\.py",
        r"top_hbn\.py",
    ]
    count = 0
    for pat in patterns:
        count += len(re.findall(pat, transcript))
    return count


def _extract_cluster_id_choices(transcript: str) -> Dict[str, int]:
    """Extract --cluster-id choices from the transcript (best effort)."""
    choices = {}
    for mat in ["graphite", "graphene", "bottom_hbn", "top_hbn"]:
        # Look for --cluster-id N near the material name
        pattern = rf"{mat}.*?--cluster-id\s+(\d+)|--cluster-id\s+(\d+).*?{mat}"
        matches = re.findall(pattern, transcript, re.IGNORECASE | re.DOTALL)
        if matches:
            last = next(
                (m[0] or m[1] for m in reversed(matches) if m[0] or m[1]),
                None,
            )
            if last:
                choices[mat] = int(last)
    return choices


def score_stack_with_agent(
    stack: str,
    *,
    work_dir: Path,
    model: str = "sonnet",
    timeout_s: int = 600,
) -> Dict:
    """Dispatch a focused agent to detect materials in `stack` and produce
    a result.gds. Score against ground truth via detect_evaluator.

    Parameters
    ----------
    stack       : e.g. "ml04"
    work_dir    : directory for all agent working files (caller manages lifecycle)
    model       : claude model alias (default "sonnet")
    timeout_s   : subprocess timeout in seconds (default 600)

    Returns
    -------
    {
        "stack": "ml04",
        "weighted": 0.85,
        "per_material": {"top_hbn": 0.97, "graphene": 0.87, ...},
        "agent_invocations": 7,
        "agent_cluster_id_choices": {"graphite": 2, ...},
        "agent_transcript_path": "/tmp/.../transcript.log",
        "agent_duration_s": 145.3,
    }
    """
    # ---- Verify prerequisites ----
    stack_dir = FIXTURE_ROOT / stack
    stack_input = stack_dir / "input"
    align_dir = stack_dir / "output" / "align"
    gdsalign_dir = stack_dir / "output" / "gdsalign"

    # Environmental pre-checks: missing fixture dirs → pytest.skip (not fail)
    # so that a missing external drive shows up as N skipped, not N failed.
    import pytest as _pytest  # noqa: PLC0415  (local import to keep top-level clean)
    for p, label in [
        (stack_input, "stack input dir"),
        (align_dir, "align output dir (warp_sift_bottom.npy, warp_top.npy, etc.)"),
        (gdsalign_dir, "gdsalign output dir (gds_warp.npy)"),
    ]:
        if not p.exists():
            _pytest.skip(
                f"[env] {label} not found for stack '{stack}': {p}. "
                "Mount the fixture volume or run the align/gdsalign stages first."
            )

    # Locate GT GDS — skip if no benchmark root contains it.
    try:
        gt_gds = _resolve_gt_gds(stack)
    except FileNotFoundError as exc:
        _pytest.skip(f"[env] No GT GDS for stack '{stack}': {exc}")

    # ---- Prepare working directory ----
    work_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = work_dir / "transcript.log"

    # ---- Build prompt ----
    prompt = _build_agent_prompt(
        stack, stack_input, align_dir, gdsalign_dir, work_dir
    )

    # ---- Invoke Claude Code agent ----
    cmd = [
        "claude",
        "--print",
        "--permission-mode", "bypassPermissions",
        "--model", model,
        "--allowedTools", "Bash,Read",
        "--output-format", "json",
        "--max-turns", "40",
        prompt,
    ]

    start = time.time()
    timed_out = False
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=str(REPO_ROOT),
        )
        raw_output = proc.stdout
        stderr_output = proc.stderr
        returncode = proc.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        raw_output = (exc.stdout or b"").decode("utf-8", errors="replace")
        stderr_output = (exc.stderr or b"").decode("utf-8", errors="replace")
        returncode = -1
    duration = time.time() - start

    # ---- Parse transcript from JSON output ----
    transcript = raw_output
    if raw_output.strip().startswith("{"):
        try:
            parsed = json.loads(raw_output)
            # claude --output-format json returns {"result": "...", ...}
            transcript = parsed.get("result", raw_output)
        except (json.JSONDecodeError, KeyError):
            pass
    if stderr_output:
        transcript = transcript + "\n[stderr]\n" + stderr_output
    if timed_out:
        transcript = transcript + f"\n[TIMEOUT after {timeout_s}s]"

    # ---- Save transcript ----
    transcript_path.write_text(transcript, encoding="utf-8", errors="replace")

    # ---- Persist stderr to a dedicated per-stack file for post-run triage ----
    if stderr_output:
        stderr_log_dir = Path("/tmp/phase9_run")
        stderr_log_dir.mkdir(parents=True, exist_ok=True)
        (stderr_log_dir / f"{stack}.stderr").write_text(
            stderr_output, encoding="utf-8", errors="replace"
        )

    if timed_out:
        raise TimeoutError(
            f"{stack}: agent timed out after {timeout_s}s. "
            f"Transcript: {transcript_path}"
        )

    if returncode not in (0, 1):  # claude returns 1 for "nothing to do" sometimes
        # Check if the result.gds was produced anyway before giving up
        result_gds = work_dir / "result.gds"
        if not result_gds.exists():
            raise RuntimeError(
                f"{stack}: agent exited with code {returncode}. "
                f"Transcript: {transcript_path}\n"
                f"Last 500 chars:\n{transcript[-500:]}"
            )

    # ---- Find RESULT_GDS: line ----
    result_gds_path = None
    for line in transcript.splitlines():
        m = re.match(r"RESULT_GDS:\s*(.+)", line.strip())
        if m:
            result_gds_path = Path(m.group(1).strip())
            break

    # Fallback: check if result.gds landed in work_dir anyway
    if result_gds_path is None or not result_gds_path.exists():
        fallback = work_dir / "result.gds"
        if fallback.exists():
            result_gds_path = fallback
        else:
            raise RuntimeError(
                f"{stack}: agent did not produce a result.gds. "
                f"No 'RESULT_GDS:' line found in transcript. "
                f"Transcript: {transcript_path}\n"
                f"Last 1000 chars:\n{transcript[-1000:]}"
            )

    # ---- Score via detect_evaluator ----
    evaluator_mod = _load_evaluator(stack)
    weighted = evaluator_mod.evaluate_flake_detect(str(result_gds_path), str(gt_gds))
    per_mat = _compute_per_material_iou(result_gds_path, gt_gds, evaluator_mod)

    # ---- Parse agent metadata ----
    agent_invocations = _count_detector_invocations(transcript)
    agent_cluster_id_choices = _extract_cluster_id_choices(transcript)

    return {
        "stack": stack,
        "weighted": round(weighted, 4),
        "per_material": {k: round(v, 4) for k, v in per_mat.items()},
        "agent_invocations": agent_invocations,
        "agent_cluster_id_choices": agent_cluster_id_choices,
        "agent_transcript_path": str(transcript_path),
        "agent_duration_s": round(duration, 1),
    }
