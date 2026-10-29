/**
 * 语音输出（TTS）。
 *
 * 三个 Provider，同一个接口：
 *  - BrowserTTS：speechSynthesis，零密钥默认路径（也是所有失败路径的兜底）。
 *    把字幕增量按句切分入队朗读，所以「说」的节奏天然跟着字幕走。
 *  - StreamTTS：消费 audio.chunk（base64 → ArrayBuffer → WebAudio）。
 *    解码/排队/取消是完备实现且被单测覆盖，但**从未用真实 MP3 验证过解码播放**（见报告）。
 *  - RoutedTTS：按分句选路（中文→Edge / 英文→Deepgram / 其余→浏览器），
 *    内部是 2 槽有序流水线：当前句在播时，下一句的合成已经在路上。
 *
 * 三者都必须做到：`cancel()` 同步、立即、彻底 —— 打断发生时不允许再冒出半个字。
 */

import {
  CHARACTER_VOICE,
  browserPitchOf,
  browserRateOf,
} from "../../shared/characterVoice";

export type AudioMode = "browser" | "stream";

export interface AudioChunk {
  seq: number;
  dataUrl: string;
  mime: string;
  /** 这一段音频属于哪一轮（只给观测用，播放逻辑不依赖它） */
  turnId?: string;
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
  /**
   * 句子级取消（可选实现）：
   *   · 当前**这一句**立刻停；
   *   · 已生成、尚未播的后续句子作废；
   *   · 在飞的合成请求被 abort（网络连接与服务端名额一起释放）；
   *   · 取消**之后**新派发的句子不受影响（它们的句子 id 更大）。
   *
   * 与 `cancel()` 的唯一区别就是最后一条：`cancel()` 把整条管道拆掉，
   * `cancelSentence()` 只作废「到此刻为止发出的那些句子」。
   * 没有实现的老 stub 走 `cancel()` 兜底（见 store 的 cancelAudio）。
   */
  cancelSentence?(): void;
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
  /** 待播队列：buffer 带上它自己那一轮的 id（不能共用一个「当前轮」字段，跨轮会串） */
  private queue: Array<{ buffer: AudioBuffer; turnId?: string }> = [];
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
        this.queue.push({ buffer, turnId: chunk.turnId });
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
    let item = this.queue.shift();
    while (item) {
      const { buffer, turnId } = item;
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
        // 「真正听到」的时刻：分片交付（turn:first-audio）之后还要 base64 解码 +
        // decodeAudioData + AudioContext 排期，这段几十到几百 ms 才是用户感知的部分。
        obsFirst("turn:first-sound", turnId);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      item = this.queue.shift();
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

// ================================================================== Provider 选择

/**
 * CJK 判据（客户端这一份；服务端 `src/server/tts.ts` 里有一模一样的另一份）。
 * 两处属于 server / web 两个独立构建，不允许跨端 import，所以有意的写两遍、两边各钉单测。
 */
const CLIENT_CJK = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

export function containsCjk(text: string): boolean {
  return CLIENT_CJK.test(text);
}

/**
 * 「这段文本值不值得念」：只要有一个字母或数字就算。
 *
 * 为什么需要它：`splitSpeech` 会把 `"……"` 这类纯标点切成分句，而 `…`(U+2026) 不在 CJK
 * 区间里 → 被判成英文 → 打到未配置的 Deepgram → 503 → 降级出第二个音色。
 * 纯标点本来就没有声音可念，直接不派发是最省事也最正确的处理。
 */
import { currentObsTurnId, obsEvent, obsFirst } from "../obs/obs";

const SPEAKABLE = /[\p{L}\p{N}]/u;

export function isSpeakable(text: string): boolean {
  return SPEAKABLE.test(text);
}

export type VoiceTtsTier = "edge" | "deepgram" | "browser";

/** 路由层看到的能力：中文看 `ttsZh`（Edge CLI），英文看 `tts`（Deepgram key） */
export interface TtsCapability {
  tts: boolean;
  ttsZh?: boolean;
}

/**
 * 分句级的 Provider 选择。判据三条，顺序不能换：
 *   1. 含 CJK → `ttsZh` 可用就走 **Edge**（本机 CLI，唯一有中文音色的方案），否则浏览器
 *   2. 纯英文且 `tts` 可用 → Deepgram Aura
 *   3. 其余（未配置 / status 还没到 / 空串）→ 浏览器。默认永远是可用的那一条。
 *
 * CJK 永远不会落到 Deepgram：Aura 只有英语模型，出来的是废音（服务端也会拦一道）。
 */
export function selectTtsChannel(
  text: string,
  status: TtsCapability | null | undefined,
): VoiceTtsTier {
  if (!text.trim()) return "browser";
  if (containsCjk(text)) return status?.ttsZh === true ? "edge" : "browser";
  return status?.tts === true ? "deepgram" : "browser";
}

/** MP3 字节 → base64（塞进既有的 audio.chunk 通道，复用 StreamTTS 的解码/排队） */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode(...bytes.subarray(i, i + block));
  }
  return btoa(binary);
}

