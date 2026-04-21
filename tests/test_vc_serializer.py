#!/usr/bin/env python
"""Tests for plugin.klayoutclaw_vc.serializer (qlaybot v0.4.4 Phase 4, §5.2.1).

Covers:
  * DM-1 deterministic serialisation.
  * DM-2 round-trip (serialize -> deserialize preserves all primitives, INCLUDING
    shape properties per §5.2.1 DM-2 "Lossless across polygons, paths, text,
    SREF, AREF, labels, **properties**, layers").
  * DM-3 ``to_pya_code`` returns executable Python that reconstructs the layout.
  * §9.2 T10 (round-trip fidelity, byte-level GDS equality) and T11
    (determinism, 10x repeat).

Contract notes for the Executor
--------------------------------
* Module path MUST be ``plugin.klayoutclaw_vc.serializer``.
* Public functions with these EXACT signatures::

      def serialize(layout: pya.Layout) -> str
      def deserialize(text: str) -> pya.Layout
      def to_pya_code(layout: pya.Layout) -> str

* ``serialize`` MUST be deterministic for the same ``pya.Layout`` input, meaning
  cells are emitted sorted by name and shapes within a cell are emitted sorted by
  ``(layer, datatype, bbox-lexicographic-tuple)``.  Byte-identical output is
  required across repeated calls on the same or re-loaded-from-GDS input.
* ``deserialize`` MUST be the inverse of ``serialize`` for every primitive type
  listed in DM-2: polygons (with holes), paths, text, SREF, AREF, multi-layer,
  multi-datatype, **and per-shape user-properties**.

* DM-3 / T10 PYA-CODE DRIVER CONTRACT (hard requirement — subprocess test):
  ``to_pya_code`` MUST emit standalone Python whose only top-level import
  is either ``import klayout.db as pya`` or ``import pya``.  The emitted code
  MUST leave a module-level variable named ``layout`` bound to the
  reconstructed ``pya.Layout`` instance when executed.  Tests append the
  driver line ``layout.write(<path>)`` to the emitted code and run the
  combined program in a FRESH Python subprocess, so neither ``layout``
  nor the ``pya`` import may be hidden inside a function or ``if __name__``
  block.  Structural check: the emitted code must contain the substring
  ``layout = pya.Layout(``.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys

import pytest

# Make the repository root importable so ``plugin.klayoutclaw_vc`` resolves once
# the Executor creates it.  Pattern copied from tests/test_flakedetect.py (which
# inserts a package path prior to importing the module under test).
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# Skip the entire module cleanly while the Executor hasn't landed the package
# yet.  This is standard test-first discipline, not skip-cheating: once the
# implementation exists, every test here runs against real code.
serializer = pytest.importorskip("plugin.klayoutclaw_vc.serializer")

import klayout.db as pya  # noqa: E402  (imported after importorskip on purpose)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_empty_layout(dbu: float = 0.001) -> pya.Layout:
    """Layout containing a single empty top cell (zero shapes)."""
    layout = pya.Layout()
    layout.dbu = dbu
    layout.create_cell("TOP")
    return layout


def _make_complex_layout(dbu: float = 0.001) -> pya.Layout:
    """Build a layout exercising every primitive required by DM-2 and T10.

    Contents:
      * Polygon with a rectangular hole on L(1, 0), carrying user properties.
      * Simple path on L(2, 0).
      * Text / label on L(3, 0).
      * A child cell with a box, instantiated as a SREF (single transform).
      * The same child cell instantiated as an AREF (3x3 array).
      * An extra (layer, datatype) pair on L(1, 5) to exercise sorting on
        ``datatype`` and not only ``layer`` in the determinism contract.
      * At least one shape carries user-properties — exercises DM-2's
        "properties" lossless clause.
    """
    layout = pya.Layout()
    layout.dbu = dbu
    top = layout.create_cell("TOP")
    child = layout.create_cell("CHILD")

    li_1_0 = layout.layer(1, 0)
    li_2_0 = layout.layer(2, 0)
    li_3_0 = layout.layer(3, 0)
    li_1_5 = layout.layer(1, 5)
    li_child = layout.layer(1, 0)  # CHILD also uses L(1,0)

    # Polygon with a hole on (1, 0).
    outer = [pya.Point(0, 0), pya.Point(10000, 0),
             pya.Point(10000, 8000), pya.Point(0, 8000)]
    poly = pya.Polygon(outer)
    poly.insert_hole([pya.Point(2000, 2000), pya.Point(6000, 2000),
                      pya.Point(6000, 5000), pya.Point(2000, 5000)])
    s_poly = top.shapes(li_1_0).insert(poly)
    # DM-2 properties coverage: attach a couple of user-properties to the
    # hole-bearing polygon.  Different value types exercise the round-trip
    # more thoroughly than a single string would.
    try:
        s_poly.set_property("net", "VDD")
        s_poly.set_property("pitch", 100)
    except Exception:
        # set_property API surface has varied slightly across klayout versions;
        # the test checking property round-trip is tolerant to a best-effort
        # attach here, but the dedicated test_roundtrip_preserves_properties
        # test uses its own explicit shape so this guard doesn't weaken it.
        pass

    # A second polygon on (1, 0) with a different bbox to exercise bbox-lex sort.
    top.shapes(li_1_0).insert(
        pya.Polygon([pya.Point(-5000, -5000), pya.Point(-2000, -5000),
                     pya.Point(-2000, -2000), pya.Point(-5000, -2000)])
    )

    # Path on (2, 0).
    path_pts = [pya.Point(0, 0), pya.Point(5000, 0),
                pya.Point(5000, 5000), pya.Point(10000, 5000)]
    top.shapes(li_2_0).insert(pya.Path(path_pts, 200))

    # Text/label on (3, 0).
    top.shapes(li_3_0).insert(
        pya.Text("MARK", pya.Trans(pya.Point(12000, 3000)))
    )

    # Extra datatype on L1 for sort contract.
    top.shapes(li_1_5).insert(pya.Box(20000, 0, 21000, 1000))

    # Child cell contents.
    child.shapes(li_child).insert(pya.Box(0, 0, 500, 500))

    # SREF (single instance, simple translation).
    top.insert(
        pya.CellInstArray(child.cell_index(),
                          pya.Trans(pya.Point(30000, 0)))
    )
    # AREF (3x3 grid).
    top.insert(
        pya.CellInstArray(child.cell_index(),
                          pya.Trans(pya.Point(40000, 0)),
                          pya.Vector(1000, 0),
                          pya.Vector(0, 1000),
                          3, 3)
    )

    return layout


def _gds_hash(layout: pya.Layout, tmp_path) -> str:
    """Write ``layout`` to GDS and return sha256 of the bytes."""
    target = os.path.join(str(tmp_path), "snapshot.gds")
    layout.write(target)
    with open(target, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _count_shapes_by_layer(layout: pya.Layout) -> dict[tuple[int, int], int]:
    """Count shapes per (layer, datatype) over all cells — excluding instances."""
    counts: dict[tuple[int, int], int] = {}
    for cell in layout.each_cell():
        for li in layout.layer_indexes():
            info = layout.get_info(li)
            key = (info.layer, info.datatype)
            counts[key] = counts.get(key, 0) + cell.shapes(li).size()
    return counts


def _count_instances(layout: pya.Layout) -> int:
    total = 0
    for cell in layout.each_cell():
        total += cell.child_instances()
    return total


# ---------------------------------------------------------------------------
# Module-import smoke (T*-sanity)
# ---------------------------------------------------------------------------


def test_module_exposes_public_api():
    """Three public symbols are importable and callable.

    This is the single "smoke" test flagged in the Overseer brief.  It still
    asserts concrete runtime behaviour (the symbols must be callables), not
    mere attribute existence.
    """
    assert callable(getattr(serializer, "serialize", None)), \
        "serializer.serialize must be a public callable"
    assert callable(getattr(serializer, "deserialize", None)), \
        "serializer.deserialize must be a public callable"
    assert callable(getattr(serializer, "to_pya_code", None)), \
        "serializer.to_pya_code must be a public callable"


# ---------------------------------------------------------------------------
# DM-1 determinism / T11
# ---------------------------------------------------------------------------


def test_serialize_is_deterministic_same_layout_instance():
    """DM-1: serialising the same in-memory layout twice -> identical text.

    Also asserts that a distinct layout produces distinct text, so that a
    trivial ``return ""`` stub cannot pass this test.
    """
    layout = _make_complex_layout()
    first = serializer.serialize(layout)
    second = serializer.serialize(layout)
    assert isinstance(first, str) and first, "serialize must return non-empty str"
    assert first == second, "serialize must be pure/deterministic on same input"

    # Distinct content must produce distinct output — defeats constant-return stubs.
    other = _make_empty_layout()
    other_text = serializer.serialize(other)
    assert other_text != first, \
        "serialize must encode content: different layouts must map to different text"


def test_serialize_deterministic_across_gds_reload_10x(tmp_path):
    """T11: write-to-GDS, reload, serialise — 10 rounds all produce the same hash."""
    src = _make_complex_layout()
    gds = os.path.join(str(tmp_path), "src.gds")
    src.write(gds)

    hashes: list[str] = []
    text_sample: str = ""
    for _ in range(10):
        reloaded = pya.Layout()
        reloaded.read(gds)
        text = serializer.serialize(reloaded)
        text_sample = text
        hashes.append(hashlib.sha256(text.encode("utf-8")).hexdigest())

    assert len(set(hashes)) == 1, \
        f"T11 violated: expected 1 unique hash across 10 runs, got {len(set(hashes))}"

    # Defeat trivial-stub passes: output must be non-empty and must differ from
    # an empty layout's serialisation.
    assert text_sample, "T11: serialized text must be non-empty for a non-trivial layout"
    empty_text = serializer.serialize(_make_empty_layout())
    assert text_sample != empty_text, \
        "T11: complex layout must not serialise to the same text as an empty one"


def test_serialize_sorts_cells_by_name(tmp_path):
    """DM-1: cell emission order is alphabetical by cell name.

    We construct two logically identical layouts that differ only in cell
    creation order and assert their serialisations are byte-identical.
    """
    # Build A with cells created in alphabetical order.
    layout_a = pya.Layout()
    layout_a.dbu = 0.001
    li_a = layout_a.layer(1, 0)
    for name in ("AAA", "BBB", "CCC"):
        c = layout_a.create_cell(name)
        c.shapes(li_a).insert(pya.Box(0, 0, 100, 100))

    # Build B with cells created in reverse order.
    layout_b = pya.Layout()
    layout_b.dbu = 0.001
    li_b = layout_b.layer(1, 0)
    for name in ("CCC", "BBB", "AAA"):
        c = layout_b.create_cell(name)
        c.shapes(li_b).insert(pya.Box(0, 0, 100, 100))

    text_a = serializer.serialize(layout_a)
    text_b = serializer.serialize(layout_b)
    assert text_a == text_b, \
        "DM-1 violated: creation order leaked into serialise output"
    assert text_a, "serialize must return non-empty text for a non-trivial layout"
    # And a layout with DIFFERENT cell names must produce DIFFERENT text —
    # guards against a stub that ignores cell content.
    layout_c = pya.Layout()
    layout_c.dbu = 0.001
    li_c = layout_c.layer(1, 0)
    for name in ("XXX", "YYY", "ZZZ"):
        c = layout_c.create_cell(name)
        c.shapes(li_c).insert(pya.Box(0, 0, 100, 100))
    assert serializer.serialize(layout_c) != text_a, \
        "DM-1: serialised text must reflect cell names"


def test_serialize_sorts_shapes_by_layer_datatype_bbox(tmp_path):
    """DM-1: shape order within a cell = sorted(layer, datatype, bbox-lex).

    Two layouts with the same shapes inserted in different orders must
    serialise identically.
    """
    def build(order):
        layout = pya.Layout()
        layout.dbu = 0.001
        top = layout.create_cell("TOP")
        for key in order:
            if key == "L1D0_A":
                top.shapes(layout.layer(1, 0)).insert(
                    pya.Box(0, 0, 100, 100))
            elif key == "L1D0_B":
                top.shapes(layout.layer(1, 0)).insert(
                    pya.Box(500, 500, 600, 600))
            elif key == "L1D5":
                top.shapes(layout.layer(1, 5)).insert(
                    pya.Box(0, 0, 100, 100))
            elif key == "L2D0":
                top.shapes(layout.layer(2, 0)).insert(
                    pya.Box(0, 0, 100, 100))
        return layout

    order_fwd = ["L1D0_A", "L1D0_B", "L1D5", "L2D0"]
    order_rev = list(reversed(order_fwd))
    text_fwd = serializer.serialize(build(order_fwd))
    text_rev = serializer.serialize(build(order_rev))
    assert text_fwd == text_rev, \
        "DM-1: shape insertion order must not leak into output"
    assert text_fwd, "serialize must produce non-empty output for non-empty layout"

    # A DIFFERENT shape set must produce different text — guards against a
    # constant-return stub.
    layout_alt = pya.Layout()
    layout_alt.dbu = 0.001
    layout_alt.create_cell("TOP").shapes(layout_alt.layer(9, 9)).insert(
        pya.Box(0, 0, 1, 1))
    assert serializer.serialize(layout_alt) != text_fwd, \
        "DM-1: serialised text must reflect actual layer/shape content"


# ---------------------------------------------------------------------------
# DM-2 round-trip / T10
# ---------------------------------------------------------------------------


def test_roundtrip_preserves_empty_layout():
    """Empty layout (one empty top cell) survives serialise + deserialise."""
    layout = _make_empty_layout()
    text = serializer.serialize(layout)
    restored = serializer.deserialize(text)

    assert isinstance(restored, pya.Layout), "deserialize must return pya.Layout"
    names = sorted(c.name for c in restored.each_cell())
    assert names == ["TOP"], f"empty layout must round-trip its single cell, got {names}"


def test_roundtrip_single_polygon():
    """Polygon-only layout round-trip preserves geometry."""
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(7, 0)
    top.shapes(li).insert(pya.Polygon(
        [pya.Point(0, 0), pya.Point(1000, 0),
         pya.Point(1000, 2000), pya.Point(0, 2000)]))

    restored = serializer.deserialize(serializer.serialize(layout))
    r_li = restored.layer(7, 0)
    r_top = next(iter(restored.top_cells()))
    shapes = list(r_top.shapes(r_li).each())
    assert len(shapes) == 1
    assert shapes[0].is_polygon() or shapes[0].is_box(), \
        "polygon must survive round-trip as polygon or axis-aligned box"


def test_roundtrip_polygon_with_hole(tmp_path):
    """Polygon with hole round-trips (vertex-count check)."""
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(1, 0)
    poly = pya.Polygon([pya.Point(0, 0), pya.Point(10000, 0),
                        pya.Point(10000, 10000), pya.Point(0, 10000)])
    poly.insert_hole([pya.Point(2000, 2000), pya.Point(5000, 2000),
                      pya.Point(5000, 5000), pya.Point(2000, 5000)])
    top.shapes(li).insert(poly)

    restored = serializer.deserialize(serializer.serialize(layout))
    r_li = restored.layer(1, 0)
    r_top = next(iter(restored.top_cells()))
    shapes = list(r_top.shapes(r_li).each())
    assert len(shapes) == 1
    shp = shapes[0].polygon
    assert shp is not None, "hole-bearing polygon must deserialise as a Polygon"
    assert shp.holes() >= 1, \
        f"DM-2 violated: hole lost during round-trip (holes={shp.holes()})"


def test_roundtrip_path_preserves_width():
    """DM-2: paths round-trip as paths with the EXACT width preserved.

    Strict: we require the restored shape to be a Path (not a polygonal
    approximation) and the width to match the original value exactly.  Any
    polygonal conversion is a lossy round-trip for DM-2 purposes — spec calls
    paths out explicitly in the "Lossless" list.
    """
    original_width = 250
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(2, 0)
    top.shapes(li).insert(pya.Path(
        [pya.Point(0, 0), pya.Point(1000, 0), pya.Point(1000, 1000)],
        original_width))

    restored = serializer.deserialize(serializer.serialize(layout))
    r_li = restored.layer(2, 0)
    r_top = next(iter(restored.top_cells()))
    shapes = list(r_top.shapes(r_li).each())
    assert len(shapes) == 1, \
        f"DM-2: expected exactly 1 shape after round-trip, got {len(shapes)}"
    assert shapes[0].is_path(), (
        "DM-2 strict: path must round-trip as a Path (not polygon), "
        f"got shape type: is_path={shapes[0].is_path()}, "
        f"is_polygon={shapes[0].is_polygon()}, is_box={shapes[0].is_box()}"
    )
    assert shapes[0].path.width == original_width, (
        f"DM-2 strict: path width must round-trip exactly, "
        f"expected {original_width}, got {shapes[0].path.width}"
    )


def test_roundtrip_text_label():
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(3, 0)
    top.shapes(li).insert(pya.Text("HELLO", pya.Trans(pya.Point(100, 200))))

    restored = serializer.deserialize(serializer.serialize(layout))
    r_li = restored.layer(3, 0)
    r_top = next(iter(restored.top_cells()))
    texts = [s.text for s in r_top.shapes(r_li).each() if s.is_text()]
    assert len(texts) == 1, "text shape must survive round-trip"
    assert texts[0].string == "HELLO", "text string must round-trip verbatim"


def test_roundtrip_sref():
    """DM-2 strict: SREF (single instance) round-trips with IDENTICAL transform.

    Asserts the restored TOP cell contains exactly one instance of SUB, at the
    same translation as the original.  Without this, a serializer that emits
    the instance with a default (0,0) transform would pass the weak
    "instance exists" check.
    """
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    sub = layout.create_cell("SUB")
    li = layout.layer(1, 0)
    sub.shapes(li).insert(pya.Box(0, 0, 100, 100))
    orig_disp = pya.Point(500, 500)
    top.insert(pya.CellInstArray(sub.cell_index(), pya.Trans(orig_disp)))

    restored = serializer.deserialize(serializer.serialize(layout))
    names = {c.name for c in restored.each_cell()}
    assert {"TOP", "SUB"}.issubset(names), "child cell must round-trip"
    r_top = restored.cell("TOP")
    r_sub = restored.cell("SUB")
    assert r_top is not None and r_sub is not None
    assert r_top.child_instances() == 1, (
        f"DM-2 strict: SREF round-trip must yield exactly 1 instance, "
        f"got {r_top.child_instances()}"
    )

    insts = list(r_top.each_inst())
    assert len(insts) == 1
    inst = insts[0]
    # Instance must point at SUB cell.
    assert inst.cell.name == "SUB", \
        f"DM-2 strict: SREF must reference cell SUB, got {inst.cell.name}"
    # Transform must match translation.  We check the complex transform's
    # displacement, rotation and magnification independently so a partial
    # identity that drops one of them is still caught.
    t = inst.trans
    # pya.Trans has .disp (Vector), .rot (int 0..7), no explicit mag
    # (CplxTrans has .mag).  A simple Trans(orig_disp) has rot=0, no mirror.
    assert t.disp.x == orig_disp.x and t.disp.y == orig_disp.y, (
        f"DM-2 strict: SREF translation must round-trip exactly, "
        f"expected ({orig_disp.x}, {orig_disp.y}), got ({t.disp.x}, {t.disp.y})"
    )
    assert t.rot == 0, f"DM-2 strict: SREF rotation must be 0 (was 0), got {t.rot}"
    assert t.is_mirror() is False, \
        "DM-2 strict: SREF mirror flag must round-trip (original was not mirrored)"


def test_roundtrip_aref():
    """AREF (array instance) round-trips with correct expanded shape count."""
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    sub = layout.create_cell("SUB")
    li = layout.layer(1, 0)
    sub.shapes(li).insert(pya.Box(0, 0, 100, 100))
    top.insert(pya.CellInstArray(
        sub.cell_index(), pya.Trans(pya.Point(0, 0)),
        pya.Vector(1000, 0), pya.Vector(0, 1000), 4, 2))  # 4x2 = 8

    restored = serializer.deserialize(serializer.serialize(layout))
    r_top = restored.cell("TOP")
    assert r_top is not None
    # Expand instance count: expect the AREF with na*nb = 8 positions to be
    # represented either as a single CellInstArray or 8 separate CellInsts.
    expanded = 0
    for inst in r_top.each_inst():
        ca = inst.cell_inst
        na = ca.na if ca.is_regular_array() else 1
        nb = ca.nb if ca.is_regular_array() else 1
        expanded += na * nb
    assert expanded == 8, f"AREF must round-trip 8 instance positions, got {expanded}"


def test_roundtrip_multilayer_shape_counts(tmp_path):
    """DM-2 strict: multi-layer, multi-datatype layout preserves per-layer shape counts EXACTLY.

    Strict ``==`` catches BOTH under-counting (shape loss) AND over-counting
    (duplicated insertion) in the round-trip.  The earlier ``>=`` version
    allowed a silent-duplication bug to slip through.
    """
    layout = _make_complex_layout()
    before = _count_shapes_by_layer(layout)

    restored = serializer.deserialize(serializer.serialize(layout))
    after = _count_shapes_by_layer(restored)

    # Every (layer, datatype) that had shapes before must have the same count
    # after — neither more nor less.
    for key, n in before.items():
        assert after.get(key, 0) == n, \
            f"DM-2 violated: shape count for {key} changed from {n} to {after.get(key, 0)}"

    # And no NEW (layer, datatype) populations may appear with shapes > 0 that
    # weren't in the original — rules out phantom-layer insertion bugs.
    for key, n in after.items():
        if n > 0:
            assert key in before and before[key] == n, (
                f"DM-2 violated: restored layout contains unexpected shapes on "
                f"{key} (count={n}) not present in original"
            )


def _compare_gds_shapes(path_a: str, path_b: str) -> None:
    """Reload two GDS files and assert they contain the same per-(cell,layer) shape population.

    This is the byte-agnostic fallback invoked when GDS byte equality fails for
    reasons unrelated to serializer correctness (e.g. timestamp records).
    Compares per-cell, per-(layer, datatype) shape counts AND the sorted list of
    each shape's bounding box.  Bounding-box equality is the strongest cheap
    proxy for "same geometry" that we can extract without a full shape
    equivalence check.
    """
    def fingerprint(path: str):
        lay = pya.Layout()
        lay.read(path)
        cells = {}
        for cell in lay.each_cell():
            per_layer = {}
            for li in lay.layer_indexes():
                info = lay.get_info(li)
                key = (info.layer, info.datatype)
                bboxes = []
                for sh in cell.shapes(li).each():
                    b = sh.bbox()
                    bboxes.append((b.left, b.bottom, b.right, b.top))
                if bboxes:
                    per_layer[key] = sorted(bboxes)
            # include child-instance count to cover SREF/AREF survival
            per_layer["_instances"] = cell.child_instances()
            cells[cell.name] = per_layer
        return cells

    fp_a = fingerprint(path_a)
    fp_b = fingerprint(path_b)
    assert fp_a == fp_b, (
        "T10 fallback: GDS bytes differed AND reloaded shape fingerprints "
        f"differ.\n  a={fp_a}\n  b={fp_b}")


def test_roundtrip_preserves_properties():
    """DM-2 strict: per-shape user-properties round-trip lossless.

    Spec §5.2.1 DM-2 explicitly enumerates 'properties' in the lossless
    clause.  We attach two properties (string value + int value) to a single
    box shape, round-trip through serialize/deserialize, and assert the same
    (key, value) pairs reappear on the restored shape.

    Tolerance: the implementation may store property VALUES as either str or
    their original int type (GDS property records are int-indexed / value-typed
    but in-memory representations vary).  We compare values after str()
    coercion so both conventions pass.
    """
    layout = pya.Layout()
    layout.dbu = 0.001
    top = layout.create_cell("TOP")
    li = layout.layer(4, 0)
    shape = top.shapes(li).insert(pya.Box(0, 0, 50, 50))
    # Attach two user-properties.  Use set_property (per-shape metadata).
    shape.set_property("net", "VDD")
    shape.set_property("pitch", 100)

    text = serializer.serialize(layout)
    restored = serializer.deserialize(text)

    r_top = next(iter(restored.top_cells()))
    r_li = restored.layer(4, 0)
    r_shapes = list(r_top.shapes(r_li).each())
    assert len(r_shapes) == 1, \
        f"DM-2 property round-trip: expected 1 shape, got {len(r_shapes)}"
    r_sh = r_shapes[0]

    # Extract restored properties as a dict.  pya Shape exposes .property(key)
    # and .properties() (dict-like).  Fall back to iteration if needed.
    restored_props: dict = {}
    try:
        # Simplest API: .properties() returns a dict.
        p = r_sh.properties()
        if isinstance(p, dict):
            restored_props = {k: v for k, v in p.items()}
        else:
            raise AttributeError
    except Exception:
        # Try .property(name) probes.
        for k in ("net", "pitch"):
            v = None
            try:
                v = r_sh.property(k)
            except Exception:
                v = None
            if v is not None:
                restored_props[k] = v

    assert restored_props, (
        "DM-2 violated: no properties surfaced on the restored shape "
        "(empty dict). Properties were attached to the original."
    )
    # Check each expected key is present with a matching value (str-coerced).
    assert str(restored_props.get("net")) == "VDD", (
        f"DM-2 violated: property 'net' did not round-trip. "
        f"expected 'VDD', got {restored_props.get('net')!r}"
    )
    assert str(restored_props.get("pitch")) == "100", (
        f"DM-2 violated: property 'pitch' did not round-trip. "
        f"expected '100' (str-coerced), got {restored_props.get('pitch')!r}"
    )


def test_roundtrip_gds_hash_equals_original(tmp_path):
    """T10 (serialize path): GDS bytes of the round-tripped layout equal the original.

    Primary probe: hash the GDS file bytes written from the original layout and
    compare against the hash of the GDS file bytes written from
    ``deserialize(serialize(layout))``.  If pya's GDS writer turns out not to be
    byte-stable in this environment (e.g. it embeds a wall-clock stamp), fall
    back to a reloaded shape-fingerprint equality check.  Either path is the
    checksum-verifiable data-integrity probe required by §5.3 "Data integrity";
    the earlier serialise-text round-trip alone would let a symmetric
    serializer/deserializer bug pass.
    """
    layout = _make_complex_layout()

    # Original -> GDS bytes / hash.
    path_orig = os.path.join(str(tmp_path), "orig.gds")
    layout.write(path_orig)
    with open(path_orig, "rb") as fh:
        h_orig = hashlib.sha256(fh.read()).hexdigest()

    # serialize -> deserialize -> GDS bytes / hash.
    text = serializer.serialize(layout)
    assert text, \
        "T10 pre-condition: complex layout must produce non-empty serialised text"
    restored = serializer.deserialize(text)
    assert isinstance(restored, pya.Layout), \
        "T10: deserialize must return a pya.Layout (not None)"

    path_rt = os.path.join(str(tmp_path), "roundtrip.gds")
    restored.write(path_rt)
    with open(path_rt, "rb") as fh:
        h_rt = hashlib.sha256(fh.read()).hexdigest()

    if h_orig == h_rt:
        return  # strictest success

    # Fall back to reload-and-compare-shapes.  This still defeats the
    # symmetric-bug scenario: any shape lost or duplicated in the serializer
    # path will show up as a fingerprint mismatch here, independent of
    # serializer text canonicalisation.
    _compare_gds_shapes(path_orig, path_rt)

    # And as a secondary anchor, re-serialise must also be stable per DM-1.
    text_after = serializer.serialize(restored)
    assert text == text_after, \
        "T10: layout state after serialize->deserialize must re-serialise identically"


# ---------------------------------------------------------------------------
# DM-3 / T10 pya-codegen path
# ---------------------------------------------------------------------------


def _exec_pya_code_subprocess(code: str, out_gds: str) -> None:
    """Run emitted pya code in a FRESH Python interpreter.

    The emitted code must bind a module-level variable ``layout`` (contract
    documented in the module docstring + re-asserted structurally by
    ``test_to_pya_code_has_no_non_pya_imports``).  We append a driver line that
    writes that layout to ``out_gds`` so we can diff against the original in
    bytes.  Subprocess isolation is a stricter check than in-process ``exec()``
    — no test-fixture state can leak into the namespace, so a stub that relies
    on a pre-imported ``pya`` or a pre-built layout cannot sneak through.
    """
    driver = (
        code
        + "\n# driver appended by test (DM-3 contract: module-level `layout`)\n"
        + f"layout.write({out_gds!r})\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", driver],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise AssertionError(
            "DM-3: emitted pya code failed to execute in a fresh subprocess.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
    assert os.path.exists(out_gds), \
        "DM-3: subprocess ran without error but no GDS was written — did the emitted code leave a `layout` variable?"


def test_to_pya_code_returns_nonempty_string():
    layout = _make_empty_layout()
    code = serializer.to_pya_code(layout)
    assert isinstance(code, str) and code.strip(), \
        "to_pya_code must return a non-empty str"


def test_to_pya_code_has_no_non_pya_imports():
    """DM-3: the only import allowed is klayout.db / pya.

    Also requires the emitted code to:
      * contain at least one ``pya.`` reference (rules out empty-stub passes);
      * contain the substring ``layout = pya.Layout(`` — the DM-3 driver
        contract documented in the module docstring, which the subprocess
        tests rely on to locate the reconstructed layout.
    """
    layout = _make_complex_layout()
    code = serializer.to_pya_code(layout)
    assert isinstance(code, str) and code.strip(), \
        "DM-3: to_pya_code must return a non-empty str for non-empty layout"
    assert "pya" in code, \
        "DM-3: emitted code must reference 'pya' to reconstruct the layout"
    assert "layout = pya.Layout(" in code, (
        "DM-3 driver contract: emitted code MUST contain the literal "
        "`layout = pya.Layout(` so the subprocess driver can invoke "
        "`layout.write(path)` after execution. See module docstring."
    )
    disallowed = []
    for line in code.splitlines():
        stripped = line.strip()
        if stripped.startswith("import ") or stripped.startswith("from "):
            if ("klayout.db" not in stripped
                    and not stripped.startswith("import pya")
                    and not stripped.startswith("from pya")):
                disallowed.append(stripped)
    assert not disallowed, \
        f"DM-3: unexpected non-pya imports in to_pya_code output: {disallowed}"


def test_to_pya_code_executes_and_rebuilds_cells(tmp_path):
    """DM-3: exec'd-in-subprocess code produces a layout with the same cells.

    Subprocess isolation ensures no fixture/test namespace leaks into the
    emitted code's environment.
    """
    layout = _make_complex_layout()
    before_cell_names = sorted(c.name for c in layout.each_cell())

    code = serializer.to_pya_code(layout)
    out = os.path.join(str(tmp_path), "rebuilt.gds")
    _exec_pya_code_subprocess(code, out)

    # Reload the subprocess-written GDS back into this process to verify
    # cell population matches.
    rebuilt = pya.Layout()
    rebuilt.read(out)
    after_cell_names = sorted(c.name for c in rebuilt.each_cell())
    assert before_cell_names == after_cell_names, \
        ("DM-3: rebuilt layout has different cells. "
         f"before={before_cell_names}, after={after_cell_names}")


def test_to_pya_code_preserves_shape_counts(tmp_path):
    """DM-3: exec'd-in-subprocess code reproduces per-(layer,datatype) shape counts EXACTLY."""
    layout = _make_complex_layout()
    before = _count_shapes_by_layer(layout)

    code = serializer.to_pya_code(layout)
    out = os.path.join(str(tmp_path), "rebuilt_counts.gds")
    _exec_pya_code_subprocess(code, out)
    rebuilt = pya.Layout()
    rebuilt.read(out)
    after = _count_shapes_by_layer(rebuilt)

    # Strict equality: DM-3 is "lossless" per DM-2 wording.  Any over- or
    # under-reporting indicates an emission bug.
    for key, n in before.items():
        assert after.get(key, 0) == n, (
            f"DM-3: shape count for {key} changed from {n} to {after.get(key, 0)} "
            "through the emitted-pya-code round trip"
        )


def test_to_pya_code_matches_serialize_snapshot(tmp_path):
    """T10 (pya-code path): GDS bytes from the subprocess-rebuilt layout equal the original.

    Byte-level equality is the strongest equivalence check.  Falls back to a
    reloaded-shape-fingerprint diff only if the writer proves not to be
    byte-stable for timestamp-ish reasons unrelated to correctness.
    """
    layout = _make_complex_layout()

    # Original reference GDS.
    path_orig = os.path.join(str(tmp_path), "orig.gds")
    layout.write(path_orig)
    with open(path_orig, "rb") as fh:
        h_orig = hashlib.sha256(fh.read()).hexdigest()

    # Rebuilt GDS via the emitted-pya-code -> subprocess path.
    code = serializer.to_pya_code(layout)
    path_rt = os.path.join(str(tmp_path), "rebuilt.gds")
    _exec_pya_code_subprocess(code, path_rt)
    with open(path_rt, "rb") as fh:
        h_rt = hashlib.sha256(fh.read()).hexdigest()

    if h_orig == h_rt:
        return  # strictest success

    # Fallback: compare reloaded shape fingerprints.  This still catches any
    # missing/duplicated shape from the emitted-code path.
    _compare_gds_shapes(path_orig, path_rt)

    # Anchor check: the serialiser text of the rebuilt layout must equal the
    # original (DM-1 determinism applied to identical content).
    rebuilt = pya.Layout()
    rebuilt.read(path_rt)
    assert serializer.serialize(layout) == serializer.serialize(rebuilt), \
        "T10 pya-code: rebuilt layout does not re-serialise identically"
