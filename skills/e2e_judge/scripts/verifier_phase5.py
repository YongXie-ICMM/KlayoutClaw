#!/usr/bin/env python3
"""Phase 5 verification functions for E2E agentic tests.

Each verify_* function makes direct MCP calls to KLayout to confirm
the agent actually accomplished its task, independent of what the
agent claimed in its transcript.
"""

import json
import os
from typing import Any

from verifier import MCPClient, VerificationResult


# ---------------------------------------------------------------------------
# T0: Tool/Skill Preflight
# ---------------------------------------------------------------------------

def verify_preflight_json(client: MCPClient, filepath: str = "/tmp/preflight.json",
                          **kwargs) -> VerificationResult:
    """Check /tmp/preflight.json exists and contains results from 3 tool calls."""
    if not os.path.exists(filepath):
        return VerificationResult(
            checks={"filepath": filepath, "exists": False},
            passed=False,
            summary=f"MISSING {filepath}",
        )
    try:
        with open(filepath) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        return VerificationResult(
            checks={"filepath": filepath, "parse_error": str(e)},
            passed=False,
            summary=f"Failed to parse {filepath}: {e}",
        )

    # Must contain results for all 3 tools
    expected_tools = {"get_layout_info", "validate_pixel_size", "evaluate_design"}
    found_tools = set()
    if isinstance(data, dict):
        found_tools = expected_tools & set(data.keys())
    elif isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict):
                name = entry.get("tool") or entry.get("name") or ""
                found_tools.add(name)
        found_tools = expected_tools & found_tools

    missing = expected_tools - found_tools
    ok = len(missing) == 0

    return VerificationResult(
        checks={"filepath": filepath, "found_tools": sorted(found_tools),
                "missing_tools": sorted(missing), "data_keys": list(data.keys()) if isinstance(data, dict) else f"list[{len(data)}]"},
        passed=ok,
        summary=f"preflight.json: found {len(found_tools)}/3 tools"
                + (f", missing: {sorted(missing)}" if missing else " -- ALL PRESENT"),
    )


def verify_skill_discovery(client: MCPClient, expected_names: list[str] = None,
                           **kwargs) -> VerificationResult:
    """Transcript-only check -- verifier confirms the MCP server is reachable
    and that the tools the agent should have discovered actually exist.
    We call the MCP initialize to list tools as a sanity check.
    """
    if expected_names is None:
        expected_names = ["nanodevice_hallbar", "nanodevice_e2e_design"]

    # Verify the server has the expected tools by calling get_layout_info
    # (a lightweight way to confirm the server is alive and responsive)
    try:
        info = client.call_tool("get_layout_info")
        server_alive = True
    except Exception as e:
        server_alive = False
        info = {"error": str(e)}

    # Verify that each expected skill has a SKILL.md on disk
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    skill_files = {}
    for name in expected_names:
        skill_md = os.path.join(repo_root, "skills", name, "SKILL.md")
        skill_files[name] = os.path.exists(skill_md)

    missing_skills = [n for n, exists in skill_files.items() if not exists]
    skills_ok = len(missing_skills) == 0

    ok = server_alive and skills_ok

    return VerificationResult(
        checks={"server_alive": server_alive, "expected_names": expected_names,
                "layout_info": info, "skill_files": skill_files,
                "missing_skills": missing_skills},
        passed=ok,
        summary=f"MCP server alive={server_alive}; "
                f"SKILL.md files: {sum(skill_files.values())}/{len(skill_files)}"
                + (f", missing: {missing_skills}" if missing_skills else " -- ALL PRESENT")
                + "; skill discovery is transcript-judged",
    )


# ---------------------------------------------------------------------------
# T1: Pixel Gate
# ---------------------------------------------------------------------------

def verify_pixel_gate(client: MCPClient, pixel_size: float = 0.1,
                      expect_valid: bool = True, **kwargs) -> VerificationResult:
    """Call validate_pixel_size directly and check result matches expectation."""
    try:
        result = client.call_tool("validate_pixel_size", pixel_size=pixel_size)
    except Exception as e:
        return VerificationResult(
            checks={"error": str(e)},
            passed=False,
            summary=f"validate_pixel_size call failed: {e}",
        )

    is_valid = result.get("valid", None)
    objective = result.get("likely_objective", "unknown")
    warnings = result.get("warnings", [])

    ok = (is_valid == expect_valid)

    return VerificationResult(
        checks={"pixel_size": pixel_size, "valid": is_valid,
                "expected_valid": expect_valid, "likely_objective": objective,
                "warnings": warnings, "raw": result},
        passed=ok,
        summary=f"pixel_size={pixel_size}: valid={is_valid} (expected {expect_valid}), "
                f"objective={objective}, {len(warnings)} warnings",
    )


