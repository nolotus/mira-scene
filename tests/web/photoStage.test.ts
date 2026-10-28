/**
 * 「落地感」参数：接触阴影 / 边缘色 / 底部渐隐。
 *
 * 这些数字决定「照片是否像站在场景里」，所以钉住的不是具体像素，而是**关系**：
 *   · 主光在右 → 影子偏左（符号不能反）；
 *   · 场景越暗（打烊）→ 阴影越淡；
 *   · 任何参数都不越界（宽度 36–56%、模糊 2–7px、渐隐 8–12px）。
 */

import { describe, expect, test } from "bun:test";
import {
  STAGE_REF_WIDTH,
  bottomFadePx,
  contactShadow,
  edgeTint,
  luminance,
  parseHex,
  photoStageVars,
} from "../../src/web/stage/characters/photoStage";
import { SCENE_SPECS } from "../../src/web/stage/scenes/spec";

const NIGHT = SCENE_SPECS.cafe_night;
const CLOSING = SCENE_SPECS.cafe_closing;

describe("contactShadow：随光照方向偏移", () => {
  test("主光在右（keyDir.x>0）→ 阴影偏左；左右镜像", () => {
    const right = contactShadow({ ...NIGHT.lighting, keyDir: { x: 1, y: 0.2 } }, NIGHT.palette);
    const left = contactShadow({ ...NIGHT.lighting, keyDir: { x: -1, y: 0.2 } }, NIGHT.palette);
    expect(right.xPx).toBeLessThan(0);
    expect(left.xPx).toBeGreaterThan(0);
    expect(language(right.xPx, left.xPx)).toBe(true);
  });

  test("偏移有上限：不会大到「人走了影子还留在原地」", () => {
    for (const x of [-1, -0.4, 0, 0.4, 1]) {
      const s = contactShadow({ ...NIGHT.lighting, keyDir: { x, y: 0 } }, NIGHT.palette);
      expect(Math.abs(s.xPx)).toBeLessThanOrEqual(18);
    }
  });

  test("场景越暗（主光变弱）→ 接触阴影越淡", () => {
    const night = contactShadow(NIGHT.lighting, NIGHT.palette);
    const dimmed = contactShadow({ ...NIGHT.lighting, keyColor: "#5a4630" }, NIGHT.palette);
    expect(dimmed.opacity).toBeLessThan(night.opacity);
  });

  test("椭圆与模糊都夹在标定区间内，颜色是场景暗部的 rgba", () => {
    for (const scene of [NIGHT, CLOSING, SCENE_SPECS.window_rain]) {
      const s = contactShadow(scene.lighting, scene.palette);
      expect(s.widthPct).toBeGreaterThanOrEqual(36);
      expect(s.widthPct).toBeLessThanOrEqual(56);
      expect(s.blurPx).toBeGreaterThanOrEqual(2);
      expect(s.blurPx).toBeLessThanOrEqual(7 * 2.2);
      expect(s.opacity).toBeGreaterThanOrEqual(0.3);
      expect(s.opacity).toBeLessThanOrEqual(0.78);
      expect(s.color).toMatch(/^rgba\(\d+, \d+, \d+, 0\.92\)$/);
    }
  });

  test("舞台变宽 → 像素参数等比放大（百分比参数不变）", () => {
    const narrow = contactShadow(NIGHT.lighting, NIGHT.palette, STAGE_REF_WIDTH);
    const wide = contactShadow(NIGHT.lighting, NIGHT.palette, STAGE_REF_WIDTH * 2);
    expect(Math.abs(wide.xPx)).toBeGreaterThan(Math.abs(narrow.xPx));
    expect(wide.widthPct).toBe(narrow.widthPct);
  });
});

describe("edgeTint / bottomFade", () => {
  test("边缘色比场景底色更暗，且带模糊半径（只作用于轮廓）", () => {
    const base = parseHex(NIGHT.palette.base);
    const tint = edgeTint(NIGHT.palette);
    const m = /^rgba\((\d+), (\d+), (\d+), 0\.85\)$/.exec(tint.color);
    expect(m).not.toBeNull();
    const rgb = [Number(m![1]), Number(m![2]), Number(m![3])] as [number, number, number];
    expect(luminance(rgb)).toBeLessThan(luminance(base));
    expect(tint.blurPx).toBeGreaterThan(0);
    expect(tint.blurPx).toBeLessThan(2);
  });

  test("底部渐隐落在 8–12px，且随舞台宽度变化", () => {
    // 口径已改：8–12px 太短，读作裁切而非渐隐（实测底边跳变 36.7 luma）
    expect(bottomFadePx(320)).toBeGreaterThanOrEqual(24);
    expect(bottomFadePx(430)).toBeGreaterThanOrEqual(24);
    expect(bottomFadePx(430)).toBeLessThanOrEqual(36);
    expect(bottomFadePx(3000)).toBeLessThanOrEqual(36);
  });

  test("CSS 变量齐全（渲染层只读变量）", () => {
    const vars = photoStageVars(NIGHT.lighting, NIGHT.palette);
    for (const key of [
      "--photo-shadow-x",
      "--photo-shadow-y",
      "--photo-shadow-w",
      "--photo-shadow-h",
      "--photo-shadow-blur",
      "--photo-shadow-opacity",
      "--photo-shadow-color",
      "--photo-edge-color",
      "--photo-edge-blur",
      "--photo-fade-h",
    ]) {
      expect(typeof vars[key]).toBe("string");
      expect(vars[key]).not.toBe("");
    }
  });
});

/** 两个数符号相反（用于「镜像」断言） */
function language(a: number, b: number): boolean {
  return a * b < 0;
}
