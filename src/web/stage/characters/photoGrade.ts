/**
 * 照片角色的「合成校准」——纯函数，零 DOM、零时钟。
 *
 * 为什么这些参数要单独成文件并从场景数据算出来：定妆照是在**棚拍白底**下生成的
 * （中性光、偏亮、偏冷），而舞台是「暖吊灯 + 冷窗雨夜」。直接把这张图贴在场景里，
 * 三个破绽会同时出现：
 *
 *   ① 色温/亮度不匹配 —— 人物比场景亮一档，且高光偏冷；
 *   ② 底部硬接缝     —— 胸像被界面截断的那一刀没有过渡，读作裁切失误；
 *   ③ 道具穿帮       —— 桌面的杯子在她身体轮廓的透明缝隙里露出来，像放在肩上。
 *
 * 这三个量全部由 `SceneSpec.palette` / `SceneSpec.lighting` 推出（主光色温、基色亮度、
 * 场景色相），换场景自动跟着变；数值是**标定值**，改一个数字就能一眼看出观感差异。
 */

import type { LightingSpec, PaletteSpec } from "../scenes/spec";

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luma(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 色温代理量：R-B（与验收脚本 measurePhoto.py 的口径一致） */
function warmthOf(hex: string): number {
  const [r, , b] = parseHex(hex);
  return r - b;
}

export interface ColorGrade {
  /** CSS `saturate()` 系数（<1 = 收敛饱和度，压掉「棚拍彩度」） */
  saturate: number;
  /** CSS `brightness()` 系数（<1 = 压暗到场景亮度带） */
  brightness: number;
  /** CSS `sepia()` 系数：给高光补场景主光的暖，抵消棚拍的冷 */
  sepia: number;
  /** 场景主光色温（R-B），仅用于诊断与对拍 */
  keyWarmth: number;
  /** 场景调色板基色的亮度（0..1），仅用于诊断与对拍 */
  baseLuma: number;
}

/**
 * 调色系数：**只作用于角色像素**（img 自带 alpha，filter 不会染到背景）。
 *
 * 取值的三条口径：
 *  - 亮度：场景越暗，人像压得越狠（白棚拍出来的亮度在半暗的房间里一定「浮」）；
 *  - 饱和度：主光越暖，越要把彩度往回收 —— 暖光下人像的橙会被场景的橙顶爆；
 *  - 暖度：主光色温 R-B 越高、补光越冷，sepia 加得越多（把冷高光拉回暖）。
 */
export function colorGrade(lighting: LightingSpec, palette: PaletteSpec): ColorGrade {
  const keyWarmth = warmthOf(lighting.keyColor);
  const accentWarmth = warmthOf(palette.accent);
  const fillWarmth = warmthOf(lighting.fillColor);
  const baseLuma = luma(palette.base);

  // 暖光强度归一化：主光与主色的暖，减去补光的冷（补光越冷，需要的补偿越多）
  const warmSignal = clamp((keyWarmth + accentWarmth - fillWarmth) / 240, 0, 1);

  return {
    saturate: Math.round(clamp(1.04 - warmSignal * 0.34, 0.72, 0.98) * 100) / 100,
    brightness: Math.round(clamp(0.8 + baseLuma * 0.9, 0.8, 0.94) * 100) / 100,
    sepia: Math.round(clamp(0.02 + warmSignal * 0.16, 0.02, 0.2) * 100) / 100,
    keyWarmth,
    baseLuma: Math.round(baseLuma * 100) / 100,
  };
}

/** 一组 CSS 变量（渲染层只读变量，不读 spec 对象） */
export function gradeVars(grade: ColorGrade): Record<string, string> {
  return {
    "--photo-grade-sat": `${grade.saturate}`,
    "--photo-grade-bright": `${grade.brightness}`,
    "--photo-grade-sepia": `${grade.sepia}`,
  };
}

// ---------------------------------------------------------------- 底部渐隐与字幕带间距

/**
 * 底部渐隐高度（px）：24–36px。
 *
 * 为什么不是原来的 8–12px：8–12px 在 2× 屏上只有 16–24 个物理像素，
 * 人眼读到的不是「渐隐」而是「一刀切」——尤其是胸像底边本来就是一条水平直线。
 * 24–36px 才够把「被界面截断」读成设计。
 */
export function bottomFadePx(stageWidth = 430): number {
  return Math.round(clamp(stageWidth * 0.07, 24, 36));
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 与字幕带上沿的最小间距（px）：渐隐结束后还要留这么多空，才不像被字幕压住 */
export const SUBTITLE_GAP_PX = 12;

/**
 * 角色元素底边距离舞台底部多少 px（即 CSS `bottom`）。
 *
 * 目标：**元素底边（渐隐走到 0 的位置）落在字幕带上沿之上 SUBTITLE_GAP_PX 处**。
 * 原实现是写死的 9%，实测角色底边 848.1 而字幕带上沿 799.1 —— 角色的硬边直接
 * 压在字幕带的渐变里，所以两者叠加出一条更明显的横线。这里改成按实测字幕位置反推。
 *
 * 字幕不在了（无字幕）→ 回落到原来的 9%。
 */
export function photoBottomPx(
  canvasHeight: number,
  subtitleTop: number | null,
  fallbackRatio = 0.09,
): number {
  if (!Number.isFinite(canvasHeight) || canvasHeight <= 0) return 0;
  const fallback = canvasHeight * fallbackRatio;
  if (subtitleTop === null || !Number.isFinite(subtitleTop)) return Math.round(fallback);
  const targetTop = subtitleTop - SUBTITLE_GAP_PX;
  const bottom = canvasHeight - targetTop;
  // 不允许把人像顶到舞台上半场（>46% 就说明字幕带了异常高，宁可按旧值走）
  return Math.round(clamp(bottom, 0, canvasHeight * 0.46));
}

// ---------------------------------------------------------------- 道具遮挡判定

export interface PropOcclusion {
  /** 该道具是否应被判为「被角色挡住」而隐藏 */
  hidden: boolean;
  /** 道具 rect 落在角色 rect 内的面积比例（0..1），诊断用 */
  overlap: number;
}

/**
 * 桌面道具（杯子/碟子）是否该隐藏。
 *
 * 判据不是「谁在上面」——z-order 本来是对的（道具在角色层之下）。
 * 问题是道具落在**角色 rect 内部的透明缝隙**里（抠图边缘之外、肩线旁边），
 * 既没有被人挡住、也不在场景里，视觉上读作「杯子放在她肩上」。
 * 所以按 rect 做遮挡判定：道具大部分落在角色框内 → 直接隐藏，交给场景的空桌。
 *
 * 阈值 0.35 是标定值：低于它说明道具主要在桌面上，留着更像场景道具。
 */
export function propOcclusion(
  charRect: Rect | null,
  propRect: Rect | null,
  threshold = 0.35,
): PropOcclusion {
  if (!charRect || !propRect) return { hidden: false, overlap: 0 };
  const ix = Math.max(0, Math.min(charRect.x + charRect.w, propRect.x + propRect.w) - Math.max(charRect.x, propRect.x));
  const iy = Math.max(0, Math.min(charRect.y + charRect.h, propRect.y + propRect.h) - Math.max(charRect.y, propRect.y));
  const propArea = propRect.w * propRect.h;
  if (propArea <= 0) return { hidden: false, overlap: 0 };
  const overlap = (ix * iy) / propArea;
  return { hidden: overlap >= threshold, overlap: Math.round(overlap * 1000) / 1000 };
}