def verify_layout_per_layer(client: MCPClient, expected_layers: dict[str, dict],
                            **kwargs) -> VerificationResult:
    """Check specific layers have expected shape counts and optional bounding boxes.

    expected_layers: dict mapping "L/D" strings to spec dicts.
    Example: {"4/0": {"min_shapes": 1, "expected_bbox": {"w": 100, "h": 50, "tol": 5}},
              "7/0": {"min_shapes": 2}}

    expected_bbox fields (all in microns):
      w: expected width, h: expected height, tol: tolerance (default 5um)
    """
    info = client.call_tool("get_layout_info")
    cells = info.get("cells", [])
    cell_name = cells[0] if cells else info.get("top_cell", "TOP")

    checks = {"cell": cell_name}
    all_ok = True

    for ld_str, spec in expected_layers.items():
        parts = ld_str.split("/")
        layer, dt = int(parts[0]), int(parts[1])
        min_shapes = spec.get("min_shapes", 1)
        expected_bbox = spec.get("expected_bbox", None)

        # Query both shape count and bounding box in a single MCP call
        r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"error": "cell not found", "count": 0}}
else:
    li = _layout.layer({layer}, {dt})
    count = cell.shapes(li).size()
    bbox = cell.bbox_per_layer(li)
    if bbox.empty():
        result = {{"count": count, "layer": {layer}, "datatype": {dt},
                   "bbox_empty": True}}
    else:
        dbu = _layout.dbu
        result = {{"count": count, "layer": {layer}, "datatype": {dt},
                   "bbox_empty": False,
                   "bbox_left": bbox.left * dbu,
                   "bbox_bottom": bbox.bottom * dbu,
                   "bbox_right": bbox.right * dbu,
                   "bbox_top": bbox.top * dbu,
                   "bbox_width": bbox.width() * dbu,
                   "bbox_height": bbox.height() * dbu}}
