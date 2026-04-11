#!/usr/bin/env python
"""Import a GDS file into the current KLayout layout.

Avoids the ``Layout.read()`` pitfalls documented in CLAUDE.md:

- Cell-name collisions → orphaned cell indices.
- Dangling ``CellView.cell`` after read.
- Multi-top-cell states after merging.

Flattens hierarchy and collapses any residual multi-top-cell state into a
single top cell (the one with the largest bounding box).

Usage:
    python import_gds.py --filepath /abs/path/to.gds [--flatten] \
        [--no-flatten] [--merge-into-current] [--no-merge-into-current]

Prints a JSON result to stdout:
    {"status": "ok", "top_cell": "TOP", "shapes_added": 1234}
or
    {"status": "error", "error": "..."}
"""

import argparse
import json
import os
import sys
import traceback

# Locate skills/scripts/mcp_client.py (two levels up from this file, then
# into ``scripts/``). Matches the pattern used by other KlayoutClaw skills
# (e.g. skills/geometry/scripts/add_rect.py).
sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts"),
)
from mcp_client import init_session, execute_script  # noqa: E402


# pya code executed inside KLayout. We template in only three values so
# quoting stays simple: filepath, flatten (bool), merge (bool).
_PYA_TEMPLATE = r"""
import traceback as _tb

try:
    _view, _layout, _top = _get_or_create_view()
    _mw = pya.Application.instance().main_window()

    _filepath = {filepath!r}
    _flatten = {flatten}
    _merge = {merge}

    if not _merge:
        # Open a fresh tab (non-destructive) and re-grab handles.
        _mw.create_layout(1)
        _view = _mw.current_view()
        _cv = _view.active_cellview()
        _layout = _cv.layout()

    # Count shapes pre/post so we can report shapes_added.
    def _total_shapes(lay):
        _n = 0
        for _c in lay.each_cell():
            for _li in lay.layer_indices():
                _n += _c.shapes(_li).size()
        return _n

    _before = _total_shapes(_layout)

    # The actual GDS read. Any cell-name collision now risks leaving orphaned
    # index slots behind; we will walk via each_cell() / each_top_cell() so
    # indexed access never happens.
    _layout.read(_filepath)

    # Collect top cells via iterator (never by direct index on _layout).
    # ``each_top_cell()`` yields cell *indices*; resolve via ``cell()`` which
    # accepts indices safely even when the layout has orphaned slots from a
    # colliding read.
    def _collect_tops(lay):
        _out = []
        for _ci in lay.each_top_cell():
            try:
                _c = lay.cell(_ci)
            except Exception:
                _c = None
            if _c is not None:
                _out.append(_c)
        return _out

    _tops = _collect_tops(_layout)

    if not _tops:
        raise RuntimeError("No top cell after GDS read")

    if _flatten:
        for _c in list(_tops):
            # flatten(levels=-1, prune=True) — collapse all hierarchy, drop
            # now-empty subcells.
            try:
                _c.flatten(-1, True)
            except Exception:
                _c.flatten(True)
        # Re-collect top cells post-flatten in case prune exposed new ones.
        _tops = _collect_tops(_layout)

    # Collapse multi-top-cell state into the largest-bbox top.
    def _bbox_area(c):
        try:
            _b = c.bbox()
            return max(0, _b.width()) * max(0, _b.height())
        except Exception:
            return 0

    _tops.sort(key=_bbox_area, reverse=True)
    _canonical = _tops[0]

    if len(_tops) > 1:
        for _other in _tops[1:]:
            # Move shapes layer by layer into the canonical top.
            for _li in _layout.layer_indices():
                _dst = _canonical.shapes(_li)
                _src = _other.shapes(_li)
                for _sh in _src.each():
                    _dst.insert(_sh)
                _src.clear()
            # Prune the emptied cell. If it still has instances (shouldn't
            # after flatten), leave it and continue — do not crash.
            try:
                _layout.delete_cell(_other.cell_index())
            except Exception:
                pass

    # Rebind the CellView to the resolved top so downstream code never sees
    # a dangling cv.cell pointer (CLAUDE.md: "Dangling cv.cell after read").
    _cv = _view.active_cellview()
    _cv.cell = _canonical
    try:
        _view.max_hier()
    except Exception:
        pass
    try:
        _view.zoom_fit()
    except Exception:
        pass

    _refresh_view()

    _after = _total_shapes(_layout)
    result = {{
        "status": "ok",
        "top_cell": _canonical.name,
        "shapes_added": max(0, _after - _before),
    }}
except Exception as _e:
    result = {{
        "status": "error",
        "error": "{{}}: {{}}\n{{}}".format(type(_e).__name__, _e, _tb.format_exc()),
    }}
"""


def _build_pya_code(filepath: str, flatten: bool, merge_into_current: bool) -> str:
    return _PYA_TEMPLATE.format(
        filepath=filepath,
        flatten="True" if flatten else "False",
        merge="True" if merge_into_current else "False",
    )


def _parse_args(argv):
    p = argparse.ArgumentParser(
        description="Import a GDS file into the current KLayout layout "
        "(flatten + single-top-cell).",
    )
    p.add_argument("--filepath", required=True, help="Absolute path to .gds file")
    p.add_argument(
        "--flatten",
        dest="flatten",
        action="store_true",
        default=True,
        help="Flatten hierarchy into top cell (default: true)",
    )
    p.add_argument(
        "--no-flatten",
        dest="flatten",
        action="store_false",
        help="Do not flatten hierarchy",
    )
    p.add_argument(
        "--merge-into-current",
        dest="merge_into_current",
        action="store_true",
        default=True,
        help="Merge into currently focused layout (default: true)",
    )
    p.add_argument(
        "--no-merge-into-current",
        dest="merge_into_current",
        action="store_false",
        help="Open a new tab instead of merging into current",
    )
    return p.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)

    filepath = os.path.abspath(os.path.expanduser(args.filepath))
    if not os.path.exists(filepath):
        print(json.dumps({
            "status": "error",
            "error": f"GDS file not found: {filepath}",
        }))
        return 1

    code = _build_pya_code(filepath, args.flatten, args.merge_into_current)

    try:
        init_session()
        result = execute_script(code)
    except RuntimeError as e:
        # mcp_client now raises RuntimeError on connect failure; surface it
        # as a structured error instead of a traceback.
        print(json.dumps({"status": "error", "error": str(e)}))
        return 2
    except Exception as e:
        print(json.dumps({
            "status": "error",
            "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}",
        }))
        return 2

    # execute_script returns the result dict directly (tool_call unwraps).
    print(json.dumps(result))
    if isinstance(result, dict) and result.get("status") == "ok":
        return 0
    return 3


if __name__ == "__main__":
    sys.exit(main())
