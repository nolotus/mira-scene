/**
 * 语音识别（STT）代理：浏览器 WS ⇄ 服务端 ⇄ Deepgram WS。
 *
 * 为什么必须服务端代理：`POST /v1/auth/grant` 实测 403，签不出短时 token，
 * 所以 key 一旦进浏览器就等于泄漏。唯一安全的形态是「浏览器连我们，我们连 Deepgram」。
 *
 * 三个硬约束：
 *   1. 只把**精简消息**回给浏览器（interim / final / speech_started / utterance_end / error），
 *      Deepgram 的原始 payload 里有 words/confidence/metadata 等一大堆东西，不进客户端。
 *   2. **不记录音频内容**：日志只有帧数/字节数/状态，绝不打印转写文本与音频。
 *   3. 任一侧关闭必须清掉另一侧：不做这件事，一次说话就会漏一条上游连接（等于漏钱）。
 *   4. **不能硬断上游**：收尾要先发 `{"type":"CloseStream"}` 并等尾段 final（上限
 *      FLUSH_TIMEOUT_MS）再关。真机踩过：客户端一关就 close 上游，Deepgram 来不及
 *      flush 尾段，浏览器只拿到 interim、永远等不到 final（细节见「控制消息」段）。
 *
 * ── 关于音频格式（已实测，别改成想当然）──
 * 两条路都通，客户端用哪条决定传哪个 format：
 *   · `webm-opus`（**默认**，= MediaRecorder('audio/webm;codecs=opus') 的真实产出）：
 *     **不写** encoding / sample_rate，让 Deepgram 按容器自己识别。
 *     实测：headless Chrome 播放中文语音 → MediaStreamAudioDestinationNode → MediaRecorder
 *     录出 56.3KB webm，原样流给上游后依次收到 speech_started(+962ms) / interim×3 /
 *     final（「外面还在下雨吗,我在顿利」）。所以浏览器侧**不需要** AudioWorklet 降采样。
 *   · `linear16`：100ms PCM 切片 @22050，声明 `encoding=linear16&sample_rate=22050`。
 *     这是最早实测通过的那条路，保留给「客户端改成直送 PCM」的将来。
 * 把 opus 字节塞进声明 linear16 的流，上游会按 PCM 去解释那段字节 —— 声音是错的，别混。
 */

import type { DeepgramConfig } from "./config.ts";

/** 中文只能用 nova-2：nova-3 对中文返回空结果（实测）。 */
export const STT_MODEL = "nova-2";
/** 实测通过的 PCM 参数 */
export const STT_PCM_SAMPLE_RATE = 22050;
export const STT_ENDPOINTING_MS = 300;
export const UPSTREAM_URL = "wss://api.deepgram.com/v1/listen";

/** 客户端真实送来的音频格式 */
export type SttAudioFormat = "webm-opus" | "linear16";

export interface SttUrlOptions {
  /** `zh-CN` → zh，`en-US` → en；en 未实测（实测过的只有 zh） */
  lang?: "zh-CN" | "en-US";
  format?: SttAudioFormat;
}

export function sttLanguage(lang: string | undefined): string {
  return lang === "en-US" ? "en" : "zh";
}

/**
 * 上游 URL。默认 webm-opus（= 浏览器 MediaRecorder 的真实产出）。
 * 注意：不返回带 key 的 URL，key 只走 Authorization 头。
 */
export function sttUpstreamUrl(options: SttUrlOptions = {}): string {
  const params = new URLSearchParams({
    model: STT_MODEL,
    language: sttLanguage(options.lang),
    interim_results: "true",
    smart_format: "true",
    endpointing: String(STT_ENDPOINTING_MS),
    vad_events: "true",
  });
  if ((options.format ?? "webm-opus") === "linear16") {
    params.set("encoding", "linear16");
    params.set("sample_rate", String(STT_PCM_SAMPLE_RATE));
    params.set("channels", "1");
  }
  return `${UPSTREAM_URL}?${params.toString()}`;
}

// ------------------------------------------------------------------ 精简消息

export type SttClientMessage =
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "speech_started" }
  | { type: "utterance_end" }
  | { type: "error"; reason: string };

/**
 * Deepgram 原始 payload → 精简消息。纯函数，空结果/无关消息回 null（不发给客户端）。
 *
 * 见过的几种：
 *   {"type":"Results", "is_final":false, "channel":{"alternatives":[{"transcript":"你"}]}}
 *   {"type":"Results", "is_final":true,  "speech_final":true, ...}
 *   {"type":"SpeechStarted", "channel":[0], "timestamp":1.2}
 *   {"type":"UtteranceEnd", "channel":[0], "last_word_end":2.5}
 *   {"type":"Metadata", ...}                     ← 建连时的握手，不发给客户端
 */