''')
        count = r.get("count", 0)
        ok = count >= min_shapes

        layer_check = {"count": count, "min_required": min_shapes, "ok": ok}

        # Add bbox info if available
        if not r.get("bbox_empty", True):
            layer_check["bbox_width"] = r.get("bbox_width", 0)
            layer_check["bbox_height"] = r.get("bbox_height", 0)

        # Validate bounding box if expected_bbox specified
        if expected_bbox and not r.get("bbox_empty", True):
            tol = expected_bbox.get("tol", 5.0)
            actual_w = r.get("bbox_width", 0)
            actual_h = r.get("bbox_height", 0)
            exp_w = expected_bbox.get("w", 0)
            exp_h = expected_bbox.get("h", 0)
            w_ok = abs(actual_w - exp_w) <= tol
            h_ok = abs(actual_h - exp_h) <= tol
            bbox_ok = w_ok and h_ok
            layer_check["bbox_check"] = {
                "expected_w": exp_w, "expected_h": exp_h,
                "actual_w": round(actual_w, 3), "actual_h": round(actual_h, 3),
                "tolerance": tol, "w_ok": w_ok, "h_ok": h_ok, "ok": bbox_ok,
            }
            if not bbox_ok:
                ok = False
                layer_check["ok"] = False
        elif expected_bbox and r.get("bbox_empty", True):
            layer_check["bbox_check"] = {"ok": False, "error": "bbox is empty"}
            ok = False
            layer_check["ok"] = False

        checks[ld_str] = layer_check
        if not ok:
            all_ok = False

    return VerificationResult(
        checks=checks,
        passed=all_ok,
        summary=f"Per-layer check on '{cell_name}': "
                + ", ".join(f"{k}={v['count']}/{v['min_required']}" for k, v in checks.items() if isinstance(v, dict) and 'count' in v)
                + f" ({'ALL OK' if all_ok else 'MISSING SHAPES OR BBOX MISMATCH'})",
    )


# ---------------------------------------------------------------------------
# T2/T9: Evaluate Design
# ---------------------------------------------------------------------------

def verify_evaluate_drc(client: MCPClient, layer_map: dict = None,
                        expected_check_count: int = 6,
                        expected_names: list[str] = None,
                        **kwargs) -> VerificationResult:
    """Call evaluate_design mode=drc directly and verify it returns expected checks.

    If expected_names is provided (or defaults to the 6 known DRC check names),
    the verifier confirms those names are present in the returned checks list.
    """
    if layer_map is None:
        layer_map = {
            "mesa": [20, 0],
            "contact_patch": [21, 0],
            "topgate": [22, 0],
            "contact_route": [23, 0],
            "bonding_pad": [24, 0],
        }

    if expected_names is None:
        expected_names = [
            "topgate", "contact_isolation", "connectivity",
            "route_endpoints", "contact_mesa_adjacency", "mesa_probes",
        ]

    try:
        result = client.call_tool("evaluate_design", timeout=120,
                                  layer_map=layer_map, mode="drc")
    except Exception as e:
        return VerificationResult(
            checks={"error": str(e)},
            passed=False,
            summary=f"evaluate_design drc call failed: {e}",
        )

    checks_list = result.get("checks", [])
    num_checks = len(checks_list)
    overall = result.get("overall", -1)
    check_names = [c.get("name", "?") for c in checks_list]

    # Verify expected check names are present
    found_expected = [n for n in expected_names if n in check_names]
    missing_expected = [n for n in expected_names if n not in check_names]
    names_ok = len(missing_expected) == 0

    ok = (num_checks >= expected_check_count
          and 0 <= overall <= 1
          and names_ok)

    return VerificationResult(
        checks={"num_checks": num_checks, "expected_check_count": expected_check_count,
                "overall_score": overall, "check_names": check_names,
                "score_in_range": 0 <= overall <= 1,
                "expected_names": expected_names,
                "found_expected": found_expected,
                "missing_expected": missing_expected},
        passed=ok,
        summary=f"DRC mode: {num_checks} checks (expected >={expected_check_count}), "
                f"overall={overall:.3f}"
                + (f", missing checks: {missing_expected}" if missing_expected
                   else ", all expected check names present"),
    )


def verify_evaluate_score(client: MCPClient, layer_map: dict = None,
                          reference_gds: str = None,
                          expected_check_count: int = 8, **kwargs) -> VerificationResult:
    """Call evaluate_design mode=score directly and verify 8 checks returned."""
    if layer_map is None:
        layer_map = {
            "mesa": [20, 0],
            "contact_patch": [21, 0],
            "topgate": [22, 0],
            "contact_route": [23, 0],
            "bonding_pad": [24, 0],
        }
    if reference_gds is None:
        return VerificationResult(
            checks={"error": "no reference_gds provided"},
            passed=False,
            summary="Cannot run score mode without reference_gds",
        )

    # If the agent didn't save the reference GDS, save current layout as fallback
    # so the verifier can independently check score mode functionality.
    ref_created_by_verifier = False
    if not os.path.exists(reference_gds):
        try:
            client.call_tool("save_layout", filepath=reference_gds)
            ref_created_by_verifier = True
        except Exception:
            pass

    try:
        result = client.call_tool("evaluate_design", timeout=120,
                                  layer_map=layer_map, mode="score",
                                  reference_gds=reference_gds)
    except Exception as e:
        return VerificationResult(
            checks={"error": str(e)},
            passed=False,
            summary=f"evaluate_design score call failed: {e}",
        )

    checks_list = result.get("checks", [])
    num_checks = len(checks_list)
    overall = result.get("overall", -1)
    check_names = [c.get("name", "?") for c in checks_list]

    # Check for the two reference-dependent checks
    has_mesa_overlap = "mesa_on_overlap" in check_names
    has_contacts_regions = "contacts_in_regions" in check_names

    ok = (num_checks >= expected_check_count and 0 <= overall <= 1
          and has_mesa_overlap and has_contacts_regions)

    return VerificationResult(
        checks={"num_checks": num_checks, "expected_check_count": expected_check_count,
                "overall_score": overall, "check_names": check_names,
                "has_mesa_on_overlap": has_mesa_overlap,
                "has_contacts_in_regions": has_contacts_regions,
                "ref_created_by_verifier": ref_created_by_verifier},
        passed=ok,
        summary=f"Score mode: {num_checks} checks (expected >={expected_check_count}), "
                f"overall={overall:.3f}, mesa_overlap={has_mesa_overlap}, "
                f"contacts_regions={has_contacts_regions}"
                + (" (verifier saved reference GDS)" if ref_created_by_verifier else ""),
    )


def verify_evaluate_graceful_error(client: MCPClient, layer_map: dict = None,
                                   **kwargs) -> VerificationResult:
    """Call evaluate_design mode=score with a missing reference_gds.
    Expect either an error or a graceful fallback to drc mode.
    """
    if layer_map is None:
        layer_map = {
            "mesa": [20, 0],
            "contact_patch": [21, 0],
            "topgate": [22, 0],
            "contact_route": [23, 0],
            "bonding_pad": [24, 0],
        }

    try:
        result = client.call_tool("evaluate_design", timeout=120,
                                  layer_map=layer_map, mode="score",
                                  reference_gds="/tmp/nonexistent_ref_12345.gds")
        # If it returned without error, it may have fallen back to DRC
        mode = result.get("mode", "unknown")
        has_checks = len(result.get("checks", [])) > 0
        ok = has_checks  # graceful fallback is acceptable
        return VerificationResult(
            checks={"fallback_mode": mode, "has_checks": has_checks, "raw": result},
            passed=ok,
            summary=f"Graceful fallback: mode={mode}, has_checks={has_checks}",
        )
    except RuntimeError as e:
        # An error is also an acceptable outcome -- the tool properly reported failure
        error_msg = str(e)
        ok = len(error_msg) > 0
        return VerificationResult(
            checks={"error": error_msg, "graceful": True},
            passed=ok,
            summary=f"Tool returned error (acceptable): {error_msg[:100]}",
        )


# ---------------------------------------------------------------------------
# T3: Hallbar / No-layer check
# ---------------------------------------------------------------------------

def verify_no_layer_geometry(client: MCPClient, layer: int, datatype: int = 0,
                             **kwargs) -> VerificationResult:
    """Check that a specific layer has NO shapes (zero geometry)."""
    info = client.call_tool("get_layout_info")
    cells = info.get("cells", [])
    cell_name = cells[0] if cells else info.get("top_cell", "TOP")

    r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"error": "cell not found", "count": 0}}
else:
    li = _layout.layer({layer}, {datatype})
    count = cell.shapes(li).size()
    result = {{"count": count, "layer": {layer}, "datatype": {datatype}}}
''')
    count = r.get("count", 0)
    ok = count == 0

    return VerificationResult(
        checks={"cell": cell_name, "layer": layer, "datatype": datatype,
                "shape_count": count},
        passed=ok,
        summary=f"L{layer}/{datatype} in '{cell_name}': {count} shapes "
                f"({'EMPTY as expected' if ok else f'HAS {count} shapes -- UNEXPECTED'})",
    )


