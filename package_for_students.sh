#!/usr/bin/env bash
# 打学生发货包：KlayoutClaw 离线布线工具链 → _SHIPPED_SNAPSHOTS/
#
# 包含: tools/ examples/ tests/ plugin/ skills/ docs(仅文档,不含视频)
#       README/LICENSE/install.py/requirements_routing.txt + 开始这里.txt
# 剔除: .git, agent/(需要 node), tests_resources/(flakedetect 用),
#       docs 里的 mp4/gif 大媒体
# 用法: bash package_for_students.sh [学生任务书.pdf 路径(可选,一并放入)]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SNAP_DIR="$REPO_DIR/../_SHIPPED_SNAPSHOTS"
STAMP=$(date +%Y%m%d)
NAME="KlayoutClaw_布线包_${STAMP}_发给学生"
STAGE=$(mktemp -d)/"$NAME"
TASKBOOK_PDF="${1:-}"

mkdir -p "$STAGE"
cd "$REPO_DIR"

# 干净树导出（当前 HEAD，未提交的改动不会进包）
git archive HEAD | tar -x -C "$STAGE"

# 剔除学生用不到的大件
rm -rf "$STAGE/agent" "$STAGE/tests_resources"
find "$STAGE/docs" -type f \( -name "*.mp4" -o -name "*.gif" -o -name "*.webp" -o -name "*.PNG" \) -delete
rm -f "$STAGE/KLayout_Claw.PNG" "$STAGE/KLayout_Claw.webp"

# 任务书 PDF（可选）
if [[ -n "$TASKBOOK_PDF" && -f "$TASKBOOK_PDF" ]]; then
    cp "$TASKBOOK_PDF" "$STAGE/学生任务书.pdf"
fi

cat > "$STAGE/开始这里.txt" <<'EOF'
KlayoutClaw 布线包 —— 先读我
================================

这是光刻流水线 G4 组的布线工具（版图上把器件引脚自动连到焊盘）。
完整教程: docs/route_quickstart_cn.md （必读，10 分钟上手）
任务背景: 学生任务书 G4 节（包里若有 学生任务书.pdf 就是它）

三步跑通（Windows 把 python3 换成 py，source 那行换成
routeenv\Scripts\activate）：

  1) 装环境（一次性，任意 Python 3.10+）:
     python3 -m venv routeenv && source routeenv/bin/activate
     pip install -r requirements_routing.txt

  2) 造演示版图 + 看层:
     python examples/make_demo_hallbar.py demo.gds
     python tools/route_easy.py demo.gds --list-layers

  3) 布线:
     python tools/route_easy.py demo.gds --pins 102/0 --pads 111/0 --obstacles 1/0 3/0

     跑完看 demo_routed/preview.png —— 8 条线应无交叉连到 8 块焊盘。
     demo_routed/routed.gds 就是能进下一步流水线的版图。

有问题先查 docs/route_quickstart_cn.md 第四节"常见报错对照"。
EOF

# 打 zip（-X 去掉 mac 扩展属性）
mkdir -p "$SNAP_DIR"
OUT="$SNAP_DIR/$NAME.zip"
rm -f "$OUT"
(cd "$(dirname "$STAGE")" && zip -qrX "$OUT" "$NAME")
rm -rf "$(dirname "$STAGE")"

echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"
echo "记得在 _SHIPPED_SNAPSHOTS/README.md 登记。"
