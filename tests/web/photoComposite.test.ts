/**
 * 照片模式三处「贴上去」缺陷的校准函数（纯函数，零 DOM）。
 *
 * 每一条断言对应一个**改前实测数字**，而不是「看起来好点了」：
 *   · 色温：角色 R-B 均值 75.1 vs 场景 4.26（差值 70.83）、亮度 72.2 vs 25.2；
 *   · 底边：渐隐只有 10px，相邻两行亮度跳变峰值 36.7（读作裁切）；
 *   · 道具：桌面杯 rect 有 99.7% 落在角色框内，560 个屏幕像素从透明缝隙里漏出来。
 */

import { describe, expect, test } from "bun:test";
import { SCENE_SPECS } from "../../src/web/stage/scenes/spec";
import {
  SUBTITLE_GAP_PX,
  bottomFadePx,
  colorGrade,
  gradeVars,
  photoBottomPx,
  propOcclusion,
} from "../../src/web/stage/characters/photoGrade";

const NIGHT = SCENE_SPECS.cafe_night;

describe("colorGrade：与 palette / lighting 联动的调色", () => {
  test("暖光暗场景：饱和度与亮度都被压下来（人像不该比场景亮 2.9 倍）", () => {
    const g = colorGrade(NIGHT.lighting, NIGHT.palette);
    expect(g.saturate).toBeLessThan(1);
    expect(g.saturate).toBeGreaterThanOrEqual(0.72);
    expect(g.brightness).toBeLessThan(0.95);
    expect(g.brightness).toBeGreaterThanOrEqual(0.8);
    expect(g.sepia).toBeGreaterThan(0);
  });

  test("冷光场景需要的暖补偿更多，暖到一定上限就夹住", () => {
    const cool = colorGrade(
      { keyDir: { x: 0.4, y: -0.8 }, keyColor: "#cfe0ff", fillColor: "#a8c6ff", rimStrength: 1, shadowSoftness: 0.6 },
      { base: "#101820", depth: "#05080c", sky: "#0a1420", accent: "#9fc0e0", key: "#cfe0ff", fill: "#a8c6ff" },
    );
    // 冷主光的 R-B 为负 → warmSignal 归零 → sepia 落到下限，饱和度不会过度收紧
    expect(cool.sepia).toBeCloseTo(0.02, 5);
    expect(cool.saturate).toBeGreaterThan(0.9);
    expect(cool.brightness).toBeLessThanOrEqual(0.94);
  });

  test("诊断量带出主光色温与基色亮度（R-B 与 measurePhoto.py 同口径）", () => {
    const g = colorGrade(NIGHT.lighting, NIGHT.palette);
    expect(g.keyWarmth).toBe(255 - 189); // #ffe6bd
    expect(g.baseLuma).toBeGreaterThan(0);
    expect(g.baseLuma).toBeLessThan(0.5);
  });

  test("gradeVars 只输出三个 CSS 变量，且都能被 CSS filter 直接消费", () => {
    const vars = gradeVars(colorGrade(NIGHT.lighting, NIGHT.palette));
    expect(Object.keys(vars).sort()).toEqual([
      "--photo-grade-bright",
      "--photo-grade-sat",
      "--photo-grade-sepia",
    ]);
    for (const value of Object.values(vars)) {
      expect(Number(value)).toBeGreaterThan(0);
    }
  });
});

describe("底部渐隐：24–36px，并与字幕带上沿留间距", () => {
  test("渐隐高度落在 24–36px（改前 8–12px 实测读作裁切）", () => {
    expect(bottomFadePx(320)).toBeGreaterThanOrEqual(24);
    expect(bottomFadePx(430)).toBe(30);
    expect(bottomFadePx(3000)).toBeLessThanOrEqual(36);
  });

  test("角色底边被抬到字幕带上沿之上 SUBTITLE_GAP_PX", () => {
    // 改前实测：角色底边 848.1，字幕带上沿 799.1（底边压在字幕带里 49px）
    const bottom = photoBottomPx(932, 799.1);
    const charBottom = 932 - bottom;
    expect(charBottom).toBeCloseTo(799.1 - SUBTITLE_GAP_PX, 0);
    expect(charBottom).toBeLessThan(799.1);
  });

  test("没有字幕时回落到 9%，字幕位置异常时被夹在 46% 以内", () => {
    expect(photoBottomPx(932, null)).toBe(Math.round(932 * 0.09));
    expect(photoBottomPx(932, 10)).toBeLessThanOrEqual(Math.round(932 * 0.46));
    expect(photoBottomPx(0, 100)).toBe(0);
  });

  test("渐隐整段落在字幕带之外：底边 - 渐隐高度 > 字幕带上沿", () => {
    const bottom = photoBottomPx(932, 799.1);
    const charBottom = 932 - bottom;
    expect(charBottom - bottomFadePx(430)).toBeLessThan(799.1);
    expect(charBottom).toBeGreaterThan(bottomFadePx(430));
  });
});

describe("propOcclusion：按角色 rect 判断桌面杯该不该隐藏", () => {
  const charRect = { x: 12.9, y: 403.4, w: 404.2, h: 444.8 };

  test("改前实测的杯子位置（99.7% 落在角色框内）→ 隐藏", () => {
    const cup = { x: 79.5, y: 679.4, w: 30.3, h: 32.1 };
    const verdict = propOcclusion(charRect, cup);
    expect(verdict.hidden).toBe(true);
    expect(verdict.overlap).toBeGreaterThan(0.9);
  });

  test("完全在角色框外的桌面道具 → 保留", () => {
    const verdict = propOcclusion(charRect, { x: 360, y: 880, w: 30, h: 32 });
    expect(verdict.hidden).toBe(false);
    expect(verdict.overlap).toBe(0);
  });

  test("只有小部分压到角色框（< 35%）→ 保留，避免把桌面道具全抹掉", () => {
    const verdict = propOcclusion(charRect, { x: 400, y: 700, w: 60, h: 40 });
    expect(verdict.hidden).toBe(false);
    expect(verdict.overlap).toBeLessThan(0.35);
  });

  test("拿不到 rect（道具不存在 / 未挂载）→ 不隐藏、不抛错", () => {
    expect(propOcclusion(null, { x: 0, y: 0, w: 10, h: 10 }).hidden).toBe(false);
    expect(propOcclusion(charRect, null).hidden).toBe(false);
    expect(propOcclusion(charRect, { x: 0, y: 0, w: 0, h: 0 })).toEqual({ hidden: false, overlap: 0 });
  });
});
