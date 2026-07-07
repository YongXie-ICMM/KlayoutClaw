# 自动布线快速上手（中文）

给第一次接触本仓库的同学：**布线 = 把器件上的引脚（pin）自动连到外围焊盘（pad），
线不许压到台面、别的焊盘或别的线**。引擎用代价图 + Dijkstra/A* 寻路，
支持有序环配对（防交叉）、多引脚总线、两级粗细网格等。它在整条光刻流水线里的
位置是 G4 的第一步：**布线出版图 → gds_to_mpath 转路径 → 真机曝光**。

---

## 一、10 分钟离线上手（不需要 KLayout GUI）

```bash
# 0) 环境（一次性）：任意 Python 3.10+，装齐依赖
python3 -m venv routeenv && source routeenv/bin/activate
pip install numpy scipy scikit-image klayout gdstk shapely matplotlib

# 1) 造一个演示 Hall bar 版图
python examples/make_demo_hallbar.py demo.gds

# 2) 先看版图里有哪些层
python tools/route_easy.py demo.gds --list-layers

# 3) 布线：102/0 的引脚 → 111/0 的焊盘，绕开台面 1/0 和焊盘 3/0
python tools/route_easy.py demo.gds --pins 102/0 --pads 111/0 --obstacles 1/0 3/0
```

跑完会得到 `demo_routed/` 目录：

| 文件 | 是什么 |
|------|--------|
| `preview.png` | 结果预览图，**先看它**，8 条线应该无交叉地扇出到 8 块焊盘 |
| `routed.gds` | 输入版图 + 布好的金属线（默认写在 2/0 层），可直接进下一步流水线 |
| `routes.json` | 引擎原始输出（坐标，单位 dbu） |
| `route_config.json` | 自动生成的引擎配置——想学手写 config 就从它改起 |

`--help` 能看到全部选项（线宽 `--width-um`、结果层 `--metal-layer`、
只做配对预览的 `--dry-run` 等）。

---

## 二、这套代码有两条使用路线

| | 路线 A：MCP（KLayout GUI） | 路线 B：离线 worker（本页主线） |
|---|---|---|
| 平台 | 仅 macOS | 任意平台 |
| 启动 | `python install.py` 装插件，开 KLayout 即起服务 | 不需要 KLayout GUI |
| 调用 | AI agent 调 `auto_route` 工具 | `tools/route_easy.py` 或 `tools/route_worker.py config.json` |
| 结果 | 直接写回当前版图 | 输出 JSON；`route_easy.py` 会帮你写 `routed.gds` |
| 参数名 | `path_width`、`obs_safe_distance`（**不带 `_um`**） | `path_width_um`、`obs_safe_distance_um`（**带 `_um`**） |

**最大的坑就是最后一行**：两边参数名差一个 `_um` 后缀，互抄必错。
现在 `route_worker.py` 会直接报错拦下 MCP 风格的参数名（以前是静默忽略、
偷偷用默认值），拼错的键也会给出"你是不是想写 X"的警告。

---

## 三、进阶：手写 config 直接驱动引擎

`route_easy.py` 覆盖不了的功能（指定配对 `pin_pairs_override`、多引脚总线
`bus_pairs`、两级布线粗细线宽等）需要手写 config：

```bash
python tools/route_worker.py my_config.json --example   # 生成模板
python tools/route_worker.py my_config.json --check     # 只检查不布线
python tools/route_worker.py my_config.json             # 布线
```

### config 键参考（常用在前）

