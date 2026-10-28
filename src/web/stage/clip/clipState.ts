/**
 * 片段的四态状态机 —— 纯函数，零 DOM、零定时器、零 fetch、零随机。
 *
 * 为什么单独抽出来：题目第 ⑤ 条考的是「媒体资源」的加载 / 播放结束 / 中途打断 / 失败。
 * SVG 角色动画没有资源生命周期，所以这里补一条真的 spritesheet 片段，并且把它的生命周期
 * 钉成一台可单测的机器：
 *
 *   idle ──load──▶ loading ──loaded──▶ playing ──ended──▶ ended
 *                    │                    │
 *                    ├──abort──▶ interrupted ◀──abort──┘
 *                    └──error──▶ failed
 *
 * 三条硬性质（测试逐条钉住）：
 *   ① 单向：ended 只能从 playing 进入；loading 阶段收到 ended 无效。
 *   ② 打断即终态：interrupted 之后任何事件（loaded / ended / error）都不再改变状态，
 *      于是「打断后还有什么迟到的回调把画面拉回来」在状态层就不可能发生。
 *   ③ 只回报一次：ended / failed 各自只有一次有效迁移，`reports` 计数器不会超过 1。
 *      （重复的 ended 事件不会让计数器 +1，也不会产生第二个回调。）
 *
 * 相位 → 可见性：只有 loading / playing 会占画面；ended / interrupted / failed 一律回落角色。
 */

import type { SceneState } from "../../../shared/protocol";

// ---------------------------------------------------------------- 类型

export type ClipPhase = "idle" | "loading" | "playing" | "ended" | "interrupted" | "failed";

/** 谁要求中止的：会话换 epoch / 用户打断 / 新一轮开始 / 手动 */
export type AbortReason = "epoch" | "interrupt" | "turn" | "user";

/** 生命周期回调的上报次数（唯一性由状态机保证） */
export interface ClipReports {
  ended: number;
  failed: number;
}

export interface ClipState {
  phase: ClipPhase;
  /** 当前片段 id；同一会话内用它去重 */
  clip: string | null;
  /** 进入当前相位的序号：渲染层用它判断「这是不是同一轮」，不会因为重复事件跳动 */
  seq: number;
  /** 失败原因（仅 failed 时有值） */
  error: string | null;
  /** 最近一次中止原因（仅 interrupted 时有值，便于诊断区写清楚是谁打断的） */
  abortReason: AbortReason | null;
  reports: ClipReports;
}

export type ClipEvent =
  | { type: "load"; clip: string }
  | { type: "loaded" }
  | { type: "ended" }
  | { type: "abort"; reason: AbortReason }
  | { type: "error"; message: string }
  | { type: "reset" };

/** 机器迁移时产生的「一次性副作用」：只有真的发生迁移才为 true */
export interface ClipEffect {
  ended: boolean;
  failed: boolean;
  interrupted: boolean;
}

export interface ClipTransition {
  state: ClipState;
  effect: ClipEffect;
}

const NO_EFFECT: ClipEffect = { ended: false, failed: false, interrupted: false };

export const IDLE_CLIP: ClipState = {
  phase: "idle",
  clip: null,
  seq: 0,
  error: null,
  abortReason: null,
  reports: { ended: 0, failed: 0 },
};

const ACTIVE = new Set<ClipPhase>(["loading", "playing"]);

// ---------------------------------------------------------------- 迁移

/**
 * 状态迁移。返回下一次状态 + 本次迁移的副作用。
 * 任何「无效事件」都返回**同一个 state 引用**且副作用全 false：
 * 调用方（React / 播放器）可以据此跳过重渲染，测试也能断言「状态没被迟到事件改动」。
 */
export function clipReducer(state: ClipState, event: ClipEvent): ClipTransition {
  switch (event.type) {
    case "reset": {
      if (state.phase === "idle" && state.clip === null) return { state, effect: NO_EFFECT };
      return { state: { ...IDLE_CLIP, reports: state.reports }, effect: NO_EFFECT };
    }

    case "load": {
      // 同一片段的重复 load 不重开；播放中也不允许被另一条 load 顶掉（必须先 abort）
      if (ACTIVE.has(state.phase)) return { state, effect: NO_EFFECT };
      return {
        state: {
          phase: "loading",
          clip: event.clip,
          seq: state.seq + 1,
          error: null,
          abortReason: null,
          reports: state.reports,
        },
        effect: NO_EFFECT,
      };
    }

    case "loaded": {
      if (state.phase !== "loading") return { state, effect: NO_EFFECT };
      return {
        state: { ...state, phase: "playing", seq: state.seq + 1 },
        effect: NO_EFFECT,
      };
    }

    case "ended": {
      if (state.phase !== "playing") return { state, effect: NO_EFFECT };
      return {
        state: {
          ...state,
          phase: "ended",
          seq: state.seq + 1,
          reports: { ...state.reports, ended: state.reports.ended + 1 },
        },
        effect: { ...NO_EFFECT, ended: true },
      };
    }

    case "abort": {
      if (!ACTIVE.has(state.phase)) return { state, effect: NO_EFFECT };
      return {
        state: {
          ...state,
          phase: "interrupted",
          seq: state.seq + 1,
          abortReason: event.reason,
          error: null,
        },
        effect: { ...NO_EFFECT, interrupted: true },
      };
    }

    case "error": {
      if (!ACTIVE.has(state.phase)) return { state, effect: NO_EFFECT };
      return {
        state: {
          ...state,
          phase: "failed",
          seq: state.seq + 1,
          error: event.message.trim() === "" ? "未知错误" : event.message,
          abortReason: null,
          reports: { ...state.reports, failed: state.reports.failed + 1 },
        },
        effect: { ...NO_EFFECT, failed: true },
      };
    }

    default:
      return { state, effect: NO_EFFECT };
  }
}

