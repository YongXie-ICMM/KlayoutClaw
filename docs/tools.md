# KlayoutClaw MCP Tool Reference (v0.6)

All tools are called via MCP `tools/call` method over HTTP POST to `http://127.0.0.1:8765/mcp`.

All coordinates are in **microns**. The database unit (dbu) defaults to 0.001.

**8 tools:** create_layout, execute_script, save_layout, get_layout_info, screenshot, auto_route, evaluate_design, validate_pixel_size

---

## create_layout

Create a new layout with a top cell.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | no | "TOP" | Name of the top cell |
| `dbu` | number | no | 0.001 | Database unit in microns |

**Returns:** `{"status": "ok", "top_cell": "TOP", "dbu": 0.001}`

---

## execute_script

Execute arbitrary Python/pya code in KLayout. The view is refreshed automatically after execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | string | yes | Python code to execute |

**Namespace:** The code runs with these pre-injected names:
- `pya` — KLayout Python API
- `json`, `os` — standard library modules
- `_layout` — current `pya.Layout` (may be `None`)
- `_layout_view` — current `pya.LayoutView` (may be `None`)
- `_top_cell` — current top `pya.Cell` (may be `None`)
- `_get_or_create_view()` — ensures a view/layout/top_cell exist, returns `(_layout_view, _layout, _top_cell)`
- `_refresh_view()` — updates GUI layer panel + zoom

**Returning data:** Set the `result` variable to return data to the caller. It will be JSON-serialized. If `result` is not set, `{"status": "ok"}` is returned.

### Examples

**Add a rectangle:**
```python
dbu = _layout.dbu
li = _layout.layer(1, 0)
box = pya.Box(int(-50/dbu), int(-12.5/dbu), int(50/dbu), int(12.5/dbu))
_top_cell.shapes(li).insert(box)
```

**Create a cell and add instances:**
```python
sub = _layout.create_cell("SUB")
dbu = _layout.dbu
li = _layout.layer(1, 0)
sub.shapes(li).insert(pya.Box(0, 0, int(10/dbu), int(10/dbu)))
trans = pya.Trans(pya.Point(int(20/dbu), int(30/dbu)))
_top_cell.insert(pya.CellInstArray(sub.cell_index(), trans))
```

**Add a polygon:**
```python
dbu = _layout.dbu
li = _layout.layer(1, 0)
pts = [pya.Point(int(x/dbu), int(y/dbu)) for x, y in [(0,0), (10,0), (10,10), (0,10)]]
_top_cell.shapes(li).insert(pya.Polygon(pts))
```

**Add a path:**
```python
dbu = _layout.dbu
li = _layout.layer(1, 0)
pts = [pya.Point(int(x/dbu), int(y/dbu)) for x, y in [(0,0), (50,0), (50,50)]]
_top_cell.shapes(li).insert(pya.Path(pts, int(5/dbu)))
```

**Query cells and layers:**
```python
cells = []
for ci in range(_layout.cells()):
    c = _layout.cell(ci)
    if c is not None:
        cells.append(c.name)
result = {"cells": cells, "num_layers": len(list(_layout.layer_indices()))}
```

---

## save_layout

Save the current layout to a file.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `filepath` | string | yes | | Output file path |
| `format` | string | no | "GDS2" | File format: "GDS2" or "OASIS" |

**Returns:** `{"status": "ok", "filepath": "/path/to/output.gds", "format": "GDS2"}`

---

## get_layout_info

Get summary information about the current layout. No parameters.

**Returns:**
```json
{
  "status": "ok",
  "dbu": 0.001,
  "num_cells": 1,
  "cells": ["HALLBAR"],
  "num_layers": 3
}
```

---

## screenshot

Capture the current KLayout viewport as a PNG image. Returns exactly what the user sees, including layer colors, zoom level, and visibility settings.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `filepath` | string | no | `/tmp/klayoutclaw_screenshot.png` | Output PNG file path |
| `width` | integer | no | 1024 | Image width in pixels |
| `height` | integer | no | 768 | Image height in pixels |

**Returns:** `{"status": "ok", "filepath": "/tmp/klayoutclaw_screenshot.png", "width": 1024, "height": 768}`

**Notes:**
- Uses `pya.LayoutView.save_image()` — captures the actual viewport, not a re-render
- Preserves current zoom, pan, layer visibility, and color settings
- No external dependencies required

---

## auto_route

Automatically route connections between pin pairs using cost-based pathfinding. Extracts pins from two layers, uses Hungarian matching for optimal pairing, then minimum-cost pathfinding (Dijkstra on a raster grid) to create routes avoiding obstacles.

