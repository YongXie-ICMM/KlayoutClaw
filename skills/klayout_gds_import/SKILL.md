---
name: klayout_gds_import
description: Import a GDS file into the current KLayout layout, flatten hierarchy, and merge into a single top cell. Use this instead of raw Layout.read() which leaves orphaned cell indices and multi-top-cell states.
---

# klayout_gds_import — Safe GDS Import

Import a GDS file into the running KLayout session in a way that avoids the
well-known `Layout.read()` pitfalls documented in `CLAUDE.md`:

- Cell-name collisions between the destination layout and the imported GDS
  produce orphaned cell index slots (`cells()` reports N but `cell(N-1)` is
  invalid).
- After a name collision, `CellView.cell` may point at a destroyed cell,
  causing downstream crashes.
- Multi-top-cell states are confusing for downstream routing / evaluation
  tools that assume a single top cell.

This skill provides a single-shot importer that:

1. Reads the GDS into the current layout (or a fresh tab),
2. Flattens hierarchy so there are no subcells left,
3. Collapses any residual multi-top-cell state into a single top cell,
4. Rebinds `CellView.cell` to the resolved top, zooms to fit, and refreshes
   the layer panel.

## Parameters

| Parameter             | Type   | Default | Description                                                                                                                     |
| --------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `filepath`            | string | —       | **Required.** Absolute path to a `.gds` file on disk.                                                                          |
| `flatten`             | bool   | `true`  | If `true`, flatten all subcells into the top cell after reading (`cell.flatten(-1, True)`).                                   |
| `merge_into_current`  | bool   | `true`  | If `true`, merge the GDS shapes into the currently focused layout. If `false`, open a new tab via `mw.create_layout(1)` first. |

## Usage

From a shell with access to the KlayoutClaw MCP server:

```bash
python skills/klayout_gds_import/scripts/import_gds.py \
    --filepath /path/to/template.gds \
    --flatten \
    --merge-into-current
```

To import into a fresh tab (non-destructive to existing work):

```bash
python skills/klayout_gds_import/scripts/import_gds.py \
    --filepath /path/to/template.gds \
    --no-merge-into-current
```

### Return value

On success the script prints a JSON blob like:

```json
{"status": "ok", "top_cell": "TOP", "shapes_added": 1342}
```

On failure:

```json
{"status": "error", "error": "<message + traceback>"}
```

## Edge cases handled

- **Cell-name collisions** — the importer reads the GDS, then iterates all
  top cells via `each_top_cell()` (never `cell(i)` by index) to avoid the
  orphaned-slot crash documented in `CLAUDE.md`.
- **Multi-top-cell after import** — if `flatten=true` leaves more than one
  top cell, the importer picks the top cell with the **largest bbox** as the
  canonical top, moves shapes from the other top cells into it shape-by-shape
  via `shapes().each()` + `shapes().insert()`, and deletes the emptied cells.
- **Dangling `CellView.cell`** — after the read, the importer explicitly
  rebinds `cv.cell = <resolved_top>` before returning, matching the pattern in
  `CLAUDE.md` under "Dangling cv.cell after Layout.read()".
- **No destructive clear** — this skill never calls `Layout.clear()` when
  `merge_into_current=true`, so existing user geometry is preserved.
- **Image annotations** — preserved. Images live on the `LayoutView`, not the
  `Layout`, so a plain `read()` does not touch them.

## Reference

- Script: `scripts/import_gds.py`
- Uses: `skills/scripts/mcp_client.py` (shared MCP client)
- Related pitfalls: see `CLAUDE.md` sections on `Layout.read()` cell-name
  collisions and dangling `cv.cell`.
