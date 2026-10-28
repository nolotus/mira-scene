/**
 * 在场状态仲裁器（presence）—— 「她此刻到底在干什么」的唯一判据。
 *
 * 为什么需要它：视觉状态原本由**事件流**推导（首个 text.delta 就切 speaking、
 * turn.end 就回 idle）。事件 ≠ 声音：
 *   · 中文 Edge TTS 首句要 1.7–2.0s 才出第一块音频 → 这期间嘴已经在动，却没有声音；
 *   · turn.end 到了，最后一句音频还在排队播 → 已经回待机，声音还在响；
 *   · listening 跟「用户开始输入」走，不跟麦克风真实采集走；
 *   · 口型节奏由字幕字符数推进，与音频播放位置无关，越说越漂。
 *
 * 这个模块把三路**真实信号**（请求 / TTS / 麦克风）按优先级仲裁成同一个答案，
 * 并给出可断言的 `reason`（诊断区与测试都读它）。三层分离：
 *   1. `arbitrate()`      纯函数：一份输入 → 一个状态，无时间概念（可穷举测）；
 *   2. `stepPresence()`   纯函数：加**最小停留**与「speaking 只能等 tts 回 idle 才降级」；
 *   3. `createPresenceArbiter()` / `PresenceTrace`：给 React 用的有状态门面与时间线采样器。
 * 时间一律由调用方传入，所以测试里没有 fake timer，只有手写的时间点。
 *
 * 约束：本模块**只读**消费 voice/**（`isSpeaking` 与 `pushChunk` 观察），不改 TTS。
 */

import type { CharacterStatus } from "../../shared/protocol";

// ---------------------------------------------------------------- 输入

/** 这一轮的请求阶段（由 SessionMachine 推导，见 `requestPhaseOf`） */
export type RequestPhase = "idle" | "submitted" | "streaming" | "ended" | "failed";

/** TTS 阶段（由 `ttsPhaseOf` 推导：isSpeaking 轮询 + 失败信号 + 请求阶段） */
export type TtsPhase = "idle" | "synthesizing" | "playing" | "failed";

/** 麦克风阶段：off = 没开 / requesting = 等授权 / capturing = 真的在采集 */
export type MicPhase = "off" | "requesting" | "capturing";

export type MouthState = "closed" | "half" | "open";

export interface PresenceInputs {
  request: RequestPhase;
  tts: TtsPhase;
  mic: MicPhase;
  /** 本轮是否已有文本（首个 text.delta 之后为 true） */
  hasText: boolean;
  /** 本轮是否已有音频（收到过分片，含流式分片） */
  hasAudio: boolean;
  /**
   * 麦克风已开时，用户此刻是否真的在说话。
   * 缺省（undefined）= 没有可用的语音活动信号，按「在听」处理；
   * 只有明确知道用户没开口（false）时才让 listening 让位给别的状态。
   */
  userSpeaking?: boolean;
}

export interface Presence {
  /** 与协议里的 CharacterStatus 同构，避免再造一套名词 */
  status: CharacterStatus;
  /** 静息口型：不驱动口型时应当闭合；驱动时给「张嘴」基线 */
  mouth: MouthState;
  /** 口型是否允许被驱动（**唯一开关**：只有 tts 真正在播时才为 true） */
  mouthDrive: boolean;
  /** 诊断与测试断言用：`speaking ← tts:playing` */
  reason: string;
}

// ---------------------------------------------------------------- 纯仲裁

/** 最小停留：状态至少维持这么久才允许再变（避免事件抖动把画面刷成频闪）。 */
export const PRESENCE_MIN_HOLD_MS = 160;

const closed = (status: Presence["status"], reason: string): Presence => ({
  status,
  mouth: "closed",
  mouthDrive: false,
  reason,
});

