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
    except (ValueError, shapely.errors.GEOSException):
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


def _normalize_layer_spec(spec):
    """Normalize a layer spec to list of (layer, datatype) pairs.

    Accepts:
      [layer, datatype]              -> [(layer, datatype)]
      [[layer, dt], [layer, dt]]     -> [(layer, dt), ...]
      {"layer": N, "datatype": N}    -> [(N, N)]
      [{"layer": N, "datatype": N}]  -> [(N, N)]
    """
    if isinstance(spec, dict):
        return [(spec["layer"], spec.get("datatype", 0))]
    if isinstance(spec, (list, tuple)) and len(spec) > 0:
        if isinstance(spec[0], dict):
            return [(s["layer"], s.get("datatype", 0)) for s in spec]
        if isinstance(spec[0], (list, tuple)):
            return [tuple(s) for s in spec]
        return [tuple(spec)]
    return []


def _component_union(lib, layer_map, name):
    spec = layer_map.get(name)
    if spec is None:
        return sg.Polygon()
    pairs = _normalize_layer_spec(spec)
    all_shapes = []
    for layer, dt in pairs:
        all_shapes.extend(_extract_shapely(lib, layer, dt))
    return unary_union(all_shapes) if all_shapes else sg.Polygon()


def _component_list(lib, layer_map, name):
    spec = layer_map.get(name)
    if spec is None:
        return []
    pairs = _normalize_layer_spec(spec)
    all_shapes = []
    for layer, dt in pairs:
        all_shapes.extend(_extract_shapely(lib, layer, dt))
    return all_shapes


def _get_spine_endpoints(lib, layer_map, component="contact_route"):
    spec = layer_map.get(component)
    if spec is None:
        return []
    pairs = _normalize_layer_spec(spec)
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
    comp = _component_union(out_lib, layer_map, args["component"])
    if comp.is_empty:
        return 0.0
    region = _resolve_region(out_lib, ref_lib, layer_map,
                             args["region"], args.get("region_op", "union"))
    if region.is_empty:
        return 0.0
    return comp.intersection(region).area / comp.area


def _prim_component_containment(out_lib, ref_lib, layer_map, args):
    """Fraction of component area contained within region."""
    comp = _component_union(out_lib, layer_map, args["component"])
    if comp.is_empty:
        return 0.0
    region = _resolve_region(out_lib, ref_lib, layer_map,
                             args["region"], args.get("region_op", "union"))
    if region.is_empty:
        return 0.0
    return comp.intersection(region).area / comp.area


def _route_endpoints_on_layer(lib, layer, datatype):
    """Extract spine endpoints for each route on a single layer.

    Returns list of (endpoint_a, endpoint_b) numpy arrays.
    Prefers path spine; falls back to polygon most-distant-vertices.
    """
    eps = []
    for cell in lib.cells:
        for path in cell.get_paths():
            if path.layers[0] == layer and path.datatypes[0] == datatype:
                try:
                    spine = np.array(path.spine())
                except (AttributeError, TypeError):
                    try:
                        spine = np.array(path.points)
                    except (AttributeError, TypeError):
                        continue
                if len(spine) >= 2:
                    eps.append((spine[0].copy(), spine[-1].copy()))
    if eps:
        return eps
    for cell in lib.cells:
        for poly in cell.get_polygons():
            if poly.layer == layer and poly.datatype == datatype:
                pts = poly.points
                if len(pts) < 3:
                    continue
                dists = np.sqrt(((pts[:, None] - pts[None, :]) ** 2).sum(axis=2))
                i, j = np.unravel_index(np.argmax(dists), dists.shape)
                eps.append((pts[i].copy(), pts[j].copy()))
    return eps


def _is_junction(intersection_geom, eps_a, eps_b, tolerance=2.0):
    """True if intersection sits near an endpoint of both routes (junction).

    A junction is end-to-end; a crossing is mid-body overlap.
    """
    if intersection_geom.is_empty:
        return True
    centroid = np.array(intersection_geom.centroid.coords[0])
    near_a = any(np.linalg.norm(centroid - ep) <= tolerance for ep in eps_a)
    near_b = any(np.linalg.norm(centroid - ep) <= tolerance for ep in eps_b)
    return near_a and near_b


