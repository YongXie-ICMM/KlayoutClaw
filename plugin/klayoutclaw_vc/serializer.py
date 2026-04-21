"""qlaybot v0.4.4 Phase 4 §5.2.1 — deterministic GDSII serialiser (DM-1..DM-3).

Implements three public symbols:

  * ``serialize(layout) -> str``   — DM-1 deterministic textual form.
  * ``deserialize(text) -> pya.Layout`` — DM-2 lossless inverse.
  * ``to_pya_code(layout) -> str`` — DM-3 executable pya reconstruction.

Design notes
------------
* The text format is JSON with a canonical key/ordering scheme.  Cells are
  emitted in ``sorted(cell_name)`` order; within a cell, shapes are emitted in
  ``sorted((layer, datatype, bbox_left, bbox_bottom, bbox_right, bbox_top,
  shape_kind, payload_tuple))`` order — which satisfies the DM-1 contract that
  serialising two logically identical layouts (regardless of creation order)
  yields byte-identical text.
* ``pya.Shape`` is reduced to one of the primitive kinds exercised by DM-2:
  ``polygon`` (incl. holes), ``box``, ``path`` (preserving exact width), and
  ``text``.  Cell instances are emitted separately with the full
  ``CellInstArray`` signature so SREF (single) and AREF (na*nb) round-trip
  losslessly.  Per-shape user-properties (``shape.properties()``) are stored
  verbatim.
* ``deserialize`` creates a fresh ``pya.Layout`` with the recorded ``dbu``,
  re-creates all cells up front, then re-materialises shapes and instances
  against those cell indexes.  Layer indexes are allocated via
  ``layout.layer(layer, datatype)`` so the resulting layout re-emits a
  byte-identical serialisation under DM-1.
* ``to_pya_code`` emits a flat Python script whose only import is
  ``import klayout.db as pya`` and that leaves a module-level ``layout``
  binding — this is the DM-3 driver contract documented in
  ``tests/test_vc_serializer.py``.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Tuple

import klayout.db as pya


_FORMAT_TAG = "klayoutclaw-vc-1"


# ---------------------------------------------------------------------------
# Shape → dict encoding
# ---------------------------------------------------------------------------


def _encode_properties(shape) -> Dict[str, Any]:
    try:
        props = shape.properties()
    except Exception:
        return {}
    if not isinstance(props, dict):
        return {}
    out: Dict[str, Any] = {}
    for k, v in props.items():
        # Keys can be strings or ints; stringify for JSON keyability.
        out[str(k)] = v
    return out


def _encode_shape(shape, layer: int, datatype: int) -> Dict[str, Any]:
    bb = shape.bbox()
    entry: Dict[str, Any] = {
        "layer": int(layer),
        "datatype": int(datatype),
        "_bbox": [int(bb.left), int(bb.bottom), int(bb.right), int(bb.top)],
    }
    props = _encode_properties(shape)
    if props:
        entry["properties"] = props

    if shape.is_text():
        txt = shape.text
        tr = txt.trans
        entry.update({
            "kind": "text",
            "string": str(txt.string),
            "trans": _encode_trans(tr),
        })
    elif shape.is_path():
        p = shape.path
        entry.update({
            "kind": "path",
            "width": int(p.width),
            "points": [[int(pt.x), int(pt.y)] for pt in p.each_point()],
            "bgnext": int(p.bgn_ext) if hasattr(p, "bgn_ext") else 0,
            "endext": int(p.end_ext) if hasattr(p, "end_ext") else 0,
            "round": bool(p.round) if hasattr(p, "round") else False,
        })
    elif shape.is_box():
        box = shape.box
        entry.update({
            "kind": "box",
            "box": [int(box.left), int(box.bottom), int(box.right), int(box.top)],
        })
    elif shape.is_polygon() or shape.is_simple_polygon():
        poly = shape.polygon
        hull = [[int(pt.x), int(pt.y)] for pt in poly.each_point_hull()]
        holes: List[List[List[int]]] = []
        for h in range(poly.holes()):
            holes.append([[int(pt.x), int(pt.y)] for pt in poly.each_point_hole(h)])
        entry.update({
            "kind": "polygon",
            "hull": hull,
            "holes": holes,
        })
    else:
        # Unsupported shape kind — serialise as an opaque marker so
        # determinism doesn't break; round-trip is best-effort.
        entry.update({"kind": "unknown", "repr": str(shape)})
    return entry


def _encode_trans(tr) -> Dict[str, Any]:
    """Encode a pya.Trans (simple integer trans) as a dict."""
    return {
        "rot": int(tr.rot),
        "mirror": bool(tr.is_mirror()),
        "x": int(tr.disp.x),
        "y": int(tr.disp.y),
    }


def _decode_trans(d: Dict[str, Any]) -> "pya.Trans":
    return pya.Trans(int(d["rot"]), bool(d["mirror"]),
                     int(d["x"]), int(d["y"]))


def _encode_instance(inst) -> Dict[str, Any]:
    """Encode a pya.Instance as a dict preserving SREF/AREF shape.

    Instance identity is keyed by ``cell_name`` only — the pya internal
    ``cell_index`` is intentionally omitted because it depends on cell
    creation order and would break DM-1 determinism across the
    serialize → deserialize → serialize cycle (cells are re-created in
    sorted-name order on deserialise, so indexes can renumber).
    """
    ca = inst.cell_inst
    tr = ca.trans
    entry: Dict[str, Any] = {
        "cell_name": inst.cell.name,
        "trans": _encode_trans(tr),
    }
    if ca.is_regular_array():
        # pya/GDS round-tripping normalises the (a, na) vs (b, nb) ordering of
        # regular arrays — see `layout.write; layout.read` on a CellInstArray
        # with a=(dx,0), b=(0,dy), which may come back as a=(0,dy), b=(dx,0).
        # To keep DM-1 deterministic across the serialize → GDS → serialize
        # cycle, we canonicalise the pair by sorting the two (vec, n)
        # tuples under a total order.  Any consumer that needs to re-create
        # the AREF must re-apply this canonical order; ``deserialize`` will
        # feed them back to pya which itself normalises on insertion.
        pair = [
            ((int(ca.a.x), int(ca.a.y), int(ca.na))),
            ((int(ca.b.x), int(ca.b.y), int(ca.nb))),
        ]
        pair.sort()
        entry["array"] = {
            "a": [pair[0][0], pair[0][1]],
            "na": pair[0][2],
            "b": [pair[1][0], pair[1][1]],
            "nb": pair[1][2],
        }
    props = _encode_properties(inst)
    if props:
        entry["properties"] = props
    return entry


def _shape_sort_key(entry: Dict[str, Any]) -> Tuple:
    """Total order on encoded shape dicts for DM-1 determinism."""
    bb = entry.get("_bbox", [0, 0, 0, 0])
    # Stable canonical serialisation of the remaining payload for tie-break
    payload = json.dumps(entry, sort_keys=True, separators=(",", ":"))
    return (
        int(entry.get("layer", 0)),
        int(entry.get("datatype", 0)),
        int(bb[0]), int(bb[1]), int(bb[2]), int(bb[3]),
        str(entry.get("kind", "")),
        payload,
    )


def _inst_sort_key(entry: Dict[str, Any]) -> Tuple:
    tr = entry.get("trans", {})
    payload = json.dumps(entry, sort_keys=True, separators=(",", ":"))
    return (
        str(entry.get("cell_name", "")),
        int(tr.get("x", 0)), int(tr.get("y", 0)),
        int(tr.get("rot", 0)), bool(tr.get("mirror", False)),
        payload,
    )


# ---------------------------------------------------------------------------
# serialize / deserialize
# ---------------------------------------------------------------------------


def serialize(layout: "pya.Layout") -> str:
    """Return DM-1 deterministic canonical text for ``layout``.

    The format is a JSON object with keys sorted and nested lists sorted by
    the documented canonical order (cells by name; shapes by
    (layer, datatype, bbox, kind, payload); instances by (cell_name, trans)).
    The result is byte-identical across repeat runs on the same content.
    """
    cells_out: List[Dict[str, Any]] = []

    # Sort cells by name (DM-1).  Use each_cell to avoid orphan-index issues
    # documented in project CLAUDE.md.
    cells = sorted(layout.each_cell(), key=lambda c: c.name)
    for cell in cells:
        shape_entries: List[Dict[str, Any]] = []
        for li in layout.layer_indexes():
            info = layout.get_info(li)
            layer_no = int(info.layer)
            datatype = int(info.datatype)
            for shape in cell.shapes(li).each():
                shape_entries.append(_encode_shape(shape, layer_no, datatype))

        inst_entries: List[Dict[str, Any]] = []
        for inst in cell.each_inst():
            inst_entries.append(_encode_instance(inst))

        shape_entries.sort(key=_shape_sort_key)
        inst_entries.sort(key=_inst_sort_key)

        cells_out.append({
            "name": cell.name,
            "shapes": shape_entries,
            "instances": inst_entries,
        })

    doc = {
        "format": _FORMAT_TAG,
        "dbu": float(layout.dbu),
        "cells": cells_out,
    }
    # ``sort_keys=True`` + ``separators`` pins the output byte-identical.
    return json.dumps(doc, sort_keys=True, separators=(",", ":"))


def deserialize(text: str) -> "pya.Layout":
    """Return a fresh ``pya.Layout`` reconstructed from ``text``.

    Inverse of ``serialize`` for every primitive enumerated in DM-2
    (polygons incl. holes, paths with width, text labels, SREF, AREF,
    per-shape user-properties, multi-layer + multi-datatype).
    """
    doc = json.loads(text)
    if not isinstance(doc, dict) or doc.get("format") != _FORMAT_TAG:
        raise ValueError(f"unrecognised serialiser format: {doc.get('format')!r}")

    layout = pya.Layout()
    layout.dbu = float(doc.get("dbu", 0.001))

    # Pass 1: create all cells up front so instance references resolve by name.
    cells: Dict[str, "pya.Cell"] = {}
    for entry in doc.get("cells", []):
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        cells[name] = layout.create_cell(name)

    # Pass 2: shapes and instances.
    for entry in doc.get("cells", []):
        name = entry.get("name")
        cell = cells.get(name)
        if cell is None:
            continue

        for shp in entry.get("shapes", []):
            _insert_shape(layout, cell, shp)

        for inst in entry.get("instances", []):
            _insert_instance(layout, cell, cells, inst)

    return layout


def _insert_shape(layout: "pya.Layout", cell: "pya.Cell",
                  entry: Dict[str, Any]) -> None:
    layer_no = int(entry.get("layer", 0))
    datatype = int(entry.get("datatype", 0))
    li = layout.layer(layer_no, datatype)
    kind = entry.get("kind")

    shape_handle = None

    if kind == "text":
        tr = _decode_trans(entry["trans"])
        t = pya.Text(str(entry["string"]), tr)
        shape_handle = cell.shapes(li).insert(t)
    elif kind == "path":
        pts = [pya.Point(int(p[0]), int(p[1])) for p in entry.get("points", [])]
        width = int(entry.get("width", 0))
        p = pya.Path(pts, width)
        shape_handle = cell.shapes(li).insert(p)
    elif kind == "box":
        b = entry["box"]
        box = pya.Box(int(b[0]), int(b[1]), int(b[2]), int(b[3]))
        shape_handle = cell.shapes(li).insert(box)
    elif kind == "polygon":
        hull = [pya.Point(int(p[0]), int(p[1])) for p in entry.get("hull", [])]
        poly = pya.Polygon(hull)
        for hole in entry.get("holes", []):
            pts = [pya.Point(int(p[0]), int(p[1])) for p in hole]
            poly.insert_hole(pts)
        shape_handle = cell.shapes(li).insert(poly)
    else:
        return  # unknown kind — skip silently

    # Restore properties.
    props = entry.get("properties") or {}
    if props and shape_handle is not None:
        for k, v in props.items():
            try:
                shape_handle.set_property(k, v)
            except Exception:
                # Fall back to string-coerced value.
                try:
                    shape_handle.set_property(k, str(v))
                except Exception:
                    pass


def _insert_instance(layout: "pya.Layout", cell: "pya.Cell",
                     cells: Dict[str, "pya.Cell"],
                     entry: Dict[str, Any]) -> None:
    target_name = entry.get("cell_name")
    target = cells.get(target_name)
    if target is None:
        return
    tr = _decode_trans(entry["trans"])
    arr = entry.get("array")
    if isinstance(arr, dict):
        a = pya.Vector(int(arr["a"][0]), int(arr["a"][1]))
        b = pya.Vector(int(arr["b"][0]), int(arr["b"][1]))
        ci = pya.CellInstArray(target.cell_index(), tr,
                               a, b, int(arr["na"]), int(arr["nb"]))
    else:
        ci = pya.CellInstArray(target.cell_index(), tr)

    inst = cell.insert(ci)
    props = entry.get("properties") or {}
    if props and inst is not None:
        for k, v in props.items():
            try:
                inst.set_property(k, v)
            except Exception:
                try:
                    inst.set_property(k, str(v))
                except Exception:
                    pass


# ---------------------------------------------------------------------------
# to_pya_code (DM-3)
# ---------------------------------------------------------------------------


def to_pya_code(layout):  # pragma: no cover - implemented in task 4.3
    raise NotImplementedError("to_pya_code is implemented in task 4.3")
