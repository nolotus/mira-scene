/**
 * 简易 VAD：AnalyserNode 能量阈值 + 回声自打断守卫。
 *
 * 用途只有一个 —— 角色说话时判断「用户开口了」，触发打断。
 * 能量 VAD 分不清「用户说话」和「外放的 TTS 回声」，所以真正决定是否触发的
 * 是 `SpeechTriggerGate`（阈值 + 持续时长 + 回声守卫），见 state/bargeIn.ts。
 *
 * 「角色是否在说话」由本文件自己的朗读相位决定（SpeechPhaseTracker），
 * 而不是裸的 `speechSynthesis.speaking`：后者在 cancel() 之后会滞后 100–300ms，
 * 足够把用户打断后立刻接的第一句话当成回声吞掉。
 *
 * 麦克风不可用（无权限/无设备）时 start() 返回 false，UI 退化为
 * 「按住说话 / 打断键」这套显式交互，绝不假装在听。
 */

import {
  DEFAULT_ECHO_GUARD,
  evaluateSpeechBargeIn,
  type EchoGuardConfig,
  type SpeechGuardDecision,
  type SpeechGuardStats,
} from "../state/bargeIn";

/** 角色是否在出声，以及「从开口到现在多久」 */
export interface SpeakingSnapshot {
  speaking: boolean;
  sinceSpeechStartMs: number | null;
}

export type SpeakingProbe = () => SpeakingSnapshot;

export interface VadOptions {
  /** RMS 阈值 0..1，默认 0.045（笔记本麦克风安静房间的实测经验值） */
  threshold?: number;
  /** 连续超过阈值多久才算「开口」，避免咔哒声误触发 */
  holdMs?: number;
  /** 触发后的冷却，避免一次开口连发 */
  cooldownMs?: number;
  /** 采样窗口 */
  fftSize?: number;
  /** 回声自打断守卫（只作用于 VAD 触发的打断，按钮/Esc 不经过这里） */
  echoGuard?: Partial<EchoGuardConfig>;
  /**
   * 「角色正在出声吗」的探针；默认用我们自己的朗读相位（见 SpeechPhaseTracker）。
   * 刻意**不**直接读 `speechSynthesis.speaking`：那个标志在 cancel() 后滞后 100–300ms，
   * 会把用户打断后立刻接的第一句当成回声吞掉。
   */
  speakingProbe?: SpeakingProbe;
  onSpeech?(): void;
  onLevel?(level: number, threshold: number): void;
  /** 守卫每次放行/丢弃时回调（诊断用；steam 级计数另见 readSpeechGuardStats） */
  onGuarded?(info: {
    decision: SpeechGuardDecision;
    sustainedMs: number;
    sinceSpeechStartMs: number | null;
  }): void;
  onError?(message: string): void;
}

export interface VadController {
  readonly running: boolean;
  /** 返回 false 表示麦克风不可用（权限/设备/API） */
  start(): Promise<boolean>;
  stop(): void;
  setThreshold(value: number): void;
  /** 本实例的回声守卫计数 */
  guardStats(): SpeechGuardStats;
}

// ---------------------------------------------------------------- 守卫计数

function emptyGuardStats(): SpeechGuardStats {
  return { accepted: 0, rejected: 0, lastReject: null };
}

/**
 * 模块级累计计数：VAD 实例是在 App 里局部创建的，诊断面板拿不到它，
 * 所以另存一份「全页面累计」，让「守卫命中/丢弃 N」能在界面上自证。
 */
let aggregateGuardStats: SpeechGuardStats = emptyGuardStats();

export function readSpeechGuardStats(): SpeechGuardStats {
  return { ...aggregateGuardStats };
}

/** 仅供测试与重新开启麦克风时清零 */
export function resetSpeechGuardStats(): void {
  aggregateGuardStats = emptyGuardStats();
}

