# Tool Usage Guide

## Native KLayout Tools (klayout_native_*)

| Tool | Use When |
|------|----------|
| `klayout_native_create_layout` | Starting a new design — creates layout + top cell |
| `klayout_native_execute_script` | Running arbitrary pya code for custom operations |
| `klayout_native_save_layout` | Saving design as GDS2 or OASIS file |
| `klayout_native_get_layout_info` | Checking layout state (cells, layers, dbu) |
| `klayout_native_screenshot` | Capturing viewport for visual review |
| `klayout_native_auto_route` | Autorouting pin pairs (subprocess, heavy computation) |
| `klayout_native_evaluate_design` | Evaluate hall bar design quality (solidity, contacts, isolation) |
| `klayout_native_validate_pixel_size` | Validate pixel_size against known objectives (0.05, 0.087, 0.1, 0.25, 0.5) |

### get_layout_info per-layer output

`klayout_native_get_layout_info` returns per-layer shape count information, including the layer number, datatype, and shape count for each layer in the layout. Use this to verify geometry placement after design steps.

## Domain Tools (klayout_{group}_*)

### Geometry (klayout_geometry_*)
- `add_rect` — rectangles (mesa, pads, gates)
- `add_polygon` — arbitrary polygons (device outlines, custom shapes)
- `add_path` — paths with width (leads, traces)
- `create_cell` — new cells (device, routing, markers)
- `add_instance` — place cell instances (hierarchical design)

### Display (klayout_display_*)
- `toggle_layer` — show/hide individual layers
- `show_only` — isolate specific layers for inspection

### Image (klayout_image_*)
- `add_image` — load microscope photos as background overlays
- `list_images` — list loaded background images
- `remove_image` — remove a background image

### Visual (klayout_visual_*)
- `capture` — capture layout as PNG for review

### Nanodevice (klayout_nanodevice_*)
- `flakedetect_*` — van der Waals stack detection from microscope images
- `gdsalign_*` — align microscope images to GDS templates
- `routing_*` — place bonding pads and route leads

## Memory Tools
- `memory_save` — persist knowledge, procedures, preferences, or daily log
- `memory_search` — search persistent memory across all categories

## Coordinate System
- All coordinates are in **microns** (um)
- KLayout uses integer database units internally: `int(um / dbu)`
- Default dbu = 0.001 um (1 nm)
- Origin is at (0, 0); positive X is right, positive Y is up