export function toClientMessage(raw: unknown): SttClientMessage | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const type = record.type;

  if (type === "SpeechStarted") return { type: "speech_started" };
  if (type === "UtteranceEnd") return { type: "utterance_end" };
  if (type !== "Results") return null;

  const channel = record.channel;
  const alternatives =
    channel && typeof channel === "object" ? (channel as Record<string, unknown>).alternatives : undefined;
  const first = Array.isArray(alternatives) ? alternatives[0] : undefined;
  const transcript =
    first && typeof first === "object" ? (first as Record<string, unknown>).transcript : undefined;
  const text = typeof transcript === "string" ? transcript.trim() : "";
  // 空结果（静音期间的 interim）不发给客户端：上游很爱发空串，客户端拿到只会白刷一次
  if (!text) return null;

  return record.is_final === true ? { type: "final", text } : { type: "interim", text };
}

// ------------------------------------------------------------------ 控制消息（浏览器 → 服务端）

/**
 * 客户端有两种「停止」，服务端必须分开处理：
 *   · 说完一句（`{type:"finish_utterance"}`）：把这一句的 final 冲出来，**保留**浏览器 WS；
 *     用户接着说下一句只需再发音频（服务端会为下一句补建一条上游）。
 *   · 彻底断开（关 WS / 页面卸载）：先冲尾段，再把两侧一起收摊。
 *
 * 为什么必须冲：Deepgram 的尾段 final 要等 endpointing（我们设 300ms）与它自己的缓冲。
 * 直接把上游 close 掉，那条 final 就永远到不了浏览器 —— 真机实测过：代理只回
 * speech_started + 1 条 interim，final 缺失；同一条 webm 直连 Deepgram 却能拿到 final。
 *
 * 协议约定：**文本帧 = 控制消息，二进制帧 = 音频**。认不出来的文本一律丢弃（不喂上游，
 * 否则会被当音频解析）。
 */
export type SttControlKind = "finish_utterance";

/** `CloseStream` 是 Deepgram 自己的叫法，留作别名，别让调用方去猜 */
export function parseSttControl(raw: string): SttControlKind | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const type = (parsed as Record<string, unknown>).type;
  if (type === "finish_utterance" || type === "CloseStream") return "finish_utterance";
  return null;
}

/**
 * 收尾等待上限。Deepgram 收到 CloseStream 后通常 200~600ms 内回尾段 final，
 * 1500ms ≈ 它的 2.5~7 倍：慢网有富余，又不会让「上游已经坏了」的会话把 WS 拖成僵尸。
 * 超时不是错误路径 —— 只是「硬断」，仍然把已经拿到的 final 转发过、并留日志。
 */
export const FLUSH_TIMEOUT_MS = 1500;

// ------------------------------------------------------------------ 双向桥

/** 上游 socket 的最小接口（生产是全局 WebSocket，测试是假的） */
export interface UpstreamSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen?: (() => void) | null;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onclose?: ((event?: unknown) => void) | null;
  onerror?: ((event?: unknown) => void) | null;
}

/** 浏览器侧 socket 的最小接口（生产是 Bun 的 ServerWebSocket） */
export interface BrowserSink {
  sendText(payload: string): void;
  close(code?: number, reason?: string): void;
}

export type UpstreamConnect = (url: string, headers: Record<string, string>) => UpstreamSocket;

export interface SttBridgeOptions {
  config: DeepgramConfig;
  connect: UpstreamConnect;
  sink: BrowserSink;
  lang?: "zh-CN" | "en-US";
  format?: SttAudioFormat;
  /** 只喂「帧数 / 字节数 / 状态」，绝不喂音频或转写文本 */
  log?: (line: string) => void;
  /** 上游还没 open 时浏览器推来的帧先排队（预热没到位也不丢第一句） */
  maxPendingFrames?: number;
  /** 收尾等待上限（测试可调小；默认 FLUSH_TIMEOUT_MS） */
  flushTimeoutMs?: number;
}

export interface SttBridge {
  /** 浏览器 → 上游（同时兼容「上一句已 flush、这句要新建上游」） */
  pushAudio(data: string | Uint8Array | ArrayBuffer): void;
  /** 「这句说完了，还要说下一句」：冲 final，**保留**浏览器连接 */
  finishUtterance(): void;
  /** 浏览器彻底断开（关 WS / 页面卸载）：冲尾段后两侧一起收摊 */
  clientClosed(): void;
  readonly closed: boolean;
  /** 诊断：最后一条上游消息的类型（只有类型，绝不含转写文本） */
  readonly lastUpstreamType: string | null;
}

