"""Shared fixtures for detector regression tests."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Iterator

import numpy as np
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = Path("/Volumes/RandomData/harbour-workspace/qlaybot/detect")
SNAPSHOT_ROOT = REPO_ROOT / "tests_resources" / "detector_snapshots"

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
