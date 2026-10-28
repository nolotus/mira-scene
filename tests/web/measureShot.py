#!/usr/bin/env python3
"""
截图量化：轮廓环带亮度 / 区域亮度直方图。

为什么单独写：颜色差异肉眼只能说「好像淡了点」，而「贴上去」的核心症状是
**抠图边缘比周围亮一档**，这必须用同一区域的数字说清楚，否则改完也没法判断有没有效。

用法：
  # 轮廓外 3px 环带（portrait.png 的 alpha 决定轮廓，rect 决定它落在截图的哪里）
  python3 tests/web/measureShot.py edge --shot after.png \
      --rect 13,102,404,408 --portrait public/char/portrait.png --band 3

  # 局部区域亮度直方图（桌面杯那块：mean / std / p5 / p95）
  python3 tests/web/measureShot.py box --shot after.png --box 164,1356,232,1426
"""

import argparse
import json

from PIL import Image, ImageFilter, ImageStat


def srgb_luma(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ring_mask(portrait_path: str, band: int):
    """轮廓外 band 像素的环带（alpha 膨胀后减去 alpha 本身）。"""
    im = Image.open(portrait_path).convert("RGBA")
    alpha = im.split()[3]
    opaque = alpha.point(lambda v: 255 if v > 8 else 0)
    grown = opaque.filter(ImageFilter.MaxFilter(band * 2 + 1))
    ring = Image.new("L", im.size, 0)
    ring_px = ring.load()
    grown_px = grown.load()
    opaque_px = opaque.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            if grown_px[x, y] > 0 and opaque_px[x, y] == 0:
                ring_px[x, y] = 255
    return ring, w, h


def cmd_edge(args) -> None:
    shot = Image.open(args.shot).convert("RGB")
    rect = json.loads(args.rect) if args.rect.startswith("[") else [float(v) for v in args.rect.split(",")]
    x, y, w, h = rect
    ring, pw, ph = ring_mask(args.portrait, args.band)
    dpr = shot.width / args.stage_width
    sx, sy = (w * dpr) / pw, (h * dpr) / ph
    ring_px = ring.load()
    px = shot.load()
    values = []
    # 底边渐隐区（最后 14px）不参与采样：那里是 alpha 过渡，不代表「亮边」
    skip_bottom = ph - int(ph * (14.0 / max(1.0, h)))
    for py in range(0, min(ph, skip_bottom)):
        for px_x in range(pw):
            if ring_px[px_x, py] == 0:
                continue
            X = int(x * dpr + px_x * sx)
            Y = int(y * dpr + py * sy)
            if 0 <= X < shot.width and 0 <= Y < shot.height:
                r, g, b = px[X, Y]
                values.append(srgb_luma(r, g, b))
    if not values:
        raise SystemExit("环带为空：rect 或 portrait 不匹配")
    values.sort()
    mean = sum(values) / len(values)
    p = lambda q: values[min(len(values) - 1, int(len(values) * q))]
    print(
        json.dumps(
            {
                "samples": len(values),
                "mean": round(mean, 1),
                "p10": round(p(0.10), 1),
                "p50": round(p(0.50), 1),
                "p90": round(p(0.90), 1),
                "max": round(values[-1], 1),
            }
        )
    )


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
    e = sub.add_parser("edge")
    e.add_argument("--shot", required=True)
    e.add_argument("--rect", required=True, help="x,y,w,h（CSS px，元素 bounding rect）或 [x,y,w,h]")
    e.add_argument("--portrait", default="public/char/portrait.png")
    e.add_argument("--band", type=int, default=3)
    e.add_argument("--stage-width", type=float, default=430.0)
    e.set_defaults(fn=cmd_edge)
    b = sub.add_parser("box")
    b.add_argument("--shot", required=True)
    b.add_argument("--box", required=True, help="x0,y0,x1,y1（截图设备像素）")
    b.set_defaults(fn=cmd_box)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
