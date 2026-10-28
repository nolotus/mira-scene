/**
 * 演出编排层（cue）—— 把离散的 directive 编排成「一段有时长的演出」。
 *
 * 为什么需要这一层：
 *   状态机把每条 directive 逐条写进 SceneState，渲染层各自播各自的动画（闪电一条 CSS、
 *   镜头一条 CSS、动作一条 CSS）。那是「五个独立事件」，不是「一句话换来的一段画面变化」。
 *   这里把「当前画面上命中什么内容」翻译成一条 Cue：有总时长、有分层、有先后、
 *   有联动（闪电 → 雨势 → 镜头抖动 → 角色动作），渲染层只负责把 Cue 的时间线交给 CSS。
 *
 * 本文件是纯 TS：零 DOM、零 React、零定时器、零随机。
 *   · composeCue()      状态 → Cue（同输入必同输出，可单测）
 *   · createCueScheduler()  跨帧状态：合并（幂等）/ 打断（淡出）/ 自然收尾
 * 渲染（CSS 变量 + 动画）在 Cues.tsx / cues.css。
 */

import type { SceneState, Vfx } from "../../shared/protocol";

// ---------------------------------------------------------------- 类型

/** Cue 能驱动的视觉层（与 Cues.tsx 的 DOM 层一一对应） */
export type CueTarget = "lightning" | "rain" | "camera" | "glow" | "char";

/** 四套固定模板：命中哪一类内容，就播哪一套编排 */
export type CueKind = "storm" | "window_call" | "warm_beat" | "close_down";

/**
 * 分层时间线。`atMs` 相对 cue 起点，`durationMs` 是该层的时长：
 *   · 0 时刻 = 该层的 from 值
 *   · atMs + durationMs = 该层的 to 值（此后保持 to，由 .cue-stage 收尾淡出）
 * from / to 都是 0..1 的强度（camera 层是位移幅度）。
 */
export interface CueLayer {
  target: CueTarget;
  from: number;
  to: number;
  atMs: number;
  durationMs: number;
}

export interface Cue {
  /** 这一次演出的唯一 id（key + 起始时刻）——渲染层用它做 React key / 动画重播 */
  id: string;
  /** 内容指纹（不含时间）：同一个 beat 的同一类命中 → 同一条 key → 幂等合并 */
  key: string;
  /** 触发它的 beat id（SceneState.lastBeat），换 beat 才重新编排 */
  beat: string;
  kind: CueKind;
  startedAt: number;
  durationMs: number;
  /** 整体强度 0..1（vfx 强度 / 情绪决定），CSS 里作为各层的乘数 */
  intensity: number;
  /** 按 atMs 升序：时间线即演出 */
  layers: CueLayer[];
}

export type FadeReason = "interrupt" | "end";

export interface FadingCue {
  cue: Cue;
  startedAt: number;
  durationMs: number;
  reason: FadeReason;
}

/** 调度器状态：至多一条正在演出的 cue + 至多一条正在淡出的 cue（旧的那条） */
export interface CueState {
  active: Cue | null;
  fadeOut: FadingCue | null;
  /** 只在「真的换了画面」时 +1：渲染层据此跳过一次重渲染，避免 60fps setState */
  version: number;
}

export interface CueScheduler {
  state(): CueState;
  now(): number;
  /** 输入当前场景；无可编排内容且无收尾动作时返回同一个引用（调用方可据此跳过重渲染） */
  update(scene: SceneState): CueState;
  reset(): CueState;
}

// ---------------------------------------------------------------- 常量

/** 同一 kind 在这个窗口内重复触发 → 合并（不叠加、不重播） */
export const MERGE_WINDOW_MS = 400;
/** 被打断的旧 cue 的淡出时长（要求 80–160ms，硬切会「跳帧」） */
export const FADE_OUT_MS = 110;
/** cue 自然演完后的收尾淡出：让最后一层的 to 值（例如雨密度 0.9）不至于瞬间消失 */
export const EXIT_FADE_MS = 260;

export const EMPTY_CUE_STATE: CueState = { active: null, fadeOut: null, version: 0 };

/** vfx 强度达到这个值才算「内容命中」，避免残留的 0.03 尾巴反复触发编排 */
const VFX_HIT = 0.2;