function countGuard(stats: SpeechGuardStats, decision: SpeechGuardDecision): void {
  if (decision.accept) {
    stats.accepted += 1;
    aggregateGuardStats.accepted += 1;
    return;
  }
  stats.rejected += 1;
  stats.lastReject = decision.reject;
  aggregateGuardStats.rejected += 1;
  aggregateGuardStats.lastReject = decision.reject;
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ---------------------------------------------------------------- 朗读相位（我们自己的状态）

/**
 * 我们自己的「角色正在出声」相位 —— 回声守卫的**唯一**判定依据。
 *
 * 为什么不直接信 `speechSynthesis.speaking`：Chrome 实测在 `cancel()` 之后还会让这个标志
 * 保持 true 100–300ms。用户按下 Esc / 点了打断键之后立刻接话，这段滞后期里的开口会被守卫
 * 当成「角色还在说话」而按回声丢弃 —— 用户那句「停一下」就整句没了（实测复现见
 * tests/web/manualInterruptGuard.test.ts）。
 *
 * 相位有两个来源，且我们自己的判断优先：
 *   · 浏览器标志的**上升沿**（角色真的开始出声）→ 开相位，起点时间由我们自己记录
 *     （浏览器不给「这句从何时开始」的时间戳）；
 *   · **人工打断**（按钮 / Esc / 打字 / VAD 打断）→ 立刻关相位，不等标志回落。
 *
 * 关相位后的边界：要等到标志真的回落（看到一次 false）才算干净，之后的新上升沿才是角色
 * 真的又开口了。否则滞后的 true 会被误当成「新一句的起点」，守卫提前恢复、继续吞话。
 *
 * 权衡：若浏览器标志永远不回落，守卫就一直解除。宁可不拦这一次回声（最坏是角色被自己的
 * 声音误打断），也不吞用户的话 —— 两个方向的失败代价不对称。
 */
export interface SpeechPhaseTracker {
  /** 喂一次观测，返回「按我们自己的判断，角色是否在出声、从何时开始」 */
  observe(now: number): SpeakingSnapshot;
  /** 人工打断 / TTS cancel：立刻结束相位（守卫从下一帧起解除） */
  markSilent(): void;
  readonly speaking: boolean;
}

export interface SpeechPhaseTrackerOptions {
  /** 浏览器标志读取器，默认读 `speechSynthesis.speaking` */
  readBrowserSpeaking?: () => boolean;
}

export function createSpeechPhaseTracker(
  options: SpeechPhaseTrackerOptions = {},
): SpeechPhaseTracker {
  const read = options.readBrowserSpeaking ?? readBrowserSpeakingFlag;
  let speaking = false;
  let startedAt: number | null = null;
  /** 人工打断之后为 true：在看到浏览器标志真正回落之前，不再把 true 当成朗读相位 */
  let awaitingFalloff = false;

  return {
    get speaking() {
      return speaking;
    },
    observe(now: number) {
      if (!read()) {
        // 浏览器说「停了」→ 结束相位。这里的滞后只会让守卫少拦一会儿，方向安全。
        speaking = false;
        startedAt = null;
        awaitingFalloff = false;
        return { speaking: false, sinceSpeechStartMs: null };
      }
      if (!speaking) {
        // 人工打断后的滞后 true：那是上一次朗读的残影，不是新的朗读相位
        if (awaitingFalloff) return { speaking: false, sinceSpeechStartMs: null };
        speaking = true;
        startedAt = now;
      }
      const since = startedAt === null ? 0 : Math.max(0, now - startedAt);
      return { speaking: true, sinceSpeechStartMs: since };
    },
    markSilent() {
      speaking = false;
      startedAt = null;
      awaitingFalloff = true;
    },
  };
}

function readBrowserSpeakingFlag(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.speechSynthesis !== "undefined" &&
      Boolean(window.speechSynthesis?.speaking)
    );
  } catch {
    return false;
  }
}

/** 模块级相位：VAD 与（将来的）TTS 接线共用同一份判断 */
let speechPhase = createSpeechPhaseTracker();

/** 默认探针：相位来自我们自己的跟踪器，而不是裸的浏览器标志 */
export function createSpeakingPhaseProbe(clock: () => number = defaultNow): SpeakingProbe {
  return () => speechPhase.observe(clock());
}

/**
 * 人工打断（按钮 / Esc / 打字 / 任何「用户明确要求角色闭嘴」的入口）→ 立刻解除回声守卫，
 * 不等 `speechSynthesis.speaking` 回落。挂上 cancel 钩子后这些入口无需各自调用
 * （见 installSpeechSynthesisCancelWatch），显式调用留作钳制点与测试入口。
 */
export function noteManualSpeechInterrupt(): void {
  speechPhase.markSilent();
}

/** 仅供测试复位 */
export function resetSpeechPhase(): void {
  speechPhase = createSpeechPhaseTracker();
}

// ---------------------------------------------------------------- 回声源（cancel）订阅

