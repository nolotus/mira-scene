/**
 * 照片角色的「表演逻辑」——纯函数，不碰 DOM、不碰时钟、不碰随机。
 *
 * 与 SVG 版的分工刻意相反：SVG 可以逐路径抖动（眼睑开口、眉形、下颌弧线都是可微调的量），
 * 照片只有三张眼睛 / 三张嘴，能动的只有「换哪一个 + 换多快」。所以这里做三件事：
 *   ① 把字幕换算成口型节奏（沿用 SVG 版的口型序列与哈希，换一张图也不换节奏）；
 *   ② 把 (情绪, 状态, 眨眼) 收敛到 (眼变体, 嘴变体)；
 *   ③ 给出位移/呼吸/过渡时长——**幅度统统比 SVG 版小**，否则静态照片一动就像在抖。
 */

import type { CharacterStatus, Emotion } from "../../../shared/protocol";
import { EYE_VARIANTS, MOUTH_VARIANTS, type EyeVariant, type MouthVariant } from "./portraitSpec";

/** SVG 版的三相位口型序列（0 闭合 / 1 半开 / 2 圆 / 3 扁），原样沿用 */
export const TALK_SEQ = [1, 0, 2, 1, 3, 0, 1, 2, 1, 0, 3, 1] as const;

/** 首音节延迟（ms）：先闭嘴一拍再开口，和 SVG 版一致 */
export const SPEAK_ONSET_MS = 70;

/** 单音节最短时长（ms）：再快就成了摩尔纹，3 张图撑不住 */
export const MIN_SYLLABLE_MS = 116;

/** 节奏推进的步数上限：字幕异常长时不至于在一次 rAF 里算上万步 */
export const MAX_STEPS = 512;

/**
 * 快语速阈值（ms）：基准音节间隔短于它时，`half` 不再出现，口型退化成「闭合 / 张开」两态。
 *
 * 为什么要有这一条：3 张图在 116ms 的间隔里轮转，眼睛读到的不是「说话」而是「抖动」；
 * 两态交替虽然信息更少，但起码读得动。判据取**基准节奏**（`syllableMs(count)`）而不是
 * 逐音节的 jitter 后间隔——否则同一句台词会在两种模式之间来回切，比抖动更难看。
 */
export const FAST_SYLLABLE_MS = 180;

/**
 * 4 相位 → 3 张变体：圆(2) 给 `open`，半开(1) 与扁(3) 都落到 `half`，
 * 闭合(0) 给 `closed`。少一张图不会让嘴「卡在张着」。
 */
export function mouthVariantOfPhase(phase: number): MouthVariant {
  if (phase === 0) return "closed";
  if (phase === 2) return "open";
  return "half";
}

/** mouth 变体 → MOUTH_VARIANTS 下标（渲染层用它切 opacity，测试用它断言节奏） */
export function mouthVariantIndex(variant: MouthVariant): 0 | 1 | 2 {
  const index = MOUTH_VARIANTS.indexOf(variant);
  return (index < 0 ? 0 : index) as 0 | 1 | 2;
}

/** 字越多 → 音节越短（沿用 SVG 版的线性关系，只是换了常数项口径） */
export function syllableMs(charCount: number): number {
  return Math.max(MIN_SYLLABLE_MS, 262 - charCount * 3.4);
}

/** 第 step 个音节的哈希（同一句台词永远不会掉进固定循环） */
function hashOf(code: number, step: number, charCount: number): number {
  return (code * 31 + step * 17 + charCount * 7) % 996;
}

/** 第 step 个音节的口型变体（内部版：字符数组只切一次，长字幕也不会每步重新 Array.from） */
function variantOfChars(chars: readonly string[], step: number): MouthVariant {
  const count = chars.length;
  if (count === 0 || step < 0) return "closed";
  const code = chars[step % count]?.codePointAt(0) ?? 0;
  const h = hashOf(code, step, count);
  const phase = TALK_SEQ[h % TALK_SEQ.length] ?? 1;
  return mouthVariantOfPhase(phase);
}

