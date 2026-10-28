/**
 * 简易 VAD：AnalyserNode 能量阈值 + 回声自打断守卫。
 *
 * 用途只有一个 —— 角色说话时判断「用户开口了」，触发打断。
 * 能量 VAD 分不清「用户说话」和「外放的 TTS 回声」，所以真正决定是否触发的
 * 是 `SpeechTriggerGate`（阈值 + 持续时长 + 回声守卫），见 state/bargeIn.ts。
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
   * 「角色正在出声吗」的探针；默认读 `speechSynthesis.speaking`。
   * 浏览器 TTS 就是回声源，所以默认探针即最直接的真值来源。
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

/**
 * 默认探针：`speechSynthesis.speaking` 的**边沿**检测。
 * 浏览器不给「这句从何时开始」的时间戳，所以由探针自己在每次调用时记录上升沿时刻。
 * 说话中多句之间的瞬时 `speaking=false` 会让禁声期重新计时 —— 方向是更保守，可接受。
 */
export function createBrowserTtsSpeakingProbe(clock: () => number = defaultNow): SpeakingProbe {
  let startedAt: number | null = null;
  return () => {
    const active =
      typeof window !== "undefined" &&
      typeof window.speechSynthesis !== "undefined" &&
      Boolean((window.speechSynthesis as SpeechSynthesis | undefined)?.speaking);
    if (!active) {
      startedAt = null;
      return { speaking: false, sinceSpeechStartMs: null };
    }
    const now = clock();
    if (startedAt === null) startedAt = now;
    return { speaking: true, sinceSpeechStartMs: now - startedAt };
  };
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
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
    this.speakingProbe = options.speakingProbe ?? createBrowserTtsSpeakingProbe();
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
