# Device Design Workflow

## Phase 0: Query
- Parse the user's request to identify device type, materials, and constraints
- Determine if this is a new design or modification of an existing layout
- Identify which pipeline steps are needed (flake detection, GDS alignment, device design, routing)
- Validate pixel_size if microscope images are involved
- **Entry criteria:** User describes a design task
- **Exit criteria:** Device type, materials, and pipeline steps identified
- **Key tools:** `klayout_native_validate_pixel_size`

## Design Constraints Summary
- Device-specific constraints are derived from physics knowledge and RULES.md — no universal shape rules apply to all devices
- Contacts must be placed in single-material regions appropriate to the device type
- Isolation gaps (gates vs. contacts/mesa) must respect device physics and fabrication limits
- All dimensions are adaptive, derived from actual flake geometry or user-specified constraints

## Phase 1: Plan
- Understand the target device (type, materials, dimensions)
- Scout existing layout (if any) via `klayout_native_get_layout_info`
- Design geometry plan with layer assignments
- Validate against fabrication constraints (RULES.md)
- **Entry criteria:** User describes target device
- **Exit criteria:** Design plan documented, user approves
- **Key tools:** `klayout_native_get_layout_info`, `klayout_native_screenshot`

## Phase 2: Design
- Create layout via `klayout_native_create_layout`
- Build device geometry using `klayout_geometry_*` tools
- Place alignment markers on L5/0
- Define pin positions for routing
- Visual review with `klayout_native_screenshot`
- **Entry criteria:** Approved design plan
- **Exit criteria:** All geometry placed, pins defined, visual review passed
- **Key tools:** `klayout_geometry_add_rect`, `klayout_geometry_add_polygon`, `klayout_geometry_create_cell`

## Phase 3: Interact
- Place bonding pads via `klayout_nanodevice_routing_place_pads`
- Route leads: inner fine + outer coarse + boundary patches
- Validate routing (no overlaps, all pins connected)
- Save final GDS via `klayout_native_save_layout`
- **Entry criteria:** Device geometry complete with pins
- **Exit criteria:** All pins routed, GDS saved
- **Key tools:** `klayout_native_auto_route`, `klayout_native_save_layout`

## Phase 4: Evaluate and Iterate
- Compose a check list appropriate for the device type (containment, adjacency, solidity, isolation, connectivity, spacing, etc.)
- Run `klayout_native_evaluate_design` with the composed checks and `layer_map`
- Review per-check scores; if overall score < 0.80, identify the lowest-scoring check and iterate on the corresponding geometry
- Maximum 2 retries; stop and report to the user if not resolved
- Visual review with `klayout_native_screenshot` after each iteration
- **Entry criteria:** Design geometry complete (Phase 2 or Phase 3 done)
- **Exit criteria:** Overall evaluation score >= 0.80 and visual inspection passes
- **Key tools:** `klayout_native_evaluate_design`, `klayout_native_screenshot`
