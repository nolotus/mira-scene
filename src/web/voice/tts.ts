/**
 * 语音输出（TTS）。
 *
 * 两个 Provider，同一个接口：
 *  - BrowserTTS：speechSynthesis，零密钥默认路径。把字幕增量按句切分入队朗读，
 *    所以「说」的节奏天然跟着字幕走。
 *  - StreamTTS：消费协议里的 audio.chunk（base64 → ArrayBuffer → WebAudio）。
 *    Mock 模式不产生音频分片，但代码路径完整，可用 `?audio=stream` 打开验证。
 *
 * 两者都必须做到：`cancel()` 同步、立即、彻底 —— 打断发生时不允许再冒出半个字。
 */

export type AudioMode = "browser" | "stream";

export interface AudioChunk {
  seq: number;
  dataUrl: string;
  mime: string;
}

export interface TTSProvider {
  readonly name: string;
  readonly isSpeaking: boolean;
  /** 增量文本（字幕 delta）：内部按句切分后入队 */
  speak(text: string): void;
  /** 把句末残句立刻读出来（turn.end 时调用） */
  flush(): void;
  /** 立即静音：停掉正在播的 + 清空队列 */
  cancel(): void;
  dispose(): void;
}

/** StreamTTS 额外接收音频分片 */
export interface AudioChunkSink {
  pushChunk(chunk: AudioChunk): void;
}

export function hasAudioChunkSink(tts: TTSProvider): tts is TTSProvider & AudioChunkSink {
  return typeof (tts as Partial<AudioChunkSink>).pushChunk === "function";
}

// ---------------------------------------------------------------- 断句

/** 强断句符 */
const HARD_BREAK = /[。！？!?…；;\n]/;
/** 软断句符：句子过长时在这里换气 */
const SOFT_BREAK = /[，,、：:—]/;

export interface SplitResult {
  segments: string[];
  rest: string;
}

/**
 * 增量断句：喂一段增长中的文本，产出可以立刻朗读的整句。
 * 纯函数，单测友好。
 */
export function splitSpeech(
  buffer: string,
  opts: { flush?: boolean; maxSegment?: number } = {},
): SplitResult {
  const flush = opts.flush ?? false;
  const maxSegment = opts.maxSegment ?? 42;
  const segments: string[] = [];

  let cursor = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if (ch === undefined) continue;
    if (HARD_BREAK.test(ch)) {
      const seg = buffer.slice(cursor, i + 1).trim();
      if (seg) segments.push(seg);
      cursor = i + 1;
      continue;
    }
    if (i - cursor >= maxSegment && SOFT_BREAK.test(ch)) {
      const seg = buffer.slice(cursor, i + 1).trim();
      if (seg) segments.push(seg);
      cursor = i + 1;
    }
  }

  let rest = buffer.slice(cursor);
  // 模型长时间不吐标点时也要能开口：硬切成 maxSegment 长度的块
  while (rest.length > maxSegment * 2) {
    segments.push(rest.slice(0, maxSegment).trim());
    rest = rest.slice(maxSegment);
  }

  if (flush) {
    const tail = rest.trim();
    if (tail) segments.push(tail);
    rest = "";
  }

  return { segments, rest };
}

// ---------------------------------------------------------------- 浏览器 TTS

export interface BrowserTTSOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  /** 优先匹配的音色名（不同平台命名不同） */
  voiceHints?: string[];
  /** 每句开始朗读时回调（空串表示队列读完/被打断）——UI 用它显示「正在朗读」并与字幕对齐 */
  onSegment?: (text: string) => void;
}

export function isBrowserTtsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/**
 * 零密钥主路径：speechSynthesis。
 *
 * 三个必须做对的地方（都会在真实浏览器里咬人）：
 *  1. 按句入队：只有「句子完整」才开口，所以说话的节奏跟着字幕增长走，不会念半句。
 *  2. cancel() 立即静音并清空队列。
 *  3. **代际令牌**：Chrome/Safari 在 cancel() 之后仍可能把被取消 utterance 的
 *     onend/onerror 回调补发出来。若不做代际校验，这些迟到回调会推进队列、
 *     把 UI 拉回「正在说话」——正是题目要求防的那类「打断后状态被旧回调改回去」。
 *     每次 cancel() 都让 generation +1，旧回调凭旧令牌自我作废。
 *  另加一道路程保护：某些浏览器会丢 onend，用与文本长度相关的看门狗推进队列，
 *  避免整条语音链路卡死。
 */