/**
 * 四套固定模板（kind → 各层时间线）。
 * 约束（见测试）：闪电早于雨势；镜头抖动紧随闪电 120–260ms；角色动作落在抖动尾段。
 */
export const CUE_TEMPLATES: Readonly<Record<CueKind, { durationMs: number; layers: readonly CueLayer[] }>> = {
  // 雷雨：0 爆闪 → 120 雨势起 → 220 抖动（闪电后 220ms）→ 820 角色一颤（抖动尾段）
  storm: {
    durationMs: 1800,
    layers: [
      { target: "lightning", from: 1, to: 0, atMs: 0, durationMs: 320 },
      { target: "rain", from: 0.25, to: 0.9, atMs: 120, durationMs: 1000 },
      { target: "camera", from: 1, to: 0, atMs: 220, durationMs: 780 },
      { target: "char", from: 0.9, to: 0.12, atMs: 820, durationMs: 460 },
    ],
  },
  // 望向窗外 / 电话那端：窗外冷光起 → 轻推 → 她慢慢回头
  window_call: {
    durationMs: 1600,
    layers: [
      { target: "rain", from: 0.3, to: 0.62, atMs: 0, durationMs: 900 },
      { target: "glow", from: 0.12, to: 0.36, atMs: 80, durationMs: 1400 },
      { target: "camera", from: 0.45, to: 0, atMs: 160, durationMs: 900 },
      { target: "char", from: 0.6, to: 0.1, atMs: 620, durationMs: 560 },
    ],
  },
  // 暖场：暖光呼吸两次 → 她抬眼 → 极轻的推近
  warm_beat: {
    durationMs: 1400,
    layers: [
      { target: "glow", from: 0.3, to: 0.82, atMs: 0, durationMs: 1250 },
      { target: "char", from: 0.45, to: 0.1, atMs: 140, durationMs: 820 },
      { target: "camera", from: 0.22, to: 0, atMs: 200, durationMs: 700 },
    ],
  },
  // 打烊：雨声变稀 → 暖光收缩 → 画面压暗下沉 → 她低头
  close_down: {
    durationMs: 2200,
    layers: [
      { target: "rain", from: 0.5, to: 0.28, atMs: 0, durationMs: 2200 },
      { target: "glow", from: 0.34, to: 0.06, atMs: 60, durationMs: 1100 },
      { target: "camera", from: 0.3, to: 0, atMs: 220, durationMs: 980 },
      { target: "char", from: 0.5, to: 0.05, atMs: 940, durationMs: 760 },
    ],
  },
};

/** 字幕里的「望向窗外 / 等的人 / 电话」——内容命中，不是定时器 */
const SUBTITLE_CALL = /窗外|外面|电话|打给|等谁|还在等|雨声/;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function vfxOf(state: SceneState, key: Vfx): number {
  const v = state.vfx[key];
  return typeof v === "number" ? v : 0;
}

// ---------------------------------------------------------------- 内容命中

/**
 * 状态 → 该编排哪一套模板（null = 画面上没有值得编排的东西）。
 * 优先级写死成数组顺序，保证「同一状态永远命中同一条模板」。
 *
 * 什么输入 → 命中哪套（按 mock 导演的 beat 表对照，换输入就会换演出）：
 *   雨 / 雷 / 闪电 / 下大        → rain_lightning  → 闪电+大雨+shake+shiver → storm
 *   打烊 / 关门 / 太晚 / 几点    → closing_keyword → scene=cafe_closing + lights_dim → close_down
 *   我得走 / 下次 / 对不起       → leaving         → sad + turn_away + sigh → close_down(farewell)
 *   等谁 / 一个人 / 为什么在这   → who_waiting     → pose=glance_window → window_call
 *   一起 / 陪你 / 要不要 / 坐下  → invite          → warm + lean_in + push_in → warm_beat
 *   好看 / 星星 / 发夹           → star_pin        → surprised + hair_tuck → warm_beat(emotion)
 *   报警 / 别等了 / 放鸽子       → danger          → anxious + shake + startle → 无命中（不编排）
 * 闪电只存在于 storm 模板里（见测试「闪电只属于 storm」），所以「不管说什么都放闪电」不可能发生。
 */
