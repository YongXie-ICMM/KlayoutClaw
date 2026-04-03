---
name: nanodevice_hallbar
description: Design Hall bar devices on van der Waals heterostructure flakes with adaptive geometry, physics-based constraints, and automated evaluation. Use this skill when the user wants to create a Hall bar mesa, place contacts, route leads, and evaluate the design on detected flake material regions.
---

# nanodevice_hallbar -- Hall Bar Device Design

Design a Hall bar device on van der Waals heterostructure flakes that have already been detected and committed to KLayout (via the nanodevice_flakedetect pipeline). The design is adaptive -- all dimensions derive from the actual flake geometry, not from fixed formulas.

**This is a pure-text skill.** There are no scripts. The agent uses `execute_script`, `get_layout_info`, `evaluate_design`, `save_layout`, and the `nanodevice_routing` skill to implement each step.

---

## Step 0: Query User

Before designing anything, gather these parameters from the user:

| Parameter | Example | Default | Notes |
|-----------|---------|---------|-------|
| Device type | "8-pin Hall bar" | 8-pin Hall bar | Current + voltage probes |
| Shape | "H-bar" | H-bar | Channel with perpendicular probes |
| Pin count | 8 | 8 | Total pins (2 current + 6 voltage typical) |
| Topgate? | yes / no | yes | Gate electrode covering channel |
| Backgate? | yes / no | yes | Contacts in graphite-only region |
| pixel_size | 0.087 um/px | 0.1 um/px | Microns per pixel (see guide below) |
| Layer assignments | mesa=20/0, contact=21/0 | See table below | Layer/datatype pairs |

### Pixel Size Guide

Pixel size depends on the microscope objective used to capture the source images:

| Objective | Typical pixel_size (um/px) |
|-----------|---------------------------|
| 100x | 0.05 or 0.087 |
| 50x | 0.1 |
| 20x | 0.25 |
| 10x | 0.5 |

If the user specifies an objective but not a pixel size, use the values above. Ask the user to confirm pixel_size before proceeding.

---

## Step 1: Analyze Material Regions

Use `get_layout_info` to identify which layers contain material contours (graphene on L11/0, graphite on L13/0, bottom_hBN on L10/0, top_hBN on L12/0).

Then use `execute_script` with `pya.Region` to compute the overlap between graphene and graphite:

```
graphene_region = pya.Region(top_cell.shapes(li_graphene))
graphite_region = pya.Region(top_cell.shapes(li_graphite))
overlap = graphene_region & graphite_region
```

Record the overlap bounding box -- this is where the mesa channel must sit. Also compute:
- **graphene-only region**: graphene minus graphite (for graphene contacts)
- **graphite-only region**: graphite minus graphene (for backgate contacts)

Take a screenshot to visually inspect the overlap region and plan the mesa orientation.

---

## Step 2: Design Mesa

The mesa consists of a channel (the Hall bar active region) and voltage probes extending from the channel. Together they form the characteristic H-bar shape.

**Physics rules** (adaptive to actual flake geometry):
- The channel must sit entirely within the graphene-graphite overlap region
- Probe arms extend perpendicular to the channel to provide voltage measurement points
- Channel length, width, and probe spacing all adapt to the overlap region dimensions
- Orient the channel along the longest axis of the overlap to maximize usable area
- The number of probes adapts to the pin count from Step 0

**Hard constraints:**
- Solidity must be less than 0.5 -- the mesa must be a non-convex H-bar shape, not a filled rectangle. Solidity = (mesa area) / (convex hull area); values below 0.5 confirm the shape has the required probe geometry
- The entire mesa must lie within the overlap region
- Place on the layer specified in Step 0 query (default 20/0)

The agent should visually inspect the overlap region via screenshot and design the mesa geometry accordingly. There are no hardcoded dimension formulas -- every dimension adapts to the available material.

---

## Step 3: Place Contacts

Place contact patches at the mesa probe tips and channel ends. Contact placement follows physics-based rules for each material region:

**Graphene contacts:**
- Place at each probe tip and at the two channel ends
- Each contact centroid must be in the graphene-only region (graphene minus graphite), not in the overlap
- Contact size adapts to probe width and available graphene area

**Backgate contacts:**
- Place in the graphite-only region (graphite minus graphene)
- Typically 2 contacts, positioned where graphite extends beyond the graphene boundary
- Contact size adapts to available graphite area