/**
 * 一份输入 → 一个状态。**按优先级，冲突时高优先**。
 *
 * | # | 条件 | 结果 | 口型 |
 * |---|------|------|------|
 * | 1 | `tts === playing` | speaking | 开（跟音频） |
 * | 2 | `tts === synthesizing` 且 `hasAudio` 且请求在 streaming/ended | speaking | **关**（句间空隙没有声音） |
 * | 3 | `mic === capturing` 且（有语音活动 / 她手头没活儿） | listening | 关 |
 * | 4a| `request === submitted` | thinking | 关 |
 * | 4b| `request === streaming && !hasAudio` | thinking | 关 |
 * | 5 | `request/tts === failed` | idle | 关 |
 * | 6 | 其它（含 `request === ended`） | idle | 关 |
 *
 * 第 2 条是这次额外加的：一条流式回复会被切成多句合成，句与句之间有几百毫秒
 * 没有声音。只按第 1 条判会让状态在句间掉回 idle 再弹回 speaking（视觉抽搐），
 * 而只按「事件流」判又会提前进入 speaking（本次要修的病）。所以：**已有音频、
 * 但此刻没在播** → 状态仍是 speaking，口型必须关闭。它晚于规则 1、早于麦克风，
 * 所以真正的「用户在打断」会让位吗？不会 —— 打断时 tts 会 cancel，`hasAudio` 由
 * 新一轮重置，规则 3 自然接管。
 */
export function arbitrate(input: PresenceInputs): Presence {
  // 1. 音频真的在播：唯一有资格驱动口型的状态
  if (input.tts === "playing") {
    return { status: "speaking", mouth: "open", mouthDrive: true, reason: "tts:playing" };
  }

  // 2. 本轮音频在飞（分片/解码/句间）：算在说话，但不许动嘴
  if (
    input.tts === "synthesizing" &&
    input.hasAudio &&
    (input.request === "streaming" || input.request === "ended")
  ) {
    return closed("speaking", "tts:synthesizing(audio-in-flight)");
  }

  // 3. 麦克风正在采集：她在听（口型必须关掉，嘴动起来等于「她在说话」）
  //
  //    细分的理由：麦克风开着 ≠ 用户此刻在说话。所以
  //      · 有语音活动信号（userSpeaking === true）→ 无条件 listening（用户正在插话）；
  //      · 没有语音活动信号且她手头没活儿（idle/ended/failed）→ 也算在听（常见的「等你说话」）；
  //      · 没有语音活动信号但她正忙着想/说（submitted/streaming）→ 让位给 thinking，
  //        否则「她在想」会被一个一直开着的麦克风永久盖住。
  if (input.mic === "capturing") {
    const busy = input.request === "submitted" || input.request === "streaming";
    if (input.userSpeaking === true) return closed("listening", "mic:capturing(speech)");
    if (input.userSpeaking === undefined && !busy) return closed("listening", "mic:capturing");
  }

  // 4. 请求在路上、音频还没到 —— 中文 TTS 那 1.7–2.0s 的空白落在这里
  if (input.request === "submitted") {
    return closed("thinking", "request:submitted");
  }
  if (input.request === "streaming" && !input.hasAudio) {
    return closed(
      "thinking",
      input.hasText ? "request:streaming(text-ready,audio-pending)" : "request:streaming(no-text-yet)",
    );
  }

  // 5. 失败：任何一路彻底失败且没有声音 → 回待机；两条原因都留在 reason 里
  if (input.request === "failed" || input.tts === "failed") {
    const requestFailed = input.request === "failed";
    const ttsFailed = input.tts === "failed";
    const reason =
      requestFailed && ttsFailed
        ? "request:failed+tts:failed"
        : requestFailed
          ? "request:failed"
          : "tts:failed";
    return closed("idle", reason);
  }

  // 6. 其它：本轮结束了、没有任何在飞的音频
  return closed("idle", input.request === "ended" ? "request:ended" : "idle");
}