export function detectKind(state: SceneState): CueKind | null {
  const lightning = vfxOf(state, "lightning");
  const rainHeavy = vfxOf(state, "rain_heavy");
  const rainLight = vfxOf(state, "rain_light");
  const warmGlow = vfxOf(state, "warm_glow");
  const dim = vfxOf(state, "lights_dim");
  const acts = state.pendingActions;

  // 1) 雷雨：闪电本身，或「大雨 + 镜头抖 / 冷颤」这套组合
  if (lightning >= VFX_HIT) return "storm";
  if (
    rainHeavy >= 0.35 &&
    (state.camera === "shake" || acts.includes("shiver") || acts.includes("startle"))
  ) {
    return "storm";
  }

  // 2) 打烊压暗：场景已经翻牌，或灯已经暗下去
  if (state.scene === "cafe_closing" || dim >= VFX_HIT) return "close_down";

  // 3) 望向窗外 / 电话那端
  if (state.pose === "glance_window") return "window_call";
  if (state.scene === "window_rain" && rainLight >= 0.3) return "window_call";
  if (SUBTITLE_CALL.test(state.subtitle)) return "window_call";

  // 3.5) 难过 / 叹气 / 道别 → 同一套「压暗收场」，但内容指纹不同，不与打烊合并
  if (state.emotion === "sad" || acts.includes("sigh")) return "close_down";

  // 4) 暖场：暖光 / 温柔或失笑 / 前倾
  if (warmGlow >= VFX_HIT) return "warm_beat";
  if (state.emotion === "warm" || state.emotion === "amused") return "warm_beat";
  if (state.pose === "lean_in") return "warm_beat";

  return null;
}

/** 内容指纹：同 kind 下再区分「是哪一种命中」，用于幂等合并 */
function keyOf(state: SceneState, kind: CueKind): string {
  switch (kind) {
    case "storm":
      return "storm";
    case "close_down":
      if (state.scene === "cafe_closing") return "closing";
      if (vfxOf(state, "lights_dim") >= VFX_HIT) return "dim";
      return "farewell";
    case "window_call":
      return state.pose === "glance_window"
        ? "window"
        : state.scene === "window_rain"
          ? "rain_window"
          : "outside";
    case "warm_beat":
      return state.emotion === "warm" || state.emotion === "amused"
        ? `emotion:${state.emotion}`
        : state.pose === "lean_in"
          ? "lean_in"
          : "glow";
  }
}

function intensityOf(state: SceneState, kind: CueKind): number {
  switch (kind) {
    case "storm":
      return clamp01(0.55 + 0.45 * Math.max(vfxOf(state, "lightning"), vfxOf(state, "rain_heavy")));
    case "close_down":
      return clamp01(0.6 + 0.35 * Math.max(vfxOf(state, "lights_dim"), state.scene === "cafe_closing" ? 0.9 : 0));
    case "window_call":
      return clamp01(0.5 + 0.4 * vfxOf(state, "rain_light"));
    case "warm_beat":
      return clamp01(0.45 + 0.5 * vfxOf(state, "warm_glow"));
  }
}

// ---------------------------------------------------------------- 纯函数：状态 → Cue

/**
 * 编排：同一个 (state, now) 永远得到同一条 Cue（层数组是深拷贝，模板不会被污染）。
 * 没有命中 → null。
 */
export function composeCue(state: SceneState, now: number): Cue | null {
  const kind = detectKind(state);
  if (kind === null) return null;
  const template = CUE_TEMPLATES[kind];
  const intensity = intensityOf(state, kind);
  const key = `${kind}:${keyOf(state, kind)}`;
  return {
    id: `${key}#${Math.round(now).toString(36)}`,
    key,
    beat: state.lastBeat ?? "",
    kind,
    startedAt: now,
    durationMs: template.durationMs,
    intensity,
    layers: template.layers.map((l) => ({ ...l })),
  };
}

/** cue 在某一时刻的进度 0..1（供观测/测试；渲染层用 CSS 动画，不逐帧调用） */
export function cueProgress(cue: Cue, now: number): number {
  return clamp01((now - cue.startedAt) / cue.durationMs);
}

/** 该 cue 已经演完？ */
export function isCueOver(cue: Cue, now: number): boolean {
  return now >= cue.startedAt + cue.durationMs;
}

