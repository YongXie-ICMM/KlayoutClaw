"""Shared fixtures for detector regression tests.

NOTE (Phase 0.5): Snapshot-based regression (_deprecated_snapshot_regression.py)
has been superseded by GT-evaluator regression (test_gt_regression.py). The
frozen snapshot PNGs in tests_resources/detector_snapshots/ are kept on disk as
informational drift indicators only — they are NOT used as a test gate.

NOTE (Phase 0.75): The canonical gate is now the *agent-driven* test in
test_agent_regression.py. The static GT gate in test_gt_regression.py has been
marked @pytest.mark.informational and is skipped by default because its
BASELINE_SCORES were derived from agent-with-vision outputs (not default-
algorithm outputs), making it structurally biased.

Custom markers:
  informational  — tests that are skipped by default; enable with
                   --run-informational flag (registered in conftest.py).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = Path("/Volumes/RandomData/harbour-workspace/qlaybot/detect")
SNAPSHOT_ROOT = REPO_ROOT / "tests_resources" / "detector_snapshots"

def pytest_addoption(parser):
    parser.addoption(
        "--run-informational",
        action="store_true",
        default=False,
        help="Run tests marked @pytest.mark.informational (skipped by default).",
    )


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "informational: tests that are skipped by default because they are "
        "diagnostics rather than authoritative gates. Enable with --run-informational.",
    )


def pytest_collection_modifyitems(config, items):
    if not config.getoption("--run-informational", default=False):
        skip_marker = pytest.mark.skip(
            reason="informational gate (not authoritative); use --run-informational to enable"
        )
        for item in items:
            if "informational" in item.keywords:
                item.add_marker(skip_marker)


REGRESSION_STACKS = ["ml04", "ml08", "ml09", "ml11", "ml14"]
HELD_OUT_STACKS = [
    "AH02", "AH03", "AH05", "AH06", "AH07",
    "HM05", "HM06", "HM07", "HM08", "HM11",
    "QH06", "QH07", "QH12",
]
MATERIALS = ["graphite", "graphene", "bottom_hbn", "top_hbn"]

IOU_THRESHOLD = 0.95  # regression gate per (stack, material)


def _read_mask(path: Path) -> np.ndarray:
    import cv2
    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise FileNotFoundError(path)
    return (m > 127).astype(np.uint8)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        raise ValueError(f"shape mismatch: {a.shape} vs {b.shape}")
    inter = np.logical_and(a, b).sum()
    union = np.logical_or(a, b).sum()
    return float(inter) / float(union) if union else 1.0


@pytest.fixture(scope="session")
def fixture_root() -> Path:
    if not FIXTURE_ROOT.exists():
        pytest.skip(f"fixture volume not mounted: {FIXTURE_ROOT}")
    return FIXTURE_ROOT


@pytest.fixture(scope="session")
def snapshot_root() -> Path:
    if not SNAPSHOT_ROOT.exists():
        pytest.fail(f"snapshot baseline missing — run snapshot_baseline.py first ({SNAPSHOT_ROOT})")
    return SNAPSHOT_ROOT


@pytest.fixture(params=REGRESSION_STACKS)
def stack(request) -> str:
    return request.param


@pytest.fixture(params=MATERIALS)
def material(request) -> str:
    return request.param
