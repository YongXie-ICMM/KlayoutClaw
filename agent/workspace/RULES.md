# Design Rules & Constraints

## Minimum Feature Sizes
- Inner EBL window: 0.1 um minimum feature
- Outer EBL window: 0.5 um minimum feature
- Bonding pad minimum: 80 x 80 um

## Layer Assignments

> **Layer Assignments**: Layer assignments are **task-specific**. Always read the task instruction for correct layers. The table below is an EXAMPLE ONLY — benchmark tasks often use different layers.

| Layer | Purpose (example) |
|-------|-------------------|
| 1/0 | (example) Mesa / active area |
| 2/0 | (example) Bottom gate |
| 3/0 | (example) Top gate |
| 4/0 | (example) Contact / ohmic |
| 5/0 | (example) Alignment markers |
| 6/0 | (example) Bonding pads |
| 10/0 | (example) Inner EBL write field |
| 11/0 | (example) Outer EBL write field |

## Fabrication Safety
- No overlapping geometry on the same layer
- All pins must be connected after routing
- Bonding pads must fit within the write field
- Alignment markers must be on L5/0 and placed in pairs
- GDS file size should be reasonable (< 50 MB)

## Spacing Rules
- Minimum spacing between features on same layer: 0.1 um (inner), 0.5 um (outer)
- Minimum pad-to-pad spacing: 50 um
- Lead routing safe distance: 5 um (default), increase for dense fan-out

## Pixel Size Validation
- Always validate pixel_size before running alignment or image-based pipelines
- Use `klayout_native_validate_pixel_size` to confirm against known objective values
- Common valid values: 0.05, 0.087, 0.1, 0.25, 0.5 um/px
- Incorrect pixel_size causes marker detection failures and incorrect transforms

## Device-Specific Geometry Constraints (Example: Hall Bar)
These constraints apply specifically to Hall bar designs. For other device types, the agent derives equivalent constraints from physics knowledge.
- **Solidity < 0.5**: The mesa must have solidity below 0.5 — a proper Hall bar shape with arms, not a filled rectangle
- **Contacts in single-material regions**: Each contact must lie entirely within a single material boundary (e.g., only graphene, not overlapping graphene + hBN)
- **Topgate isolation**: The topgate must maintain an isolation gap from mesa edges and contact regions to prevent shorts; topgate should not overlap or touch contacts

## Design Hierarchy
- Use cells for repeated structures (pads, markers)
- Top cell contains all device geometry and cell instances
- Keep hierarchy shallow (max 3 levels)
