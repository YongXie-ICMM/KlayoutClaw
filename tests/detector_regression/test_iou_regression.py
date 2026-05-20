"""IoU >= 0.95 vs the frozen snapshot. New detector code must not regress."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from conftest import IOU_THRESHOLD, _read_mask, iou
from run_detector import run


def test_regression(stack, material, fixture_root, snapshot_root):
    snap_mask = snapshot_root / stack / f"{material}_mask.png"
    snap_meta = snapshot_root / stack / f"{material}_meta.json"
    if not snap_mask.exists():
        pytest.skip(f"no snapshot for {stack}/{material}")
    meta = json.loads(snap_meta.read_text())
    if meta.get("baseline_failure"):
        pytest.skip(f"{stack}/{material}: baseline run failed at Phase 0")

    with tempfile.TemporaryDirectory() as td:
        new_mask_path = run(material, fixture_root / stack / "input", Path(td))
        new = _read_mask(new_mask_path)
    base = _read_mask(snap_mask)
    try:
        score = iou(new, base)
    except ValueError as e:
        pytest.fail(f"{stack}/{material}: shape mismatch — {e}")
    assert score >= IOU_THRESHOLD, (
        f"{stack}/{material} IoU={score:.3f} < {IOU_THRESHOLD}"
    )