**Hard constraints:**
- Every contact centroid must lie within its designated single-material region
- All contacts must be within 2 um of the mesa edge
- Place contacts on the layer from Step 0 query (default 21/0)

---

## Step 4: Place Topgate

If the user requested a topgate (Step 0), place a gate electrode that covers the channel region.

**Physics rules:**
- The topgate must cover the channel to gate the 2DEG (two-dimensional electron gas)
- Topgate size adapts to channel geometry -- it should extend slightly beyond the channel width but not cover the probe arms
- The topgate must be electrically isolated from contact routes to prevent shorting

**Hard constraints:**
- Topgate must intersect the mesa channel area (coverage check)
- Topgate must not overlap with contact route layers (isolation check)
- Place on topgate layer (default 22/0)

---

## Step 5: Place Pin Markers

Place pin markers for routing. Each device contact needs a source pin (Pin_A) and each bonding pad needs a destination pin (Pin_B).

- **Pin_A** on layer 100/0: place at each contact patch centroid (source for routing)
- **Pin_B** on layer 101/0: place at nearest available bonding pad centroid (destination for routing)

Pin assignment uses greedy nearest-first matching: for each Pin_A, find the closest unassigned pad and place a Pin_B there. Each pad is used at most once.

**Hard constraint:** Pin_A count must equal Pin_B count.

---

## Step 6: Route

Use the `nanodevice_routing` skill to connect device contacts to bonding pads:

1. Run `place_pads.py` if bonding pads are not already present
2. Run `route_multiwindow.py` with appropriate parameters:
   - Inner window: fine routes from contacts to boundary (default 0.5 um width)
   - Outer window: coarse routes from boundary to pads (default 1.0 um width)
3. If routing fails for some pairs, use the manual L-shaped route fallback described in the nanodevice_routing skill

---

## Step 7: DRC

Run design rule checking via the `evaluate_design` tool:

```
evaluate_design with mode=drc
```

This checks geometric constraints: minimum spacing, overlap violations, layer integrity, contact placement validity, and topgate isolation.

If any DRC check fails, identify the failing component and re-run the corresponding design step (Step 2-5). Maximum 2 retries per step.

---

## Step 8: Evaluate

Run design scoring via the `evaluate_design` tool:

```
evaluate_design with mode=score
```

This produces a composite score (0.0 to 1.0) across all design metrics: mesa geometry, contact placement, topgate coverage, routing completeness, and DRC compliance.

- If score >= 0.80, proceed to Step 9
- If score < 0.80, identify the lowest-scoring metric and iterate on that component. Maximum 2 iterations. If the score remains below 0.80 after iterations, stop and report the failure with diagnostic information.

---

## Step 9: Save

Save the completed design:

1. Call `save_layout` to write the GDS file (e.g., `result.gds`)
2. Write `result.json` containing:
   - `layer_map`: mapping of component names to layer/datatype pairs used
   - `score`: final evaluate_design score
   - `pixel_size`: the pixel_size used
   - `device_type`: the device type from Step 0
   - `feedback`: any notes on design decisions or limitations

---

## Layer Convention Table

| Component | Layer | Datatype | Purpose |
|-----------|-------|----------|---------|
| Mesa | 20 | 0 | Hall bar channel + probes |
| Contact patch | 21 | 0 | Contact regions |
| Topgate | 22 | 0 | Gate electrode |
| Fine routes | 3 | 0 | Inner EBL window routes |
| Coarse routes | 4 | 0 | Outer EBL window routes |
| Boundary patches | 6 | 0 | EBL window connection patches |
| Bonding pads | 2 | 0 | Bond pad array |
| Markers | 5 | 0 | Alignment markers (from template, read-only) |
| Graphene (ref) | 11 | 0 | Detected graphene contour |
| Top hBN (ref) | 12 | 0 | Detected top hBN contour |
| Graphite (ref) | 13 | 0 | Detected graphite contour |
| Bottom hBN (ref) | 10 | 0 | Detected bottom hBN contour |
| Pin_A (contacts) | 100 | 0 | Temporary routing source pins |
| Pin_B (pads) | 101 | 0 | Temporary routing destination pins |

---

## Design Philosophy

This skill encodes physics-based design rules, not rigid recipes. Every dimension adapts to the actual flake geometry discovered in Step 1. The evaluator (Steps 7-8) provides the hard constraints -- the agent's job is to produce a design that satisfies those constraints while making intelligent use of the available material regions. No two devices will have the same dimensions, because no two flakes have the same shape.
