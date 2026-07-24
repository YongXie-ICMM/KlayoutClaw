# 选定样品 → 电极布线：完整链路

> 场景：识别工作已完成一部分，手上有一块选定的 flake（显微照片 / 识别 mask），
> 下一步要把它变成"布好电极线的 GDS"，再进曝光流水线。

## 0. 先想清楚：布线引擎只认三样东西

布线函数只有一个引擎：`tools/route_worker.py` 里的 `route()`。三个入口是同一引擎的皮：

| 入口 | 场景 |
|---|---|
| MCP 工具 `auto_route` | KLayout GUI + AI agent（路线 A） |
| `tools/route_easy.py` | 命令行一条命令（路线 B，学生首选） |
| 手写 config + `tools/route_worker.py` | 进阶（指定配对、总线、两级线宽） |

引擎开跑的前提是 GDS 里已有：

1. **flake/台面形状** —— 障碍层（惯例 1/0），线不许压
2. **触点引脚标记** —— pin_layer_a（惯例 102/0），器件上要接线的点，每处一个小方块
3. **焊盘 + 焊盘引脚标记** —— 焊盘本体（3/0，也是障碍）+ 中心 pin_layer_b（111/0）

"选定样品 → 布线"的全部工作，就是把这三样东西弄进 GDS，然后一条命令。

## 1. 路线 A：全自动（macOS + KLayout GUI + AI agent）

用 `skills/nanodevice_e2e_design`（纯编排 skill），对 agent 一句话即可驱动：

> "用这张 50X 照片（pixel_size=0.04014）在 flake 上设计 6 触点 Hall bar，布线到四周焊盘"

流程（agent 自动走）：

1. **flake 进 GDS**：`nanodevice_flakedetect` 把照片里的 flake 轮廓识别成多边形写入 mesa 层。
   `pixel_size` **必须用对应显微镜的标定**：
   | rig | 50X µm/px |
   |---|---|
   | ICMM（马德里） | 0.04014 |
   | XDU（西电） | 0.02795 |
2. **放触点**：agent 经 `execute_script` 在 flake 上画触点几何 + 102/0 引脚标记
3. **放焊盘**：`skills/nanodevice_routing/scripts/place_pads.py --field 2000 --pad-size 80 --pads-per-edge 12`
4. **布线**：`auto_route`（大写场两级粗细用 `route_multiwindow.py`）
5. **DRC/评估 → 存 GDS**

装好环境的机器上，照 `docs/README_KlayoutClaw_upstream.md` 的 Quick Start 起 MCP 服务即可。

## 2. 路线 B：半手动（任意平台，无 GUI 依赖）

识别输出（mask/多边形）目前**没有自动导入 GDS 的桥**（见 §3），所以离线路线前半段手动：

1. KLayout 打开新版图，手动描 flake 轮廓到 1/0 层（照片当底图对着描即可，精度要求不高——它只是障碍）
2. 在想放电极的位置画触点，并在每个触点尖端放 5×5 µm 小方块到 **102/0**
3. 画焊盘（如 300×300 µm）到 **3/0**，每块焊盘中心放小方块到 **111/0**
4. 存盘，然后：

```bash
python tools/route_easy.py 样品.gds --pins 102/0 --pads 111/0 --obstacles 1/0 3/0
```

产出 `routed.gds`（线在 2/0 层）+ `preview.png`。接流水线下一步（InteLitho-Agentic 仓库根）：

```bash
python3 scanpath/gds_to_mpath.py routed.gds --layer 2 --datatype 0 \
    --zone-aware --gap-buffer-um 2.0 --out dev01.json
```

## 3. 已知缺口（下一个要补的工具）

**识别 mask → GDS 自动导入桥**：识别管线（MoS2-Spectral-Mapper / MaskTerial）输出的
mask 目前进不了布线，需要一个转换器。建议接口：

```
mask_to_gds.py <mask.png|多边形.json> --pixel-size-um <µm/px> [--origin-um x y] \
    --layer 1/0 --out flake.gds
```

要点：mask 二值化 → 轮廓提取（cv2.findContours / skimage）→ 简化（Douglas-Peucker，
容差 ~2×pixel_size）→ 乘 pixel_size 变 µm → 写 kdb.Polygon。有了它，路线 B 的
手动描图一步就消掉，识别输出直通布线；触点位置也可以进一步在 flake 多边形上自动
提案（最长内接方向两端 + 侧臂，参考 `skills/nanodevice_e2e_design` 的 DESIGN 规则）。

## 4. 常见坑

- 两条路线**参数名不同**：MCP `path_width` vs worker `path_width_um`——worker 现在会直接报错拦下 MCP 风格键名。
- 引脚标记放在**障碍层里面**没关系（引擎会给每个 pin 开自己的豁口），但 102/0 和 111/0 层里**不要有额外杂物**——每个方块都会被当成一个待接引脚。
- 布线跑完必看 `preview.png` 与 `status` 字段：`partial` = 有线没布通，原因在输出的 errors 里。
- 跨 rig 严禁混用 µm/px 标定（0.3 节表）；照片里有标尺以标尺为准。
