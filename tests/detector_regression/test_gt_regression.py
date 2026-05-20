"""GT-evaluator regression gate (Phase 0.5+).

Each new detector commit must score >= the existing priored-pipeline result.gds
GT score minus a 0.1 tolerance band (variance noise, post-warp anti-aliasing).

The floor is BASELINE_SCORES in gt_evaluator.py — measured from the existing
result.gds files at /Volumes/RandomData/harbour-workspace/qlaybot/detect/{stack}/output/result.gds.

Why 0.1 tolerance?
  Post-warp anti-aliasing and contour approximation introduce ~0.03-0.07 IoU
  variance across identical runs. A 0.1 band gives 3x headroom above noise
  while still catching genuine regressions (>0.1 drop = meaningful regression).

See: docs/superpowers/plans/2026-05-20-detector-de-tuning.md § Phase 0.5
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from conftest import FIXTURE_ROOT, REGRESSION_STACKS
from gt_evaluator import BASELINE_SCORES, score_stack

GT_ROOT = Path("/Users/andrewwayne/KLayout_Harbour/datasets/klayout-bench-qlaybot")
TOLERANCE = 0.1  # IoU tolerance band: baseline - TOLERANCE is the floor

# Cache scores per stack across tests in the same session to avoid re-running
# the full pipeline (4 detectors + transform + gdsalign) for each test parametrize.
_SCORE_CACHE: dict[str, dict] = {}


def _get_score(stack: str, fixture_root: Path, tmp_path_factory) -> dict:
    """Return cached score for stack, computing on first call."""
    if stack not in _SCORE_CACHE:
        work_dir = tmp_path_factory.mktemp(f"gt_{stack}", numbered=False)
        _SCORE_CACHE[stack] = score_stack(
            stack, fixture_root, GT_ROOT, work_dir=work_dir
        )
    return _SCORE_CACHE[stack]


@pytest.fixture(scope="session")
def fixture_root_session() -> Path:
    if not FIXTURE_ROOT.exists():
        pytest.skip(f"fixture volume not mounted: {FIXTURE_ROOT}")
    return FIXTURE_ROOT


@pytest.fixture(params=REGRESSION_STACKS, scope="session")
def stack_session(request) -> str:
    return request.param


def test_gt_weighted_score_not_regressed(
    stack_session, fixture_root_session, tmp_path_factory
):
    """Weighted GT score >= existing-result.gds baseline minus 0.1 tolerance."""
    actual = _get_score(stack_session, fixture_root_session, tmp_path_factory)
    baseline = BASELINE_SCORES[stack_session]["weighted"]
    floor = max(0.0, baseline - TOLERANCE)
    assert actual["weighted"] >= floor, (
        f"{stack_session}: weighted GT score {actual['weighted']:.3f} "
        f"< floor {floor:.3f} (baseline={baseline:.3f}, tol={TOLERANCE})"
    )


MATERIALS_GT = ["top_hbn", "graphene", "bottom_hbn", "graphite"]


@pytest.mark.parametrize("material", MATERIALS_GT)
def test_gt_per_material_not_regressed(
    stack_session, material, fixture_root_session, tmp_path_factory
):
    """Per-material IoU >= existing-result.gds per-material baseline minus 0.1."""
    actual = _get_score(stack_session, fixture_root_session, tmp_path_factory)
    per_mat = actual.get("per_material", {})
    if material not in per_mat:
        pytest.skip(f"{stack_session}/{material}: material not detected")
    actual_iou = per_mat[material]
    baseline = BASELINE_SCORES[stack_session]["per_material"].get(material, 0.0)
    floor = max(0.0, baseline - TOLERANCE)
    assert actual_iou >= floor, (
        f"{stack_session}/{material}: IoU {actual_iou:.3f} "
        f"< floor {floor:.3f} (baseline={baseline:.3f}, tol={TOLERANCE})"
    )