/** 诊断区一行文本：`speaking ← tts:playing`。 */
export function describePresence(presence: Presence): string {
  return `${presence.status} ← ${presence.reason}`;
}

// ---------------------------------------------------------------- 带时间的仲裁（最小停留）

export interface PresenceState {
  presence: Presence;
  /** 当前状态是什么时候被采纳的（用于最小停留） */
  since: number;
  /** 被最小停留压住、等待提交的目标状态 */
  pending: { presence: Presence; since: number } | null;
}

export function createPresenceState(inputs: PresenceInputs, now = 0): PresenceState {
  return { presence: arbitrate(inputs), since: now, pending: null };
}

/**
 * 「speaking → 别的」必须等到 tts 真的不再是 playing/synthesizing 才允许：
 * 这是「turn.end 已到但声音还在响」的硬保证，不依赖调用方的输入质量。
 */
function holdGuard(target: Presence, current: Presence, input: PresenceInputs): Presence {
  if (current.status !== "speaking" || target.status === "speaking") return target;
  if (input.tts === "playing" || input.tts === "synthesizing") {
    // 声音还在（或还在路上）：状态留在 speaking，但口型跟着 tts 走 —— 没声就闭嘴
    const mouthDrive = input.tts === "playing";
    return {
      status: "speaking",
      mouth: mouthDrive ? "open" : "closed",
      mouthDrive,
      reason: `hold:speaking(${input.tts} → ${target.reason})`,
    };
  }
  return target;
}

/**
 * 一步仲裁：输入 + 当前状态 + 此刻时刻 → 新状态。
 *
 * 最小停留的语义是「**每个被采纳的状态至少活满 minHoldMs**」，因此提交条件看的是
 * `now - since`（上一次采纳的时刻），而不是目标出现多久。抖动回原状态时 pending
 * 直接作废，一次切换都不会发生。
 */
export function stepPresence(
  prev: PresenceState,
  input: PresenceInputs,
  now: number,
  minHoldMs = PRESENCE_MIN_HOLD_MS,
): PresenceState {
  const target = holdGuard(arbitrate(input), prev.presence, input);

  // 状态没变：reason / 口型可以立刻更新（诊断要即时），但不重置停留计时
  if (target.status === prev.presence.status) {
    if (
      target.reason === prev.presence.reason &&
      target.mouth === prev.presence.mouth &&
      !prev.pending
    ) {
      return prev;
    }
    return { presence: target, since: prev.since, pending: null };
  }

  // 状态要变：还没活满最小停留就先记账
  if (now - prev.since < minHoldMs) {
    return {
      ...prev,
      pending: { presence: target, since: prev.pending?.since ?? now },
    };
  }

  return { presence: target, since: now, pending: null };
}

// ---------------------------------------------------------------- 信号推导（喂给仲裁器的三路）

export interface RequestSignals {
  turnActive: boolean;
  firstEventAt: number | null;
  error: string | null;
  lastTurnId: string | null;
}

/** SessionMachine → RequestPhase。纯函数，只读四个字段。 */
export function requestPhaseOf(machine: RequestSignals): RequestPhase {
  if (machine.turnActive) return machine.firstEventAt === null ? "submitted" : "streaming";
  if (machine.error !== null) return "failed";
  if (machine.lastTurnId !== null) return "ended";
  return "idle";
}

export interface TtsSignals {
  /** 从 TTS 读到的 `isSpeaking`（已含排队与解码中的分片） */
  playing: boolean;
  /** 从 TTS 读到的失败原因（StreamTTS.error / 演示注入 / 媒体错误） */
  error: string | null;
  request: RequestPhase;
}

/**
 * TTS 三路信号 → TtsPhase。刻意不猜「合成进度」：
 * 只要这一轮还在跑（submitted/streaming）而声音没出来，就说明音频还在路上；
 * 请求结束了又没有声音，就是 idle（这也是唯一能把 speaking 降级的信号）。
 */