export type SpeakRequestResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; reason: string };

/**
 * 流式合成的一个分片流。`ok` 时 `chunks` 边到边吐 MP3 字节。
 *
 * 为什么要有这一层：中文的整句合成要等 1.5s+ 才有第一个字节，而一句话的开头
 * 通常几百毫秒就出来了。拿到第一块就开始播，才能把「等待」变成「已经在说」。
 */
export type SpeakStreamResult =
  | { ok: true; chunks: AsyncIterable<Uint8Array> }
  | { ok: false; reason: string };

/**
 * `signal` 是**句子级取消**的抓手：取消时 abort 它，
 * fetch 立刻断开，服务端那一路合成（Edge WS 名额）也就立刻释放。
 */
export type SpeakStream = (text: string, signal?: AbortSignal) => Promise<SpeakStreamResult>;

/**
 * 入队前的最小聚合字节数。
 *
 * Edge 的 `Path:audio` 分片**不对齐 MPEG 帧边界**，直接把每一片丢给 `decodeAudioData`
 * 会在分片尾部丢掉半个帧；片越小越明显。聚到 ~1KB 再入队，代价是首个可播单位晚
 * 约 40–80ms（48kbps 下 1KB ≈ 170ms 音频里的一小段缓冲），换的是稳定的解码。
 */
export const MIN_AUDIO_CHUNK_BYTES = 1024;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode(...bytes.subarray(i, i + block));
  }
  return btoa(binary);
}

function mergeBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已经被取消 */
    }
  }
}

/**
 * 默认实现：`POST /api/tts?stream=1`，读 `ReadableStream`。
 * 失败（非 2xx / 没有 body）只回 reason —— 调用方据此对这一句回退本机音。
 */
export function createSpeakStream(fetcher: typeof fetch = fetch): SpeakStream {
  return async (text, signal) => {
    try {
      const res = await fetcher("/api/tts?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok) {
        let reason = `status-${res.status}`;
        try {
          const payload = (await res.json()) as { reason?: string };
          if (typeof payload?.reason === "string" && payload.reason) reason = payload.reason;
        } catch {
          /* body 不是 JSON：保留状态码 */
        }
        return { ok: false, reason };
      }
      if (!res.body) return { ok: false, reason: "no-body" };
      return { ok: true, chunks: readBody(res.body) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "network" };
    }
  };
}

export type SpeakRequest = (text: string, signal?: AbortSignal) => Promise<SpeakRequestResult>;

/** 默认实现：POST /api/tts 拿 MP3。失败只回 reason（服务端的 400/502 原因码）。 */
export function createSpeakRequest(fetcher: typeof fetch = fetch): SpeakRequest {
  return async (text, signal) => {
    try {
      const res = await fetcher("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok) {
        let reason = `status-${res.status}`;
        try {
          const body = (await res.json()) as { reason?: unknown };
          if (typeof body?.reason === "string") reason = body.reason;
        } catch {
          /* 非 JSON 响应：保留状态码即可 */
        }
        return { ok: false, reason };
      }
      return { ok: true, bytes: await res.arrayBuffer() };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : "network" };
    }
  };
}

export interface RoutedTtsOptions {
  lang?: string;
  onSegment?: (text: string) => void;
  /** 每个分句现查一次：status 可能比第一句话更晚到 */
  getStatus?: () => TtsCapability | null;
  speakRequest?: SpeakRequest;
  /**
   * 流式合成（首块即播）。**显式传 `null` 可以关掉**：
   * 注入了 `speakRequest`（测试的假实现）而没有传 `speakStream` 时默认关掉，
   * 这样既有的整块路径测试不受影响；生产不传任何东西 → 默认开启流式。
   */
  speakStream?: SpeakStream | null;
  /**
   * 第一次用上「本机合成音」时回调一次（诊断区用它说明「非角色音色」）。
   * 只在首句触发，不打断对话、不弹窗。
   */
  onBrowserFallback?: (reason: string) => void;
  /**
   * 某一句重试后仍然没有合成出来、最终**没有出声**时回调（诊断区用它说明原因）。
   * 注意语义：这里**不会**降级到本机音 —— 角色音色必须唯一，第二个音色比一句静音更糟。
   */
  onSynthIssue?: (reason: string) => void;
}

