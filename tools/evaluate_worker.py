#!/usr/bin/env python
"""evaluate_worker.py -- Subprocess evaluator for device design quality checks.

CLI: python evaluate_worker.py config.json

Config JSON input: {gds_path, reference_gds (optional), layer_map, mode, output_path}
Output JSON: {status, overall, mode, checks: [{name, score, weight, detail}]}
"""

import sys
import os
import json

# Pre-flight dependency check
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
# Constants
# ---------------------------------------------------------------------------

REF_GRAPHENE = (11, 0)
REF_GRAPHITE = (13, 0)

REQUIRED_COMPONENTS = ["mesa", "contact_patch", "topgate", "contact_route", "bonding_pad"]


# ---------------------------------------------------------------------------
# Geometry helpers
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
    # Support both [layer, datatype] and [[layer, datatype], ...] formats
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


def _ref_material(lib, layer_spec):
    shapes = _extract_shapely(lib, *layer_spec)
    return unary_union(shapes) if shapes else sg.Polygon()


def _get_spine_endpoints(lib, layer_map):
    spec = layer_map.get("contact_route")
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
# Check functions
# ---------------------------------------------------------------------------

def _check_mesa_on_overlap(out_lib, ref_lib, layer_map):
    """Check 1: mesa_on_overlap (0.15) -- needs reference GDS."""
    try:
        mesa = _component_union(out_lib, layer_map, "mesa")
        if mesa.is_empty:
            return 0.0
        graphene = _ref_material(ref_lib, REF_GRAPHENE)
        graphite = _ref_material(ref_lib, REF_GRAPHITE)
        if graphene.is_empty or graphite.is_empty:
            return 0.0
        overlap = graphene.intersection(graphite)
        if overlap.is_empty:
            return 0.0
        return mesa.intersection(overlap).area / mesa.area
    except Exception:
        return 0.0


def _check_contacts_in_regions(out_lib, ref_lib, layer_map):
    """Check 2: contacts_in_regions (0.15) -- needs reference GDS."""
    try:
        patches = _component_list(out_lib, layer_map, "contact_patch")
        if not patches:
            return 0.0
        graphene = _ref_material(ref_lib, REF_GRAPHENE)
        graphite = _ref_material(ref_lib, REF_GRAPHITE)
        graphene_only = graphene.difference(graphite) if not graphene.is_empty else sg.Polygon()
        graphite_only = graphite.difference(graphene) if not graphite.is_empty else sg.Polygon()
        correct = sum(1 for p in patches if graphene_only.contains(p.centroid) or graphite_only.contains(p.centroid))
        return correct / len(patches)
    except Exception:
        return 0.0


def _check_topgate(out_lib, layer_map):
    """Check 3: topgate (0.10) -- no reference needed."""
    try:
        topgate = _component_union(out_lib, layer_map, "topgate")
        mesa = _component_union(out_lib, layer_map, "mesa")
        routes = _component_union(out_lib, layer_map, "contact_route")
        coverage = 1.0 if (not topgate.is_empty and not mesa.is_empty and topgate.intersection(mesa).area > 0) else 0.0
        isolation = 1.0 if (topgate.is_empty or routes.is_empty or topgate.intersection(routes).area < 1.0) else 0.0
        return 0.5 * coverage + 0.5 * isolation
    except Exception:
        return 0.0


def _check_contact_isolation(out_lib, layer_map):
    """Check 4: contact_isolation (0.10) -- no reference needed."""
    try:
        routes = _component_list(out_lib, layer_map, "contact_route")
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


def _check_connectivity(out_lib, layer_map, tolerance=15.0):
    """Check 5: connectivity (0.10) -- no reference needed."""
    try:
        patches = _component_list(out_lib, layer_map, "contact_patch")
        pads = _component_union(out_lib, layer_map, "bonding_pad")
        if not patches or pads.is_empty:
            return 0.0
        pads_buf = pads.buffer(tolerance)
        route_eps = _get_spine_endpoints(out_lib, layer_map)
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


def _check_route_endpoints(out_lib, layer_map, tolerance=15.0):
    """Check 6: route_endpoints (0.10) -- no reference needed."""
    try:
        route_eps = _get_spine_endpoints(out_lib, layer_map)
        if not route_eps:
            return 0.0
        device = _component_union(out_lib, layer_map, "contact_patch")
        mesa = _component_union(out_lib, layer_map, "mesa")
        pads = _component_union(out_lib, layer_map, "bonding_pad")
        target = sg.Polygon()
        for g in [device, mesa, pads]:
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


