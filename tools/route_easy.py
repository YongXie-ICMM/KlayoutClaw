#!/usr/bin/env python
"""route_easy.py — 一条命令跑通自动布线（本科生入口 / undergrad-friendly front end).

route_worker.py 是引擎：吃一个手写的 config.json，只输出坐标 JSON，不改 GDS。
这个脚本把常用流程包成一条命令，并把每一步的产物都留在一个目录里：

    结果目录/
      route_config.json   自动生成的引擎配置（想学 config 写法就看它）
      routes.json         引擎原始输出（坐标，单位 dbu）
      routed.gds          输入版图 + 布好的金属线（可直接进后续流水线）
      preview.png         结果预览图

用法（先看版图里有哪些层）:
    python tools/route_easy.py my.gds --list-layers

布线（引脚层 102/0 连到焊盘层 111/0，绕开 1/0 和 3/0）:
    python tools/route_easy.py my.gds --pins 102/0 --pads 111/0 \
        --obstacles 1/0 3/0

没有自己的版图？先造一个演示 Hall bar（完全离线，不需要 KLayout GUI）:
    python examples/make_demo_hallbar.py demo.gds

完整文档: docs/route_quickstart_cn.md
"""
from __future__ import annotations
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import klayout.db as kdb  # noqa: E402

from route_worker import route, parse_layer, validate_config  # noqa: E402


def list_layers(gds_path: str) -> None:
    layout = kdb.Layout()
    layout.read(gds_path)
    tops = [c.name for c in layout.top_cells()]
    print(f"文件: {gds_path}")
    print(f"dbu : {layout.dbu} um/单位")
    print(f"顶层 cell: {', '.join(tops) if tops else '(无)'}")
    print(f"{'层':>8}  图形数")
    for li in layout.layer_indexes():
        info = layout.get_info(li)
        n = 0
        for cell in layout.each_cell():
            n += cell.shapes(li).size()
        print(f"{info.layer:>5}/{info.datatype:<2}  {n}")
    print("\n提示: --pins 给器件端引脚层, --pads 给焊盘端引脚层, "
          "--obstacles 给不许压线的层(台面/焊盘本体)。")


def pick_cell(layout: kdb.Layout, cell_arg: str | None) -> str:
    if cell_arg:
        if not any(c.name == cell_arg for c in layout.each_cell()):
            names = [c.name for c in layout.each_cell()]
            sys.exit(f"错误: 版图里没有 cell '{cell_arg}'。现有: {names}")
        return cell_arg
    tops = layout.top_cells()
    if len(tops) == 1:
        return tops[0].name
    sys.exit(f"错误: 版图有 {len(tops)} 个顶层 cell "
             f"({[c.name for c in tops]})，请用 --cell 指定一个。")


def write_routed_gds(gds_path: str, cell_name: str, result: dict,
                     metal_layer: str, default_width_um: float,
                     out_gds: str) -> int:
    """Insert result paths (and two-level patches) into a copy of the GDS."""
    layout = kdb.Layout()
    layout.read(gds_path)
    dbu = layout.dbu
    cell = next(c for c in layout.each_cell() if c.name == cell_name)
    ml, md = parse_layer(metal_layer)
    li = layout.layer(ml, md)
    n_inserted = 0
    for p in result.get("paths", []):
        pts = [kdb.Point(int(x), int(y)) for x, y in p["points_dbu"]]
        if len(pts) < 2:
            continue
        width_dbu = max(1, int(round(p.get("width_um", default_width_um) / dbu)))
        cell.shapes(li).insert(kdb.Path(pts, width_dbu))
        n_inserted += 1
    for patch in result.get("patches", []):
        x, y, s = patch["x_dbu"], patch["y_dbu"], patch["size_dbu"]
        h = s // 2
        cell.shapes(li).insert(kdb.Box(x - h, y - h, x + h, y + h))
    layout.write(out_gds)
    return n_inserted