/** 同时在飞的合成请求数：1 个当前句 + 1 个预取。服务端也限 2 个 CLI 进程，正好对齐。 */
const MAX_SYNTH_INFLIGHT = 2;

/** 首句预热用的极短文本（CJK → Edge 那一路） */
const PREWARM_TEXT_ZH = "。";

interface SynthJob {
  /** 句序号（入队序），交付顺序以它为准 */
  order: number;
  /**
   * **句子 id**（发号序）：句子级取消的代际令牌。
   *
   * 取消只作废 `id <= cancelledSentence` 的句子；取消之后新派发的句子 id 更大，
   * 因此不受影响 —— 这就是「打断只清旧句、不误伤下一轮」的根据。
   */
  sentence: number;
  text: string;
  tier: "edge" | "deepgram";
  /**
   * 派发那一刻的轮次 id（快照）。
   *
   * 不能等请求回来再问「现在是哪一轮」：打断之后新旧轮会同时在飞，
   * 上一轮被取消的请求迟到返回时，`currentObsTurnId()` 已经指向新一轮了 ——
   * 那条请求会被记到下一轮头上（2026-10-28 审查发现）。
   */
  turnId?: string;
}

/** 一句话的流式交付状态 */
interface JobState {
  job: SynthJob;
  /** 已到手、还没送进播放器的 dataURL（按到达顺序） */
  chunks: string[];
  /** 这句的合成是否已经结束（成功或失败） */
  done: boolean;
  /** 失败原因（没有拿到任何音频时才有值） */
  failed: string | null;
  /**
   * 这句是否**真的**收到过音频分片。
   *
   * 不能用 `chunks.length === 0` 判断：队首那句的分片会被 `drain()` 立刻交给播放器
   * 并从数组里 shift 掉，于是「合成完整但正在播」的句子看起来和「一个字都没合成出来」
   * 一模一样 —— 误判成 empty-audio 之后每句都会用本机音再念一遍，用户听到两个声音
   * 同时说话（2026-10-28 复现并修复）。
   */
  gotAudio: boolean;
}

/**
 * 按分句选 Provider 的 TTS：
 *   · 中文 / status 不可用 → BrowserTTS（行为与改造前完全一致）
 *   · 纯英文且可用 → POST /api/tts → MP3 字节包成 audio.chunk → StreamTTS（既有播放路径）
 * 两条路都遵守同一条铁律：`cancel()` 之后，迟到的 fetch / 迟到的解码一律不许出声（代际令牌）。
 */
export class RoutedTTS implements TTSProvider {
  private browser: BrowserTTS | null = null;
  private stream: StreamTTS | null = null;
  private buffer = "";
  private generation = 0;
  private seq = 0;
  private lastErrorValue: string | null = null;
  /** 待合成队列（按句序）：预取 = 让队首两个同时在飞 */
  private readonly synthQueue: SynthJob[] = [];
  private synthInflight = 0;
  /** 下一个入队的序号 */
  private synthOrder = 0;
  /** 下一个「按序交付」的序号：乱序先完成的结果在这里等前一句 */
  private synthHead = 0;
  /** 按句序排好的交付状态：分片先进各自队列，只有「队首」允许立刻入播放器 */
  private readonly jobs = new Map<number, JobState>();
  /** 已发出的句子 id（发号器）：句子级取消用它划定「作废范围」的右界 */
  private sentenceSeq = 0;
  /** <= 这个 id 的句子全部作废（取消之后新发的句子 id 更大，不受影响） */
  private cancelledSentence = 0;
  /** 每句自己的 AbortController：取消只 abort 这些句子的合成请求 */
  private readonly sentenceControllers = new Map<number, AbortController>();
  /** 首句预热是否已经做过（只做一次） */
  private prewarmed = false;
  private browserNoticeSent = false;
  private readonly lang: string;
  private readonly onSegment: ((text: string) => void) | null;
  private readonly getStatus: () => TtsCapability | null;
  private readonly speakRequest: SpeakRequest;
  private readonly speakStream: SpeakStream | null;
  private readonly onBrowserFallback: ((reason: string) => void) | null;
  private readonly onSynthIssue: ((reason: string) => void) | null;