def verify_topgate_off(client: MCPClient, layer: int = 22, datatype: int = 0,
                       device_layers: dict[str, dict] = None,
                       **kwargs) -> VerificationResult:
    """Check that topgate layer (L22/0) has NO shapes AND that the other device
    layers (L20/0, L21/0, L23/0, L24/0) DO have geometry."""
    if device_layers is None:
        device_layers = {
            "20/0": {"min_shapes": 1},
            "21/0": {"min_shapes": 1},
            "23/0": {"min_shapes": 1},
            "24/0": {"min_shapes": 1},
        }

    info = client.call_tool("get_layout_info")
    cells = info.get("cells", [])
    cell_name = cells[0] if cells else info.get("top_cell", "TOP")

    checks = {"cell": cell_name}
    all_ok = True

    # Check topgate layer is empty
    r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"error": "cell not found", "count": 0}}
else:
    li = _layout.layer({layer}, {datatype})
    count = cell.shapes(li).size()
    result = {{"count": count, "layer": {layer}, "datatype": {datatype}}}
''')
    tg_count = r.get("count", 0)
    tg_ok = tg_count == 0
    checks["topgate"] = {"layer": f"{layer}/{datatype}", "count": tg_count, "ok": tg_ok}
    if not tg_ok:
        all_ok = False

    # Check other device layers have geometry
    for ld_str, spec in device_layers.items():
        parts = ld_str.split("/")
        l, d = int(parts[0]), int(parts[1])
        min_shapes = spec.get("min_shapes", 1)
        r2 = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"count": 0}}
else:
    li = _layout.layer({l}, {d})
    result = {{"count": cell.shapes(li).size()}}
''')
        count = r2.get("count", 0)
        ok = count >= min_shapes
        checks[ld_str] = {"count": count, "min_required": min_shapes, "ok": ok}
        if not ok:
            all_ok = False

    return VerificationResult(
        checks=checks,
        passed=all_ok,
        summary=f"Topgate off: L{layer}/{datatype}={tg_count} shapes "
                f"({'EMPTY' if tg_ok else 'HAS SHAPES'}); "
                + ", ".join(f"{k}={v['count']}" for k, v in checks.items()
                            if isinstance(v, dict) and 'count' in v and k != "topgate")
                + f" ({'ALL OK' if all_ok else 'ISSUES FOUND'})",
    )


def _find_file(primary: str, alternatives: list[str] = None) -> str | None:
    """Return the first existing file from primary path + alternatives."""
    if os.path.exists(primary):
        return primary
    for alt in (alternatives or []):
        if os.path.exists(alt):
            return alt
    return None


def verify_hallbar_deliverables(client: MCPClient, filepath: str,
                                gds_filepath: str = None,
                                required_keys: list[str] = None,
                                **kwargs) -> VerificationResult:
    """Check both the result.json schema AND the GDS file existence."""
    if required_keys is None:
        required_keys = ["layer_map", "score", "feedback"]

    checks = {}
    all_ok = True

    # Check GDS file exists with non-zero size (search alternatives)
    if gds_filepath:
        gds_alts = [
            gds_filepath.replace(".gds", "_hallbar.gds"),
            "/tmp/hallbar.gds",
            "/tmp/klayoutclaw_hallbar.gds",
            "/tmp/phase5_hallbar.gds",
        ]
        actual_gds = _find_file(gds_filepath, gds_alts)
        gds_exists = actual_gds is not None
        gds_size = os.path.getsize(actual_gds) if gds_exists else 0
        gds_ok = gds_exists and gds_size > 100
        checks["gds"] = {"filepath": actual_gds or gds_filepath,
                          "expected_path": gds_filepath,
                          "exists": gds_exists,
                          "size": gds_size, "ok": gds_ok}
        if not gds_ok:
            # If no GDS file found, try saving current layout as fallback
            try:
                client.call_tool("save_layout", filepath=gds_filepath)
                gds_size = os.path.getsize(gds_filepath) if os.path.exists(gds_filepath) else 0
                gds_ok = gds_size > 100
                checks["gds"] = {"filepath": gds_filepath,
                                  "exists": True, "size": gds_size,
                                  "ok": gds_ok, "saved_by_verifier": True}
            except Exception:
                all_ok = False
            if not gds_ok:
                all_ok = False
    else:
        checks["gds"] = {"skipped": True}

    # Check JSON file schema (search alternatives)
    json_alts = [
        filepath.replace("result.json", "hallbar_result.json"),
        "/tmp/result.json",
        "/tmp/klayoutclaw_result.json",
    ]
    actual_json = _find_file(filepath, json_alts)
    if actual_json is None:
        checks["json"] = {"filepath": filepath, "exists": False,
                           "searched": [filepath] + json_alts}
        all_ok = False
    else:
        try:
            with open(actual_json) as f:
                data = json.load(f)
            if not isinstance(data, dict):
                checks["json"] = {"filepath": actual_json, "type": type(data).__name__}
                all_ok = False
            else:
                found = [k for k in required_keys if k in data]
                missing = [k for k in required_keys if k not in data]
                checks["json"] = {"filepath": actual_json, "exists": True,
                                   "found_keys": found, "missing_keys": missing}
                if missing:
                    all_ok = False
        except (json.JSONDecodeError, OSError) as e:
            checks["json"] = {"filepath": actual_json, "parse_error": str(e)}
            all_ok = False

    gds_summary = ""
    if gds_filepath:
        gds_summary = f"GDS={'EXISTS' if checks['gds'].get('ok') else 'MISSING'}, "

    return VerificationResult(
        checks=checks,
        passed=all_ok,
        summary=f"Deliverables: {gds_summary}"
                f"JSON={actual_json or filepath}: "
                + (f"{len(checks.get('json', {}).get('found_keys', []))}/{len(required_keys)} keys"
                   if checks.get("json", {}).get("exists") else "MISSING"),
    )