def main():
    parser = argparse.ArgumentParser(
        description="一条命令自动布线：引脚 → 焊盘，绕开障碍层，"
                    "输出 routed.gds + 预览图。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python tools/route_easy.py demo.gds --list-layers\n"
               "  python tools/route_easy.py demo.gds --pins 102/0 "
               "--pads 111/0 --obstacles 1/0 3/0\n")
    parser.add_argument("gds", help="输入 GDS 文件")
    parser.add_argument("--list-layers", action="store_true",
                        help="只列出版图里的层和图形数，然后退出")
    parser.add_argument("--pins", metavar="L/D",
                        help="器件端引脚层, 如 102/0")
    parser.add_argument("--pads", metavar="L/D",
                        help="焊盘端引脚层, 如 111/0")
    parser.add_argument("--obstacles", metavar="L/D", nargs="*", default=[],
                        help="障碍层(不许压线), 如 1/0 3/0")
    parser.add_argument("--width-um", type=float, default=1.0,
                        help="布线线宽 um (默认 1.0)")
    parser.add_argument("--cell", help="cell 名 (默认: 唯一的顶层 cell)")
    parser.add_argument("--metal-layer", default="2/0", metavar="L/D",
                        help="布线结果写到哪一层 (默认 2/0)")
    parser.add_argument("--map-resolution-um", type=float, default=None,
                        help="寻路网格分辨率 um (默认自动)")
    parser.add_argument("--out-dir", default=None,
                        help="结果目录 (默认: <gds名>_routed/)")
    parser.add_argument("--dry-run", action="store_true",
                        help="只做引脚配对预览，不实际寻路")
    args = parser.parse_args()

    if not os.path.exists(args.gds):
        sys.exit(f"错误: 找不到文件 {args.gds}")

    if args.list_layers:
        list_layers(args.gds)
        return

    if not args.pins or not args.pads:
        sys.exit("错误: 布线需要 --pins 和 --pads 两个层。\n"
                 "不知道层号? 先跑: python tools/route_easy.py "
                 f"{args.gds} --list-layers")

    layout = kdb.Layout()
    layout.read(args.gds)
    cell_name = pick_cell(layout, args.cell)
    file_dbu = layout.dbu

    out_dir = args.out_dir or (os.path.splitext(args.gds)[0] + "_routed")
    os.makedirs(out_dir, exist_ok=True)

    config = {
        "gds_path": os.path.abspath(args.gds),
        "cell_name": cell_name,
        "dbu": file_dbu,
        "pin_layer_a": args.pins,
        "pin_layer_b": args.pads,
        "obstacle_layers": list(args.obstacles),
        "path_width_um": args.width_um,
        "auto_map_resolution": args.map_resolution_um is None,
        "dry_run": bool(args.dry_run),
    }
    if args.map_resolution_um is not None:
        config["map_resolution_um"] = args.map_resolution_um

    fatal, warns = validate_config(config)
    for w in warns:
        print(f"警告: {w}", file=sys.stderr)
    if fatal:
        sys.exit("配置错误:\n  - " + "\n  - ".join(fatal))

    config_path = os.path.join(out_dir, "route_config.json")
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

    print(f"开始布线: {args.pins} 的引脚 → {args.pads} 的焊盘, "
          f"障碍层 {args.obstacles or '(无)'} ...")
    result = route(config)

    routes_path = os.path.join(out_dir, "routes.json")
    with open(routes_path, "w") as f:
        json.dump(result, f, indent=2)

    status = result.get("status")
    routed = result.get("routed_pairs", 0)
    n_a = result.get("total_pins_a", 0)
    n_b = result.get("total_pins_b", 0)

    print()
    print("=" * 56)
    print(f"状态: {status}    引脚: A 层 {n_a} 个 / B 层 {n_b} 个    "
          f"布通: {routed} 条")
    for e in result.get("errors", []):
        info = str(e).startswith(("auto_map_resolution", "dry_run:"))
        print(f"  [{'说明' if info else '问题'}] {e}")

    if status == "dry_run":
        print(f"\n(dry-run 只做配对预览) 配对结果见 {routes_path} 的 pairs 字段。")
        return

    artifacts = [config_path, routes_path]
    if result.get("paths"):
        routed_gds = os.path.join(out_dir, "routed.gds")
        n_ins = write_routed_gds(args.gds, cell_name, result,
                                 args.metal_layer, args.width_um, routed_gds)
        artifacts.append(routed_gds)
        print(f"已把 {n_ins} 条线写入 {routed_gds} 的 {args.metal_layer} 层。")
        try:
            from gds_to_image import gds_to_image
            preview = os.path.join(out_dir, "preview.png")
            gds_to_image(routed_gds, preview)
            artifacts.append(preview)
        except Exception as e:  # preview is best-effort, never fail the run
            print(f"(预览图生成失败, 不影响结果: {e})", file=sys.stderr)

    print("\n产物:")
    for a in artifacts:
        print(f"  {a}")

    if status == "partial":
        print(f"\n注意: 只布通 {routed} 条, 有引脚没连上——看上面的 [问题] 行, "
              "常见原因: 障碍太密(试试调小 --width-um)、引脚被完全围死。")
    elif status == "success":
        ml = parse_layer(args.metal_layer)
        print("\n全部布通。下一步(接 InteLitho-Agentic 流水线, G4 Step 2):\n"
              f"  python3 scanpath/gds_to_mpath.py {out_dir}/routed.gds "
              f"--layer {ml[0]} --datatype {ml[1]} --zone-aware "
              "--gap-buffer-um 2.0 --out dev01.json")

    if status == "error":
        sys.exit(1)


if __name__ == "__main__":
    main()
