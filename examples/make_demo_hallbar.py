#!/usr/bin/env python
"""生成一个未布线的演示 Hall bar GDS —— 完全离线，不需要 KLayout GUI/MCP。

几何与 tests/create_hallbar_unrouted.py 相同（那个脚本要求 MCP 服务在跑，
这个只用 klayout 的 Python 库）：

- 1/0   Mesa: 石墨烯沟道 100x25 um + 6 根侧臂（障碍层）
- 3/0   Pads: 8 块 300x300 um 焊盘（障碍层）
- 102/0 Pin_A: 器件端引脚标记（臂尖 + 沟道两端, 共 8 个）
- 111/0 Pin_B: 焊盘中心引脚标记（共 8 个）

用法:
    python examples/make_demo_hallbar.py [demo.gds]

然后布线:
    python tools/route_easy.py demo.gds --pins 102/0 --pads 111/0 \
        --obstacles 1/0 3/0
"""
import sys

import klayout.db as kdb

DBU = 0.001  # um per database unit


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "demo.gds"

    layout = kdb.Layout()
    layout.dbu = DBU
    top = layout.create_cell("TOP")

    def rect(layer, dt, x1, y1, x2, y2):
        li = layout.layer(layer, dt)
        top.shapes(li).insert(kdb.Box(
            int(x1 / DBU), int(y1 / DBU), int(x2 / DBU), int(y2 / DBU)))

    def pin(layer, dt, cx, cy, half=2.5):
        rect(layer, dt, cx - half, cy - half, cx + half, cy + half)

    # 1/0 Mesa: channel + 6 side probes
    rect(1, 0, -50, -12.5, 50, 12.5)
    for px in (-30, 0, 30):
        rect(1, 0, px - 5, 12.5, px + 5, 32.5)     # top probes
        rect(1, 0, px - 5, -32.5, px + 5, -12.5)   # bottom probes

    # 3/0 Bonding pads (300x300 um)
    rect(3, 0, -1050, -150, -750, 150)   # left current pad
    rect(3, 0, 750, -150, 1050, 150)     # right current pad
    for x1 in (-750, -150, 450):
        rect(3, 0, x1, 700, x1 + 300, 1000)      # top voltage pads
        rect(3, 0, x1, -1000, x1 + 300, -700)    # bottom voltage pads

    # 102/0 Pin_A: probe tips + channel ends
    for px in (-30, 0, 30):
        pin(102, 0, px, 32.5)
        pin(102, 0, px, -32.5)
    pin(102, 0, -50, 0)
    pin(102, 0, 50, 0)

    # 111/0 Pin_B: pad centers
    for cx, cy in [(-900, 0), (900, 0),
                   (-600, 850), (0, 850), (600, 850),
                   (-600, -850), (0, -850), (600, -850)]:
        pin(111, 0, cx, cy)

    layout.write(out)
    print(f"已生成 {out} (cell TOP, ~2100x2000 um)")
    print("下一步:")
    print(f"  python tools/route_easy.py {out} --pins 102/0 --pads 111/0 "
          "--obstacles 1/0 3/0")


if __name__ == "__main__":
    main()