| 键 | 默认 | 说明 |
|----|------|------|
| `gds_path` | **必填** | 输入 GDS |
| `pin_layer_a` | **必填** | 器件端引脚层，如 `"102/0"` |
| `pin_layer_b` | **必填** | 焊盘端引脚层，如 `"111/0"` |
| `obstacle_layers` | `[]` | 不许压线的层列表 |
| `path_width_um` | `1.0` | 线宽 |
| `output_path` | 无 | 结果 JSON 写到哪（不给就打印到屏幕） |
| `cell_name` | `"TOP"` | 布哪个 cell |
| `dbu` | `0.001` | 数据库单位（um）；**要和 GDS 文件一致** |
| `auto_map_resolution` | `false` | 自动选网格分辨率（推荐开；`route_easy` 默认开） |
| `map_resolution_um` | `1.0` | 寻路网格分辨率；太粗会把窄缝挤成假交叉 |
| `obs_safe_distance_um` | `5.0` | 线离障碍的软安全距离 |
| `path_safe_distance_um` | `5.0` | 线与线的软安全距离 |
| `dry_run` | `false` | 只做引脚配对预览，不寻路 |
| `pin_pairs_override` | 无 | 手动指定配对 `[[a_idx,b_idx],...]`，跳过自动配对 |
| `bus_pairs` | 无 | 多引脚网 `[[a_idx,[b_idx,...]],...]`（Steiner 树近似） |
| `routing_strategy` | `"hybrid"` | `hybrid` / `per_pair` / `steiner` |
| `rescue_unrouted_nets` | `true` | 密集扇出里被围死的线做一次局部解救重试 |
| `two_level` | `"auto"` | 大版图两级粗细网格布线（`auto`/`on`/`off`） |
| `inner_width` / `outer_width` | 线宽/2.0 | 两级模式下器件区/外围区各自线宽 |
| `freeze_completed_routes_as_obstacles_with_margin` | `2.5` | 已布的线膨胀成硬障碍的边距 um |
| `sort_pairs` / `sort_pairs_reverse` | `true`/`false` | 先布短线（默认）还是先布长线 |

其余（阻尼/硬度等调参键 `obs_hardness`、`pin_safe_distance_a_um` 等）
一般不用动，语义见 `tools/route_worker.py` 开头注释。

### 输出 JSON 怎么读

- `status`: `success` 全布通 / `partial` 有线没布通（看 `errors`）/ `error` 没跑起来 / `dry_run`
- `routed_pairs` vs `total_pins_a`：布通几条、共几个引脚
- `paths[]`: 每条线的折点 `points_dbu`（乘以 dbu 得 um）、`net_id`、`rescued`（是否走了解救重试）
- 两级模式额外有 `patches[]`（粗细网格交界处的方形补丁）和每条线自己的 `width_um`

**注意：worker 只输出坐标，不改 GDS。** 要拿到布好线的版图，用
`route_easy.py`（自动写 `routed.gds`），或走 MCP 路线让插件写回。

---

## 四、常见报错对照

| 现象 | 原因 / 解法 |
|------|-------------|
| `missing required key 'gds_path'` | config 缺必填键，照提示补 |
| `'path_width' is the MCP auto_route parameter name...` | 把 MCP 参数抄进了 worker config，改成带 `_um` 的名字 |
| `unknown key 'obstacle_layer' ... did you mean 'obstacle_layers'?` | 键名拼错，会被忽略——照提示改 |
| `No pins found: pin_layer_a '102/0' has 0 pins` | 层号给错了，先 `route_easy.py xx.gds --list-layers` |
| `Cell 'TOP' not found` | cell 名不对，`--list-layers` 能看到顶层 cell 名 |
| `status: partial` + `No path found` | 引脚被障碍围死或线宽太大挤不过去；试更小 `--width-um`、开 `auto_map_resolution`、或减少障碍层 |
| 布线很慢 / 内存暴涨 | 网格太细；引擎超过 2500 万格会自动变粗并在 errors 里注明 |

---

## 五、接入 XDU/ICMM 光刻流水线（G4）

`routed.gds` 出来后，在 `InteLitho-Agentic/` 仓库根继续：

```bash
python3 scanpath/gds_to_mpath.py routed.gds --layer 2 --datatype 0 \
    --zone-aware --gap-buffer-um 2.0 --out dev01.json
```

后续双仿真、真机曝光步骤见 InteLith 仓库的《学生任务书》G4 节。
