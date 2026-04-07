# Generalized E2E Device Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Hall-bar-specific `nanodevice_e2e_design` + `nanodevice_hallbar` skills with a single device-agnostic design methodology skill, and generalize `evaluate_worker.py` to accept configurable check lists.

**Architecture:** The skill becomes a 7-step methodology guide (QUERY, PREPARE, ANALYZE, DESIGN, ROUTE, EVALUATE, SAVE) where the agent derives device-specific rules from context. The evaluator accepts a `checks` list in its config JSON instead of hardcoding 8 Hall bar checks. The MCP tool schema and server handler are updated to pass `checks` through.

**Tech Stack:** Python (evaluate_worker.py, gdstk, shapely, numpy), XML/Python (klayoutclaw_server.lym), Markdown (SKILL.md)

**Spec:** `docs/superpowers/specs/2026-04-06-generalized-e2e-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `tools/evaluate_worker.py` | Rewrite | Configurable check primitives, no hardcoded Hall bar checks |
| `plugin/klayoutclaw_server.lym` | Modify | Update `evaluate_design` tool schema + handler to accept `checks` param |
| `skills/nanodevice_e2e_design/SKILL.md` | Rewrite | Device-agnostic 7-step methodology |
| `skills/nanodevice_hallbar/SKILL.md` | Delete | Absorbed into generalized methodology |
| `tests/test_phase1_worker.py` | Rewrite | Tests for configurable check primitives |
| `docs/tools.md` | Modify | Update `evaluate_design` docs |
| `docs/skills.md` | Modify | Remove hallbar section, update e2e_design section |
| `CLAUDE.md` | Modify | Remove hallbar references from directory structure |

---

### Task 1: Rewrite evaluate_worker.py — Check Primitives

**Files:**
- Rewrite: `tools/evaluate_worker.py`

This is the core change. Replace the 8 hardcoded Hall bar checks with configurable geometric primitives.

- [ ] **Step 1: Write the new evaluate_worker.py**

Replace the entire file. The new worker:
- Requires `checks` list in config JSON (no fallback)
- Removes `REQUIRED_COMPONENTS` constant
- Removes `ALL_CHECKS` registry
- Removes all `_check_*` functions
- Adds primitive functions: `_prim_component_overlap`, `_prim_component_containment`, `_prim_contact_isolation`, `_prim_connectivity`, `_prim_route_endpoints`, `_prim_adjacency`, `_prim_solidity`, `_prim_spacing`
- Adds `_resolve_region(lib, layer_map, region_spec, region_op)` helper that resolves region args (single key, list of keys + set operation)
- Removes `mode` parameter — the caller controls what checks to run via the `checks` list
- Removes requirement for `reference_gds` — only needed if a check references layers not in the output GDS

```python
#!/usr/bin/env python
"""evaluate_worker.py -- Configurable device design evaluator.

CLI: python evaluate_worker.py config.json

Config JSON input:
{
    "gds_path": "result.gds",
    "reference_gds": "reference.gds",  (optional, for checks that need ref layers)
    "layer_map": {"mesa": [20, 0], "contact_patch": [21, 0], ...},
    "checks": [
        {"name": "component_containment", "args": {...}, "weight": 0.2},
        ...
    ],
    "output_path": "output.json"
}

Output JSON: {status, overall, checks: [{name, score, weight, detail}]}
"""

import sys
import os
import json

try:
    import gdstk
except ImportError as e:
    print("ERROR: Missing dependency gdstk: {}".format(e), file=sys.stderr)
    sys.exit(1)

try:
    import shapely
    import shapely.geometry as sg
    from shapely.ops import unary_union
    from shapely.validation import make_valid
except ImportError as e:
    print("ERROR: Missing dependency shapely: {}".format(e), file=sys.stderr)
    sys.exit(1)

try:
    import numpy as np
