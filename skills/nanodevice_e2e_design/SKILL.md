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
2. Write `result.json` — **check if the task or benchmark specifies a required format first and use that exactly**. If no format is specified, use this general-purpose default:
   - `device_type`: from QUERY
   - `layer_map`: all layer assignments used (e.g. `{"mesa": [{"layer": 20, "datatype": 0}], ...}`)
   - `score`: final evaluation score from EVALUATE
   - `pixel_size`: if applicable
   - `pipeline_status`: per-step pass/fail/retry counts
   - `checks`: the evaluation check configuration used
   - `feedback`: design notes and any user interventions

> **Note for benchmark tasks**: Benchmarks often require a flat format where component names are top-level keys mapping to layer arrays (e.g., `{"mesa": [...], "contact_patch": [...], "bonding_pad": [...]}`). This differs from the general-purpose format above. Always follow the benchmark instruction's format specification.

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

- **Conda env:** `instrMCPdev` (has opencv, numpy, scipy, sklearn, shapely, gdstk)
- **Pixel coordinates:** image origin at top-left; KLayout uses center origin with Y-flip
- **Layer references:** always as `layer/datatype` (e.g., `11/0`)
- **Output directory:** defaults to source image directory if not specified
- **Sub-skill dispatch:** flakedetect and gdsalign sub-skills run as subagents reading their own SKILL.md