/**
 * 订阅 `speechSynthesis.cancel()` —— 「我们自己把角色闭麦」的唯一可靠信号。
 *
 * BrowserTTS.stop()、performBargeIn 的 cancelAudio()、以及按钮 / Esc / 打字触发的打断，
 * 最终都会走到 cancel()。在这里挂一次钩子，就等于在人工打断那一刻拿到通知：
 * 不用改 App / tts 的调用点，也不用等浏览器标志回落。
 *
 * 引用计数：麦克风可能被反复 start/stop（每次开麦都换一个 VAD 实例）。
 */
let cancelWatchCount = 0;
let restoreCancel: (() => void) | null = null;

export function installSpeechSynthesisCancelWatch(): () => void {
  if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") {
    return () => {};
  }
  if (cancelWatchCount === 0) {
    const synth = window.speechSynthesis;
    const original = synth.cancel;
    try {
      synth.cancel = function patchedCancel(this: SpeechSynthesis) {
        // 先解守卫再真的取消：守卫的解除不能依赖 cancel 本身是否成功
        noteManualSpeechInterrupt();
        original.call(this);
      };
      restoreCancel = () => {
        synth.cancel = original;
      };
    } catch {
      // 只读环境（冻结对象）：退化为靠显式 noteManualSpeechInterrupt() 接线，不影响 VAD 本身
      restoreCancel = null;
    }
  }
  cancelWatchCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    cancelWatchCount -= 1;
    if (cancelWatchCount > 0) return;
    restoreCancel?.();
    restoreCancel = null;
  };
}

// ---------------------------------------------------------------- 触发闸门

export type SpeechTriggerOutcome =
  | { kind: "idle" }
  | { kind: "rising" }
  | { kind: "fire"; sustainedMs: number }
  | { kind: "guarded"; reject: NonNullable<SpeechGuardDecision["reject"]>; sustainedMs: number };

export interface SpeechTriggerGateOptions {
  threshold?: number;
  holdMs?: number;
  cooldownMs?: number;
  echoGuard?: Partial<EchoGuardConfig>;
  speakingProbe?: SpeakingProbe;
  onGuarded?(info: {
    decision: SpeechGuardDecision;
    sustainedMs: number;
    sinceSpeechStartMs: number | null;
  }): void;
}

/**
 * 「什么时候算用户开口」的唯一判定处，纯逻辑（时间从外部传入，不读 DOM 时钟），
 * 所以「短促回声不打断、长声打断、冷却不连发」都能被单测直接钉住。
 */
export class SpeechTriggerGate {
  private threshold: number;
  private readonly holdMs: number;
  private readonly cooldownMs: number;
  private readonly echoGuard: EchoGuardConfig;
  private readonly speakingProbe: SpeakingProbe;
  private readonly onGuarded?: SpeechTriggerGateOptions["onGuarded"];

  private aboveSince: number | null = null;
  private lastFireAt = Number.NEGATIVE_INFINITY;
  /** 同一段连续语音是否已经记过一次「被守卫丢弃」，避免每帧刷计数 */
  private segmentRejected = false;
  private readonly stats: SpeechGuardStats = emptyGuardStats();

  constructor(options: SpeechTriggerGateOptions = {}) {
    this.threshold = options.threshold ?? 0.045;
    this.holdMs = options.holdMs ?? 120;
    this.cooldownMs = options.cooldownMs ?? 900;
    this.echoGuard = { ...DEFAULT_ECHO_GUARD, ...options.echoGuard };
    this.speakingProbe = options.speakingProbe ?? createSpeakingPhaseProbe();
    this.onGuarded = options.onGuarded;
  }

  get guardStats(): SpeechGuardStats {
    return { ...this.stats };
  }

  setThreshold(value: number): void {
    this.threshold = value;
  }

  reset(): void {
    this.aboveSince = null;
    this.lastFireAt = Number.NEGATIVE_INFINITY;
    this.segmentRejected = false;
  }