/** 第 step 个音节持续多久（内部版）：基准节奏 + 哈希抖动，闭合相位多停 52ms（换气） */
function gapOfChars(chars: readonly string[], step: number): number {
  const count = chars.length;
  if (count === 0) return MIN_SYLLABLE_MS;
  const code = chars[step % count]?.codePointAt(0) ?? 0;
  const h = hashOf(code, step, count);
  const phase = TALK_SEQ[h % TALK_SEQ.length] ?? 1;
  return syllableMs(count) + (h % 6) * 21 + (phase === 0 ? 52 : 0);
}

/** 第 step 个音节的口型变体（对外版，测试与调试用） */
export function syllableVariant(subtitle: string, step: number): MouthVariant {
  return variantOfChars(Array.from(subtitle), step);
}

/** 第 step 个音节持续多久（对外版） */
export function syllableGap(subtitle: string, step: number): number {
  return gapOfChars(Array.from(subtitle), step);
}

/**
 * 口型节奏函数：**给定字幕与已说话时长，返回此刻应有的口型**（MOUTH_VARIANTS 下标）。
 *
 * 纯函数（同输入同输出），时间由调用方提供——组件里是一个节流计时器，
 * 测试里是一串手写的时间点，不需要 fake timer。
 */
export function mouthIndex(subtitle: string, elapsedMs: number): 0 | 1 | 2 {
  // 纯空白字幕视为没有字幕：闭合，不留一张「空张着的嘴」
  const chars = typeof subtitle === "string" ? Array.from(subtitle.trim()) : [];
  if (chars.length === 0) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;

  const fast = syllableMs(chars.length) < FAST_SYLLABLE_MS;
  let at = SPEAK_ONSET_MS;
  let current = mouthVariantIndex("closed");
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    if (elapsedMs < at) break;
    let next = mouthVariantIndex(variantOfChars(chars, step));
    // 快语速：半开位退化成「与上一帧相反的闭合/张开」，两态交替读作语速快，三态读作抽筋
    if (fast && next === 1) next = current === 2 ? 0 : 2;
    current = next;
    at += gapOfChars(chars, step);
  }
  return current;
}

/** 便捷版：直接给变体名 */
export function mouthAt(subtitle: string, elapsedMs: number): MouthVariant {
  return MOUTH_VARIANTS[mouthIndex(subtitle, elapsedMs)] ?? "closed";
}

/**
 * 眼睛能表达的只有三档，这是照片方案**最大的信息损失**：
 * 7 种情绪里有 5 种共用 `open`，所以「好奇」和「惊讶」在照片上主要靠嘴和身体区分。
 * 映射原则是「按 SVG 版 EMOTION_SPEC.eyeOpen 的档位分箱」，不另造语义：
 *   eyeOpen ≥ 1.0 → open，0.6–1.0 → half（笑眼/疲惫/难过都是眼睑压低）。
 * `closed` 不给任何情绪——它被眨眼独占，否则「难过」和「眨眼」会混淆。
 */
export const EMOTION_FACE: Record<Emotion, { eyes: EyeVariant; mouth: MouthVariant }> = {
  // eyeOpen 1      / 嘴角平
  neutral: { eyes: "open", mouth: "closed" },
  // eyeOpen 1.14   / 说话欲（半开）
  curious: { eyes: "open", mouth: "half" },
  // eyeOpen 0.84   / 柔和闭唇
  warm: { eyes: "half", mouth: "closed" },
  // eyeOpen 0.7    / 笑意（半开半合）
  amused: { eyes: "half", mouth: "half" },
  // eyeOpen 1.06 但是「闭一下忍住」/ 抿嘴 —— 用 closed 与眨眼共用一张图属已知妥协
  anxious: { eyes: "closed", mouth: "half" },
  // eyeOpen 0.6    / 半张口的一声叹
  sad: { eyes: "half", mouth: "open" },
  // eyeOpen 1.28   / 圆口
  surprised: { eyes: "open", mouth: "open" },
};

export interface FaceInput {
  emotion: Emotion;
  status: CharacterStatus;
  subtitle: string;
  /** 说话已持续的毫秒数（非说话态忽略） */
  elapsedMs: number;
  /** 眨眼进行中：盖住情绪眼。只在 eyes_closed.png 存在时由渲染层传 true */
  blinking?: boolean;
}

