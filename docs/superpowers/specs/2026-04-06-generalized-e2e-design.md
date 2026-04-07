# Generalized E2E Nanodevice Design Skill

**Date:** 2026-04-06
**Status:** Draft
**Scope:** Rewrite `nanodevice_e2e_design` as a device-agnostic methodology, delete `nanodevice_hallbar`, generalize `evaluate_worker.py`

---

## Problem

The current `nanodevice_e2e_design` skill is hardcoded for Hall bar devices. It references `nanodevice_hallbar` by name, assumes specific layer conventions (mesa=20/0, contact=21/0, topgate=22/0), and gates on Hall-bar-specific evaluation checks (mesa solidity, contacts in graphene-only regions). This makes it unusable for other device types (FETs, quantum dots, Josephson junctions, etc.).

The `nanodevice_hallbar` skill encodes device-specific physics rules that the agent should be able to derive from its own knowledge given the device type and available materials.

## Design Decision

**Approach:** Methodology Guide -- the skill teaches the agent *how to think* about device design rather than prescribing device-specific rules. The agent derives physics rules, layer maps, and evaluation criteria from context and user input.

---

## Changes

### Delete

- `skills/nanodevice_hallbar/SKILL.md` -- absorbed into the generalized methodology

### Rewrite

- `skills/nanodevice_e2e_design/SKILL.md` -- from Hall-bar orchestrator to general device design methodology

### Generalize

- `tools/evaluate_worker.py` -- configurable check list instead of hardcoded Hall bar checks

### Keep as-is

- `nanodevice_flakedetect*` skills -- already device-agnostic
- `nanodevice_gdsalign` -- already device-agnostic
- `nanodevice_routing` -- stays available as reference, but the generalized skill does not mandate its use

---

## Generalized Pipeline

7-step methodology where each step is a reasoning phase, not a hardcoded action.

| # | Step | What the agent does | Skip when |
|---|------|---------------------|-----------|
| 1 | QUERY | Check if required info is missing; ask only if needed | User provided everything in initial prompt |
| 2 | PREPARE | Run flake detection + GDS alignment if microscope images provided; otherwise analyze existing layout | No images provided / layout already prepared |
| 3 | ANALYZE | Study material regions, compute overlaps/exclusions, identify design-relevant zones | Never |
| 4 | DESIGN | Create device geometry via `execute_script` -- active region, contacts, gates, etc. | Never |
| 5 | ROUTE | Use `auto_route` tool to connect device contacts to bonding pads | Device has no external contacts |
| 6 | EVALUATE | Run generalized evaluator + visual inspection, iterate on failures | Never |
| 7 | SAVE | Export GDS + write result.json summary | Never |

### Step 1: QUERY

Check the user's initial prompt against this checklist:

| Parameter | Required? | Notes |
|-----------|-----------|-------|
| Device type | Yes | What to build (Hall bar, FET, QD, etc.) |
| Material regions | Yes | Which layers have which materials, or microscope images to detect them |
| Layer assignments | Yes | Which layers to use for each design component |
| pixel_size | If images provided | Needed for detection/alignment pipeline |
| Device-specific constraints | If any | Gates, contacts, pin count, dimensions -- whatever the device needs |
| Output path | No | Defaults to source directory |

If all required parameters are already provided, skip to PREPARE (or ANALYZE). Only ask about missing items.

### Step 2: PREPARE

Conditional step -- only runs if the user provides microscope images.

If microscope images are provided:
1. Validate pixel_size via `validate_pixel_size` tool
2. Run `nanodevice_flakedetect` pipeline (align, detect, combine)
3. Run `nanodevice_gdsalign` if a GDS template is provided
4. Run `nanodevice_flakedetect_commit` to insert material polygons into KLayout

If starting from an existing layout, verify that the expected material regions are present via `get_layout_info`.

**Gate:** Material regions exist as polygons on their designated layers in KLayout. Reference images (if any) are loaded as background overlays.

### Step 3: ANALYZE

**Prerequisite:** Material contours must exist as polygons in KLayout, and any reference images must be loaded as background overlays. If they are not present, go back to PREPARE or ask the user.

The agent studies the available geometry to inform design decisions:
- Use `get_layout_info` to identify which layers have material regions
- Use `execute_script` with `pya.Region` to compute overlaps, exclusions, and bounding boxes
- Use `screenshot` to visually inspect material regions and plan device placement
- Identify which material zones are relevant for the specific device type (the agent derives this from device physics, not from hardcoded rules)

**Gate:** The agent has a clear understanding of available material regions and where the device should be placed.

### Step 4: DESIGN

The agent creates device geometry using `execute_script`. What geometry to create depends entirely on the device type -- the agent applies its physics knowledge to:
- Design the active region (mesa, channel, dot, junction, etc.)
- Place contacts appropriate to the device type
- Place gates if needed
- Ensure all components respect material region boundaries identified in ANALYZE

The skill does NOT prescribe specific geometries, dimensions, or layer numbers. The agent derives these from:
- Device type and physics requirements
- Available material regions from ANALYZE
- Layer assignments agreed in QUERY
- User-specified constraints

**Gate:** Device geometry is present on the designated layers. Visual inspection via `screenshot` confirms the design looks correct.

### Step 5: ROUTE