// ---------------------------------------------------------------- 查询

/** 占用画面吗？loading（轻提示）与 playing（画面）占；其余一律回落角色。 */
export function clipVisible(state: Pick<ClipState, "phase">): boolean {
  return ACTIVE.has(state.phase);
}

export function clipSettled(state: Pick<ClipState, "phase">): boolean {
  return state.phase === "ended" || state.phase === "interrupted" || state.phase === "failed";
}

/** 诊断区 / 状态提示用的中文短语 */
export function clipPhaseLabel(phase: ClipPhase): string {
  switch (phase) {
    case "idle":
      return "未播放";
    case "loading":
      return "载入中";
    case "playing":
      return "播放中";
    case "ended":
      return "已放完";
    case "interrupted":
      return "已打断";
    case "failed":
      return "失败（已降级）";
  }
}

export function abortReasonLabel(reason: AbortReason): string {
  switch (reason) {
    case "epoch":
      return "会话 epoch 变化";
    case "interrupt":
      return "用户打断";
    case "turn":
      return "新一轮开始";
    case "user":
      return "手动中止";
  }
}

// ---------------------------------------------------------------- 触发

/**
 * 这一帧画面算不算「storm 类演出」。
 *
 * 判定与 cues.ts 的 storm 模板保持一致（闪电本身，或「大雨 + 镜头抖 / 冷颤」组合），
 * 但**不 import** cues.ts：那条线正在被另一个改动同时编辑，这里只依赖已冻结的 SceneState。
 */
export const STORM_VFX_HIT = 0.2;
export const STORM_RAIN_HIT = 0.35;

export function isStormShot(
  scene: Pick<SceneState, "vfx" | "camera" | "pendingActions">,
): boolean {
  const lightning = scene.vfx.lightning ?? 0;
  if (lightning >= STORM_VFX_HIT) return true;
  const rainHeavy = scene.vfx.rain_heavy ?? 0;
  return (
    rainHeavy >= STORM_RAIN_HIT &&
    (scene.camera === "shake" ||
      scene.pendingActions.includes("shiver") ||
      scene.pendingActions.includes("startle"))
  );
}

// ---------------------------------------------------------------- 已播集合

export interface PlayedClips {
  has(id: string): boolean;
  /** 标记为已播；返回 true 表示这次是新标记 */
  add(id: string): boolean;
  clear(): void;
  readonly size: number;
}

/**
 * 会话内已播集合：同一个片段在一次会话里只播一次。
 * 刻意不是定时器 / 轮播：唯一入口是「storm 演出命中」。
 */
export function createPlayedClips(): PlayedClips {
  const seen = new Set<string>();
  return {
    has: (id) => seen.has(id),
    add: (id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    clear: () => seen.clear(),
    get size() {
      return seen.size;
    },
  };
}

// ---------------------------------------------------------------- 片段元数据

export const CLIP_ID = "storm-strip";
export const CLIP_SRC = "/clip/storm-strip.png";
/** ?demo=media 注入的必 404 地址：路径刻意与真实资源分开，避免缓存或回退把 404 变成 200 */
export const CLIP_MISSING_SRC = "/clip/demo-missing/storm-strip.png";

export function clipSrcFor(mediaFault: boolean): string {
  return mediaFault ? CLIP_MISSING_SRC : CLIP_SRC;
}

export const CLIP_FRAME_W = 320;
export const CLIP_FRAME_H = 180;
export const CLIP_FRAMES = 12;
export const CLIP_FPS = 12;
/** 整段时长：12 帧 @12fps = 1000ms */
export const CLIP_DURATION_MS = (CLIP_FRAMES * 1000) / CLIP_FPS;

/** 已播毫秒 → 帧号（纯函数，越界夹到末帧） */
export function frameAt(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const index = Math.floor((elapsedMs * CLIP_FPS) / 1000);
  return Math.min(CLIP_FRAMES - 1, index);
}
