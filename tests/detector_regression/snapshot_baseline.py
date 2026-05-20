"""One-shot baseline generator. Run ONCE at Phase 0 to freeze the current
detector outputs as the regression target. Not run in CI."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from conftest import (
    FIXTURE_ROOT,
    MATERIALS,
    REGRESSION_STACKS,
    SNAPSHOT_ROOT,
)
from run_detector import run, _pixel_size


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stacks", nargs="*", default=REGRESSION_STACKS)
    ap.add_argument("--materials", nargs="*", default=MATERIALS)
    ap.add_argument("--force", action="store_true",
                    help="overwrite existing snapshots")
    args = ap.parse_args()

    git_sha = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True
    ).strip()

    for stack in args.stacks:
        stack_input = FIXTURE_ROOT / stack / "input"
        if not stack_input.exists():
            raise SystemExit(f"missing fixture: {stack_input}")
        for material in args.materials:
            snap_dir = SNAPSHOT_ROOT / stack
            snap_dir.mkdir(parents=True, exist_ok=True)
            mask_dst = snap_dir / f"{material}_mask.png"
            meta_dst = snap_dir / f"{material}_meta.json"
            if mask_dst.exists() and not args.force:
                print(f"[skip] {mask_dst}")
                continue
            with tempfile.TemporaryDirectory() as td:
                out = Path(td)
                try:
                    mask_src = run(material, stack_input, out)
                    shutil.copy(mask_src, mask_dst)
                    meta_dst.write_text(json.dumps({
                        "stack": stack,
                        "material": material,
                        "pixel_size_um_per_px": _pixel_size(stack_input),
                        "source_image": str(stack_input),
                        "detector_git_sha": git_sha,
                    }, indent=2))
                    print(f"[snap] {mask_dst}")
                except Exception as exc:
                    print(f"[FAIL] {stack}/{material}: {exc}")
                    meta_dst.write_text(json.dumps({
                        "stack": stack,
                        "material": material,
                        "pixel_size_um_per_px": _pixel_size(stack_input),
                        "source_image": str(stack_input),
                        "detector_git_sha": git_sha,
                        "baseline_failure": True,
                        "baseline_failure_reason": str(exc),
                    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