If the device has contacts that need fan-out to bonding pads, the agent uses the `auto_route` MCP tool directly:
- Place pin markers at contact positions and pad positions via `execute_script`
- Call `auto_route` with appropriate parameters (line width, obstacle layers, etc.)
- For failed pairs, write custom routing scripts via `execute_script`

The agent decides routing topology, line widths, and obstacle avoidance based on the device layout. It may reference the `nanodevice_routing` skill for implementation patterns, but is not required to use its scripts.

**Gate:** All contacts are connected to bonding pads. No route crossings or shorts.

### Step 6: EVALUATE

Run the generalized `evaluate_design` tool with a device-appropriate check configuration. The agent composes the check list based on what it designed.

Available check primitives (see Generalized Evaluator section below):
- `component_overlap` -- A overlaps B
- `component_containment` -- A is within B
- `contact_isolation` -- routes don't cross
- `connectivity` -- contacts reach pads
- `route_endpoints` -- endpoints land on valid targets
- `adjacency` -- A is within N um of B
- `solidity` -- shape solidity above/below threshold
- `spacing` -- minimum distance between components

Also take a `screenshot` for visual inspection.

- If score >= 0.80, proceed to SAVE
- If score < 0.80, identify the lowest-scoring check and iterate on that component
- Maximum 2 retries per step

**Gate:** Evaluation score >= 0.80 and visual inspection passes.

### Step 7: SAVE

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

## Generalized Evaluator

### Current State

`evaluate_worker.py` hardcodes 8 Hall-bar-specific checks with fixed weights:

| Check | Weight | Hall-bar specific? |
|-------|--------|--------------------|
| mesa_on_overlap | 0.15 | Yes (graphene-graphite overlap) |
| contacts_in_regions | 0.15 | Yes (graphene-only, graphite-only) |
| topgate | 0.10 | Yes |
| contact_isolation | 0.10 | No |
| connectivity | 0.10 | No |
| route_endpoints | 0.10 | No |
| contact_mesa_adjacency | 0.15 | Partially |
| mesa_probes | 0.15 | Yes (H-bar solidity) |

### Generalized Design

The evaluator accepts a configurable check list in the input JSON. Each check is a **geometric primitive** that works for any device type.

**Input config format:**

```json
{
  "gds_path": "result.gds",
  "reference_gds": "reference.gds",
  "layer_map": {"mesa": [20, 0], "contact_patch": [21, 0]},
  "mode": "score",
  "checks": [
    {"name": "component_containment", "args": {"component": "mesa", "region": ["graphene", "graphite"], "region_op": "intersection"}, "weight": 0.2},
    {"name": "contact_isolation", "args": {}, "weight": 0.15},
    {"name": "connectivity", "args": {}, "weight": 0.2},
    {"name": "adjacency", "args": {"component_a": "contact_patch", "component_b": "mesa", "tolerance": 2.0}, "weight": 0.15},
    {"name": "solidity", "args": {"component": "mesa", "threshold": 0.5, "direction": "below"}, "weight": 0.15},
    {"name": "spacing", "args": {"component_a": "contact_patch", "component_b": "contact_patch", "min_distance": 1.0}, "weight": 0.15}
  ]
}
```

**No backward compatibility:** The old hardcoded Hall-bar checks are removed. Callers must provide a `checks` list.

**Check primitives:**

| Primitive | Args | What it measures |
|-----------|------|-----------------|
| `component_overlap` | component, region, region_op | Fraction of component area overlapping with region (region can be a layer_map key or list of keys combined via region_op: intersection/union/difference) |
| `component_containment` | component, region, region_op | Fraction of component area contained within region (same region resolution as above) |
| `contact_isolation` | (none) | Fraction of route pairs that don't cross |
| `connectivity` | (none) | Fraction of contacts that reach a bonding pad |
| `route_endpoints` | (none) | Fraction of route endpoints on valid targets |
| `adjacency` | component_a, component_b, tolerance | Fraction of A shapes within tolerance of B |
| `solidity` | component, threshold, direction | 1.0 if solidity is above/below threshold, else ratio |
| `spacing` | component_a, component_b, min_distance | Fraction of pairs meeting minimum distance |

Each primitive returns a score in [0.0, 1.0]. The overall score is the weighted sum.

---

## What the Skill Prescribes vs. What It Doesn't

**Prescribes:**
- Step ordering (QUERY -> PREPARE -> ANALYZE -> DESIGN -> ROUTE -> EVALUATE -> SAVE)
- Gate conditions before proceeding to next step
- Retry protocol (max 2 retries per step)
- Which MCP tools to use (`execute_script`, `auto_route`, `evaluate_design`, `screenshot`, `get_layout_info`, `save_layout`)
- Query checklist for completeness checking

**Does NOT prescribe:**
- Specific device geometries or dimensions
- Specific layer numbers (agreed with user in QUERY)
- Specific material assumptions (agent derives from device type)
- Specific evaluation weights (agent composes per device)
- Specific routing topology (agent decides based on device layout)
- Whether to use `nanodevice_routing` scripts (agent's choice)

---

## Conventions

- **Conda env:** `base` (has opencv, numpy, scipy, sklearn)
- **Pixel coordinates:** image origin at top-left; KLayout uses center origin with Y-flip
- **Layer references:** always as `layer/datatype` (e.g., `11/0`)
- **Output directory:** defaults to source image directory if not specified
- **Sub-skill dispatch:** flakedetect and gdsalign sub-skills run as subagents reading their own SKILL.md