export class BrowserTTS implements TTSProvider {
  readonly name = "browser-speech-synthesis";

  private readonly lang: string;
  private readonly rate: number;
  private readonly pitch: number;
  private readonly volume: number;
  private readonly voiceHints: string[];
  private readonly onSegment: ((text: string) => void) | null;

  private buffer = "";
  private queue: string[] = [];
  /** 每次 cancel 都 +1；迟到的 onend/onerror 回调凭它自我作废 */
  private generation = 0;
  private speakingNow = false;
  private disposed = false;
  private voice: SpeechSynthesisVoice | null = null;
  private voiceLoaded = false;
  private voicesWatched = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BrowserTTSOptions = {}) {
    this.lang = options.lang ?? "zh-CN";
    this.rate = options.rate ?? 1.0;
    this.pitch = options.pitch ?? 1.0;
    this.volume = options.volume ?? 0.9;
    this.voiceHints = options.voiceHints ?? ["tingting", "ting-ting", "xiaoxiao", "meijia", "mei-jia", "yunxi", "chinese"];
    this.onSegment = options.onSegment ?? null;
    if (isBrowserTtsSupported()) this.watchVoices();
  }

  get isSpeaking(): boolean {
    return this.speakingNow || this.queue.length > 0;
  }

  /** 当前正在朗读的句子（空串 = 没在说话），供 UI 与字幕对齐展示 */
  get currentSegment(): string {
    return this.speakingNow ? this.currentText : "";
  }

  private currentText = "";

  speak(text: string): void {
    if (!isBrowserTtsSupported() || this.disposed || !text) return;
    this.buffer += text;
    const { segments, rest } = splitSpeech(this.buffer);
    this.buffer = rest;
    if (segments.length > 0) {
      this.queue.push(...segments);
      this.pump();
    }
  }

  flush(): void {
    if (!isBrowserTtsSupported() || this.disposed) return;
    if (!this.buffer.trim()) {
      this.pump();
      return;
    }
    const { segments } = splitSpeech(this.buffer, { flush: true });
    this.buffer = "";
    if (segments.length > 0) {
      this.queue.push(...segments);
      this.pump();
    }
  }

  /** 立即静音。generation+1 之后，旧 utterance 的任何回调都不再生效。 */
  cancel(): void {
    this.generation += 1;
    this.queue = [];
    this.buffer = "";
    this.speakingNow = false;
    this.currentText = "";
    this.clearStallWatchdog();
    this.emitSegment("");
    if (!isBrowserTtsSupported()) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* 某些浏览器在无用户手势时会抛，忽略 */
    }
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  // ------------------------------------------------------------ 内部

  private pump(): void {
    if (!isBrowserTtsSupported() || this.disposed) return;
    if (this.speakingNow || this.queue.length === 0) return;

    const next = this.queue.shift();
    if (next === undefined) return;

    const synth = window.speechSynthesis;
    const generation = this.generation;
    const utterance = new SpeechSynthesisUtterance(next);
    utterance.lang = this.lang;
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    utterance.volume = this.volume;

    const voice = this.pickVoice();
    if (voice) utterance.voice = voice;

    const finish = () => {
      // ← 代际令牌：被打断之后补发的老回调在这里被丢弃
      if (generation !== this.generation) return;
      this.clearStallWatchdog();
      this.speakingNow = false;
      this.currentText = "";
      if (this.queue.length === 0 && !this.buffer.trim()) this.emitSegment("");
      this.pump();
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    this.speakingNow = true;
    this.currentText = next;
    this.emitSegment(next);
    try {
      if (synth.paused) synth.resume();
      synth.speak(utterance);
    } catch {
      this.speakingNow = false;
      this.currentText = "";
    }
    this.armStallWatchdog(next, generation);
  }

  /** 丢失 onend 的兜底：按文本长度估一个上限，超时且浏览器明确不在说话就自行推进 */
  private armStallWatchdog(text: string, generation: number): void {
    this.clearStallWatchdog();
    if (typeof setTimeout !== "function") return;
    const budget = Math.min(30_000, Math.max(3_000, text.length * 400 + 1_500));
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (generation !== this.generation || !this.speakingNow) return;
      let busy = false;
      try {
        busy = window.speechSynthesis.speaking || window.speechSynthesis.pending;
      } catch {
        busy = false;
      }
      if (busy) {
        this.armStallWatchdog(text, generation);
        return;
      }
      this.speakingNow = false;
      this.currentText = "";
      if (this.queue.length === 0 && !this.buffer.trim()) this.emitSegment("");
      this.pump();
    }, budget);
  }

  private clearStallWatchdog(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private emitSegment(text: string): void {
    this.onSegment?.(text);
  }

  /** 音色列表在 Chrome 里是异步就绪的，voiceschanged 之后要重新挑一次 */
  private watchVoices(): void {
    if (this.voicesWatched) return;
    this.voicesWatched = true;
    try {
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        this.voiceLoaded = false;
        this.voice = null;
      });
    } catch {
      /* 老浏览器没有 addEventListener，忽略 */
    }
  }

  /** 中文优先：zh-CN 精确匹配 > 同语种 > 名字命中 > 本地音色 */
  private pickVoice(): SpeechSynthesisVoice | null {
    if (this.voiceLoaded && this.voice) return this.voice;

    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = window.speechSynthesis.getVoices();
    } catch {
      return null;
    }
    if (voices.length === 0) {
      this.voiceLoaded = false; // 还没就绪，下次再挑
      return null;
    }

    const wanted = this.lang.toLowerCase();
    const primary = wanted.slice(0, 2);
    let best: SpeechSynthesisVoice | null = null;
    let bestScore = -1;

    for (const candidate of voices) {
      const candidateLang = (candidate.lang || "").toLowerCase();
      let score: number;
      if (candidateLang === wanted) score = 100;
      else if (candidateLang.startsWith(primary)) score = 60;
      else continue;

      const name = (candidate.name || "").toLowerCase();
      if (this.voiceHints.some((hint) => name.includes(hint))) score += 30;
      if (candidate.localService) score += 10;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    if (!best) return null;
    this.voice = best;
    this.voiceLoaded = true;
    return best;
  }
}

