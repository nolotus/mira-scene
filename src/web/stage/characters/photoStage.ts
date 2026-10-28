/**
 * 照片角色的「落地感」参数 —— 纯函数，零 DOM、零时钟。
 *
 * 三件事都只回答一个问题：**这张定妆照怎么和场景发生关系**，而不是继续修图。
 * 素材一个像素都不改（改图等于换脸，已验证不可行），所以「贴上去」的三个破绽
 * 只能用合成手段压下去：
 *
 *   ① 接触阴影 —— 人站在地上，脚下必须有一块随光源方向偏移的暗部；
 *   ② 边缘色匹配 —— 抠图边缘残留的亮边必须往场景主色拉一档，而不是整体调色；
 *   ③ 底部渐隐 —— 胸像被界面截断要么是设计（渐隐），要么是裁切失误（硬切）。
 *
 * 参数全部来自 `SceneSpec.lighting` / `SceneSpec.palette`，不写死：
 * 换一个场景（海边逆光 vs 室内吊灯）阴影方向与边缘色自动跟着变，观感不需要逐场手调。
 */

import type { LightingSpec, PaletteSpec } from "../scenes/spec";
import { bottomFadePx, colorGrade, gradeVars } from "./photoGrade";

/** 舞台基准宽度（设计稿 430×932）：像素级参数按这个宽度标定，再按实际宽度缩放 */
export const STAGE_REF_WIDTH = 430;

export interface ContactShadowSpec {
  /** 横向偏移（px，屏幕坐标，正右）：由 keyDir.x 决定，随光照方向走 */
  xPx: number;
  /** 纵向偏移（px）：光源越高，影子越贴近脚下（keyDir.y 越负 → 影子越收） */
  yPx: number;
  /** 椭圆宽度（相对角色宽度的百分比） */
  widthPct: number;
  /** 椭圆高度（px） */
  heightPx: number;
  /** 模糊半径（px）：shadowSoftness 越大越散 */
  blurPx: number;
  /** 不透明度 0..1：场景主光越亮，接触阴影越明确 */
  opacity: number;
  /** 阴影颜色（rgba 字符串）：取场景 depth 色再压暗，保证「同一场景里的暗」 */
  color: string;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** `#rrggbb` → [r,g,b]（解析失败回落到近黑，不抛错：渲染期抛错等于白屏） */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [8, 5, 4];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 相对亮度（0..1，sRGB 感知近似）：只用来判断「这个场景亮不亮」，不用于颜色计算 */
export function luminance(rgb: [number, number, number]): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** 往黑里混：`amount` 越大越暗（阴影要落在场景暗部那一档，而不是纯黑） */
function darken(rgb: [number, number, number], amount: number): [number, number, number] {
  const k = clamp(1 - amount, 0, 1);
  return [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)];
}

/**
 * 接触阴影：横向偏移直接取主光方向（`keyDir.x` 指向光源，影子朝反方向），
 * 纵向偏移取 `keyDir.y` 的一半 —— 光源越靠上，影子越贴着脚下收。
 *
 * 上限 ±18px 是**标定值**：再大就不像接触阴影，而像「人被挪走了、影子还留在原地」。
 */
export function contactShadow(
  lighting: LightingSpec,
  palette: PaletteSpec,
  stageWidth = STAGE_REF_WIDTH,
): ContactShadowSpec {
  const scale = clamp(stageWidth / STAGE_REF_WIDTH, 0.6, 2.2);
  const dx = clamp(-lighting.keyDir.x, -1, 1);
  const dy = clamp(lighting.keyDir.y, -1, 1);
  // 主光越亮（keyColor 越亮）→ 接触阴影越实；打烊/关灯场景自动变淡
  const keyLevel = luminance(parseHex(lighting.keyColor));
  const opacity = clamp(0.34 + keyLevel * 0.42, 0.3, 0.78);
  const base = parseHex(palette.depth);
  const [r, g, b] = darken(base, 0.45);
  return {
    xPx: Math.round(dx * 14 * scale),
    yPx: Math.round(dy * 4 * scale),
    widthPct: Math.round(clamp(46 + dx * 6, 36, 56)),
    heightPx: Math.round(clamp(10 + (1 - keyLevel) * 6, 8, 18) * scale),
    blurPx: Math.round(clamp(2 + lighting.shadowSoftness * 4, 2, 7) * scale),
    opacity: Math.round(opacity * 100) / 100,
    color: `rgba(${r}, ${g}, ${b}, 0.92)`,
  };
}

/**
 * 边缘色匹配：drop-shadow 打一圈**近零模糊**的场景暗色。
 *
 * 为什么是 drop-shadow 而不是整体 `brightness()`：亮边只存在于 alpha 过渡的那 1–2px，
 * 整体调色会连脸一起暗掉。drop-shadow 落在 alpha 背后，只和被抠图边缘的半透明像素
 * 合成 —— 等于「用场景的暗色给轮廓补一道内吸的边」，受影响的正是那一圈。
 *
 * 颜色取 palette.base 再压暗：既不是纯黑（会像描边），又比场景亮部暗一档。
 */
export function edgeTint(palette: PaletteSpec): { color: string; blurPx: number } {
  const [r, g, b] = darken(parseHex(palette.base), 0.55);
  return { color: `rgba(${r}, ${g}, ${b}, 0.85)`, blurPx: 0.85 };
}

/**
 * 底部渐隐高度（px）：改到 24–36px，实现移到 `photoGrade.bottomFadePx`
 * （连同「与字幕带上沿留间距」的推导放在一起，改前 8–12px 那条已经作废）。
 */
export { bottomFadePx } from "./photoGrade";

/** 全部参数 → 一组 CSS 变量（渲染层只读变量，不读 spec 对象） */
export function photoStageVars(
  lighting: LightingSpec,
  palette: PaletteSpec,
  stageWidth = STAGE_REF_WIDTH,
): Record<string, string> {
  const shadow = contactShadow(lighting, palette, stageWidth);
  const edge = edgeTint(palette);
  return {
    "--photo-shadow-x": `${shadow.xPx}px`,
    "--photo-shadow-y": `${shadow.yPx}px`,
    "--photo-shadow-w": `${shadow.widthPct}%`,
    "--photo-shadow-h": `${shadow.heightPx}px`,
    "--photo-shadow-blur": `${shadow.blurPx}px`,
    "--photo-shadow-opacity": `${shadow.opacity}`,
    "--photo-shadow-color": shadow.color,
    "--photo-edge-color": edge.color,
    "--photo-edge-blur": `${edge.blurPx}px`,
    "--photo-fade-h": `${bottomFadePx(stageWidth)}px`,
    // 调色（色温 / 亮度 / 暖度）与上面三项同源：全部由 palette / lighting 推出
    ...gradeVars(colorGrade(lighting, palette)),
  };
}
