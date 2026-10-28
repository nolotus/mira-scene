#!/usr/bin/env python3
"""
照片模式的量化对照（色温 / 桌面杯可见像素 / 底边硬接缝）。

三个数字对应三处「贴上去」的缺陷，每一处都必须能回答「改前多少、改后多少」：

  1. 色温  —— 角色区域与同帧场景区域的 R-B 均值之差的绝对值（越小越贴）；
  2. 杯子  —— 桌面杯 rect 内、角色 alpha 近乎为 0 的像素数（= 漏出来的杯子面积）；
  3. 接缝  —— 角色底边一带相邻两行的平均亮度跳变峰值（越大越像裁切）。

用法：
  python3 tests/web/measurePhoto.py all \
    --shot /tmp/before_idle.png \
    --char 12.9,403.4,404.2,444.8 \
    --cup 79.5,679.4,30.3,32.1 \
    --portrait public/char/portrait.png --stage-width 430

rect 一律是 CSS 像素（getBoundingClientRect），脚本自己按 shot/舞台宽度算 dpr。
"""

import argparse
import json

from PIL import Image

ALPHA_OPAQUE = 240
ALPHA_CLEAR = 24


def load(args):
    shot = Image.open(args.shot).convert("RGB")
    portrait = Image.open(args.portrait).convert("RGBA")
    dpr = shot.width / args.stage_width
    return shot, portrait, dpr


def parse_rect(raw: str):
    return [float(v) for v in raw.split(",")]


def alpha_at(portrait, rect_px, nx: int, ny: int, x: int, y: int) -> int:
    """把截图坐标映射回 portrait 坐标取 alpha（最近邻，够用且快）"""
    px = int((x - rect_px[0]) / rect_px[2] * nx)
    py = int((y - rect_px[1]) / rect_px[3] * ny)
    px = min(max(px, 0), nx - 1)
    py = min(max(py, 0), ny - 1)
    return portrait.getpixel((px, py))[3]


def r_minus_b(px):
    r, g, b = px
    return r - b


def cmd_temps(args):
    shot, portrait, dpr = load(args)
    rect = parse_rect(args.char)
    rect_px = [v * dpr for v in rect]
    nx, ny = portrait.size
    char_vals, scene_vals, char_luma, scene_luma = [], [], [], []
    x0, y0 = int(rect_px[0]), int(rect_px[1])
    x1, y1 = int(rect_px[0] + rect_px[2]), int(rect_px[1] + rect_px[3])
    for y in range(y0, y1):
        for x in range(x0, x1):
            a = alpha_at(portrait, rect_px, nx, ny, x, y)
            p = shot.getpixel((x, y))
            if a >= ALPHA_OPAQUE:
                char_vals.append(r_minus_b(p))
                char_luma.append(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
            elif a <= 8:
                scene_vals.append(r_minus_b(p))
                scene_luma.append(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
    char_rb = sum(char_vals) / len(char_vals)
    scene_rb = sum(scene_vals) / len(scene_vals)
    return {
        "charRB": round(char_rb, 2),
        "sceneRB": round(scene_rb, 2),
        "deltaRB": round(char_rb - scene_rb, 2),
        "absDeltaRB": round(abs(char_rb - scene_rb), 2),
        "charLuma": round(sum(char_luma) / len(char_luma), 2),
        "sceneLuma": round(sum(scene_luma) / len(scene_luma), 2),
        "charPx": len(char_vals),
        "scenePx": len(scene_vals),
    }


def cmd_cup(args):
    shot, portrait, dpr = load(args)
    rect = parse_rect(args.char)
    rect_px = [v * dpr for v in rect]
    cup = [v * dpr for v in parse_rect(args.cup)]
    nx, ny = portrait.size
    visible = 0
    total = 0
    for y in range(int(cup[1]), int(cup[1] + cup[3])):
        for x in range(int(cup[0]), int(cup[0] + cup[2])):
            total += 1
            a = alpha_at(portrait, rect_px, nx, ny, x, y)
            if a <= ALPHA_CLEAR:
                visible += 1
    return {
        "cupRectPx": [round(v, 1) for v in cup],
        "cupAreaPx": total,
        "cupVisiblePx": visible,
        "cupVisiblePct": round(visible / total * 100, 1) if total else 0.0,
        "cupVisibleCssPx2": round(visible / (dpr * dpr), 1),
    }


def cmd_seam(args):
    """角色底边一带：相邻两行的平均亮度跳变峰值 + 该行位置（CSS 坐标）"""
    shot, portrait, dpr = load(args)
    rect = parse_rect(args.char)
    rect_px = [v * dpr for v in rect]
    bottom_px = rect_px[1] + rect_px[3]
    nx, ny = portrait.size
    # 只在「人像真正不透明」的列上取行均值：避开两侧透明区把跳变稀释掉
    cols = []
    for x in range(int(rect_px[0]), int(rect_px[0] + rect_px[2])):
        if alpha_at(portrait, rect_px, nx, ny, x, int(bottom_px - 2)) >= ALPHA_OPAQUE:
            cols.append(x)
    rows = {}
    for y in range(int(bottom_px - 70), int(bottom_px + 12)):
        vals = []
        for x in cols:
            p = shot.getpixel((x, y))
            vals.append(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
        rows[y] = sum(vals) / len(vals) if vals else 0.0
    jumps = [(y, abs(rows[y + 1] - rows[y])) for y in sorted(rows) if y + 1 in rows]
    peak_y, peak = max(jumps, key=lambda kv: kv[1])
    return {
        "columns": len(cols),
        "peakJumpLuma": round(peak, 2),
        "peakJumpAtCssY": round(peak_y / dpr, 1),
        "charBottomCssY": round(bottom_px / dpr, 1),
        "profile": {round(k / dpr, 1): round(v, 1) for k, v in sorted(rows.items())},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["temps", "cup", "seam", "all"])
    parser.add_argument("--shot", required=True)
    parser.add_argument("--char", required=True)
    parser.add_argument("--cup", default="0,0,0,0")
    parser.add_argument("--portrait", default="public/char/portrait.png")
    parser.add_argument("--stage-width", dest="stage_width", type=float, default=430.0)
    args = parser.parse_args()

    out = {}
    if args.cmd in ("temps", "all"):
        out["temps"] = cmd_temps(args)
    if args.cmd in ("cup", "all"):
        out["cup"] = cmd_cup(args)
    if args.cmd in ("seam", "all"):
        seam = cmd_seam(args)
        seam.pop("profile")
        out["seam"] = seam
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