  constructor(options: RoutedTtsOptions = {}) {
    this.lang = options.lang ?? "zh-CN";
    this.onSegment = options.onSegment ?? null;
    this.getStatus = options.getStatus ?? (() => null);
    this.speakRequest = options.speakRequest ?? createSpeakRequest();
    this.speakStream =
      options.speakStream === undefined
        ? options.speakRequest
          ? null // 注入了整块实现（测试）：不擅自切到流式
          : createSpeakStream()
        : options.speakStream;
    this.onBrowserFallback = options.onBrowserFallback ?? null;
    this.onSynthIssue = options.onSynthIssue ?? null;
  }

  get name(): string {
    const status = this.getStatus();
    const tiers: string[] = [];
    if (status?.ttsZh === true) tiers.push("edge");
    if (status?.tts === true) tiers.push("deepgram");
    tiers.push("browser");
    return tiers.join("+");
  }

  /** 最近一次 Deepgram 合成失败的原因（UI/诊断可读；内容不含凭据） */
  get lastError(): string | null {
    return this.lastErrorValue;
  }

  get isSpeaking(): boolean {
    return (
      (this.browser?.isSpeaking ?? false) ||
      (this.stream?.isSpeaking ?? false) ||
      this.synthInflight > 0 ||
      this.jobs.size > 0
    );
  }

  /** 必须在用户手势里调一次：StreamTTS 的 AudioContext 不能在后台悄悄创建 */
  warmUp(): void {
    const status = this.getStatus();
    if (status?.tts !== true && status?.ttsZh !== true) return;
    // 先预热：连接捂热比 AudioContext 恢复更影响首句延迟，
    // 且后者在个别环境里会抛（没有 AudioContext）—— 不能让它连累预热。
    this.prewarmTts(status);
    try {
      this.ensureStream().warmUp();
    } catch {
      /* 音频上下文起不来：预热仍然有效 */
    }
  }

  /**
   * 首句预热：先发一次**极短**的合成请求，把上游的连接冷启
   * （Edge WS 握手实测约 1.2s）挪到用户还在打字/说话的时候。
   *
   * 预热返回的音频直接丢掉（不进播放器、不进字幕）—— 它只负责把连接捂热。
   * 整轮只做一次；失败不重试、不出声（预热失败 = 没有预热，不该有别的后果）。
   */
  private prewarmTts(status: TtsCapability | null): void {
    if (this.prewarmed) return;
    if (status?.ttsZh !== true && status?.tts !== true) return;
    this.prewarmed = true;
    // 中文走 Edge、纯英文走 Deepgram：预热文本必须落在同一条路上，否则白捂
    const text = status?.ttsZh === true ? PREWARM_TEXT_ZH : "ok";
    void Promise.resolve(this.speakRequest(text)).catch(() => undefined);
  }

  speak(text: string): void {
    if (!text) return;
    this.buffer += text;
    const { segments, rest } = splitSpeech(this.buffer);
    this.buffer = rest;
    for (const segment of segments) this.dispatch(segment);
  }

  flush(): void {
    if (this.buffer.trim()) {
      const { segments } = splitSpeech(this.buffer, { flush: true });
      this.buffer = "";
      for (const segment of segments) this.dispatch(segment);
    }
    // 浏览器那一路自己攒着残句；Deepgram 那一路按整句请求，不需要 flush
    this.browser?.flush();
  }

  cancel(): void {
    this.generation += 1;
    this.buffer = "";
    // 整轮取消 = 句子级取消 + 把 provider 状态复位（回退提示只说一次）
    this.cancelSentence();
    this.browserNoticeSent = false;
  }