export function ttsPhaseOf(signal: TtsSignals): TtsPhase {
  if (signal.playing) return "playing";
  if (signal.error !== null) return "failed";
  if (signal.request === "submitted" || signal.request === "streaming") return "synthesizing";
  if (signal.request === "failed") return "failed";
  return "idle";
}

/** App 的 mic 状态（store.MicState）→ MicPhase */
export function micPhaseOf(mic: string): MicPhase {
  if (mic === "listening") return "capturing";
  if (mic === "requesting") return "requesting";
  return "off";
}

/** 从任意 TTS 实例上只读地取失败原因（不吃异常） */
export function readTtsError(tts: unknown): string | null {
  if (!tts || typeof tts !== "object") return null;
  try {
    const value = (tts as { error?: unknown }).error;
    if (typeof value === "string" && value.trim() !== "") return value;
  } catch {
    // 拿不到就是拿不到：诊断读不到原因，不该把界面一起弄崩
  }
  return null;
}

// ---------------------------------------------------------------- React/App 用的有状态门面

export interface PresenceArbiter {
  /** 喂一份输入，返回此刻的（已过最小停留的）在场状态 */
  update(input: PresenceInputs, now?: number): Presence;
  get(): Presence;
  /** 取完整内部状态（测试与诊断用） */
  state(): PresenceState;
  reset(input: PresenceInputs, now?: number): Presence;
}

export interface PresenceArbiterOptions {
  minHoldMs?: number;
  clock?: () => number;
}