/** (情绪, 状态, 眨眼) → 这一帧该显示哪张眼/哪张嘴 */
export function faceAt(input: FaceInput): { eyes: EyeVariant; mouth: MouthVariant } {
  const base = EMOTION_FACE[input.emotion];
  const eyes: EyeVariant = input.blinking ? "closed" : base.eyes;
  const speaking = input.status === "speaking" && input.subtitle.trim() !== "";
  const mouth: MouthVariant = speaking ? mouthAt(input.subtitle, input.elapsedMs) : base.mouth;
  return { eyes, mouth };
}

// ---------------------------------------------------------------- 位移与过渡

/**
 * 微动幅度表。**每一项都刻意小于 SVG 版**（SVG 的呼吸/摆动动在矢量分层上，
 * 照片一动就是整张脸在抖，所以：整体缩放 0.6% 封顶，旋转 0.3° 封顶，点头位移 ≤2px）。
 */
export const PHOTO_MOTION = {
  /** 呼吸周期（s）：与 SVG 版 STATUS_SPEC.breathDur.idle 对齐 */
  breathDur: 4.6,
  /** 呼吸缩放上限（1.000 ↔ 1.006） */
  breathScale: 1.006,
  /** 说话点头的旋转幅度（°） */
  nodDeg: 0.3,
  /** 说话点头的位移幅度（px） */
  nodPx: 1.6,
  /** 状态切换过渡（ms）：120–200 之间，见 transitionMs() */
  transitionMs: 160,
  /** 变体交叉淡入（ms）：太快读作闪烁，太慢读作两张嘴 */
  variantFadeMs: 90,
} as const;

/** 状态 → 站位（px / 倍率 / 度）。数值口径与 SVG STATUS_SPEC 同源，但只用于站位，不参与动画 */
export const STATUS_PLACEMENT: Record<CharacterStatus, { y: number; scale: number; rot: number }> = {
  idle: { y: 0, scale: 1, rot: 0 },
  /** 倾听：前倾（原 brief 定的 -10px） */
  listening: { y: -10, scale: 1.02, rot: -0.2 },
  /** 思考：下移 + 极轻的歪头 */
  thinking: { y: 12, scale: 0.99, rot: -0.3 },
  /** 说话：略上提，点头的正负号由 CSS keyframes 负责 */
  speaking: { y: -3, scale: 1.006, rot: 0 },
};

/**
 * 过渡时长：基础 140ms，位移越大越长，但**严格夹在 120–200ms**。
 * 太短读作跳帧，太长会让「打断」失去即时感。
 */
export function transitionMs(prev: CharacterStatus | null, next: CharacterStatus): number {
  const a = prev ? STATUS_PLACEMENT[prev] : null;
  const b = STATUS_PLACEMENT[next];
  if (!a) return PHOTO_MOTION.transitionMs;
  const dy = Math.abs(b.y - a.y);
  const dScale = Math.abs(b.scale - a.scale) * 1000;
  const dRot = Math.abs(b.rot - a.rot) * 10;
  const raw = 140 + dy * 3 + dScale * 0.5 + dRot * 0.6;
  return Math.round(Math.min(200, Math.max(120, raw)));
}

/** 是否该跑微动（prefers-reduced-motion 下全关） */
export function motionEnabled(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

/** 眼变体名 → 稳定的 data 属性值（截图/断言用） */
export function faceKey(eyes: EyeVariant, mouth: MouthVariant): string {
  return `${eyes}+${mouth}`;
}

/** 全部可能的眼/嘴组合（测试用：确认映射表只产出于契约内的名字） */
export function faceVariantsUsed(): { eyes: EyeVariant[]; mouth: MouthVariant[] } {
  const eyes = new Set<EyeVariant>();
  const mouth = new Set<MouthVariant>();
  for (const e of Object.keys(EMOTION_FACE) as Emotion[]) {
    eyes.add(EMOTION_FACE[e].eyes);
    mouth.add(EMOTION_FACE[e].mouth);
  }
  return {
    eyes: [...eyes].filter((v) => EYE_VARIANTS.includes(v)),
    mouth: [...mouth].filter((v) => MOUTH_VARIANTS.includes(v)),
  };
}