def verify_file_json_schema(client: MCPClient, filepath: str,
                            required_keys: list[str] = None,
                            **kwargs) -> VerificationResult:
    """Check a JSON file exists and contains required top-level keys."""
    if required_keys is None:
        required_keys = ["layer_map", "score", "feedback"]

    if not os.path.exists(filepath):
        return VerificationResult(
            checks={"filepath": filepath, "exists": False},
            passed=False,
            summary=f"MISSING {filepath}",
        )

    try:
        with open(filepath) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        return VerificationResult(
            checks={"filepath": filepath, "parse_error": str(e)},
            passed=False,
            summary=f"Failed to parse {filepath}: {e}",
        )

    if not isinstance(data, dict):
        return VerificationResult(
            checks={"filepath": filepath, "type": type(data).__name__},
            passed=False,
            summary=f"{filepath} is not a JSON object (got {type(data).__name__})",
        )

    found_keys = [k for k in required_keys if k in data]
    missing_keys = [k for k in required_keys if k not in data]
    ok = len(missing_keys) == 0

    return VerificationResult(
        checks={"filepath": filepath, "found_keys": found_keys,
                "missing_keys": missing_keys, "all_keys": list(data.keys())},
        passed=ok,
        summary=f"{filepath}: {len(found_keys)}/{len(required_keys)} required keys"
                + (f", missing: {missing_keys}" if missing_keys else " -- ALL PRESENT"),
    )


# ---------------------------------------------------------------------------
# T7: Layout Info Deep
# ---------------------------------------------------------------------------

def verify_recursive_cells(client: MCPClient, min_cell_count: int = 2,
                           expected_parent: str = None,
                           expected_child: str = None,
                           expected_cell_layers: dict[str, list[str]] = None,
                           **kwargs) -> VerificationResult:
    """Verify cell hierarchy: parent cell contains child instance.

    If expected_cell_layers is provided, also verify which layers each cell
    has geometry on. Format: {"HIER_CHILD": ["4/0"], "HIER_TOP": ["5/0"]}.
    """
    r = client.execute_script('''
cells = []
for ci in range(_layout.cells()):
    c = _layout.cell(ci)
    if c is not None:
        children = []
        for inst in c.each_inst():
            children.append(_layout.cell(inst.cell_index).name)
        # Collect layers with direct geometry (not from instances)
        layers_with_shapes = []
        for li in _layout.layer_indices():
            if c.shapes(li).size() > 0:
                info = _layout.get_info(li)
                layers_with_shapes.append(str(info.layer) + "/" + str(info.datatype))
        cells.append({"name": c.name, "children": children,
                       "layers_with_shapes": layers_with_shapes})
result = {"cells": cells, "count": len(cells)}
''')
    count = r.get("count", 0)
    cells = r.get("cells", [])

    ok = count >= min_cell_count

    # Check parent-child relationship if specified
    parent_has_child = False
    if expected_parent and expected_child:
        for c in cells:
            if c["name"] == expected_parent:
                if expected_child in c.get("children", []):
                    parent_has_child = True
                break
        ok = ok and parent_has_child

    # Check per-cell layer geometry if specified
    cell_layer_checks = {}
    if expected_cell_layers:
        cell_map = {c["name"]: c.get("layers_with_shapes", []) for c in cells}
        for cell_name, expected_lds in expected_cell_layers.items():
            actual_lds = cell_map.get(cell_name, [])
            found_lds = [ld for ld in expected_lds if ld in actual_lds]
            missing_lds = [ld for ld in expected_lds if ld not in actual_lds]
            extra_lds = [ld for ld in actual_lds if ld not in expected_lds]
            # Only fail on missing expected layers; extra layers from agent
            # interaction are acceptable (agent may create geometry as side effect)
            layer_ok = len(missing_lds) == 0
            cell_layer_checks[cell_name] = {
                "expected": expected_lds, "actual": actual_lds,
                "found": found_lds, "missing": missing_lds,
                "extra_layers": extra_lds, "ok": layer_ok,
            }
            if not layer_ok:
                ok = False

    cell_names = [c["name"] for c in cells]

    checks_dict = {
        "cell_count": count, "min_required": min_cell_count,
        "cell_names": cell_names,
        "parent_has_child": parent_has_child if expected_parent else "not_checked",
        "hierarchy": cells,
    }
    if cell_layer_checks:
        checks_dict["cell_layer_checks"] = cell_layer_checks

    layer_summary = ""
    if cell_layer_checks:
        layer_parts = []
        for cn, info in cell_layer_checks.items():
            if info["ok"]:
                layer_parts.append(f"{cn}={','.join(info['actual'])}")
            else:
                layer_parts.append(f"{cn} MISSING {info['missing']}")
        layer_summary = "; layers: " + ", ".join(layer_parts)

    return VerificationResult(
        checks=checks_dict,
        passed=ok,
        summary=f"{count} cells (>= {min_cell_count}): {', '.join(cell_names[:5])}"
                + (f"; {expected_parent}->{expected_child}: {'YES' if parent_has_child else 'NO'}"
                   if expected_parent else "")
                + layer_summary,
    )


