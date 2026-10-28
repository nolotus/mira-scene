/**
 * 视觉词汇表 —— SceneState → CSS 变量的纯映射。
 *
 * 这里没有任何计时器、没有网络、没有随机：同样的 state 永远得到同样的画面。
 * 渲染层只做两件事：
 *   1. 把「语义状态」（情绪/姿势/角色状态/特效）翻译成 CSS 自定义属性；
 *   2. 用 CSS 动画消费这些属性 —— 只动 transform / opacity / filter。
 */

import type {
  Action,
  CharacterStatus,
  Emotion,
  Pose,
  SceneVariant,
  Vfx,
} from "../../shared/protocol";

/** 固定顺序（渲染端口型嘴巴/眉毛时按此顺序输出，保证 DOM 稳定） */
export const EMOTION_ORDER: readonly Emotion[] = [
  "neutral",
  "curious",
  "warm",
  "amused",
  "anxious",
  "sad",
  "surprised",
];

export const EMOTION_LABEL: Record<Emotion, string> = {
  neutral: "平静",
  curious: "好奇",
  warm: "温柔",
  amused: "被逗笑",
  anxious: "不安",
  sad: "难过",
  surprised: "惊讶",
};

export const STATUS_LABEL: Record<CharacterStatus, string> = {
  idle: "待机",
  listening: "倾听",
  thinking: "思考",
  speaking: "说话",
};

export const POSE_LABEL: Record<Pose, string> = {
  stand: "站着",
  lean_in: "前倾靠近",
  turn_away: "侧身避开",
  hold_cup: "双手握杯",
  glance_window: "望向窗外",
};

export const SCENE_LABEL: Record<SceneVariant, string> = {
  cafe_night: "雨夜咖啡馆",
  cafe_closing: "打烊中",
  window_rain: "窗前落雨",
};

export const ACTION_LABEL: Record<Action, string> = {
  blink: "眨眼",
  hair_tuck: "别头发",
  sigh: "叹气",
  shiver: "打了个冷颤",
  look_back: "回头看",
  nod: "点头",
  startle: "被惊到",
};

// --------------------------------------------------------------- 姿势

export interface PoseSpec {
  /** 身体位移（SVG 视口内的 px，相对 400×560 视口） */
  x: number;
  y: number;
  rot: number;
  scale: number;
  /** 头部相对脖子的旋转与位移 */
  headRot: number;
  headX: number;
  headY: number;
  /** 杯子透明度（hold_cup 才有） */
  cup: number;
  /** 面部侧向阴影强度（turn_away / glance_window 更重） */
  shade: number;
}

export const POSE_SPEC: Record<Pose, PoseSpec> = {
  stand: { x: 0, y: 0, rot: 0, scale: 1, headRot: 0, headX: 0, headY: 0, cup: 0, shade: 0.16 },
  lean_in: { x: 2, y: -14, rot: 0, scale: 1.075, headRot: -2, headX: 2, headY: 4, cup: 0, shade: 0.1 },
  turn_away: { x: -16, y: 2, rot: -5, scale: 1.02, headRot: -17, headX: -9, headY: 3, cup: 0, shade: 0.66 },
  hold_cup: { x: 0, y: 8, rot: 0, scale: 1.01, headRot: 4, headX: 0, headY: 6, cup: 1, shade: 0.22 },
  glance_window: {
    x: -10,
    y: -2,
    rot: -4,
    scale: 1.02,
    headRot: -21,
    headX: -7,
    headY: -2,
    cup: 0,
    shade: 0.5,
  },
};

// --------------------------------------------------------------- 角色状态

export interface StatusSpec {
  /** 叠加在姿势上的身体偏移 */
  x: number;
  y: number;
  scale: number;
  headRot: number;
  headY: number;
  /** 注视方向偏移（像素） */
  gazeX: number;
  gazeY: number;
  /** 呼吸（胸腔起伏）周期，秒 —— 倾听时节奏更快，思考更慢 */
  breathDur: number;
  /** 耳侧高光 */
  earGlow: number;
}