  /** 喂一帧电平；返回这一帧该做什么 */
  push(level: number, now: number): SpeechTriggerOutcome {
    if (level < this.threshold) {
      this.aboveSince = null;
      this.segmentRejected = false;
      return { kind: "idle" };
    }

    this.aboveSince ??= now;
    const sustainedMs = now - this.aboveSince;

    if (sustainedMs < this.holdMs) return { kind: "rising" };
    if (now - this.lastFireAt < this.cooldownMs) return { kind: "rising" };

    const snapshot = this.speakingProbe();
    const decision = evaluateSpeechBargeIn({
      speaking: snapshot.speaking,
      sustainedMs,
      sinceSpeechStartMs: snapshot.sinceSpeechStartMs,
      config: this.echoGuard,
    });

    if (decision.accept) {
      this.lastFireAt = now;
      this.aboveSince = now;
      this.segmentRejected = false;
      // 只在「守卫真的介入过」（角色在说话）时计数，否则计数会混进普通输入
      if (snapshot.speaking) {
        countGuard(this.stats, decision);
        this.onGuarded?.({ decision, sustainedMs, sinceSpeechStartMs: snapshot.sinceSpeechStartMs });
      }
      return { kind: "fire", sustainedMs };
    }

    if (!this.segmentRejected) {
      this.segmentRejected = true;
      countGuard(this.stats, decision);
      this.onGuarded?.({ decision, sustainedMs, sinceSpeechStartMs: snapshot.sinceSpeechStartMs });
    }

    // 关键：不重置 aboveSince / lastFireAt。同一段语音继续累计时长，
    // 一旦越过 minSustainedMs，下一帧就会放行 —— 否则「长声打断」永远打不断自己。
    return {
      kind: "guarded",
      reject: decision.reject ?? "too-short",
      sustainedMs,
    };
  }
}

function rmsFrom(bytes: Uint8Array<ArrayBuffer>): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const v = ((bytes[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / bytes.length);
}

export class MicEnergyVad implements VadController {
  private readonly options: VadOptions;
  private readonly gate: SpeechTriggerGate;
  private threshold: number;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private raf: number | null = null;
  private active = false;
  private detachCancelWatch: (() => void) | null = null;

  constructor(options: VadOptions = {}) {
    this.options = options;
    this.threshold = options.threshold ?? 0.045;
    // 阈值/持续时长/回声守卫三件事都在 gate 里判定，VAD 只负责喂电平
    this.gate = new SpeechTriggerGate({
      threshold: this.threshold,
      holdMs: options.holdMs,
      cooldownMs: options.cooldownMs,
      echoGuard: options.echoGuard,
      speakingProbe: options.speakingProbe,
      onGuarded: options.onGuarded,
    });
  }

  guardStats(): SpeechGuardStats {
    return this.gate.guardStats;
  }

  get running(): boolean {
    return this.active;
  }

  async start(): Promise<boolean> {
    if (this.active) return true;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.options.onError?.("当前环境没有麦克风 API（需要 https 或 localhost）");
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      const message =
        err instanceof Error && err.name === "NotAllowedError"
          ? "麦克风权限被拒绝：VAD 关闭，请用「打断键」或「按住说话」"
          : `麦克风不可用：${err instanceof Error ? err.message : String(err)}`;
      this.options.onError?.(message);
      return false;
    }

    try {
      const Ctx = window.AudioContext;
      this.ctx = new Ctx();
      const source = this.ctx.createMediaStreamSource(this.stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = this.options.fftSize ?? 1024;
      source.connect(analyser);
      this.analyser = analyser;
      this.data = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      this.active = true;
      // 开麦期间盯住 speechSynthesis.cancel()：人工打断那一刻立刻解除回声守卫
      this.detachCancelWatch = installSpeechSynthesisCancelWatch();
      this.loop();
      return true;
    } catch (err) {
      this.options.onError?.(`VAD 初始化失败：${err instanceof Error ? err.message : String(err)}`);
      this.stop();
      return false;
    }
  }

  stop(): void {
    this.active = false;
    this.detachCancelWatch?.();
    this.detachCancelWatch = null;
    if (this.raf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.raf);
    }
    this.raf = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.data = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.gate.reset();
  }

  setThreshold(value: number): void {
    this.threshold = value;
    this.gate.setThreshold(value);
  }

  private loop = (): void => {
    if (!this.active || !this.analyser || !this.data) return;
    try {
      this.analyser.getByteTimeDomainData(this.data);
      const level = rmsFrom(this.data);
      this.options.onLevel?.(level, this.threshold);

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const outcome = this.gate.push(level, now);
      // idle / rising / guarded 都不触发打断：
      // guarded 就是「角色在说话，但这段声音像回声（太短或还在开口爬升期）」→ 丢弃
      if (outcome.kind === "fire") this.options.onSpeech?.();
    } catch {
      // 设备被拔掉 / 上下文被关闭：退出循环即可，不要抛到事件循环
      this.stop();
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}

export function createVad(options: VadOptions = {}): VadController {
  const vad = new MicEnergyVad(options);
  return {
    get running() {
      return vad.running;
    },
    start: () => vad.start(),
    stop: () => vad.stop(),
    setThreshold: (value: number) => vad.setThreshold(value),
    guardStats: () => vad.guardStats(),
  };
}