  /**
   * 句子级取消（打断用）：
   *   ① 当前这句立刻停（正在播的音频 + 本机音）；
   *   ② 已生成、尚未播的后续句子作废（队列里的、已到手但没播的，都丢）；
   *   ③ 在飞的合成请求 abort —— 网络断开、服务端的 Edge 名额立刻释放，
   *      下一轮的第一句因此**不必等旧轮的 TTS 队列排空**。
   *
   * 作废范围由句子 id 划定（`<= cancelledSentence`）；取消之后新派发的句子 id 更大，
   * 不受影响 —— 这是它与 `cancel()` 的唯一区别，也是它比 `cancel()` 更安全的地方。
   */
  cancelSentence(): void {
    // 残句也必须丢掉：她说到半句时用户打断，buffer 里留着「最后一个句号之后的半句」，
    // 不清就会被下一轮首句拼成一句（审查 2026-10-29 指出）
    this.buffer = "";

    // ① 当前这句立刻停
    this.browser?.cancel();
    this.stream?.cancel();
    // ② 作废到此刻为止发出的所有句子
    this.cancelledSentence = this.sentenceSeq;
    this.generation += 1; // 在飞的结果回来时凭它自我作废（迟到不回放）
    this.synthQueue.length = 0;
    for (const order of [...this.jobs.keys()]) {
      const state = this.jobs.get(order);
      if (state && state.job.sentence <= this.cancelledSentence) this.jobs.delete(order);
    }
    this.synthHead = this.synthOrder;
    this.synthInflight = 0;
    // ③ 中止在飞的合成请求（服务端那一路也会跟着中止）
    for (const controller of this.sentenceControllers.values()) controller.abort();
    this.sentenceControllers.clear();
  }

  dispose(): void {
    this.cancel();
    this.browser?.dispose();
    this.stream?.dispose();
    this.browser = null;
    this.stream = null;
  }

  // ------------------------------------------------------------ 内部

  private dispatch(segment: string): void {
    // 纯标点碎片（`"…"` 这种）既不该发合成请求，也不该出声。
    if (!isSpeakable(segment)) return;
    const status = this.getStatus();
    let tier = selectTtsChannel(segment, status);
    // 单音色收敛：主音色（Edge）可用时，纯英文碎片也交给同一条服务端管道。
    // 否则「中文句 + 夹带英文」天然会拆成角色音 + 系统音两路 —— 那是双声的温床。
    if (tier === "browser" && status?.ttsZh === true) tier = "edge";
    if (tier === "browser") {
      // 走到这里说明没有服务端音色可用：本机合成音，首句在诊断区说明一次
      // 硬约束：任何时刻只允许一个音色出声。角色音频正在播时插入系统音，
      // 用户听到的就是两个人同时说话 —— 宁可这一句只有字幕。
      // 不只看「正在出声」，还要看「已经在飞/排队」：Edge 请求还没回来时
      // `stream.isSpeaking` 是 false，此时插入系统音，几百毫秒后 Edge 首片到达
      // 就会两路同时说（reviewer 抓到的时差窗口，2026-10-28）。
      if (this.serverPending()) {
        this.lastErrorValue = "角色音正在合成或播放，本机音会与之重叠：这一句只显示字幕";
        this.onSynthIssue?.(this.lastErrorValue);
        obsEvent("tts:issue", {
          turnId: currentObsTurnId() ?? undefined,
          detail: { reason: this.lastErrorValue },
        });
        return;
      }
      this.noticeBrowserFallback(containsCjk(segment) ? "本机合成音（非角色音色）" : "浏览器合成音");
      // 观测：本机音也是一次「请求」，否则面板上这一轮会显示「没走 TTS」，读起来像丢了数据
      obsEvent("tts:request", {
        turnId: currentObsTurnId() ?? undefined,
        detail: { tier: "browser", ms: null, ok: true, reason: null },
      });
      this.ensureBrowser().speak(segment);
      return;
    }
    const sentence = (this.sentenceSeq += 1);
    this.synthQueue.push({
      order: this.synthOrder,
      sentence,
      text: segment,
      tier,
      turnId: currentObsTurnId() ?? undefined,
    });
    this.synthOrder += 1;
    this.pumpSynth();
  }

  /**
   * 2 槽流水线：发出去就不再等回来。
   * Edge 每句要 1.7–2.0s，第 1 句在播的时候第 2 句的请求已经在路上 ——
   * 这段合成时间被播放时间遮住了，用户听到的是「一句接一句」，不是「一句一等」。
   */
  private pumpSynth(): void {
    while (this.synthInflight < MAX_SYNTH_INFLIGHT && this.synthQueue.length > 0) {
      const job = this.synthQueue.shift();
      if (!job) break;
      this.synthInflight += 1;
      void this.runSynth(job);
    }
  }

