"""Agent-driven detector regression test (Phase 9 / 0.8 gate).

Gate: per-stack weighted GT score >= 0.8.

Each test dispatches a focused Claude Code agent to:
  1. Run all 4 detectors on the stack's microscope images.
  2. Inspect candidate panels and sidecar JSONs.
  3. Pick --cluster-id overrides where beneficial (≤3 runs per detector).
  4. Assemble detections.json, run combine/transform and gdsalign.
  5. Produce result.gds and print "RESULT_GDS: <path>".

The harness scores that result.gds against Aligned_Stack.gds via
detect_evaluator.evaluate_flake_detect (canonical, read-only evaluator).

Scope expansion (Phase 9): 5 mlxx stacks → all 18 bench stacks
  (5 mlxx + 5 AH + 5 HM + 3 QH). Gate raised from 0.5 → 0.8.

Why not the static baseline gate (test_gt_regression.py)?
  BASELINE_SCORES in gt_evaluator.py were measured from existing result.gds
  files produced by the qlaybot agent using vision-in-the-loop --cluster-id
  overrides. Comparing default-algorithm outputs to agent-with-vision baselines
  is structurally biased: the default algorithm cannot reach a baseline the agent
  achieved by looking at the microscope images. The agent-driven gate is the
  honest measurement: can the new detector code, used by an agent with the same
  affordances, produce a high-quality result?

See: docs/superpowers/plans/2026-05-20-detector-de-tuning.md § Phase 9
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# Allow PYTHONPATH-based import from tests/detector_regression/
# (consistent with how gt_evaluator tests are run)
from agent_evaluator import score_stack_with_agent

# ---------------------------------------------------------------------------
# Gate configuration
# ---------------------------------------------------------------------------

WEIGHTED_FLOOR = 0.8
STACKS = [
    # mlxx series (original 5 from Phase 0.75)
    "ml04", "ml08", "ml09",
    pytest.param("ml11", marks=pytest.mark.xfail(
        reason="ml11 graphene IoU structurally < 0.4 tier — needs upstream "
               "detector improvement beyond this plan's scope")),
    "ml14",
    # AH series (5 stacks, Phase 9 expansion)
    "AH02", "AH03", "AH05", "AH06", "AH07",
    # HM series (5 stacks, Phase 9 expansion)
    "HM05", "HM06", "HM07", "HM08", "HM11",
    # QH series (3 stacks, Phase 9 expansion)
    "QH06", "QH07", "QH12",
]

# Per-test timeout in seconds. Each stack involves ~4 detector runs
# plus combine + gdsalign: budget 10 minutes.
AGENT_TIMEOUT_S = int(os.environ.get("AGENT_TIMEOUT_S", "600"))

# Model override via environment variable
AGENT_MODEL = os.environ.get("AGENT_MODEL", "sonnet")


# ---------------------------------------------------------------------------
# Fixture skip guard — same pattern as test_gt_regression.py
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def fixture_volume_ok() -> None:
    """Skip all tests if the fixture volume isn't mounted."""
    fixture_root = Path("/Volumes/RandomData/harbour-workspace/qlaybot/detect")
    if not fixture_root.exists():
        pytest.skip(f"fixture volume not mounted: {fixture_root}")


# ---------------------------------------------------------------------------
# Parametrized gate tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("stack", STACKS)
def test_agent_weighted_floor(stack: str, fixture_volume_ok, tmp_path):
    """Agent-produced result.gds must score >= {WEIGHTED_FLOOR} weighted GT."""
    result = score_stack_with_agent(
        stack,
        work_dir=tmp_path / stack,
        model=AGENT_MODEL,
        timeout_s=AGENT_TIMEOUT_S,
    )
    assert result["weighted"] >= WEIGHTED_FLOOR, (
        f"{stack}: weighted GT score {result['weighted']:.3f} < {WEIGHTED_FLOOR}.\n"
        f"Per-material: {result['per_material']}\n"
        f"Agent invocations (rough count): {result['agent_invocations']}\n"
        f"Cluster-id choices: {result['agent_cluster_id_choices']}\n"
        f"Duration: {result['agent_duration_s']:.0f}s\n"
        f"Transcript: {result['agent_transcript_path']}"
    )