except ImportError as e:
    print("ERROR: Missing dependency numpy: {}".format(e), file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Geometry helpers (unchanged from original)
# ---------------------------------------------------------------------------

def _to_shapely(points):
    try:
        s = sg.Polygon(points)
        if not s.is_valid:
            s = make_valid(s)
        return s if not s.is_empty else None
    except Exception:
        return None


def _extract_shapely(lib, layer, datatype):
    shapes = []
    for cell in lib.cells:
        for poly in cell.get_polygons():
            if poly.layer == layer and poly.datatype == datatype:
                s = _to_shapely(poly.points)
                if s is not None:
                    shapes.append(s)
    if shapes:
        return shapes
    for cell in lib.cells:
        for path in cell.get_paths():
            path_polys = path.to_polygons()
            for i, (l, dt) in enumerate(zip(path.layers, path.datatypes)):
                if l == layer and dt == datatype and i < len(path_polys):
                    s = _to_shapely(path_polys[i])
                    if s is not None:
                        shapes.append(s)
    return shapes


def _component_union(lib, layer_map, name):
    spec = layer_map.get(name)
    if spec is None:
        return sg.Polygon()
    if isinstance(spec[0], (list, tuple)):
        pairs = spec
    else:
        pairs = [spec]
    all_shapes = []
    for layer, dt in pairs:
        all_shapes.extend(_extract_shapely(lib, layer, dt))
    return unary_union(all_shapes) if all_shapes else sg.Polygon()


def _component_list(lib, layer_map, name):
    spec = layer_map.get(name)
    if spec is None:
        return []
    if isinstance(spec[0], (list, tuple)):
        pairs = spec
    else:
        pairs = [spec]
    all_shapes = []
    for layer, dt in pairs:
        all_shapes.extend(_extract_shapely(lib, layer, dt))
    return all_shapes


def _get_spine_endpoints(lib, layer_map, component="contact_route"):
    spec = layer_map.get(component)
    if spec is None:
        return []
    if isinstance(spec[0], (list, tuple)):
        pairs = spec
    else:
        pairs = [spec]
    endpoints = []
    for layer, dt in pairs:
        layer_eps = []
        for cell in lib.cells:
            for path in cell.get_paths():
                if path.layers[0] == layer and path.datatypes[0] == dt:
                    try:
                        spine = np.array(path.spine())
                    except (AttributeError, TypeError):
                        try:
                            spine = np.array(path.points)
                        except (AttributeError, TypeError):
                            continue
                    if len(spine) >= 2:
                        layer_eps.append((spine[0].copy(), spine[-1].copy()))
        if layer_eps:
            endpoints.extend(layer_eps)
            continue
        for cell in lib.cells:
            for poly in cell.get_polygons():
                if poly.layer == layer and poly.datatype == dt:
                    pts = poly.points
                    if len(pts) < 3:
                        continue
                    dists = np.sqrt(((pts[:, None] - pts[None, :]) ** 2).sum(axis=2))
                    i, j = np.unravel_index(np.argmax(dists), dists.shape)
                    endpoints.append((pts[i].copy(), pts[j].copy()))
    return endpoints


# ---------------------------------------------------------------------------
# Region resolution
# ---------------------------------------------------------------------------

def _resolve_region(out_lib, ref_lib, layer_map, region_spec, region_op="union"):
    """Resolve a region specification to a shapely geometry.

    region_spec: a layer_map key (str) or list of keys.
    region_op: "union", "intersection", or "difference" (applied left-to-right).
    Uses ref_lib if available, falls back to out_lib.
    """
    if isinstance(region_spec, str):
        region_spec = [region_spec]

    lib = ref_lib if ref_lib is not None else out_lib
    regions = []
    for key in region_spec:
        r = _component_union(lib, layer_map, key)
        if r.is_empty:
            r = _component_union(out_lib, layer_map, key)
        regions.append(r)

    if not regions:
        return sg.Polygon()

    result = regions[0]
    for r in regions[1:]:
        if region_op == "intersection":
            result = result.intersection(r)
        elif region_op == "difference":
            result = result.difference(r)
        else:
            result = result.union(r)
    return result


# ---------------------------------------------------------------------------
# Check primitives
# ---------------------------------------------------------------------------

def _prim_component_overlap(out_lib, ref_lib, layer_map, args):
    """Fraction of component area overlapping with region."""
    try:
        comp = _component_union(out_lib, layer_map, args["component"])
        if comp.is_empty:
            return 0.0
        region = _resolve_region(out_lib, ref_lib, layer_map,
                                 args["region"], args.get("region_op", "union"))
        if region.is_empty:
            return 0.0
        return comp.intersection(region).area / comp.area
    except Exception:
        return 0.0


def _prim_component_containment(out_lib, ref_lib, layer_map, args):
    """Fraction of component area contained within region."""
    try:
        comp = _component_union(out_lib, layer_map, args["component"])
        if comp.is_empty:
            return 0.0
        region = _resolve_region(out_lib, ref_lib, layer_map,
                                 args["region"], args.get("region_op", "union"))
        if region.is_empty:
            return 0.0
        return comp.intersection(region).area / comp.area
    except Exception:
        return 0.0


def _prim_contact_isolation(out_lib, ref_lib, layer_map, args):
    """Fraction of route pairs that don't cross."""
    try:
        route_comp = args.get("component", "contact_route")
        routes = _component_list(out_lib, layer_map, route_comp)
        if len(routes) < 2:
            return 1.0 if routes else 0.0
        n = len(routes)
        total_pairs = n * (n - 1) // 2
        crossing = 0
        for i in range(n):
            for j in range(i + 1, n):
                if routes[i].intersection(routes[j]).area > 1.0:
                    crossing += 1
        return (total_pairs - crossing) / total_pairs
    except Exception:
        return 0.0


def _prim_connectivity(out_lib, ref_lib, layer_map, args):
    """Fraction of contacts that reach a bonding pad via routes."""
    try:
        contact_comp = args.get("contact_component", "contact_patch")
        pad_comp = args.get("pad_component", "bonding_pad")
        route_comp = args.get("route_component", "contact_route")
        tolerance = args.get("tolerance", 15.0)

        patches = _component_list(out_lib, layer_map, contact_comp)
        pads = _component_union(out_lib, layer_map, pad_comp)
        if not patches or pads.is_empty:
            return 0.0
        pads_buf = pads.buffer(tolerance)
        route_eps = _get_spine_endpoints(out_lib, layer_map, route_comp)
        if not route_eps:
            return 0.0
        connected = 0
        for patch in patches:
            center = np.array(patch.centroid.coords[0])
            if _can_reach_pad(center, route_eps, pads_buf, tolerance):
                connected += 1
        return connected / len(patches)
    except Exception:
        return 0.0


def _can_reach_pad(start, route_eps, pads_buf, tolerance):
    frontier = [np.asarray(start)]
    visited_routes = set()
    for _ in range(20):
        next_frontier = []
        for pt in frontier:
            if pads_buf.contains(sg.Point(pt)):
                return True
            for idx, (ep_a, ep_b) in enumerate(route_eps):
                if idx in visited_routes:
                    continue
                if np.linalg.norm(pt - ep_a) <= tolerance:
                    visited_routes.add(idx)
                    next_frontier.append(ep_b)
                elif np.linalg.norm(pt - ep_b) <= tolerance:
                    visited_routes.add(idx)
                    next_frontier.append(ep_a)
        if not next_frontier:
            break
        frontier = next_frontier
    return False


def _prim_route_endpoints(out_lib, ref_lib, layer_map, args):
    """Fraction of route endpoints that land on valid targets."""
    try:
        route_comp = args.get("route_component", "contact_route")
        target_components = args.get("target_components", ["contact_patch", "mesa", "bonding_pad"])
        tolerance = args.get("tolerance", 15.0)

        route_eps = _get_spine_endpoints(out_lib, layer_map, route_comp)
        if not route_eps:
            return 0.0
        target = sg.Polygon()
        for comp_name in target_components:
            g = _component_union(out_lib, layer_map, comp_name)
            if not g.is_empty:
                target = target.union(g) if not target.is_empty else g
        if target.is_empty:
            return 0.0
        target_buf = target.buffer(tolerance)
        all_eps = []
        for ep_a, ep_b in route_eps:
            all_eps.extend([ep_a, ep_b])
        all_eps_arr = np.array(all_eps) if all_eps else np.empty((0, 2))
        correct = 0
        total = 0
        for route_idx, (ep_a, ep_b) in enumerate(route_eps):
            for ep_offset, ep in enumerate([ep_a, ep_b]):
                total += 1
                pt = sg.Point(ep)
                if target_buf.contains(pt):
                    correct += 1
                elif len(all_eps_arr) > 0:
                    dists = np.linalg.norm(all_eps_arr - ep, axis=1)
                    self_idx = 2 * route_idx + ep_offset
                    dists[self_idx] = np.inf
                    if np.any(dists <= tolerance):
                        correct += 1
        return correct / total if total > 0 else 0.0
    except Exception:
        return 0.0


def _prim_adjacency(out_lib, ref_lib, layer_map, args):
    """Fraction of component_a shapes within tolerance of component_b."""
    try:
        shapes_a = _component_list(out_lib, layer_map, args["component_a"])
        if not shapes_a:
            return 0.0
        comp_b = _component_union(out_lib, layer_map, args["component_b"])
        if comp_b.is_empty:
            return 0.0
        tolerance = args.get("tolerance", 2.0)
        comp_b_buf = comp_b.buffer(tolerance)
        return sum(1 for s in shapes_a if comp_b_buf.intersects(s)) / len(shapes_a)
    except Exception:
        return 0.0


def _prim_solidity(out_lib, ref_lib, layer_map, args):
    """Score based on shape solidity relative to threshold."""
    try:
        comp = _component_union(out_lib, layer_map, args["component"])
        if comp.is_empty:
            return 0.0
        hull = comp.convex_hull
        if hull.is_empty or hull.area == 0:
            return 0.0
        solidity = comp.area / hull.area
        threshold = args.get("threshold", 0.5)
        direction = args.get("direction", "below")
        if direction == "below":
            return max(0.0, min(1.0, 1.0 - solidity)) if solidity < threshold else 0.0
        else:
            return max(0.0, min(1.0, solidity)) if solidity >= threshold else 0.0
    except Exception:
        return 0.0


def _prim_spacing(out_lib, ref_lib, layer_map, args):
    """Fraction of component pairs meeting minimum distance."""
    try:
        shapes_a = _component_list(out_lib, layer_map, args["component_a"])
        comp_b_name = args.get("component_b", args["component_a"])
        if comp_b_name == args["component_a"]:
            shapes_b = shapes_a
        else:
            shapes_b = _component_list(out_lib, layer_map, comp_b_name)
        if not shapes_a or not shapes_b:
            return 0.0
        min_distance = args.get("min_distance", 1.0)
        same = (comp_b_name == args["component_a"])
        total = 0
        ok = 0
        for i, sa in enumerate(shapes_a):
            start_j = i + 1 if same else 0
            for j in range(start_j, len(shapes_b)):
                if same and i == j:
                    continue
                total += 1
                if sa.distance(shapes_b[j]) >= min_distance:
                    ok += 1
        return ok / total if total > 0 else 1.0
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Primitive registry
# ---------------------------------------------------------------------------

PRIMITIVES = {
    "component_overlap": _prim_component_overlap,
    "component_containment": _prim_component_containment,
    "contact_isolation": _prim_contact_isolation,
    "connectivity": _prim_connectivity,
    "route_endpoints": _prim_route_endpoints,
    "adjacency": _prim_adjacency,
    "solidity": _prim_solidity,
    "spacing": _prim_spacing,
}


# ---------------------------------------------------------------------------
# Error output helper
# ---------------------------------------------------------------------------

def _write_error(output_path, message):
    result = {"status": "error", "error": message}
    with open(output_path, "w") as f:
        json.dump(result, f)
    sys.exit(0)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print("Usage: python evaluate_worker.py config.json", file=sys.stderr)
        sys.exit(1)

    config_path = sys.argv[1]
    with open(config_path, "r") as f:
        config = json.load(f)

    gds_path = config.get("gds_path", "")
    reference_gds = config.get("reference_gds", None)
    layer_map = config.get("layer_map", {})
    checks = config.get("checks", None)
    output_path = config.get("output_path", "output.json")

    if checks is None:
        _write_error(output_path, "Config must include 'checks' list.")

    if not isinstance(checks, list) or len(checks) == 0:
        _write_error(output_path, "'checks' must be a non-empty list.")

    if not os.path.isfile(gds_path):
        _write_error(output_path, "GDS file not found: {}".format(gds_path))

    if reference_gds and not os.path.isfile(reference_gds):
        _write_error(output_path, "Reference GDS file not found: {}".format(reference_gds))

    # Validate check names
    for i, check in enumerate(checks):
        name = check.get("name", "")
        if name not in PRIMITIVES:
            _write_error(output_path,
                "Check {}: unknown primitive '{}'. Available: {}".format(
                    i, name, ", ".join(sorted(PRIMITIVES.keys()))))

    # Load GDS files
    out_lib = gdstk.read_gds(gds_path)
    ref_lib = gdstk.read_gds(reference_gds) if reference_gds else None

    # Run checks
    results = []
    for check in checks:
        name = check["name"]
        args = check.get("args", {})
        weight = check.get("weight", 1.0 / len(checks))
        score = PRIMITIVES[name](out_lib, ref_lib, layer_map, args)
        score = max(0.0, min(1.0, float(score)))
        results.append({
            "name": name,
            "score": score,
            "weight": weight,
            "detail": "{}: {:.4f}".format(name, score),
        })

    # Compute overall score (weighted sum)
    total_weight = sum(c["weight"] for c in results)
    if total_weight > 0:
        overall = round(sum(c["score"] * c["weight"] for c in results) / total_weight, 6)
    else:
        overall = 0.0

    output = {
        "status": "ok",
        "overall": overall,
        "checks": results,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify the new worker parses without errors**

Run: `~/anaconda3/bin/python3 -c "import py_compile; py_compile.compile('tools/evaluate_worker.py', doraise=True)"`
Expected: no output (clean compile)

- [ ] **Step 3: Commit**

```bash
git add tools/evaluate_worker.py
git commit -m "refactor: rewrite evaluate_worker.py with configurable check primitives

Replace 8 hardcoded Hall bar checks with 8 configurable geometric
primitives. Callers must provide a 'checks' list in config JSON.
No backward compatibility fallback."
```

---

### Task 2: Rewrite tests for evaluate_worker.py

**Files:**
- Rewrite: `tests/test_phase1_worker.py`

The old tests assert 8 specific Hall bar checks, fixed weights, and score/drc modes. The new tests validate the configurable primitive system.

- [ ] **Step 1: Write the new test file**

Replace the entire file. New test structure:

```python
#!/usr/bin/env python
"""Tests for tools/evaluate_worker.py — configurable device design evaluator.

Tests exercise the worker script by running it as a subprocess and
validating: config parsing, primitive execution, error handling, and
score computation.

Requirements:
- gdstk, shapely, numpy must be available (via anaconda3 python)
"""

import json
import os
import subprocess
import tempfile

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER_PATH = os.path.join(PROJECT_ROOT, "tools", "evaluate_worker.py")
ANACONDA_PYTHON = os.path.expanduser("~/anaconda3/bin/python3")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_worker(config_dict, python_path=None):
    """Run evaluate_worker.py with the given config dict."""
    tmp_dir = tempfile.mkdtemp(prefix="test_eval_worker_")
    config_path = os.path.join(tmp_dir, "config.json")
    output_path = os.path.join(tmp_dir, "output.json")

    config_dict["output_path"] = output_path
    with open(config_path, "w") as f:
        json.dump(config_dict, f)

    py = python_path or ANACONDA_PYTHON
    try:
        proc = subprocess.run(
            [py, WORKER_PATH, config_path],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return (-1, None, "timeout")

    output_dict = None
    if os.path.isfile(output_path):
        with open(output_path, "r") as f:
            output_dict = json.load(f)

    for p in [config_path, output_path]:
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp_dir)
    except OSError:
        pass

    return (proc.returncode, output_dict, proc.stderr)


def _make_test_gds():
    """Create a synthetic GDS with geometry for testing primitives."""
    tmp = tempfile.mktemp(suffix=".gds", prefix="test_eval_")
    script = f'''
import gdstk

lib = gdstk.Library()
cell = lib.new_cell("TOP")

# Region A (layer 10/0): large square
cell.add(gdstk.rectangle((-50, -50), (50, 50), layer=10, datatype=0))

# Region B (layer 11/0): overlapping square
cell.add(gdstk.rectangle((0, 0), (100, 100), layer=11, datatype=0))

# Component C (layer 20/0): H-shaped mesa within region A
channel = gdstk.rectangle((-30, -5), (30, 5), layer=20, datatype=0)
probe_l = gdstk.rectangle((-15, -20), (-10, 20), layer=20, datatype=0)
probe_r = gdstk.rectangle((10, -20), (15, 20), layer=20, datatype=0)
cell.add(channel, probe_l, probe_r)

# Contact patches (layer 21/0): at probe tips
cp1 = gdstk.rectangle((-17, 18), (-8, 25), layer=21, datatype=0)
cp2 = gdstk.rectangle((-17, -25), (-8, -18), layer=21, datatype=0)
cp3 = gdstk.rectangle((8, 18), (17, 25), layer=21, datatype=0)
cp4 = gdstk.rectangle((8, -25), (17, -18), layer=21, datatype=0)
cell.add(cp1, cp2, cp3, cp4)

# Routes (layer 30/0): connecting patches to pads
r1 = gdstk.FlexPath([(-12, 25), (-12, 80)], 2, layer=30, datatype=0)
r2 = gdstk.FlexPath([(-12, -25), (-12, -80)], 2, layer=30, datatype=0)
r3 = gdstk.FlexPath([(12, 25), (12, 80)], 2, layer=30, datatype=0)
r4 = gdstk.FlexPath([(12, -25), (12, -80)], 2, layer=30, datatype=0)
cell.add(r1, r2, r3, r4)

# Bonding pads (layer 40/0)
bp1 = gdstk.rectangle((-22, 80), (-2, 100), layer=40, datatype=0)
bp2 = gdstk.rectangle((-22, -100), (-2, -80), layer=40, datatype=0)
bp3 = gdstk.rectangle((2, 80), (22, 100), layer=40, datatype=0)
bp4 = gdstk.rectangle((2, -100), (22, -80), layer=40, datatype=0)
cell.add(bp1, bp2, bp3, bp4)

lib.write_gds("{tmp}")
print("OK")
'''
    proc = subprocess.run(
        [ANACONDA_PYTHON, "-c", script],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode == 0 and os.path.isfile(tmp):
        return tmp
    return None


LAYER_MAP = {
    "region_a": [10, 0],
    "region_b": [11, 0],
    "mesa": [20, 0],
    "contact_patch": [21, 0],
    "contact_route": [30, 0],
    "bonding_pad": [40, 0],
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def anaconda_has_deps():
    if not os.path.isfile(ANACONDA_PYTHON):
        pytest.skip(f"Anaconda python not found at {ANACONDA_PYTHON}")
    proc = subprocess.run(
        [ANACONDA_PYTHON, "-c", "import gdstk; import shapely; import numpy; print('OK')"],
        capture_output=True, text=True, timeout=15,
    )
    if proc.returncode != 0:
        pytest.skip(f"Missing dependencies: {proc.stderr.strip()}")
    return True


@pytest.fixture(scope="session")
def test_gds(anaconda_has_deps):
    path = _make_test_gds()
    if path is None:
        pytest.skip("Could not create test GDS")
    yield path
    try:
        os.remove(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Test: Worker Script Basics
# ---------------------------------------------------------------------------

class TestWorkerExists:
    def test_worker_script_exists(self):
        assert os.path.isfile(WORKER_PATH)

    def test_worker_compiles(self):
        proc = subprocess.run(
            [ANACONDA_PYTHON, "-c",
             f"import py_compile; py_compile.compile('{WORKER_PATH}', doraise=True)"],
            capture_output=True, text=True, timeout=15,
        )
        assert proc.returncode == 0, f"Syntax errors: {proc.stderr}"


# ---------------------------------------------------------------------------
# Test: Config Validation
# ---------------------------------------------------------------------------

class TestConfigValidation:
    def test_missing_checks_errors(self, test_gds, anaconda_has_deps):
        """Config without 'checks' must produce error status."""
        config = {"gds_path": test_gds, "layer_map": LAYER_MAP}
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"
        assert "checks" in result.get("error", "").lower()

    def test_empty_checks_errors(self, test_gds, anaconda_has_deps):
        """Empty checks list must produce error status."""
        config = {"gds_path": test_gds, "layer_map": LAYER_MAP, "checks": []}
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"

    def test_unknown_primitive_errors(self, test_gds, anaconda_has_deps):
        """Unknown check name must produce error status."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "nonexistent_check", "weight": 1.0}],
        }
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"
        assert "nonexistent_check" in result.get("error", "")

    def test_nonexistent_gds_errors(self, anaconda_has_deps):
        """Non-existent GDS must produce error status."""
        config = {
            "gds_path": "/tmp/nonexistent_12345.gds",
            "layer_map": LAYER_MAP,
            "checks": [{"name": "solidity", "args": {"component": "mesa"}, "weight": 1.0}],
        }
        rc, result, _ = _run_worker(config)
        assert result is not None and result.get("status") == "error"

    def test_no_config_arg_exits_nonzero(self, anaconda_has_deps):
        """Worker must exit non-zero without config argument."""
        proc = subprocess.run(
            [ANACONDA_PYTHON, WORKER_PATH],
            capture_output=True, text=True, timeout=15,
        )
        assert proc.returncode != 0


# ---------------------------------------------------------------------------
# Test: Primitives
# ---------------------------------------------------------------------------

class TestPrimitives:
    def test_component_overlap(self, test_gds, anaconda_has_deps):
        """Mesa overlaps region_a — score should be > 0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "component_overlap",
                         "args": {"component": "mesa", "region": "region_a"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["status"] == "ok"
        assert result["checks"][0]["score"] > 0.0

    def test_component_containment(self, test_gds, anaconda_has_deps):
        """Mesa is mostly within region_a — containment score should be > 0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "component_containment",
                         "args": {"component": "mesa", "region": "region_a"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_region_op_intersection(self, test_gds, anaconda_has_deps):
        """Containment with intersection of two regions."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "component_containment",
                         "args": {"component": "mesa",
                                  "region": ["region_a", "region_b"],
                                  "region_op": "intersection"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        # intersection of A and B is smaller, so containment should be lower
        assert 0.0 <= result["checks"][0]["score"] <= 1.0

    def test_contact_isolation(self, test_gds, anaconda_has_deps):
        """Routes should not cross — isolation score should be 1.0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "contact_isolation",
                         "args": {"component": "contact_route"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] == 1.0

    def test_connectivity(self, test_gds, anaconda_has_deps):
        """All contacts should reach pads — connectivity > 0."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "connectivity",
                         "args": {"contact_component": "contact_patch",
                                  "pad_component": "bonding_pad",
                                  "route_component": "contact_route"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_adjacency(self, test_gds, anaconda_has_deps):
        """Contact patches should be near mesa."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "adjacency",
                         "args": {"component_a": "contact_patch",
                                  "component_b": "mesa",
                                  "tolerance": 5.0},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_solidity_below(self, test_gds, anaconda_has_deps):
        """H-shaped mesa should have solidity < 0.5."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "solidity",
                         "args": {"component": "mesa", "threshold": 0.5, "direction": "below"},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0

    def test_spacing(self, test_gds, anaconda_has_deps):
        """Contact patches should be spaced apart."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "spacing",
                         "args": {"component_a": "contact_patch",
                                  "component_b": "contact_patch",
                                  "min_distance": 1.0},
                         "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert result["checks"][0]["score"] > 0.0


# ---------------------------------------------------------------------------
# Test: Score Computation
# ---------------------------------------------------------------------------

class TestScoreComputation:
    def test_overall_is_normalized_weighted_sum(self, test_gds, anaconda_has_deps):
        """Overall must equal sum(score*weight) / sum(weight)."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [
                {"name": "solidity", "args": {"component": "mesa", "threshold": 0.5, "direction": "below"}, "weight": 0.3},
                {"name": "contact_isolation", "args": {"component": "contact_route"}, "weight": 0.7},
            ],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        checks = result["checks"]
        expected = sum(c["score"] * c["weight"] for c in checks) / sum(c["weight"] for c in checks)
        assert abs(result["overall"] - round(expected, 6)) < 1e-4

    def test_scores_in_valid_range(self, test_gds, anaconda_has_deps):
        """All scores must be in [0.0, 1.0]."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [
                {"name": "component_overlap", "args": {"component": "mesa", "region": "region_a"}, "weight": 0.5},
                {"name": "adjacency", "args": {"component_a": "contact_patch", "component_b": "mesa", "tolerance": 5.0}, "weight": 0.5},
            ],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        for check in result["checks"]:
            assert 0.0 <= check["score"] <= 1.0

    def test_output_structure(self, test_gds, anaconda_has_deps):
        """Output must have status, overall, checks fields."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [{"name": "solidity", "args": {"component": "mesa"}, "weight": 1.0}],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        assert "status" in result
        assert "overall" in result
        assert "checks" in result
        assert isinstance(result["checks"], list)
        for check in result["checks"]:
            assert all(k in check for k in ["name", "score", "weight", "detail"])

    def test_default_weight_when_omitted(self, test_gds, anaconda_has_deps):
        """When weight is omitted, should default to 1/N."""
        config = {
            "gds_path": test_gds,
            "layer_map": LAYER_MAP,
            "checks": [
                {"name": "solidity", "args": {"component": "mesa"}},
                {"name": "contact_isolation", "args": {"component": "contact_route"}},
            ],
        }
        rc, result, stderr = _run_worker(config)
        assert rc == 0 and result is not None, f"Failed: {stderr[:300]}"
        for check in result["checks"]:
            assert abs(check["weight"] - 0.5) < 1e-6
```

- [ ] **Step 2: Run the new tests**

Run: `~/anaconda3/bin/python3 -m pytest tests/test_phase1_worker.py -v`
Expected: All tests PASS (they run against the new evaluate_worker.py from Task 1)

- [ ] **Step 3: Commit**

```bash
git add tests/test_phase1_worker.py
git commit -m "test: rewrite evaluate_worker tests for configurable check primitives"
```

---

### Task 3: Update MCP tool schema and handler

**Files:**
- Modify: `plugin/klayoutclaw_server.lym` (lines 247-261 for schema, lines 648-770 for handler)

Update the `evaluate_design` tool to accept the new `checks` parameter and remove the `mode` parameter.

- [ ] **Step 1: Update the tool schema in TOOLS list**

Find the `evaluate_design` entry in the TOOLS list (around line 247) and replace it:

```python
{
    "name": "evaluate_design",
    "description": "Evaluate a device design against configurable geometric quality checks. Accepts a list of check primitives (component_overlap, component_containment, contact_isolation, connectivity, route_endpoints, adjacency, solidity, spacing) with per-check weights. Returns per-check scores and weighted overall score.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "checks": {"type": "array", "description": "List of check objects: [{name, args, weight}]. Available primitives: component_overlap, component_containment, contact_isolation, connectivity, route_endpoints, adjacency, solidity, spacing."},
            "layer_map": {"type": "object", "description": "Map of component names to [layer, datatype] arrays. Keys are referenced by check args."},
            "reference_gds": {"type": "string", "description": "Path to reference GDS (optional, for checks that need reference layers)"},
            "python_path": {"type": "string", "description": "Path to python binary with gdstk/shapely/numpy (overrides conda_env)"},
            "conda_env": {"type": "string", "default": "base", "description": "Conda environment with gdstk/shapely/numpy"}
        },
        "required": ["checks", "layer_map"]
    }
}
```

- [ ] **Step 2: Update the handler function**

In `_tool_evaluate_design` (around line 648), make these changes:

1. Remove the `mode` parameter parsing and validation
2. Replace `required_keys` validation with reading the `checks` list from args
3. Pass `checks` into the config JSON sent to the worker
4. Remove the `if mode == "score" and not reference_gds` validation

The key change to the config dict construction:

```python
layer_map = args.get("layer_map", {})
checks = args.get("checks", None)
reference_gds = args.get("reference_gds", None)

if checks is None or not isinstance(checks, list) or len(checks) == 0:
    raise ValueError("'checks' must be a non-empty list of check objects.")

# ... (temp file setup unchanged) ...

config = {
    "gds_path": input_gds,
    "layer_map": layer_map,
    "checks": checks,
    "output_path": output_json,
}
if reference_gds:
    config["reference_gds"] = reference_gds
```

- [ ] **Step 3: Verify LYM file parses**

Run: `python3 -c "import xml.etree.ElementTree as ET; ET.parse('plugin/klayoutclaw_server.lym'); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add plugin/klayoutclaw_server.lym
git commit -m "feat: update evaluate_design MCP tool for configurable checks

Remove hardcoded mode parameter. Accept 'checks' list with
configurable geometric primitives and per-check weights."
```

---

### Task 4: Rewrite nanodevice_e2e_design SKILL.md

**Files:**
- Rewrite: `skills/nanodevice_e2e_design/SKILL.md`

Replace the Hall-bar-specific orchestrator with the generalized 7-step methodology from the spec.

- [ ] **Step 1: Write the new SKILL.md**

Replace the entire file with the generalized methodology. Content comes directly from the spec (`docs/superpowers/specs/2026-04-06-generalized-e2e-design.md`), sections "Generalized Pipeline" through "Conventions". The skill should include:

1. Frontmatter: update description to be device-agnostic
2. Pipeline overview table (7 steps with skip conditions)
3. Step 1 QUERY: checklist table + "skip if user provided everything"
4. Step 2 PREPARE: conditional flake detection
5. Step 3 ANALYZE: prerequisite about committed polygons + images, material region analysis
6. Step 4 DESIGN: agent-driven device geometry creation
7. Step 5 ROUTE: direct `auto_route` usage
8. Step 6 EVALUATE: configurable evaluator with check primitives table
9. Step 7 SAVE: GDS + result.json
10. Retry protocol
11. What the skill prescribes vs. doesn't prescribe
12. Conventions

```markdown
---
name: nanodevice_e2e_design
description: Orchestrate end-to-end nanodevice design from user query through optional flake detection, material analysis, device geometry creation, routing, evaluation, and save. Device-agnostic methodology -- the agent derives physics rules from device type and available materials.
---

# nanodevice_e2e_design -- End-to-End Device Design

A device-agnostic methodology for designing nanodevices on material regions in KLayout. The agent follows 7 reasoning steps, deriving device-specific physics rules from context and user input. No device type is hardcoded.

**This is a pure-text orchestrator skill.** No scripts directory. The agent uses MCP tools and sub-skills at each step.

---

## Pipeline Overview

| # | Step | What the agent does | Skip when |
|---|------|---------------------|-----------|
| 1 | QUERY | Check if required info is missing; ask only if needed | User provided everything in initial prompt |
| 2 | PREPARE | Run flake detection + GDS alignment if microscope images provided; otherwise verify existing layout | No images provided / layout already prepared |
| 3 | ANALYZE | Study material regions, compute overlaps/exclusions, identify design-relevant zones | Never |
| 4 | DESIGN | Create device geometry via `execute_script` | Never |
| 5 | ROUTE | Use `auto_route` tool to connect device contacts to bonding pads | Device has no external contacts |
| 6 | EVALUATE | Run configurable evaluator + visual inspection, iterate on failures | Never |
| 7 | SAVE | Export GDS + write result.json summary | Never |

Each step has a gate condition. Maximum 2 retries per step. If a step fails after retries, report to the user.

---

## Step 1: QUERY

Check the user's initial prompt against this checklist. Only ask about missing items -- skip this step entirely if all required info is provided.

| Parameter | Required? | Notes |
|-----------|-----------|-------|
| Device type | Yes | What to build (Hall bar, FET, QD, etc.) |
| Material regions | Yes | Which layers have which materials, or microscope images to detect them |
| Layer assignments | Yes | Which layers to use for each design component |
| pixel_size | If images provided | Microns per pixel, needed for detection/alignment |
| Device-specific constraints | If any | Gates, contacts, pin count, dimensions |
| Output path | No | Defaults to source directory |

**Gate:** All required parameters are known. Proceed.

---

## Step 2: PREPARE

Conditional step -- only runs if microscope images are provided.

**If microscope images are provided:**
1. Validate pixel_size via `validate_pixel_size` tool
2. Dispatch subagent to run `nanodevice_flakedetect` pipeline (align, detect, combine)
3. Dispatch subagent to run `nanodevice_gdsalign` if a GDS template is provided
4. Dispatch subagent to run `nanodevice_flakedetect_commit` to insert material polygons into KLayout

**If starting from an existing layout:**
- Verify expected material regions are present via `get_layout_info`

**Gate:** Material regions exist as polygons on their designated layers in KLayout.

---

## Step 3: ANALYZE

**Prerequisite:** Material contours must exist as polygons in KLayout, and any reference images must be loaded as background overlays. If they are not present, go back to PREPARE or ask the user.

The agent studies available geometry to inform design decisions:

1. Use `get_layout_info` to identify which layers have material regions
2. Use `execute_script` with `pya.Region` to compute overlaps, exclusions, bounding boxes
3. Use `screenshot` to visually inspect material regions and plan device placement
4. Identify which material zones are relevant for the specific device type

The agent derives material analysis logic from its physics knowledge of the device type. For example:
- A Hall bar needs graphene-graphite overlap for the channel
- A QD needs a gate-definable region
- A JJ needs a superconductor-insulator-superconductor stack

**Gate:** The agent has identified where the device should be placed and what material constraints apply.

---

## Step 4: DESIGN

Create device geometry using `execute_script`. What to create depends on the device type -- the agent applies its physics knowledge:

- Design the active region (mesa, channel, dot, junction, etc.)
- Place contacts appropriate to the device type
- Place gates if needed (topgate, sidegate, backgate, split-gate, etc.)
- Ensure all components respect material region boundaries from ANALYZE

The skill does NOT prescribe dimensions, shapes, or layer numbers. The agent derives these from:
- Device type and physics requirements
- Available material regions from ANALYZE
- Layer assignments agreed in QUERY
- User-specified constraints

Use `screenshot` after each major geometry addition to visually verify placement.

**Gate:** Device geometry is present on designated layers. Visual inspection via `screenshot` confirms correct placement.

---

## Step 5: ROUTE

If the device has contacts that need fan-out to bonding pads:

1. Place pin markers at contact positions via `execute_script` (on a temporary layer)
2. Place bonding pads if not already present (via `execute_script`)
3. Place pin markers at pad positions (on a temporary layer)
4. Call `auto_route` MCP tool with appropriate parameters:
   - `pin_layer_a`: contact pin layer
   - `pin_layer_b`: pad pin layer
   - `output_layer`: route layer
   - `obstacle_layers`: device geometry layers to avoid
   - Line width and safe distance as needed
5. For failed pairs, write custom routing via `execute_script`
6. Clean up temporary pin marker layers

The agent decides routing topology, line widths, and obstacle avoidance based on device layout. The `nanodevice_routing` skill is available as a reference for multi-window EBL routing patterns, but is not required.

**Gate:** All contacts connected to bonding pads. No route crossings.

---

## Step 6: EVALUATE

Run the `evaluate_design` MCP tool with a check configuration composed by the agent based on what it designed.

**Available check primitives:**

| Primitive | Args | Measures |
|-----------|------|----------|
| `component_overlap` | component, region, region_op | Fraction of component area overlapping with region |
| `component_containment` | component, region, region_op | Fraction of component area contained within region |
| `contact_isolation` | component | Fraction of route pairs that don't cross |
| `connectivity` | contact_component, pad_component, route_component, tolerance | Fraction of contacts reaching pads |
| `route_endpoints` | route_component, target_components, tolerance | Fraction of route endpoints on valid targets |
| `adjacency` | component_a, component_b, tolerance | Fraction of A shapes within tolerance of B |
| `solidity` | component, threshold, direction | Shape solidity above/below threshold |
| `spacing` | component_a, component_b, min_distance | Fraction of pairs meeting min distance |

The `region` arg can be a single layer_map key or a list of keys combined via `region_op` (union, intersection, difference).

**Example check list for a Hall bar:**
```json
{
  "checks": [
    {"name": "component_containment", "args": {"component": "mesa", "region": ["graphene", "graphite"], "region_op": "intersection"}, "weight": 0.2},
    {"name": "adjacency", "args": {"component_a": "contact_patch", "component_b": "mesa", "tolerance": 2.0}, "weight": 0.15},
    {"name": "solidity", "args": {"component": "mesa", "threshold": 0.5, "direction": "below"}, "weight": 0.15},
    {"name": "contact_isolation", "args": {"component": "contact_route"}, "weight": 0.15},
    {"name": "connectivity", "args": {"contact_component": "contact_patch", "pad_component": "bonding_pad", "route_component": "contact_route"}, "weight": 0.15},
    {"name": "route_endpoints", "args": {"route_component": "contact_route", "target_components": ["contact_patch", "mesa", "bonding_pad"]}, "weight": 0.1},
    {"name": "spacing", "args": {"component_a": "contact_patch", "min_distance": 1.0}, "weight": 0.1}
  ]
}
```

Also take a `screenshot` for visual inspection.

- If score >= 0.80, proceed to SAVE
- If score < 0.80, identify lowest-scoring check and iterate
- Maximum 2 retries

**Gate:** Evaluation score >= 0.80 and visual inspection passes.

---

## Step 7: SAVE

1. Call `save_layout` to export the GDS file
2. Write `result.json` containing:
   - `device_type`: from QUERY
   - `layer_map`: all layer assignments used
   - `score`: final evaluation score
   - `pixel_size`: if applicable
   - `pipeline_status`: per-step pass/fail/retry counts
   - `checks`: the evaluation check configuration used
   - `feedback`: design notes and any user interventions

**Gate:** GDS file written and result.json contains all required fields.

---

## Retry Protocol

Maximum 2 retries per step. When a gate fails:

| Failed Step | Retry Action |
|-------------|-------------|
| PREPARE | Re-run detection with adjusted parameters |
| ANALYZE | Re-inspect with different region computations |
| DESIGN | Redesign failing component based on gate feedback |
| ROUTE | Re-route with adjusted parameters or manual fallback |
| EVALUATE | Re-run failing design sub-step per lowest-scoring check |

If any step exhausts retries, stop and report to the user.

---

## What This Skill Prescribes

- Step ordering (QUERY -> PREPARE -> ANALYZE -> DESIGN -> ROUTE -> EVALUATE -> SAVE)
- Gate conditions before proceeding
- Retry protocol (max 2 per step)
- Which MCP tools to use: `execute_script`, `auto_route`, `evaluate_design`, `screenshot`, `get_layout_info`, `save_layout`, `validate_pixel_size`
- Query checklist for completeness

## What This Skill Does NOT Prescribe

- Specific device geometries or dimensions
- Specific layer numbers (agreed with user)
- Specific material assumptions (agent derives from device type)
- Specific evaluation weights (agent composes per device)
- Specific routing topology (agent decides)

---

## Conventions

- **Conda env:** `base` (has opencv, numpy, scipy, sklearn)
- **Pixel coordinates:** image origin at top-left; KLayout uses center origin with Y-flip
- **Layer references:** always as `layer/datatype` (e.g., `11/0`)
- **Output directory:** defaults to source image directory if not specified
- **Sub-skill dispatch:** flakedetect and gdsalign sub-skills run as subagents reading their own SKILL.md
```

- [ ] **Step 2: Commit**

```bash
git add skills/nanodevice_e2e_design/SKILL.md
git commit -m "feat: rewrite nanodevice_e2e_design as device-agnostic methodology

Replace Hall-bar-specific orchestrator with 7-step general design
methodology. Agent derives device physics from context, not hardcoded
rules. Steps are conditional (QUERY skipped if info provided,
PREPARE skipped if no images)."
```

---

### Task 5: Delete nanodevice_hallbar skill

**Files:**
- Delete: `skills/nanodevice_hallbar/SKILL.md`

- [ ] **Step 1: Delete the file**

```bash
rm skills/nanodevice_hallbar/SKILL.md
rmdir skills/nanodevice_hallbar
```

- [ ] **Step 2: Commit**

```bash
git add -A skills/nanodevice_hallbar/
git commit -m "chore: delete nanodevice_hallbar skill

Absorbed into the generalized nanodevice_e2e_design methodology.
The agent now derives Hall bar physics rules from its own knowledge."
```

---

### Task 6: Update docs and CLAUDE.md

**Files:**
- Modify: `docs/tools.md` (evaluate_design section, around line 201)
- Modify: `docs/skills.md` (hallbar section ~line 395, e2e_design section ~line 412)
- Modify: `CLAUDE.md` (directory structure, remove hallbar references)

- [ ] **Step 1: Update docs/tools.md evaluate_design section**

Replace the evaluate_design section to document the new configurable interface:
- Remove references to "8 weighted checks" and "score/drc modes"
- Document the `checks` parameter (required, list of primitives)
- Document `layer_map` (required, component names to layer/datatype)
- Document `reference_gds` (optional)
- List the 8 available primitives with brief descriptions

- [ ] **Step 2: Update docs/skills.md**

1. Remove the "Hall Bar Design (nanodevice_hallbar)" section entirely (~lines 395-408)
2. Rewrite the "End-to-End Design Pipeline (nanodevice_e2e_design)" section (~lines 412-429):
   - Remove Hall bar references
   - Describe the 7-step device-agnostic methodology
   - Note that detection/alignment steps are optional

- [ ] **Step 3: Update CLAUDE.md directory structure**

1. Remove `nanodevice_hallbar/` entry from the directory tree
2. Update the `nanodevice_e2e_design/` description to "E2E device design methodology (device-agnostic)"

- [ ] **Step 4: Commit**

```bash
git add docs/tools.md docs/skills.md CLAUDE.md
git commit -m "docs: update for generalized e2e design and evaluate_design

Remove nanodevice_hallbar references. Document configurable
evaluate_design check primitives. Update e2e_design description."
```

---

## Self-Review

**Spec coverage:**
- [x] Delete `nanodevice_hallbar` — Task 5
- [x] Rewrite `nanodevice_e2e_design` — Task 4
- [x] Generalize `evaluate_worker.py` — Task 1
- [x] No backward compatibility — Task 1 (requires `checks` list, no fallback)
- [x] 8 check primitives — Task 1
- [x] Region resolution with `region_op` — Task 1 (`_resolve_region`)
- [x] MCP tool schema update — Task 3
- [x] Tests — Task 2
- [x] Docs — Task 6
- [x] Query checklist — Task 4 Step 1
- [x] Optional QUERY step — Task 4 Step 1
- [x] Optional PREPARE step — Task 4 Step 1
- [x] ANALYZE prerequisite about committed polygons — Task 4 Step 1
- [x] Configurable evaluator in SKILL — Task 4 Step 1 (Step 6)

**Placeholder scan:** No TBDs, TODOs, or "implement later" found.

**Type consistency:**
- `checks` list format is consistent across evaluate_worker.py, MCP schema, SKILL.md, and tests
- `layer_map` format is consistent (component name → [layer, datatype])
- Primitive names match across all files: component_overlap, component_containment, contact_isolation, connectivity, route_endpoints, adjacency, solidity, spacing
