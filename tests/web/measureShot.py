#!/usr/bin/env python3
"""
截图量化：区域亮度直方图（mean / std / p5 / p95）。

为什么单独写：颜色差异肉眼只能说「好像淡了点」，必须用同一区域的数字说清楚。

用法：
  python3 tests/web/measureShot.py box --shot after.png --box 164,1356,232,1426

注：原先还有一个 `edge` 子命令（按 portrait.png 的 alpha 找轮廓、量外圈环带亮度），
照片级角色 2026-10-29 整条下线后它没有可测对象了，一并删除。
"""

import argparse
import json

from PIL import Image, ImageStat


def srgb_luma(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def cmd_box(args) -> None:
    shot = Image.open(args.shot).convert("RGB")
    x0, y0, x1, y1 = [int(v) for v in args.box.split(",")]
    crop = shot.crop((x0, y0, x1, y1))
    stat = ImageStat.Stat(crop.convert("L"))
    hist = crop.convert("L").histogram()
    total = sum(hist)
    acc = 0
    p5 = p95 = None
    for i, count in enumerate(hist):
        acc += count
        if p5 is None and acc >= total * 0.05:
            p5 = i
        if p95 is None and acc >= total * 0.95:
            p95 = i
            break
    print(json.dumps({"mean": round(stat.mean[0], 1), "std": round(stat.stddev[0], 1), "p5": p5, "p95": p95}))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("box")
    b.add_argument("--shot", required=True)
    b.add_argument("--box", required=True, help="x0,y0,x1,y1（截图设备像素）")
    b.set_defaults(fn=cmd_box)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