  /**
   * 跑一句话。两条路：
   *  - 有 `speakStream` → 边收边交给 `drain()`（队首那句收到第一块就能出声）；
   *  - 只有整块实现 → 老行为（拿到整块再入队）。
   * 无论哪条，**入播放器的顺序只由 `synthHead` 决定**，所以 2 槽预取的乱序完成
   * 不会打乱播放与字幕的同步。
   */
  private async runSynth(job: SynthJob): Promise<void> {
    const generation = this.generation;
    const state: JobState = { job, chunks: [], done: false, failed: null, gotAudio: false };
    this.jobs.set(job.order, state);
    // 句子级取消的抓手：这一句自己的 AbortController。
    // 取消只 abort 这一句的请求 —— 取消之后新派发的句子（id 更大）不受影响。
    const controller = new AbortController();
    this.sentenceControllers.set(job.sentence, controller);
    try {
      await this.synthAttempt(state, generation, controller.signal);
      // 重试一次：503 `not-configured` 实测是服务端原生 WS 的探测竞态
      // （同一轮里 4271ms 那句失败、5708ms 的同批请求就成功），第二次几乎必成。
      // 没有这次重试，一次偶发就等价于「这一句永远没声音」。
      // 只在「一个字都还没送进播放器」时重试。
      // 已经出过声的句子重试会让前半句从 0 再播一遍（用户听到重播/破音），
      // 那种情况下宁可这一句就此静音（字幕仍在）。
      if (state.failed && !state.gotAudio && generation === this.generation) {
        state.failed = null;
        state.chunks.length = 0;
        state.gotAudio = false;
        await this.synthAttempt(state, generation, controller.signal);
      }
    } finally {
      this.sentenceControllers.delete(job.sentence);
    }
    // 打断之后回来的音频：不占槽、不入队、不出声（cancel 已经把计数器清零）
    if (generation !== this.generation) {
      this.jobs.delete(job.order);
      return;
    }
    state.done = true;
    this.synthInflight = Math.max(0, this.synthInflight - 1);
    this.drain();
    this.pumpSynth();
  }

