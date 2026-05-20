"""GT-evaluator regression gate (Phase 0.5) — INFORMATIONAL ONLY.

[DEPRECATED AS GATE — Phase 0.75]

These tests are marked @pytest.mark.informational and are SKIPPED by default.
Run them with --run-informational to see their output.

Why this gate is informational, not authoritative:
  BASELINE_SCORES in gt_evaluator.py were measured from existing result.gds
  files produced by the qlaybot agent using vision-in-the-loop --cluster-id
  overrides. This means the baseline represents *agent-with-vision* performance,
  not *default-algorithm* performance. Comparing default detector outputs to
  an agent-overridden baseline is structurally biased: the default algorithm
  cannot reach a score that required a human/agent to look at candidate panels
  and pick the correct --cluster-id. For example, ml09 graphene has a baseline
  of 0.62 that was achieved by the agent picking cluster-id=1; the default
  detector selects a different candidate entirely.

  The authoritative gate (Phase 0.75) is in test_agent_regression.py:
  "given the new detector code, can a focused agent produce a high-quality
  result.gds?" — measuring agent-with-new-code performance against GT, with
  the agent allowed to use --cluster-id, candidate panels, and sidecar JSON.

See: docs/superpowers/plans/2026-05-20-detector-de-tuning.md § Phase 0.5 and § Phase 0.75
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


@pytest.mark.informational
def test_gt_weighted_score_not_regressed(
    stack_session, fixture_root_session, tmp_path_factory
):
    """Weighted GT score >= existing-result.gds baseline minus 0.1 tolerance.

    INFORMATIONAL ONLY — skipped by default. Use --run-informational to enable.
    See module docstring for why this gate is no longer authoritative.
    """
    actual = _get_score(stack_session, fixture_root_session, tmp_path_factory)
    baseline = BASELINE_SCORES[stack_session]["weighted"]
    floor = max(0.0, baseline - TOLERANCE)
    assert actual["weighted"] >= floor, (
        f"{stack_session}: weighted GT score {actual['weighted']:.3f} "
        f"< floor {floor:.3f} (baseline={baseline:.3f}, tol={TOLERANCE})"
    )


MATERIALS_GT = ["top_hbn", "graphene", "bottom_hbn", "graphite"]


@pytest.mark.informational
@pytest.mark.parametrize("material", MATERIALS_GT)
def test_gt_per_material_not_regressed(
    stack_session, material, fixture_root_session, tmp_path_factory
):
    """Per-material IoU >= existing-result.gds per-material baseline minus 0.1.

    INFORMATIONAL ONLY — skipped by default. Use --run-informational to enable.
    See module docstring for why this gate is no longer authoritative.
    """
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