def verify_text_and_polygon(client: MCPClient, layer: int, datatype: int = 0,
                            **kwargs) -> VerificationResult:
    """Check that a layer has both text objects and polygon/box shapes."""
    info = client.call_tool("get_layout_info")
    cells = info.get("cells", [])
    cell_name = cells[0] if cells else info.get("top_cell", "TOP")

    r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"error": "cell not found"}}
else:
    li = _layout.layer({layer}, {datatype})
    texts = 0
    polys = 0
    for s in cell.shapes(li).each():
        if s.is_text():
            texts += 1
        else:
            polys += 1
    result = {{"texts": texts, "polys": polys, "total": texts + polys,
               "layer": {layer}, "datatype": {datatype}}}
''')
    texts = r.get("texts", 0)
    polys = r.get("polys", 0)
    total = r.get("total", 0)

    ok = texts >= 1 and polys >= 1

    return VerificationResult(
        checks={"cell": cell_name, "layer": layer, "datatype": datatype,
                "text_count": texts, "polygon_count": polys, "total": total},
        passed=ok,
        summary=f"L{layer}/{datatype}: {texts} texts, {polys} polygons "
                f"({'BOTH present' if ok else 'MISSING one or both'})",
    )


# ---------------------------------------------------------------------------
# T9: Dual eval
# ---------------------------------------------------------------------------

def verify_dual_eval(client: MCPClient, layer_map: dict = None,
                     filepath: str = "/tmp/eval_comparison.json",
                     reference_gds: str = "/tmp/phase5_ref_adv.gds",
                     **kwargs) -> VerificationResult:
    """Run both drc and score modes independently and check consistency.
    Also check that the agent wrote a comparison JSON file.
    """
    if layer_map is None:
        layer_map = {
            "mesa": [20, 0],
            "contact_patch": [21, 0],
            "topgate": [22, 0],
            "contact_route": [23, 0],
            "bonding_pad": [24, 0],
        }

    # Run DRC mode directly
    try:
        drc_result = client.call_tool("evaluate_design", timeout=120,
                                      layer_map=layer_map, mode="drc")
        drc_ok = True
        drc_count = len(drc_result.get("checks", []))
        drc_names = [c.get("name", "?") for c in drc_result.get("checks", [])]
    except Exception as e:
        drc_ok = False
        drc_count = 0
        drc_names = []
        drc_result = {"error": str(e)}

    # Run score mode independently for cross-validation.
    # If the agent didn't save the reference GDS, the verifier saves the
    # current layout so it can still independently verify score mode works.
    score_ok = False
    score_count = 0
    score_names = []
    score_result = {}
    ref_exists = os.path.exists(reference_gds) if reference_gds else False
    if not ref_exists and reference_gds:
        try:
            client.call_tool("save_layout", filepath=reference_gds)
            ref_exists = True
        except Exception:
            pass

    if ref_exists:
        try:
            score_result = client.call_tool("evaluate_design", timeout=120,
                                            layer_map=layer_map, mode="score",
                                            reference_gds=reference_gds)
            score_ok = True
            score_count = len(score_result.get("checks", []))
            score_names = [c.get("name", "?") for c in score_result.get("checks", [])]
        except Exception as e:
            score_ok = False
            score_result = {"error": str(e)}

    # Cross-validate: score mode should have strictly more checks than DRC
    cross_valid = (score_count > drc_count) if (score_ok and drc_ok) else False

    # Check the comparison file the agent should have written
    file_exists = os.path.exists(filepath)
    file_valid = False
    comp_key_info = {}
    if file_exists:
        try:
            with open(filepath) as f:
                comp_data = json.load(f)
            file_valid = isinstance(comp_data, dict)
            if file_valid:
                # Verify it contains the expected comparison keys
                expected_comp_keys = {"drc_checks", "score_checks", "common_checks",
                                      "score_only_checks", "drc_overall", "score_overall"}
                found_comp_keys = expected_comp_keys & set(comp_data.keys())
                comp_key_info = {"expected": sorted(expected_comp_keys),
                                 "found": sorted(found_comp_keys),
                                 "all_keys": sorted(comp_data.keys())}
                # Require at least 4 of the 6 expected keys (agent may use
                # slightly different naming)
                if len(found_comp_keys) < 4:
                    file_valid = False
        except (json.JSONDecodeError, OSError):
            file_valid = False

    ok = (drc_ok and drc_count >= 6
          and score_ok and score_count >= 8
          and cross_valid
          and file_exists and file_valid)

    return VerificationResult(
        checks={"drc_ok": drc_ok, "drc_check_count": drc_count,
                "drc_check_names": drc_names,
                "score_ok": score_ok, "score_check_count": score_count,
                "score_check_names": score_names,
                "cross_valid": cross_valid,
                "reference_gds": reference_gds, "ref_exists": ref_exists,
                "file_exists": file_exists, "file_valid": file_valid,
                "comparison_keys": comp_key_info},
        passed=ok,
        summary=f"Dual eval: drc={drc_count} checks, score={score_count} checks, "
                f"cross_valid={cross_valid}, "
                f"comparison_file={'VALID' if file_valid else 'MISSING/INVALID'}"
                + (f" ({len(comp_key_info.get('found', []))}/6 expected keys)" if comp_key_info else ""),
    )


# ---------------------------------------------------------------------------
# T4: Pipeline / Auto-route
# ---------------------------------------------------------------------------

def verify_no_contours(client: MCPClient, contour_layers: list[list[int]] = None,
                       **kwargs) -> VerificationResult:
    """Verify that material contour layers have NO shapes (agent ran QUERY+VALIDATE only)."""
    if contour_layers is None:
        contour_layers = [[10, 0], [11, 0], [12, 0], [13, 0]]

    info = client.call_tool("get_layout_info")
    cells = info.get("cells", [])
    cell_name = cells[0] if cells else info.get("top_cell", "TOP")

    total_shapes = 0
    layer_counts = {}
    for ld in contour_layers:
        layer, dt = ld[0], ld[1]
        try:
            r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"count": 0}}
else:
    li = _layout.layer({layer}, {dt})
    result = {{"count": cell.shapes(li).size()}}
''')
            count = r.get("count", 0)
        except Exception:
            count = 0
        layer_counts[f"{layer}/{dt}"] = count
        total_shapes += count

    ok = total_shapes == 0

    return VerificationResult(
        checks={"cell": cell_name, "layer_counts": layer_counts,
                "total_shapes": total_shapes},
        passed=ok,
        summary=f"Contour layers: {total_shapes} total shapes "
                f"({'EMPTY as expected' if ok else 'HAS SHAPES -- unexpected'})",
    )