def _crossing_penalty(crossing):
    """Steep penalty curve for route crossings.

    0 → 1.0, 1-2 → 0.8, 3-5 → linear decay to 0.2, ≥6 → exp collapse.
    """
    if crossing == 0:
        return 1.0
    if crossing <= 2:
        return 0.8
    if crossing <= 5:
        return 0.6 - (crossing - 3) * 0.2
    return 0.1 * (0.5 ** (crossing - 5))


def _prim_contact_isolation(out_lib, ref_lib, layer_map, args):
    """Route crossing check with junction-aware detection.

    Distinguishes junctions (endpoint-to-endpoint) from real crossings
    (mid-body shorts).  Penalises crossings steeply — shorts are
    dead-or-alive, not a fractional metric.
    """
    route_comp = args.get("component", "contact_route")
    spec = layer_map.get(route_comp)
    if spec is None:
        return 0.0
    pairs = _normalize_layer_spec(spec)
    if not pairs:
        return 0.0

    all_routes = []
    all_eps = []
    for layer, dt in pairs:
        routes = _extract_shapely(out_lib, layer, dt)
        eps = _route_endpoints_on_layer(out_lib, layer, dt)
        all_routes.extend(routes)
        all_eps.extend(eps)

    n = len(all_routes)
    if n < 2:
        return 1.0 if all_routes else 0.0

    crossing = 0
    for i in range(n):
        for j in range(i + 1, n):
            ix = all_routes[i].intersection(all_routes[j])
            if ix.area <= 0.01:
                continue
            if i < len(all_eps) and j < len(all_eps):
                if _is_junction(ix, all_eps[i], all_eps[j]):
                    continue
            elif ix.area <= 1.0:
                continue
            crossing += 1

    return _crossing_penalty(crossing)


def _prim_connectivity(out_lib, ref_lib, layer_map, args):
    """Fraction of contacts that reach a bonding pad via routes."""
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


def _prim_adjacency(out_lib, ref_lib, layer_map, args):
    """Fraction of component_a shapes within tolerance of component_b."""
    shapes_a = _component_list(out_lib, layer_map, args["component_a"])
    if not shapes_a:
        return 0.0
    comp_b = _component_union(out_lib, layer_map, args["component_b"])
    if comp_b.is_empty:
        return 0.0
    tolerance = args.get("tolerance", 2.0)
    comp_b_buf = comp_b.buffer(tolerance)
    return sum(1 for s in shapes_a if comp_b_buf.intersects(s)) / len(shapes_a)


def _prim_solidity(out_lib, ref_lib, layer_map, args):
    """Score based on shape solidity relative to threshold."""
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


def _prim_spacing(out_lib, ref_lib, layer_map, args):
    """Fraction of component pairs meeting minimum distance."""
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

    # Pre-check: report which layer_map components have zero geometry
    empty_components = []
    for comp_name, spec in layer_map.items():
        if comp_name.startswith("_"):
            continue
        pairs = _normalize_layer_spec(spec)
        if not pairs:
            empty_components.append("{} (invalid layer spec: {})".format(comp_name, spec))
            continue
        has_shapes = False
        for layer, dt in pairs:
            if _extract_shapely(out_lib, layer, dt):
                has_shapes = True
                break
        if not has_shapes:
            empty_components.append("{} (layer {} — no shapes found)".format(comp_name, pairs))

    # Run checks
    results = []
    for check in checks:
        name = check["name"]
        args = check.get("args", {})
        weight = check.get("weight", 1.0 / len(checks))
        try:
            score = PRIMITIVES[name](out_lib, ref_lib, layer_map, args)
            score = max(0.0, min(1.0, float(score)))
            detail = "{}: {:.4f}".format(name, score)
        except Exception as e:
            score = 0.0
            detail = "{}: ERROR — {}".format(name, e)
        results.append({
            "name": name,
            "score": score,
            "weight": weight,
            "detail": detail,
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
    if empty_components:
        output["warnings"] = [
            "Components with no geometry in the GDS: " + "; ".join(empty_components),
            "Checks referencing empty components will score 0.0.",
        ]

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)


if __name__ == "__main__":
    main()
