#!/usr/bin/env python
"""Regression tests for exception handling in tools/evaluate_worker.py.

These tests verify that:
- 8 check primitives do NOT silently swallow unexpected errors as 0.0
- _to_shapely only catches (ValueError, shapely.errors.GEOSException), not all Exception
"""

import sys
import os

import pytest

pytest.importorskip("gdstk")
pytest.importorskip("numpy")
pytest.importorskip("shapely")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
from evaluate_worker import (
    _to_shapely,
    _prim_component_overlap,
    _prim_component_containment,
    _prim_contact_isolation,
    _prim_connectivity,
    _prim_route_endpoints,
    _prim_adjacency,
    _prim_solidity,
    _prim_spacing,
)


@pytest.mark.parametrize(
    "prim_fn",
    [
        _prim_component_overlap,
        _prim_component_containment,
        _prim_contact_isolation,
        _prim_connectivity,
        _prim_route_endpoints,
        _prim_adjacency,
        _prim_solidity,
        _prim_spacing,
    ],
    ids=[
        "component_overlap",
        "component_containment",
        "contact_isolation",
        "connectivity",
        "route_endpoints",
        "adjacency",
        "solidity",
        "spacing",
    ],
)
def test_primitives_do_not_swallow_invalid_args_type(prim_fn):
    """Passing args=42 (not a dict) must raise TypeError/AttributeError,
    not silently return 0.0."""
    with pytest.raises((TypeError, AttributeError)):
        prim_fn(None, None, {}, 42)


def test_to_shapely_propagates_type_error():
    """TypeError from non-iterable points must not be masked."""
    with pytest.raises(TypeError):
        _to_shapely(42)


def test_to_shapely_still_catches_value_error():
    """ValueError inputs should still be handled and return None."""
    result = _to_shapely("bad")
    assert result is None


def test_to_shapely_still_catches_geos_exception():
    """GEOSException from degenerate geometry should still return None."""
    import shapely.errors
    # A polygon with only 2 distinct points is degenerate and may raise GEOSException
    # or produce an empty/invalid polygon. Verify it returns None (not raises).
    result = _to_shapely([(0, 0), (1, 1)])
    assert result is None