export const STATUS_SPEC: Record<CharacterStatus, StatusSpec> = {
  idle: {
    x: 0,
    y: 0,
    scale: 1,
    headRot: 0,
    headY: 0,
    gazeX: 0,
    gazeY: 0,
    breathDur: 4.6,
    earGlow: 0,
  },
  listening: {
    x: 0,
    y: -10,
    scale: 1.04,
    headRot: -3.5,
    headY: 3,
    gazeX: 0,
    gazeY: -1,
    breathDur: 2.3,
    earGlow: 1,
  },
  thinking: {
    x: -5,
    y: 14,
    scale: 0.972,
    headRot: -6,
    headY: -2,
    gazeX: -6,
    gazeY: -4,
    breathDur: 5.8,
    earGlow: 0,
  },
  speaking: {
    x: 0,
    y: -3,
    scale: 1.018,
    headRot: 1.5,
    headY: 0,
    gazeX: 1.5,
    gazeY: 0,
    breathDur: 3.2,
    earGlow: 0,
  },
};

// --------------------------------------------------------------- 情绪

export interface EmotionSpec {
  eyeOpen: number;
  gazeX: number;
  gazeY: number;
  headTilt: number;
  headY: number;
  /** 脸颊红晕 */
  cheek: number;
  /** 环境暖度 0..1：影响暖光池、角色边缘光、整体色温 */
  warmth: number;
}

export const EMOTION_SPEC: Record<Emotion, EmotionSpec> = {
  neutral: { eyeOpen: 1, gazeX: 0, gazeY: 0, headTilt: 0, headY: 0, cheek: 0.14, warmth: 0.56 },
  curious: { eyeOpen: 1.14, gazeX: 2.5, gazeY: -2, headTilt: 5, headY: -1, cheek: 0.2, warmth: 0.62 },
  warm: { eyeOpen: 0.84, gazeX: 0, gazeY: 1.5, headTilt: -3, headY: 1, cheek: 0.52, warmth: 0.94 },
  amused: { eyeOpen: 0.7, gazeX: 1.5, gazeY: 2, headTilt: -6, headY: 2, cheek: 0.66, warmth: 0.88 },
  anxious: { eyeOpen: 1.06, gazeX: -3.5, gazeY: 1, headTilt: 2, headY: 1, cheek: 0.32, warmth: 0.3 },
  sad: { eyeOpen: 0.6, gazeX: -1.5, gazeY: 3.5, headTilt: 4, headY: 5, cheek: 0.24, warmth: 0.26 },
  surprised: { eyeOpen: 1.28, gazeX: 0, gazeY: -2, headTilt: 0, headY: -4, cheek: 0.26, warmth: 0.46 },
};

// --------------------------------------------------------------- 一次性动作

export type ActionFamily = "body" | "jitter" | "pop" | "eye" | "none";

export interface ActionSpec {
  family: ActionFamily;
  /** 毫秒 */
  dur: number;
  dy: number;
  rot: number;
}

export const ACTION_SPEC: Record<Action, ActionSpec> = {
  blink: { family: "eye", dur: 240, dy: 0, rot: 0 },
  hair_tuck: { family: "body", dur: 1500, dy: -1, rot: -3.5 },
  sigh: { family: "body", dur: 1700, dy: 10, rot: 1.6 },
  shiver: { family: "jitter", dur: 640, dy: 0, rot: 0 },
  look_back: { family: "body", dur: 1150, dy: 0, rot: -6.5 },
  nod: { family: "body", dur: 820, dy: 7, rot: 0.8 },
  startle: { family: "pop", dur: 780, dy: -9, rot: -1.8 },
};

// --------------------------------------------------------------- 特效

/** 把 vfx 强度映射成 CSS 变量（0..1，可直接参与 calc） */
export function vfxVars(vfx: Partial<Record<Vfx, number>>): Record<string, string> {
  const num = (v: number | undefined): string => String(Math.max(0, Math.min(1, v ?? 0)));
  return {
    "--vfx-lightning": num(vfx.lightning),
    "--vfx-rain-heavy": num(vfx.rain_heavy),
    "--vfx-rain-light": num(vfx.rain_light),
    "--vfx-warm-glow": num(vfx.warm_glow),
    "--vfx-lights-dim": num(vfx.lights_dim),
    "--vfx-steam-wisp": num(vfx.steam_wisp),
  };
}

// --------------------------------------------------------------- 工具

/** 由字符串得到一个稳定的色调序号：同一个 lastBeat 永远同一个视觉事件 */
export function toneOf(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 3;
}

/** 确定性伪随机（雨滴分布用，模块加载时算一次，不涉及时钟） */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