Runs routing computation in a subprocess (`tools/route_worker.py`) using numpy, scipy, and scikit-image. Requires these packages in a conda environment (default: `instrMCPdev`).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pin_layer_a` | string | yes | | Layer with start pins (e.g. "102/0") |
| `pin_layer_b` | string | yes | | Layer with end pins (e.g. "111/0") |
| `obstacle_layers` | string[] | no | [] | Layers to avoid (e.g. ["1/0", "3/0"]) |
| `output_layer` | string | no | "10/0" | Layer for routed paths |
| `path_width` | number | no | 10.0 | Path width in microns |
| `obs_safe_distance` | number | no | 5.0 | Min distance from obstacles (um) |
| `path_safe_distance` | number | no | 5.0 | Min distance between paths (um) |
| `map_resolution` | number | no | 2.0 | Grid resolution in microns |
| `conda_env` | string | no | "instrMCPdev" | Conda env with routing deps |
| `python_path` | string | no | | Path to python binary (overrides conda_env) |

**Advanced tuning parameters** (passed through to `route_worker.py` config JSON — not exposed in MCP tool schema, but can be added to the config directly):

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `obs_hardness` | number | 20.0 | Max cost at obstacle boundary (higher = paths stay further) |
| `obs_damping_step` | int | 4 | Gradient steps for obstacle avoidance field |
| `pin_safe_distance_a_um` | number | 5.0 | Avoidance halo radius around Pin A shapes (um) |
| `pin_safe_distance_b_um` | number | 5.0 | Avoidance halo radius around Pin B shapes (um) |
| `pin_hardness` | number | 20.0 | Max cost at pin halo boundary |
| `pin_damping_step` | int | 4 | Gradient steps for pin avoidance fields |
| `path_hardness` | number | 10.0 | Max cost near previously routed paths |
| `path_damping_step` | int | 5 | Gradient steps for path avoidance fields |
| `sort_pairs` | bool | true | Route shortest pairs first (improves success rate) |

**Returns:**
```json
{
  "status": "success",
  "routed_pairs": 8,
  "total_pins_a": 8,
  "total_pins_b": 8,
  "output_layer": "10/0",
  "path_width_um": 10.0,
  "errors": []
}
```

**Algorithm:**
1. Save current layout to temp GDS
2. Extract pin centers from shapes on pin_layer_a and pin_layer_b
3. Build obstacle region from obstacle_layers (raw shapes, no pre-expansion)
4. Rasterize obstacles into a 2D cost grid using `kdb.Region.rasterize()` (resolution = map_resolution)
5. Apply graduated damping fields around obstacles (stepped cost gradient within obs_safe_distance)
6. Mark all pins as impassable with their own damping halos (asymmetric per pin set)
7. Hungarian matching (scipy) finds optimal pin pairings, sorted by distance (shortest first)
8. For each pair: temporarily recover pin cells, find minimum-cost path via MCP_Geometric (scikit-image), mark path as impassable with damping, re-block pins
9. Paths compressed (collinear points removed) and inserted as pya.Path objects

**Dependencies (subprocess):** numpy, scipy, scikit-image, klayout (standalone package)

---

## evaluate_design

Evaluate a device design against configurable geometric quality checks. Runs `tools/evaluate_worker.py` as a subprocess. Accepts a list of check primitives with per-check weights. Returns per-check scores and a weighted overall score.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `checks` | array | yes | | List of check objects: `[{name, args, weight}]`. See primitives below. |
| `layer_map` | object | yes | | Map of component names to `[layer, datatype]` arrays. Keys are referenced by check args. |
| `reference_gds` | string | no | | Path to reference GDS (for checks that need reference layers) |
| `python_path` | string | no | | Path to python binary with gdstk/shapely/numpy (overrides `conda_env`) |
| `conda_env` | string | no | `"base"` | Conda environment with gdstk/shapely/numpy |

**Returns:**
```json
{
  "status": "ok",
  "overall": 0.8234,
  "checks": [
    {"name": "component_containment", "score": 0.95, "weight": 0.2, "detail": "component_containment: 0.9500"},
    {"name": "contact_isolation", "score": 1.0, "weight": 0.15, "detail": "contact_isolation: 1.0000"}
  ]
}
```

**Available check primitives (8):**
- `component_overlap` — fraction of component area overlapping with region
- `component_containment` — fraction of component area contained within region
- `contact_isolation` — route crossing check with junction-aware detection and steep penalty curve
- `connectivity` — fraction of contacts that reach a bonding pad
- `route_endpoints` — fraction of route endpoints on valid targets
- `adjacency` — fraction of A shapes within tolerance of B
- `solidity` — shape solidity above/below threshold
- `spacing` — fraction of component pairs meeting minimum distance

The `region` arg can be a single `layer_map` key or a list of keys combined via `region_op` (union, intersection, difference).

**Dependencies (subprocess):** gdstk, shapely, numpy

---

## validate_pixel_size

Validate a microscope pixel size value and optionally compute marker spacing from a GDS template. Returns validity, likely objective mapping, warnings, and marker spacing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pixel_size` | number | yes | Pixel size in microns per pixel |
| `template_gds` | string | no | Path to a GDS file with L5/0 alignment markers |
| `image_path` | string | no | Path to a microscope image for reference |

**Returns:**
```json
{
  "status": "ok",
  "valid": true,
  "pixel_size": 0.087,
  "likely_objective": "100x",
  "warnings": [],
  "marker_spacing_um": 200.0
}
```

- `valid` — `true` if pixel_size is within range [0.01, 2.0] um/px
- `likely_objective` — nearest matching objective magnification
- `warnings` — list of warning strings (empty if no issues)
- `marker_spacing_um` — spacing between L5/0 markers in microns (null if no `template_gds` provided)

**Known pixel_size values:**

| Objective | pixel_size (um/px) |
|-----------|--------------------|
| 100x | 0.05 |
| 100x (alt) | 0.087 |
| 50x | 0.1 |
| 20x | 0.25 |
| 10x | 0.5 |