// ---------------------------------------------------------------- 流式音频 TTS

/** base64（可含 data: 前缀）→ ArrayBuffer */
export function base64ToArrayBuffer(input: string): ArrayBuffer {
  const comma = input.indexOf(",");
  const payload = input.startsWith("data:") && comma >= 0 ? input.slice(comma + 1) : input;
  const base64 = payload.replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes.buffer as ArrayBuffer;
}

export interface StreamTTSOptions {
  /** 播放音量 0..1 */
  volume?: number;
  /** 断句/音色语言（回退到浏览器 TTS 时用） */
  lang?: string;
  /**
   * 整轮下来服务端一个音频分片都没发（Mock 导演就是这样）时，
   * 把攒下的字幕交给 BrowserTTS 念出来，避免 `?audio=stream` 演示时彻底没声音。
   */
  fallbackToBrowser?: boolean;
}

/**
 * 按 seq 顺序解码、连排播放。`cancel()` 会 stop 掉所有已排期但未播完的 source，
 * 清空队列，并让进行中的 decode 结果作废（generation 护栏）。
 */
export class StreamTTS implements TTSProvider, AudioChunkSink {
  readonly name = "stream-audio";

  private readonly volume: number;
  private readonly lang: string;
  private readonly fallbackToBrowser: boolean;
  private fallback: BrowserTTS | null = null;
  /** 本轮是否真的收到过音频分片；false 时字幕先攒着，turn.end 再交给回退 TTS */
  private sawChunk = false;
  private pendingText = "";
  private ctx: AudioContext | null = null;
  private generation = 0;
  private queue: AudioBuffer[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private chain: Promise<void> = Promise.resolve();
  private nextStartAt = 0;
  private playing = false;
  private pending = 0;
  private lastError: string | null = null;

  constructor(options: StreamTTSOptions = {}) {
    this.volume = options.volume ?? 1;
    this.lang = options.lang ?? "zh-CN";
    this.fallbackToBrowser = options.fallbackToBrowser ?? true;
  }

  get isSpeaking(): boolean {
    return (
      this.playing ||
      this.queue.length > 0 ||
      this.pending > 0 ||
      (this.fallback?.isSpeaking ?? false)
    );
  }

  /** 音频模式下字幕由 reducer 驱动；这里只把它攒起来，给「无分片」时的回退用 */
  speak(text: string): void {
    if (this.sawChunk || !text) return;
    this.pendingText += text;
  }

  /** turn.end：本轮一直没有音频分片 → 用浏览器 TTS 把字幕念出来（明确降级，不是静默失败） */
  flush(): void {
    if (!this.sawChunk && this.pendingText.trim() && this.fallbackToBrowser) {
      const fallback = this.ensureFallback();
      if (fallback) {
        fallback.speak(this.pendingText);
        fallback.flush();
      }
    }
    this.pendingText = "";
    this.sawChunk = false;
  }

  /** StreamTTS 的 error 供 UI 观测 */
  get error(): string | null {
    return this.lastError;
  }

  /** 必须在用户手势里调一次，否则 AudioContext 处于 suspended */
  warmUp(): void {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") void ctx.resume();
  }

  pushChunk(chunk: AudioChunk): void {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return;
    // 本轮确实有流式音频：字幕不再交给回退 TTS，避免双重声音
    this.sawChunk = true;
    this.pendingText = "";
    const generation = this.generation;
    let raw: ArrayBuffer;
    try {
      raw = base64ToArrayBuffer(chunk.dataUrl);
    } catch (err) {
      this.lastError = `音频分片 base64 解码失败（seq=${chunk.seq}）`;
      console.warn(this.lastError, err);
      return;
    }

    this.pending += 1;
    // 串行解码：保证 seq 顺序，也避免多个 decodeAudioData 抢同一个输出流
    this.chain = this.chain
      .then(async () => {
        if (generation !== this.generation) return;
        const ctx = this.ensureContext();
        const buffer = await ctx.decodeAudioData(raw.slice(0));
        if (generation !== this.generation) return; // 解码期间被打断
        this.queue.push(buffer);
        this.drainQueue();
      })
      .catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.warn("[StreamTTS] 音频分片解码失败", chunk.seq, this.lastError);
      })
      .finally(() => {
        if (generation === this.generation) this.pending = Math.max(0, this.pending - 1);
      });
  }

  cancel(): void {
    this.generation += 1;
    this.queue = [];
    this.pending = 0;
    this.chain = Promise.resolve();
    this.nextStartAt = 0;
    this.playing = false;
    this.sawChunk = false;
    this.pendingText = "";
    this.fallback?.cancel();
    for (const source of this.sources) {
      try {
        source.onended = null;
        source.stop();
        source.disconnect();
      } catch {
        /* 已停止的 source 会抛，忽略 */
      }
    }
    this.sources.clear();
  }

  dispose(): void {
    this.cancel();
    this.fallback?.dispose();
    this.fallback = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }

  // ------------------------------------------------------------ 内部

  /** 回退 TTS：只在「整轮没有任何音频分片」时使用 */
  private ensureFallback(): BrowserTTS | null {
    if (!this.fallbackToBrowser || !isBrowserTtsSupported()) return null;
    this.fallback ??= new BrowserTTS({ lang: this.lang });
    return this.fallback;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private drainQueue(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let buffer = this.queue.shift();
    while (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      source.connect(gain);
      gain.connect(ctx.destination);

      const startAt = Math.max(this.nextStartAt, ctx.currentTime + 0.02);
      this.nextStartAt = startAt + buffer.duration;
      this.playing = true;
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        try {
          gain.disconnect();
        } catch {
          /* 忽略 */
        }
        if (this.sources.size === 0) this.playing = false;
      };
      try {
        source.start(startAt);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      buffer = this.queue.shift();
    }
  }
}

export function createTts(
  mode: AudioMode,
  options: { lang?: string; onSegment?: (text: string) => void } = {},
): TTSProvider & Partial<AudioChunkSink> {
  return mode === "stream"
    ? new StreamTTS({ lang: options.lang })
    : new BrowserTTS({ lang: options.lang, onSegment: options.onSegment });
}