export function createPresenceArbiter(options: PresenceArbiterOptions = {}): PresenceArbiter {
  const clock =
    options.clock ??
    (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const minHoldMs = options.minHoldMs ?? PRESENCE_MIN_HOLD_MS;
  const placeholder: Presence = closed("idle", "boot");
  // 初值不参与最小停留：开机不该被自己的占位状态挡 160ms
  let state: PresenceState = {
    presence: placeholder,
    since: Number.NEGATIVE_INFINITY,
    pending: null,
  };

  return {
    update(input, now = clock()) {
      state = stepPresence(state, input, now, minHoldMs);
      return state.presence;
    },
    get: () => state.presence,
    state: () => state,
    reset(input, now = clock()) {
      state = createPresenceState(input, now);
      return state.presence;
    },
  };
}

// ---------------------------------------------------------------- 时间线采样器（?trace=1）

/** 一条采样：`{t, status, tts, hasAudio, subtitleLen}`（题目要求的形状） */
export interface TraceSample {
  t: number;
  status: CharacterStatus;
  tts: TtsPhase;
  hasAudio: boolean;
  subtitleLen: number;
}

export interface TraceSummaryOptions {
  /** speaking 起始比音频开始允许晚多少（题目：≤120ms） */
  startToleranceMs?: number;
  /** speaking 结束比音频结束允许的偏差（题目：≤200ms） */
  endToleranceMs?: number;
}

export interface TraceSummary {
  firstPlayingT: number | null;
  speakingStartT: number | null;
  lastPlayingT: number | null;
  speakingEndT: number | null;
  /** 文本先到、音频未开始的窗口长度 */
  thinkingGapMs: number | null;
  /** speaking 起始 - 音频开始（>0 = 晚了，<0 = 早于声音，违规） */
  startLagMs: number | null;
  /** speaking 结束 - 音频结束（<0 = 声音还没完就回待机，违规） */
  endLagMs: number | null;
  /** 音频还在播的区间里出现过非 speaking（中途掉回 idle/thinking 的抽搐） */
  prematureDowngrade: boolean;
  startOk: boolean;
  endOk: boolean;
  thinkingOk: boolean;
  ok: boolean;
}

/**
 * 时间线自证：三条断言都从采样里算，不靠肉眼。
 *  · `speaking` 起始不早于首个音频播放（容差 startToleranceMs）
 *  · `speaking` 结束不早于音频结束（容差 endToleranceMs）
 *  · 「文本到达 → 音频开始」这段里状态是 thinking（不是 speaking）
 */
export function summarizeTrace(
  samples: readonly TraceSample[],
  options: TraceSummaryOptions = {},
): TraceSummary {
  const startToleranceMs = options.startToleranceMs ?? 120;
  const endToleranceMs = options.endToleranceMs ?? 200;

  const firstPlaying = samples.find((s) => s.tts === "playing") ?? null;
  const speakingSamples = samples.filter((s) => s.status === "speaking");
  const speakingStart = speakingSamples[0] ?? null;
  const speakingEnd = speakingSamples[speakingSamples.length - 1] ?? null;
  let lastPlaying: TraceSample | null = null;
  for (const sample of samples) if (sample.tts === "playing") lastPlaying = sample;

  const firstPlayingT = firstPlaying?.t ?? null;
  const speakingStartT = speakingStart?.t ?? null;
  const lastPlayingT = lastPlaying?.t ?? null;
  const speakingEndT = speakingEnd?.t ?? null;

  const startLagMs =
    firstPlayingT !== null && speakingStartT !== null ? speakingStartT - firstPlayingT : null;
  const endLagMs =
    lastPlayingT !== null && speakingEndT !== null ? speakingEndT - lastPlayingT : null;

  // 文本先到、音频未开始：这个窗口里的每一帧都不许是 speaking
  const firstTextT = samples.find((s) => s.subtitleLen > 0)?.t ?? null;
  const thinkingGapMs =
    firstTextT !== null && firstPlayingT !== null && firstPlayingT > firstTextT
      ? firstPlayingT - firstTextT
      : null;
  const windowSamples =
    firstTextT !== null && firstPlayingT !== null
      ? samples.filter((s) => s.t >= firstTextT && s.t < firstPlayingT)
      : [];
  const thinkingOk = windowSamples.every((s) => s.status !== "speaking" && s.status !== "listening");
  // 声音在播的区间里不许出现「她没在说话」
  const prematureDowngrade =
    firstPlayingT !== null &&
    lastPlayingT !== null &&
    samples.some((s) => s.t > firstPlayingT && s.t < lastPlayingT && s.status !== "speaking");
  const startOk = startLagMs !== null && startLagMs >= -startToleranceMs;
  const endOk = endLagMs !== null && endLagMs >= -endToleranceMs && !prematureDowngrade;

  return {
    firstPlayingT,
    speakingStartT,
    lastPlayingT,
    speakingEndT,
    thinkingGapMs,
    startLagMs,
    endLagMs,
    prematureDowngrade,
    startOk,
    endOk,
    thinkingOk,
    ok: startOk && endOk && thinkingOk,
  };
}

export interface PresenceTrace {
  push(sample: Omit<TraceSample, "t">, now?: number): TraceSample;
  readonly records: readonly TraceSample[];
  clear(): void;
  summary(options?: TraceSummaryOptions): TraceSummary;
  json(): string;
}

export function createPresenceTrace(
  clock: () => number = () =>
    typeof performance !== "undefined" ? performance.now() : Date.now(),
  limit = 20_000,
): PresenceTrace {
  let t0: number | null = null;
  let records: TraceSample[] = [];

  return {
    push(sample, now = clock()) {
      if (t0 === null) t0 = now;
      const record: TraceSample = { t: Math.round(now - t0), ...sample };
      records.push(record);
      if (records.length > limit) records = records.slice(-limit);
      return record;
    },
    get records() {
      return records;
    },
    clear() {
      t0 = null;
      records = [];
    },
    summary(options) {
      return summarizeTrace(records, options);
    },
    json() {
      return JSON.stringify(records, null, 0);
    },
  };
}

/** `?trace=1` 开关（仅诊断用；显式值才算开，默认关） */
export function parsePresenceTraceFlag(search: string): boolean {
  const raw = (new URLSearchParams(search).get("trace") ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}
