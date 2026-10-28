/**
 * 简易 VAD：AnalyserNode 能量阈值。
 *
 * 用途只有一个 —— 角色说话时判断「用户开口了」，触发打断。
 * 不追求识别精度：宁可偶尔被环境噪音误触发（打断是安全动作），
 * 也不能因为阈值太保守而让用户喊不动。
 *
 * 麦克风不可用（无权限/无设备）时 start() 返回 false，UI 退化为
 * 「按住说话 / 打断键」这套显式交互，绝不假装在听。
 */

export interface VadOptions {
  /** RMS 阈值 0..1，默认 0.045（笔记本麦克风安静房间的实测经验值） */
  threshold?: number;
  /** 连续超过阈值多久才算「开口」，避免咔哒声误触发 */
  holdMs?: number;
  /** 触发后的冷却，避免一次开口连发 */
  cooldownMs?: number;
  /** 采样窗口 */
  fftSize?: number;
  onSpeech?(): void;
  onLevel?(level: number, threshold: number): void;
  onError?(message: string): void;
}

export interface VadController {
  readonly running: boolean;
  /** 返回 false 表示麦克风不可用（权限/设备/API） */
  start(): Promise<boolean>;
  stop(): void;
  setThreshold(value: number): void;
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
  private threshold: number;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private raf: number | null = null;
  private active = false;
  private aboveSince: number | null = null;
  private lastFireAt = 0;

  constructor(options: VadOptions = {}) {
    this.options = options;
    this.threshold = options.threshold ?? 0.045;
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
    this.aboveSince = null;
  }

  setThreshold(value: number): void {
    this.threshold = value;
  }

  private loop = (): void => {
    if (!this.active || !this.analyser || !this.data) return;
    try {
      this.analyser.getByteTimeDomainData(this.data);
      const level = rmsFrom(this.data);
      this.options.onLevel?.(level, this.threshold);

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const holdMs = this.options.holdMs ?? 120;
      const cooldownMs = this.options.cooldownMs ?? 900;

      if (level >= this.threshold) {
        this.aboveSince ??= now;
        if (now - this.aboveSince >= holdMs && now - this.lastFireAt >= cooldownMs) {
          this.lastFireAt = now;
          this.aboveSince = now;
          this.options.onSpeech?.();
        }
      } else {
        this.aboveSince = null;
      }
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
  };
}
