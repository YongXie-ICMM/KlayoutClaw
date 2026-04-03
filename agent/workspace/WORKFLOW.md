# Device Design Workflow

## Phase 0: Query
- Parse the user's request to identify device type, materials, and constraints
- Determine if this is a new design or modification of an existing layout
- Identify which pipeline steps are needed (flake detection, GDS alignment, hallbar design, routing)
- Validate pixel_size if microscope images are involved
- **Entry criteria:** User describes a design task
- **Exit criteria:** Device type, materials, and pipeline steps identified
- **Key tools:** `klayout_native_validate_pixel_size`

## Hallbar Design Constraints Summary
- Mesa solidity must be < 0.5 (ensures Hall bar shape, not a filled rectangle)
- Contacts must be placed in single-material regions (no overlap between materials)
- Topgate must have isolation gap from mesa edges and contacts
- Channel length/width ratio should be appropriate for transport measurements
- All dimensions are adaptive, derived from actual flake geometry

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
- Run `klayout_native_evaluate_design` to assess design quality metrics
- Check solidity, contact placement, topgate isolation, and overall geometry
- If evaluation fails, iterate: adjust geometry, re-evaluate, repeat
- The evaluate -> iterate loop continues until all metrics pass or maximum retries reached
- **Entry criteria:** Design geometry complete (Phase 2 or Phase 3 done)
- **Exit criteria:** All evaluation metrics pass
- **Key tools:** `klayout_native_evaluate_design`, `klayout_native_screenshot`