  /** 单次合成尝试（不含重试）。失败只记原因，由 `runSynth` 决定是否再试。 */
  private async synthAttempt(state: JobState, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      if (this.speakStream) await this.runSynthStreaming(state, generation, signal);
      else await this.runSynthBuffered(state, generation, signal);
    } catch (err) {
      state.failed = state.failed ?? (err instanceof Error ? err.message : "network");
    }
  }

  /** 流式：按 ~1KB 聚合后入队，句尾的零头在流结束时补上（不能丢，丢了句尾缺字） */
  private async runSynthStreaming(state: JobState, generation: number, signal?: AbortSignal): Promise<void> {
    const speakStream = this.speakStream;
    if (!speakStream) return;
    const requestStartedAt = performance.now();
    const result = await speakStream(state.job.text, signal);
    obsEvent("tts:request", {
      turnId: state.job.turnId,
      detail: {
        tier: state.job.tier,
        ms: Math.round(performance.now() - requestStartedAt),
        ok: result.ok,
        reason: result.ok ? null : result.reason,
      },
    });
    if (generation !== this.generation) return;
    if (!result.ok) {
      state.failed = result.reason;
      return;
    }
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    try {
      for await (const chunk of result.chunks) {
        if (generation !== this.generation) return;
        if (!chunk || chunk.byteLength === 0) continue;
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        if (pendingBytes < MIN_AUDIO_CHUNK_BYTES) continue;
        state.chunks.push(`data:audio/mpeg;base64,${bytesToBase64(mergeBytes(pending))}`);
        state.gotAudio = true;
        pending = [];
        pendingBytes = 0;
        this.drain();
      }
    } finally {
      if (generation === this.generation && pendingBytes > 0) {
        state.chunks.push(`data:audio/mpeg;base64,${bytesToBase64(mergeBytes(pending))}`);
        state.gotAudio = true;
      }
    }
    if (generation !== this.generation) return;
    // 连一块音频都没收到：当成这句失败，交给本机音兜底
    if (!state.gotAudio && !state.failed) state.failed = "empty-audio";
  }

  /** 整块：既有行为，一字不变地保留（Deepgram 英文路径就是这条） */
  private async runSynthBuffered(state: JobState, generation: number, signal?: AbortSignal): Promise<void> {
    const result = await this.speakRequest(state.job.text, signal);
    if (generation !== this.generation) return;
    if (result.ok) {
      state.chunks.push(`data:audio/mpeg;base64,${bytesToBase64(new Uint8Array(result.bytes))}`);
      state.gotAudio = true;
    } else {
      state.failed = result.reason;
    }
  }

  /**
   * 只按句序交付：队首那句的分片**到手即送**，后面几句的分片先待在自己队列里。
   * 这是「首块即播」与「播放/字幕顺序不乱」能同时成立的唯一办法 ——
   * 预取可以乱序完成，但喂给播放器的必须是一条连续的时间线。
   */
  private drain(): void {
    for (;;) {
      const state = this.jobs.get(this.synthHead);
      if (!state) return;
      if (state.job.sentence <= this.cancelledSentence) {
        // 已被句子级取消作废：迟到的音频绝不进播放器（迟到不回放）
        this.jobs.delete(state.job.order);
        this.synthHead += 1;
        continue;
      }
      while (state.chunks.length > 0) {
        const dataUrl = state.chunks.shift();
        if (!dataUrl) break;
        this.seq += 1;
        // 「首个音频包」= 第一个分片交付给播放器的时刻。归属用 job 自己的 turnId，
        // 不能用「当前轮」：旧轮的尾巴音频可能在新轮开始后才起播。
        obsFirst("turn:first-audio", state.job.turnId);
        // 最后一道硬保证：系统音正在播时绝不让角色音叠上去。
        // 上层路由已经尽量避免这种组合，这里是兜底 —— 谁先出声谁不被打断是次要的，
        // 「只有一个音色」是硬要求。
        if (this.browser?.isSpeaking === true) this.browser.cancel();
        this.ensureStream().pushChunk({
          seq: this.seq,
          dataUrl,
          mime: "audio/mpeg",
          turnId: state.job.turnId,
        });
      }
      if (!state.done) return;
      this.jobs.delete(state.job.order);
      this.synthHead += 1;
      if (state.failed) {
        // 重试也失败：**只静音这一句**（字幕照常），绝不启用第二个音色。
        // 旧实现在这里 `ensureBrowser().speak()` 补念，而此刻上一句的角色音频还在播，
        // 用户听到的就是两个声音同时说话（2026-10-28 实测复现）。
        this.lastErrorValue = `${state.job.tier} tts: ${state.failed}`;
        this.onSynthIssue?.(`这一句没有合成出来（${state.failed}），只有字幕`);
        obsEvent("tts:issue", {
          turnId: state.job.turnId,
          detail: { reason: state.failed },
        });
      }
    }
  }

  /** 本轮是否已有服务端音色在飞、在排队或在播（含尚未返回首片的拉取窗口） */
  private serverPending(): boolean {
    return (
      this.synthInflight > 0 ||
      this.synthQueue.length > 0 ||
      this.jobs.size > 0 ||
      this.stream?.isSpeaking === true
    );
  }

  private noticeBrowserFallback(reason: string): void {
    if (this.browserNoticeSent) return;
    this.browserNoticeSent = true;
    this.onBrowserFallback?.(reason);
  }

  private ensureBrowser(): BrowserTTS {
    if (!this.browser) {
      // 回退音色也尽量贴住角色档案：语速/音高按近似换算（browserRateOf/browserPitchOf），
      // 音色靠 BrowserTTS 内部的 zh-CN 优先匹配。注意这里用的是编译期默认档案：
      // 客户端的 env 覆盖拿不到，服务端调过 EDGE_TTS_* 时浏览器这一路不会跟着变。
      this.browser = new BrowserTTS({
        lang: this.lang,
        rate: browserRateOf(CHARACTER_VOICE.rate),
        pitch: browserPitchOf(CHARACTER_VOICE.pitch),
        onSegment: this.onSegment ?? undefined,
      });
    }
    return this.browser;
  }

  private ensureStream(): StreamTTS {
    if (!this.stream) {
      // 只是被当播放器用（分片已由我们灌入），所以关掉它自己的字幕回退，避免双重声音
      this.stream = new StreamTTS({ lang: this.lang, fallbackToBrowser: false });
    }
    return this.stream;
  }
}

export function createVoiceTts(
  options: RoutedTtsOptions & { mode?: AudioMode } = {},
): TTSProvider & Partial<AudioChunkSink> & { warmUp(): void } {
  // `?audio=stream` 是既有的实验开关，行为保持不变（不套路由层）
  if (options.mode === "stream") return new StreamTTS({ lang: options.lang });
  return new RoutedTTS(options);
}
