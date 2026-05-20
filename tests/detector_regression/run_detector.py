"""Common detector runner — invokes one of the 4 material detectors and
returns the output mask path. Used by both snapshot_baseline.py and the
regression tests."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DETECT = REPO_ROOT / "skills" / "nanodevice_flakedetect_detect" / "scripts"
ALIGN = REPO_ROOT / "skills" / "nanodevice_flakedetect_align" / "scripts"

# stacks all share pixel_size from their alignment metadata; the canonical
# bench value is 0.087 um/px (100x objective). Phase 0 reads this from
# the fixture if a manifest exists, else falls back to 0.087.
DEFAULT_PIXEL_SIZE_UM = 0.087


def _pixel_size(stack_input: Path) -> float:
    manifest = stack_input / "pixel_size.json"
    if manifest.exists():
        return float(json.loads(manifest.read_text())["pixel_size_um_per_px"])
    return DEFAULT_PIXEL_SIZE_UM


def _run(cmd: list[str], cwd: Path) -> None:
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"detector timed out after 300s: {' '.join(cmd)}"
        ) from e
    if proc.returncode != 0:
        raise RuntimeError(
            f"detector failed: {' '.join(cmd)}\nstderr:\n{proc.stderr[-2000:]}"
        )


def run_graphite(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "graphite.py"),
        "--image", str(stack_input / "bottom_part.jpg"),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "graphite_mask.png"


def run_graphene(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "graphene.py"),
        "--image", str(stack_input / "top_part.jpg"),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "graphene_mask.png"


def run_bottom_hbn(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    warp = stack_input.parent / "output" / "align" / "warp_sift_bottom.npy"
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "bottom_hbn.py"),
        "--image", str(stack_input / "bottom_part.jpg"),
        "--target-image", str(stack_input / "full_stack_raw.jpg"),
        "--warp-matrix", str(warp),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "bottom_hbn_mask.png"


def run_top_hbn(stack_input: Path, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    footprint = stack_input.parent / "output" / "align" / "footprint_mask.png"
    _run([
        "conda", "run", "-n", "instrMCPdev", "python",
        str(DETECT / "top_hbn.py"),
        "--footprint-mask", str(footprint),
        "--image", str(stack_input / "full_stack_raw.jpg"),
        "--pixel-size", str(_pixel_size(stack_input)),
        "--output-dir", str(out_dir),
    ], cwd=DETECT)
    return out_dir / "top_hbn_mask.png"


RUNNERS = {
    "graphite": run_graphite,
    "graphene": run_graphene,
    "bottom_hbn": run_bottom_hbn,
    "top_hbn": run_top_hbn,
}


def run(material: str, stack_input: Path, out_dir: Path) -> Path:
    if material not in RUNNERS:
        raise ValueError(f"unknown material {material!r}; expected one of {list(RUNNERS)}")
    return RUNNERS[material](stack_input, out_dir)