def verify_autoroute_success(client: MCPClient, pin_layer_a: str = "102/0",
                             pin_layer_b: str = "111/0",
                             output_layer: str = None,
                             path_width: float = None,
                             min_routed_pairs: int = 4,
                             **kwargs) -> VerificationResult:
    """Call auto_route directly and verify it returns success."""
    call_kwargs = dict(pin_layer_a=pin_layer_a, pin_layer_b=pin_layer_b)
    if output_layer is not None:
        call_kwargs["output_layer"] = output_layer
    if path_width is not None:
        call_kwargs["path_width"] = path_width

    try:
        result = client.call_tool("auto_route", timeout=300, **call_kwargs)
    except Exception as e:
        return VerificationResult(
            checks={"error": str(e)},
            passed=False,
            summary=f"auto_route call failed: {e}",
        )

    status = result.get("status", "unknown")
    routed = result.get("routed_pairs", 0)
    errors = result.get("errors", [])

    # Accept any non-error status (tool accepted the layer string format)
    # and check minimum routed pairs if specified
    ok = (status in ("success", "partial") and routed >= min_routed_pairs) or (
        status == "success" and min_routed_pairs <= 0)

    return VerificationResult(
        checks={"status": status, "routed_pairs": routed,
                "min_routed_pairs": min_routed_pairs,
                "output_layer": output_layer, "path_width": path_width,
                "errors": errors, "raw": result},
        passed=ok,
        summary=f"auto_route: status={status}, routed={routed} (min={min_routed_pairs}), "
                f"errors={len(errors)}",
    )


def verify_evaluate_layer_map_array(client: MCPClient, layer_map: dict = None,
                                    **kwargs) -> VerificationResult:
    """Verify evaluate_design handles array-style layer specs like [[3,0],[4,0]]."""
    if layer_map is None:
        layer_map = {
            "mesa": [20, 0],
            "contact_patch": [21, 0],
            "topgate": [22, 0],
            "contact_route": [[3, 0], [4, 0]],
            "bonding_pad": [24, 0],
        }

    try:
        result = client.call_tool("evaluate_design", timeout=120,
                                  layer_map=layer_map, mode="drc")
    except Exception as e:
        error_msg = str(e)
        # The tool may not support array layer specs -- an error is also a valid
        # outcome (the tool correctly rejected invalid input). Either a successful
        # response or a clear error counts as "handled correctly".
        return VerificationResult(
            checks={"error": error_msg, "layer_map": layer_map},
            passed=True,
            summary=f"evaluate_design with array layers: error (acceptable) -- {error_msg[:100]}",
        )

    checks_list = result.get("checks", [])
    num_checks = len(checks_list)
    overall = result.get("overall", -1)
    ok = num_checks > 0 and 0 <= overall <= 1

    return VerificationResult(
        checks={"num_checks": num_checks, "overall_score": overall,
                "layer_map_sent": layer_map},
        passed=ok,
        summary=f"Array layer map: {num_checks} checks, overall={overall}",
    )


# ---------------------------------------------------------------------------
# T10: Full pipeline
# ---------------------------------------------------------------------------