/** 下一次需要重新评估的时刻（毫秒时间戳）；null = 不需要再唤醒 */
export function nextBoundaryAt(state: CueState): number | null {
  const ends: number[] = [];
  if (state.active) ends.push(state.active.startedAt + state.active.durationMs);
  if (state.fadeOut) ends.push(state.fadeOut.startedAt + state.fadeOut.durationMs);
  if (ends.length === 0) return null;
  return Math.min(...ends);
}

/**
 * 渲染层的「要不要动」指纹：只有 beat / 镜头 / 命中类型变了才值得跑一次调度。
 * vfx 每帧都在衰减，不能让它驱动重渲染 —— 这就是这道闸门的意义。
 */
export function cueSignature(state: SceneState): string {
  return `${state.lastBeat ?? ""}|${state.camera ?? ""}|${detectKind(state) ?? "-"}`;
}

// ---------------------------------------------------------------- 调度器

export interface CueSchedulerOptions {
  /** 注入时钟（测试用）；默认 performance.now */
  now?: () => number;
  mergeWindowMs?: number;
  fadeOutMs?: number;
  exitFadeMs?: number;
}

function defaultClock(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** 到期的 cue 收尾：演出结束 → 进入收尾淡出；淡出结束 → 摘掉 */
function expire(state: CueState, now: number, exitFadeMs: number): CueState {
  let next = state;
  const active = next.active;
  if (active && now >= active.startedAt + active.durationMs) {
    next = {
      active: null,
      fadeOut: {
        cue: active,
        // 从「本该结束的时刻」起算，而不是从这次 update 的时刻
        startedAt: active.startedAt + active.durationMs,
        durationMs: exitFadeMs,
        reason: "end",
      },
      version: next.version + 1,
    };
  }
  const fade = next.fadeOut;
  if (fade && now >= fade.startedAt + fade.durationMs) {
    next = { active: next.active, fadeOut: null, version: next.version + 1 };
  }
  return next;
}

/**
 * 调度器：合并 / 打断 / 收尾。三个语义都在这里，且都可用注入时钟单测。
 *   · 幂等：同 kind + 同内容指纹 + 同 beat，或同 kind 距上次触发 <400ms → 原样返回，不叠加；
 *   · 打断：不同内容 → 旧 cue 立即进入 fadeOut（FADE_OUT_MS），新 cue 接管；
 *   · 收尾：演满 durationMs → EXIT_FADE_MS 淡出后摘掉，不做硬切。
 */
export function createCueScheduler(options: CueSchedulerOptions = {}): CueScheduler {
  const readClock = options.now ?? defaultClock;
  const mergeWindowMs = options.mergeWindowMs ?? MERGE_WINDOW_MS;
  const fadeOutMs = options.fadeOutMs ?? FADE_OUT_MS;
  const exitFadeMs = options.exitFadeMs ?? EXIT_FADE_MS;
  let current: CueState = EMPTY_CUE_STATE;
  /**
   * 已经消费掉的触发指纹（key|beat）。演完的 cue 不会被同一份内容「重新点燃」：
   * 否则收尾定时器一跑，update 又看见同样的 content 命中，演出会无限循环重播。
   */
  let consumed: string | null = null;

  return {
    state: () => current,
    now: readClock,
    reset() {
      current = EMPTY_CUE_STATE;
      consumed = null;
      return current;
    },
    update(scene) {
      const now = readClock();
      const next = expire(current, now, exitFadeMs);
      const cue = composeCue(scene, now);
      const trigger = cue === null ? null : `${cue.key}|${cue.beat}`;
      if (cue === null || trigger === consumed) {
        if (next !== current) current = next;
        return current;
      }

      const act = next.active;
      const merged =
        act !== null &&
        act.kind === cue.kind &&
        ((act.key === cue.key && act.beat === cue.beat) || now - act.startedAt <= mergeWindowMs);

      if (merged) {
        // 合并也意味着「这条内容已经编排过了」，收尾后不能再拿它重新起一段
        consumed = trigger;
        if (next !== current) current = next;
        return current;
      }

      consumed = trigger;
      current = {
        active: cue,
        // 被打断的旧 cue 不是消失，是淡出；没有旧 cue 时保留正在淡出的那条
        fadeOut: act
          ? { cue: act, startedAt: now, durationMs: fadeOutMs, reason: "interrupt" }
          : next.fadeOut,
        version: next.version + 1,
      };
      return current;
    },
  };
}
