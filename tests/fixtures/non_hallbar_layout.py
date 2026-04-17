"""Synthetic non-Hall-bar device geometry for E2E tests.

Layer map is deliberately different from the benchmark default:
    L30/0 = device_body    (60 um x 60 um square)
    L31/0 = peripheral_a   (ring around device_body, representing
                            a material_a zone)
    L32/0 = peripheral_b   (smaller overlapping ring, material_b zone)
    L33/0 = connector      (10x2 um wire off the right edge)
    L34/0 = pad            (25x25 um square at far right)

If the de-overfitting from Phase 1 worked, an agent should be able to:
    - call evaluate_design with layer_map { "device_body": [30,0], ... }
    - call bulk_containment with materials=["peripheral_a","peripheral_b"]
    - see score > 0
"""
from __future__ import annotations
import sys
import gdstk


def write_layout(path: str) -> None:
    lib = gdstk.Library(unit=1e-6, precision=1e-9)
    top = lib.new_cell("TOP")

    # L30/0 device body — 60x60 square centred at origin
    top.add(gdstk.rectangle((-30, -30), (30, 30), layer=30, datatype=0))
    # L31/0 peripheral_a — outer ring (65x65 minus 25x25 gives a ring)
    outer = gdstk.rectangle((-32.5, -32.5), (32.5, 32.5), layer=31, datatype=0)
    inner = gdstk.rectangle((-12.5, -12.5), (12.5, 12.5), layer=31, datatype=0)
    ring_a = gdstk.boolean(outer, inner, "not", layer=31, datatype=0)
    for p in ring_a:
        top.add(p)
    # L32/0 peripheral_b — smaller overlapping ring
    outer_b = gdstk.rectangle((-20, -20), (20, 20), layer=32, datatype=0)
    inner_b = gdstk.rectangle((-10, -10), (10, 10), layer=32, datatype=0)
    ring_b = gdstk.boolean(outer_b, inner_b, "not", layer=32, datatype=0)
    for p in ring_b:
        top.add(p)
    # L33/0 connector — 10x2 wire leaving right edge
    top.add(gdstk.rectangle((30, -1), (40, 1), layer=33, datatype=0))
    # L34/0 pad — 25x25 at (65, 0)
    top.add(gdstk.rectangle((52.5, -12.5), (77.5, 12.5), layer=34, datatype=0))

    lib.write_gds(path)


if __name__ == "__main__":
    write_layout(sys.argv[1])
    print(f"Wrote {sys.argv[1]}")