def _check_contact_mesa_adjacency(out_lib, layer_map, tolerance=2.0):
    """Check 7: contact_mesa_adjacency (0.15) -- no reference needed."""
    try:
        patches = _component_list(out_lib, layer_map, "contact_patch")
        if not patches:
            return 0.0
        mesa = _component_union(out_lib, layer_map, "mesa")
        if mesa.is_empty:
            return 0.0
        mesa_buf = mesa.buffer(tolerance)
        return sum(1 for p in patches if mesa_buf.intersects(p)) / len(patches)
    except Exception:
        return 0.0


def _check_mesa_probes(out_lib, layer_map):
    """Check 8: mesa_probes (0.15) -- no reference needed."""
    try:
        mesa = _component_union(out_lib, layer_map, "mesa")
        if mesa.is_empty:
            return 0.0
        hull = mesa.convex_hull
        if hull.is_empty or hull.area == 0:
            return 0.0
        solidity = mesa.area / hull.area
        return max(0.0, min(1.0, 1.0 - solidity))
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Check registry with weights
# ---------------------------------------------------------------------------

ALL_CHECKS = [
    ("mesa_on_overlap", 0.15, True),      # needs reference
    ("contacts_in_regions", 0.15, True),   # needs reference
    ("topgate", 0.10, False),
    ("contact_isolation", 0.10, False),
    ("connectivity", 0.10, False),
    ("route_endpoints", 0.10, False),
    ("contact_mesa_adjacency", 0.15, False),
    ("mesa_probes", 0.15, False),
]


def _run_check(name, out_lib, ref_lib, layer_map):
    """Run a single check by name and return the score."""
    if name == "mesa_on_overlap":
        return _check_mesa_on_overlap(out_lib, ref_lib, layer_map)
    elif name == "contacts_in_regions":
        return _check_contacts_in_regions(out_lib, ref_lib, layer_map)
    elif name == "topgate":
        return _check_topgate(out_lib, layer_map)
    elif name == "contact_isolation":
        return _check_contact_isolation(out_lib, layer_map)
    elif name == "connectivity":
        return _check_connectivity(out_lib, layer_map)
    elif name == "route_endpoints":
        return _check_route_endpoints(out_lib, layer_map)
    elif name == "contact_mesa_adjacency":
        return _check_contact_mesa_adjacency(out_lib, layer_map)
    elif name == "mesa_probes":
        return _check_mesa_probes(out_lib, layer_map)
    else:
        return 0.0


# ---------------------------------------------------------------------------
# Error output helper
# ---------------------------------------------------------------------------

def _write_error(output_path, message):
    """Write structured error JSON and exit 0."""
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
    mode = config.get("mode", "score")
    output_path = config.get("output_path", "output.json")

    if mode not in ("score", "drc"):
        _write_error(output_path, "Invalid mode '{}'. Must be 'score' or 'drc'.".format(mode))
        sys.exit(0)

    # Validate required layer_map keys
    missing = [k for k in REQUIRED_COMPONENTS if k not in layer_map]
    if missing:
        _write_error(output_path, "layer_map missing required keys: {}".format(", ".join(missing)))

    # Validate score mode requires reference_gds
    if mode == "score" and not reference_gds:
        _write_error(output_path, "mode='score' requires reference_gds in config")

    # Validate GDS file exists
    if not os.path.isfile(gds_path):
        _write_error(output_path, "GDS file not found: {}".format(gds_path))

    # Validate reference GDS exists (if provided)
    if reference_gds and not os.path.isfile(reference_gds):
        _write_error(output_path, "Reference GDS file not found: {}".format(reference_gds))

    # Load GDS files
    out_lib = gdstk.read_gds(gds_path)
    ref_lib = None
    if reference_gds:
        ref_lib = gdstk.read_gds(reference_gds)

    # Select checks based on mode
    if mode == "drc":
        checks_to_run = [(name, weight, needs_ref) for name, weight, needs_ref in ALL_CHECKS if not needs_ref]
    else:
        checks_to_run = ALL_CHECKS

    # Run checks
    results = []
    for name, weight, needs_ref in checks_to_run:
        score = _run_check(name, out_lib, ref_lib, layer_map)
        score = max(0.0, min(1.0, float(score)))
        results.append({
            "name": name,
            "score": score,
            "weight": weight,
            "detail": "{}: {:.4f}".format(name, score),
        })

    # Compute overall score
    weighted_sum = sum(c["score"] * c["weight"] for c in results)
    if mode == "drc":
        overall = round(weighted_sum / 0.70, 6)
    else:
        overall = round(weighted_sum, 6)

    output = {
        "status": "ok",
        "overall": overall,
        "mode": mode,
        "checks": results,
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)


if __name__ == "__main__":
    main()