const DEFAULT_MAX_PENDING = 50;

/** 只描述类型、不碰文本：日志里出现转写内容等于把用户说的话写进磁盘 */
export function describeUpstreamType(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unparsable";
  }
  if (!parsed || typeof parsed !== "object") return "unparsable";
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  if (type === "Results") {
    return record.is_final === true ? "Results(is_final=true)" : "Results(is_final=false)";
  }
  return type;
}

/**
 * 建立一条桥，并立即连上游。
 * 上游连不上 / 中途断开 → 给客户端一条 error，然后两侧一起收摊。
 * 收尾（CloseStream + 等尾段）见 requestFlush：既不能立刻断，也不能无限等。
 */
export function createSttBridge(options: SttBridgeOptions): SttBridge {
  const log = options.log ?? ((line: string) => console.warn(line));
  const maxPending = options.maxPendingFrames ?? DEFAULT_MAX_PENDING;
  const flushTimeoutMs = options.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;

  /** connecting：握手没回来｜live：正常转发｜draining：已发 CloseStream，等尾段｜null：没有上游 */
  let phase: "connecting" | "live" | "draining" | null = null;
  let upstream: UpstreamSocket | null = null;
  let closed = false;
  /** 收尾后浏览器侧留不留（false = 彻底断开） */
  let keepBrowser = true;
  /** 收尾原因：写进日志与超时标签，便于以后定位是谁发起的 */
  let flushReason = "client-closed";
  /** 握手还没回来就被要求收尾：open 后先补发排队帧，再发 CloseStream */
  let flushWanted = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastType: string | null = null;
  const pending: Array<string | Uint8Array> = [];
  let frames = 0;
  let bytes = 0;

  const sinkSend = (message: SttClientMessage): void => {
    if (closed && message.type !== "error") return;
    try {
      options.sink.sendText(JSON.stringify(message));
    } catch {
      // 浏览器侧已经没了：按断开处理，别让上游继续跑
      shutdown(1001, "client gone");
    }
  };

  const clearFlushTimer = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const closeUpstream = (code: number, reason: string): void => {
    const current = upstream;
    upstream = null;
    phase = null;
    flushWanted = false;
    if (!current) return;
    try {
      current.close(code, reason);
    } catch {
      /* 上游可能已经关了 */
    }
  };

  /** 彻底收摊：上游 + 浏览器侧一起关，并把「最后一条上游消息类型」留在日志里 */
  const shutdown = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    clearFlushTimer();
    pending.length = 0;
    closeUpstream(code, reason);
    try {
      options.sink.close(code, reason);
    } catch {
      /* 浏览器侧可能已经关了 */
    }
    log(`[stt] closed frames=${frames} bytes=${bytes} reason=${reason} lastUpstream=${lastType ?? "none"}`);
  };

  /** 收尾结束：关上游；keepBrowser 为真时把浏览器 WS 留着，等下一句的音频 */
  const settleSegment = (reason: string, tail: string): void => {
    clearFlushTimer();
    flushWanted = false;
    const hadUpstream = upstream !== null;
    closeUpstream(1000, reason);
    if (closed) return;
    if (hadUpstream) {
      log(
        `[stt] segment closed reason=${reason} tail=${tail} lastUpstream=${lastType ?? "none"} frames=${frames} bytes=${bytes}`,
      );
    }
    if (!keepBrowser) {
      shutdown(1000, reason);
      return;
    }
    // 下一句的音频可能已经在前排队：立刻补建，别让人再等一次握手
    if (pending.length > 0) openSegment();
  };

  /** 真的把 CloseStream 发给上游，并开始计时 */
  const sendCloseStream = (): void => {
    const current = upstream;
    if (!current) return;
    clearFlushTimer();
    phase = "draining";
    try {
      current.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      settleSegment(`${flushReason}-send-failed`, "none");
      return;
    }
    log(`[stt] CloseStream → upstream reason=${flushReason}`);
    // 上限：上游不回尾段也必须在 flushTimeoutMs 后断开，不能把会话挂成僵尸
    flushTimer = setTimeout(() => {
      flushTimer = null;
      settleSegment(`${flushReason}-timeout`, "timeout");
    }, flushTimeoutMs);
  };

  /** 「这句说完了」/「彻底断开」的共同入口 */
  const requestFlush = (reason: string, keep: boolean): void => {
    if (closed) return;
    keepBrowser = keep;
    flushReason = reason;
    if (!upstream) {
      // 没有上游 = 没东西可冲：彻底断开就收摊，说完一句则什么都不用做
      if (!keep) shutdown(1000, reason);
      return;
    }
    if (phase === "connecting") {
      // 握手还没回来：挂上意图（open 后补发排队帧 + CloseStream），同时先计时，
      // 免得「连上一个永远不开的 socket」把 WS 挂死
      flushWanted = true;
      clearFlushTimer();
      flushTimer = setTimeout(() => {
        flushTimer = null;
        settleSegment(`${flushReason}-timeout`, "no-open");
      }, flushTimeoutMs);
      return;
    }
    if (phase === "live") sendCloseStream();
    // phase === "draining"：已经在等尾段了，重复请求直接忽略
  };

  const openSegment = (): void => {
    if (closed || upstream) return;
    let created: UpstreamSocket;
    try {
      created = options.connect(sttUpstreamUrl({ lang: options.lang, format: options.format }), {
        // key 只出现在这里：不写日志、不进 URL、不回响应
        Authorization: `Token ${options.config.apiKey}`,
      });
    } catch {
      options.sink.sendText(JSON.stringify({ type: "error", reason: "upstream-unavailable" }));
      try {
        options.sink.close(1011, "upstream unavailable");
      } catch {
        /* 忽略 */
      }
      closed = true;
      log("[stt] connect threw; closing");
      return;
    }
    upstream = created;
    phase = "connecting";

    created.onopen = () => {
      if (closed || upstream !== created) {
        try {
          created.close(1000, "closed before open");
        } catch {
          /* 忽略 */
        }
        return;
      }
      phase = "live";
      log(`[stt] upstream open pending=${pending.length}`);
      while (pending.length > 0) {
        const frame = pending.shift();
        if (frame === undefined) continue;
        try {
          created.send(frame);
        } catch {
          shutdown(1011, "upstream send failed");
          return;
        }
      }
      // 握手期间就被要求收尾：排队帧已经送出去了，现在补 CloseStream
      if (flushWanted) sendCloseStream();
    };

    created.onmessage = (event) => {
      if (closed || upstream !== created) return;
      if (typeof event.data === "string") lastType = describeUpstreamType(event.data);
      const message = toClientMessage(event.data);
      // final 一律转发 —— 包括 draining 期间收到的尾段（这段代码就是为它存在的）
      if (message) sinkSend(message);
      // draining 中收到 final / UtteranceEnd = 尾段已经吐出来了，可以关上游
      if (phase === "draining" && (message?.type === "final" || message?.type === "utterance_end")) {
        settleSegment("flush-tail", message.type);
      }
    };

    created.onerror = () => {
      if (closed || upstream !== created) return;
      if (phase === "draining") {
        // 收尾阶段上游报错：尾段已经尽力，按正常收尾走，不吓客户端
        settleSegment("flush-error", "error");
        return;
      }
      sinkSend({ type: "error", reason: "upstream-error" });
      shutdown(1011, "upstream error");
    };

    created.onclose = () => {
      if (closed || upstream !== created) return;
      if (phase === "draining") {
        // 上游 flush 完自己关的（CloseStream 的正常结局）：这不是错误
        settleSegment("flush-closed", "closed");
        return;
      }
      // 上游自己关了（配额/鉴权/超时）：客户端必须收到收摊信号，否则它会一直等字幕
      sinkSend({ type: "error", reason: "upstream-closed" });
      shutdown(1000, "upstream closed");
    };
  };

  openSegment();

  return {
    pushAudio(data) {
      if (closed) return;
      frames += 1;
      const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      bytes += typeof frame === "string" ? frame.length : frame.byteLength;
      // 上一句 flush 完已经把上游关了：这句要一条新的上游
      if (!upstream) openSegment();
      if (upstream && phase === "live") {
        try {
          upstream.send(frame);
        } catch {
          shutdown(1011, "upstream send failed");
        }
        return;
      }
      // connecting（还没 open）或 draining（尾段还没吐完）：先排队，等新上游 open 后按序补发。
      // 上限兜底：宁可丢老帧，也不让内存无限涨
      if (pending.length >= maxPending) pending.shift();
      pending.push(frame);
    },

    finishUtterance() {
      requestFlush("utterance-end", true);
    },

    clientClosed() {
      requestFlush("client-closed", false);
    },

    get closed() {
      return closed;
    },

    get lastUpstreamType() {
      return lastType;
    },
  };
}