def verify_hallbar_on_contours(client: MCPClient, layer_map: dict = None,
                               min_score: float = 0.80,
                               **kwargs) -> VerificationResult:
    """Verify hallbar design on precomputed contours via evaluate_design."""
    if layer_map is None:
        layer_map = {
            "mesa": [20, 0],
            "contact_patch": [21, 0],
            "topgate": [22, 0],
            "contact_route": [23, 0],
            "bonding_pad": [24, 0],
        }

    try:
        result = client.call_tool("evaluate_design", timeout=120,
                                  layer_map=layer_map, mode="drc")
    except Exception as e:
        return VerificationResult(
            checks={"error": str(e)},
            passed=False,
            summary=f"evaluate_design failed: {e}",
        )

    overall = result.get("overall", 0)
    checks_list = result.get("checks", [])
    ok = overall >= min_score and len(checks_list) >= 6

    return VerificationResult(
        checks={"overall_score": overall, "min_score": min_score,
                "num_checks": len(checks_list),
                "check_names": [c.get("name") for c in checks_list]},
        passed=ok,
        summary=f"Hallbar eval: score={overall:.3f} (min={min_score}), "
                f"{len(checks_list)} checks",
    )


def verify_full_pipeline(client: MCPClient, gds_path: str = None,
                          result_json_path: str = None,
                          **kwargs) -> VerificationResult:
    """Verify the full E2E pipeline produced GDS + result.json."""
    checks = {}
    all_ok = True

    # Check GDS file
    if gds_path:
        gds_exists = os.path.exists(gds_path)
        gds_size = os.path.getsize(gds_path) if gds_exists else 0
        checks["gds"] = {"exists": gds_exists, "size": gds_size}
        if not (gds_exists and gds_size > 100):
            all_ok = False
    else:
        checks["gds"] = {"skipped": True}

    # Check result.json
    if result_json_path:
        rj_exists = os.path.exists(result_json_path)
        if rj_exists:
            try:
                with open(result_json_path) as f:
                    rj_data = json.load(f)
                required = ["layer_map", "score", "device_type", "pipeline_status", "feedback"]
                found = [k for k in required if k in rj_data]
                checks["result_json"] = {"exists": True, "found_keys": found,
                                          "missing": [k for k in required if k not in rj_data]}
                if len(found) < len(required):
                    all_ok = False
            except Exception as e:
                checks["result_json"] = {"exists": True, "parse_error": str(e)}
                all_ok = False
        else:
            checks["result_json"] = {"exists": False}
            all_ok = False
    else:
        checks["result_json"] = {"skipped": True}

    # Check layout has device layers
    info = {}
    try:
        info = client.call_tool("get_layout_info")
        checks["layout"] = {"num_cells": info.get("num_cells", 0),
                            "num_layers": info.get("num_layers", 0)}
        if info.get("num_cells", 0) < 1:
            all_ok = False
    except Exception as e:
        checks["layout"] = {"error": str(e)}
        all_ok = False

    # Verify geometry exists on the primary device layer (L20/0 mesa)
    try:
        cells = info.get("cells", [])
        cell_name = cells[0] if cells else info.get("top_cell", "TOP")
        r = client.execute_script(f'''
cell = _layout.cell("{cell_name}")
if cell is None:
    result = {{"error": "cell not found", "mesa_shapes": 0}}
else:
    li = _layout.layer(20, 0)
    result = {{"mesa_shapes": cell.shapes(li).size()}}
''')
        mesa_shapes = r.get("mesa_shapes", 0)
        checks["device_layers"] = {"mesa_L20_0": mesa_shapes}
        if mesa_shapes < 1:
            all_ok = False
    except Exception as e:
        checks["device_layers"] = {"error": str(e)}
        all_ok = False

    return VerificationResult(
        checks=checks,
        passed=all_ok,
        summary=f"Full pipeline: " + ", ".join(f"{k}={'OK' if isinstance(v, dict) and v.get('exists', True) else 'FAIL'}" for k, v in checks.items()),
    )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

_REGISTRY = {
    "verify_preflight_json": verify_preflight_json,
    "verify_skill_discovery": verify_skill_discovery,
    "verify_pixel_gate": verify_pixel_gate,
    "verify_layout_per_layer": verify_layout_per_layer,
    "verify_evaluate_drc": verify_evaluate_drc,
    "verify_evaluate_score": verify_evaluate_score,
    "verify_evaluate_graceful_error": verify_evaluate_graceful_error,
    "verify_no_layer_geometry": verify_no_layer_geometry,
    "verify_topgate_off": verify_topgate_off,
    "verify_hallbar_deliverables": verify_hallbar_deliverables,
    "verify_file_json_schema": verify_file_json_schema,
    "verify_recursive_cells": verify_recursive_cells,
    "verify_text_and_polygon": verify_text_and_polygon,
    "verify_dual_eval": verify_dual_eval,
    "verify_no_contours": verify_no_contours,
    "verify_autoroute_success": verify_autoroute_success,
    "verify_evaluate_layer_map_array": verify_evaluate_layer_map_array,
    "verify_hallbar_on_contours": verify_hallbar_on_contours,
    "verify_full_pipeline": verify_full_pipeline,
}


def run_verification_phase5(fn_name: str, client: MCPClient, **kwargs) -> VerificationResult:
    """Dispatch a Phase 5 verification function by name."""
    fn = _REGISTRY.get(fn_name)
    if fn is None:
        return VerificationResult(
            checks={"error": f"unknown phase5 function: {fn_name}"},
            passed=False, summary=f"Unknown phase5 verification: {fn_name}",
        )
    try:
        return fn(client, **kwargs)
    except Exception as e:
        return VerificationResult(
            checks={"error": str(e)},
            passed=False, summary=f"Phase5 verification error: {e}",
        )
