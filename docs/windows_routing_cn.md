# Windows 实验室电脑布线指南

> 场景：实验室的 Windows 电脑上，对一块已选定的样品（显微照片在手）做电极布线。
> 前置阅读：[sample_to_routing_cn.md](sample_to_routing_cn.md)（链路全貌）、
> [route_quickstart_cn.md](route_quickstart_cn.md)（布线工具详解）。

## 0. 先分清两件事

- **布线本身不需要 KLayout 软件**：`route_easy.py` 用的是 pip 装的 `klayout`
  Python 模块（Windows 有现成 wheel），纯命令行运行。
- **KLayout GUI 用来"画"和"看"**：描 flake 轮廓、放引脚标记、画焊盘、检查
  布线结果。从 https://www.klayout.de/build.html 装 Windows 64-bit 版。

⚠️ **KlayoutClaw 的 MCP 插件（路线 A，AI 自动设计）只支持 macOS**——Windows 上
别跑 `install.py`，装了也起不了服务。Windows 工作流是纯路线 B：

```
KLayout GUI 画版图 → 命令行 route_easy 布线 → KLayout GUI 打开 routed.gds 检查
```

## 1. 装环境（一次性）

装 Python 3.10+（python.org，勾选 "Add python to PATH"）和 KLayout，然后：

```bat
py -m venv routeenv
routeenv\Scripts\activate
pip install -r requirements_routing.txt
```

验证（5 分钟，跑通说明环境没问题）：

```bat
python examples\make_demo_hallbar.py demo.gds
python tools\route_easy.py demo.gds --pins 102/0 --pads 111/0 --obstacles 1/0 3/0
```

打开 `demo_routed\preview.png`：8 条线无交叉扇出到 8 块焊盘 = 通过。

## 2. KLayout 里画样品版图

新建 layout（dbu 保持默认 0.001 µm）。

**把显微照片垫底描图**：File → Import → Image Data，导入选定样品的照片，
缩放系数填你那台显微镜的标定（**每像素多少 µm**）：

| rig | 50X µm/px |
|---|---|
| ICMM（马德里） | 0.04014 |
| XDU（西电） | 0.02795 |

缩放不确定时，先在照片里找带标尺/已知尺寸的参照物核一遍长度再描。

然后按层画（层号是布线工具的默认约定，照抄最省事）：

| 层 | 画什么 |
|---|---|
| **1/0** | flake 轮廓（对着底图描；精度要求不高，它只是障碍） |
| **102/0** | 每个想接电极的触点位置放一个 5×5 µm 小方块 |
| **3/0** | 焊盘本体（如 300×300 µm，摆在外围） |
| **111/0** | 每块焊盘中心放一个小方块 |

注意 102/0 和 111/0 里**不要有多余图形**——每个方块都会被当成一个待接引脚。
存成 `sample01.gds`。

## 3. 布线 + 检查

```bat
python tools\route_easy.py sample01.gds --pins 102/0 --pads 111/0 --obstacles 1/0 3/0
```

- `sample01_routed\preview.png` 先看一眼；`routed.gds` 拖进 KLayout 细看（线在 2/0 层）。
- `状态: partial` = 有线没布通，看输出里的 [问题] 行；常见解法：调小 `--width-um`、
  检查引脚是否被障碍完全围死。
- 全通后接流水线下一步（在 InteLitho-Agentic 仓库根）：
  `python scanpath/gds_to_mpath.py routed.gds --layer 2 --datatype 0 --zone-aware --gap-buffer-um 2.0 --out dev01.json`

## 4. 常见 Windows 坑

- 命令里路径分隔符用 `\`；激活虚拟环境是 `routeenv\Scripts\activate`（不是 `source`）。
- 每次新开终端都要先 activate，提示符前有 `(routeenv)` 才对。
- `pip install` 慢/失败：换网络或加 `-i https://pypi.tuna.tsinghua.edu.cn/simple`（国内镜像）。
- 中文文件名一般没问题；如果 `route_easy.py` 报编码错，把 GDS 改成纯英文名再试。
