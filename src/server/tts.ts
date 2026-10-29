/**
 * 语音合成（TTS）：Deepgram `/v1/speak` 代理 + 按语言分流的路由层 + 字节缓存。
 *
 * 两层结构：
 *  - `createTtsProxy`：**只做英文**的 Deepgram Aura 代理（原有行为，一字未改）。
 *  - `createTtsRouter`：`/api/tts` 的真正实现。含 CJK 走 Edge TTS（见 edgeTts.ts），
 *    纯英文走上面那个代理；两者都按 `sha256(voice + text)` 命中同一份内存 LRU。
 *
 * 为什么 Deepgram 只放英文过：
 * Deepgram 的 Aura 音色（aura-asteria-en）只有英语模型，`/v1/models` 里 103 个音色
 * 的语言只有 de/en/es/fr/it/ja/nl —— **没有中文**。把中文文本喂进去**不报错**，
 * 它照样回一段 MP3，只是那段音是废的（实测 round-trip 转回来是「外媒体验再次一码」conf=0.56）。
 * 所以代理层仍然自带 400 拦截：即使上层路由哪天接错，Aura 也不会收到中文。
 *
 * 为什么必须代理而不能让浏览器直连：
 * 直连需要把 key 交给浏览器。本 key 又没有 `POST /v1/auth/grant` 权限（实测 403），
 * 签不出短时 token，所以**没有安全的浏览器直连方案**，只能服务端代理。
 *
 * 密钥纪律：key 只在内存里拼 header，绝不进响应、日志、错误信息。文本同样不进日志。
 */

import { createHash } from "node:crypto";
import { EdgeWsError, type EdgeVoiceParams, type EdgeWsClient } from "./edgeTtsWs.ts";
import type { EdgeTtsSynthesizer } from "./edgeTts.ts";

/** 唯一支持的合成模型（英语） */
export const DEEPGRAM_SPEAK_MODEL = "aura-asteria-en";
/** 一句话的上限：正常断句远小于这个值，超了说明调用方没断句 */
export const MAX_TTS_CHARS = 400;
export const UPSTREAM_TIMEOUT_MS = 15_000;

export type TtsReason =
  | "unsupported-language"
  | "text-required"
  | "text-too-long"
  | "not-configured"
  | "upstream-error"
  /** Edge TTS 这条路：CLI 不存在 / 超时 / 非 0 退出 / 排队超时 —— 客户端据此回退浏览器 TTS */
  | "tts-unavailable";

export interface TtsConfig {
  apiKey: string;
}

export function upstreamSpeakUrl(): string {
  return `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(DEEPGRAM_SPEAK_MODEL)}`;
}

/**
 * CJK 判据（服务端与客户端各一份：两处分别属于 server / web 的独立构建，
 * 不允许跨端 import，所以这份正则有意的写两遍，并且两边都有单测钉住）。
 *
 * 覆盖：CJK 统一表意（4E00–9FFF / 3400–4DBF）、兼容表意（F900–FAFF）、
 * 假名（3040–30FF）、注音（3100–312F）、CJK 标点（3000–303F）、
 * 全角形式（FF00–FFEF，含全角标点与字母）、康熙部首（2E80–2EFF）。
 */
const CJK = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

export function containsCjk(text: string): boolean {
  return CJK.test(text);
}

export type TtsFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    /** `{"text": "..."}` —— 上游要的就是这个 */
    body: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export type TtsResult =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; status: number; reason: TtsReason };

/**
 * 流式结果：`chunks` 一到就转发，不攒整块。
 * `source` 只用于日志/诊断（客户端不看它）：
 *  - `native` = 原生 WS（快路径）
 *  - `cli`    = 回退到 `edge-tts` CLI（整句一次产出，所以只有一个分片）
 *  - `cache`  = 命中整块缓存（同样只有一个分片）
 *  - `buffer` = 上游只有整块接口（Deepgram），已经是整块拿到再一次吐出
 *
 * 注意契约：`ok: true` 返回时**第一块音频已经到手**。这样 `/api/tts?stream=1`
 * 才能做到「先失败就回 JSON（沿用现有错误契约），已经开始转发就不再改状态码」。
 */
export type TtsStreamSource = "native" | "cli" | "cache" | "buffer";

export type TtsStreamResult =
  | { ok: true; mime: string; source: TtsStreamSource; chunks: AsyncIterable<Uint8Array> }
  | { ok: false; status: number; reason: TtsReason };

export interface TtsProxyOptions {
  config: TtsConfig | null;
  /** 测试注入；生产用全局 fetch */
  fetch?: TtsFetch;
  timeoutMs?: number;
  /** 只喂状态码与字节数，绝不喂文本 */
  log?: (line: string) => void;
}

/** 一次合成请求的可选上下文：`signal` 用来在客户端打断/断开时中止上游合成 */
export interface TtsRequestOptions {
  signal?: AbortSignal;
}

export interface TtsProxy {
  readonly configured: boolean;
  synthesize(raw: unknown, opts?: TtsRequestOptions): Promise<TtsResult>;
  /** 可选：支持流式（只有路由层实现；Deepgram 代理不支持） */
  synthesizeStream?(raw: unknown, opts?: TtsRequestOptions): Promise<TtsStreamResult>;
  /** 可选：两条路的可用性（诊断用；不含任何凭据） */
  readonly routes?: { english: boolean; chinese: boolean };
  /** 可选：原生快路径状态（诊断区用） */
  readonly native?: {
    configured: boolean;
    enabled: boolean;
    offReason: string | null;
    lastDrop: { reason: string; at: number } | null;
  };
}

export function createTtsProxy(options: TtsProxyOptions): TtsProxy {
  const config = options.config;
  const doFetch: TtsFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const log = options.log ?? ((line: string) => console.warn(line));

  /** 语言/长度这类「我们自己能判」的拒绝，都在碰网络之前返回 */
  function validate(text: string): TtsResult | null {
    if (!text.trim()) return { ok: false, status: 400, reason: "text-required" };
    if (text.length > MAX_TTS_CHARS) return { ok: false, status: 400, reason: "text-too-long" };
    if (containsCjk(text)) return { ok: false, status: 400, reason: "unsupported-language" };
    return null;
  }

  return {
    get configured() {
      return config !== null;
    },

    async synthesize(raw: unknown, opts?: TtsRequestOptions): Promise<TtsResult> {
      const text = typeof raw === "object" && raw !== null && "text" in raw ? (raw as { text?: unknown }).text : undefined;
      if (typeof text !== "string") return { ok: false, status: 400, reason: "text-required" };

      const rejected = validate(text);
      if (rejected) return rejected;
      if (!config) return { ok: false, status: 503, reason: "not-configured" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
      // 客户端打断/断开 → 立刻中止上游合成（不必等满 timeout）
      const external = opts?.signal;
      const onExternalAbort = (): void => controller.abort(external?.reason);
      if (external) {
        if (external.aborted) controller.abort(external.reason);
        else external.addEventListener("abort", onExternalAbort, { once: true });
      }
      const started = performance.now();
      try {
        const response = await doFetch(upstreamSpeakUrl(), {
          method: "POST",
          headers: {
            // key 只出现在这里，绝不写进日志/响应
            authorization: `Token ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (!response.ok) {
          log(`[tts] upstream status=${response.status} bytes=0`);
          return { ok: false, status: 502, reason: "upstream-error" };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const ms = Math.round(performance.now() - started);
        log(`[tts] upstream status=${response.status} bytes=${bytes.byteLength} ${ms}ms`);
        if (bytes.byteLength === 0) return { ok: false, status: 502, reason: "upstream-error" };
        // 上游的 Content-Type 不可全信：Deepgram 的 speak 固定返回 mp3，
        // 这里统一按 audio/mpeg 回，客户端解码路径只有一条。
        return { ok: true, bytes, mime: "audio/mpeg" };
      } catch {
        // 超时/网络异常：不把 error 详情带出去（可能含 URL 与请求细节）
        log(`[tts] upstream failed ${Math.round(performance.now() - started)}ms`);
        return { ok: false, status: 502, reason: "upstream-error" };
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}

// ================================================================== 字节缓存

/** 缓存条数上限的默认值：一句 ≤400 字、MP3 约 20–30KB，128 条约 3MB —— 够用且不失控 */
export const DEFAULT_TTS_CACHE_ENTRIES = 128;

export interface CachedAudio {
  bytes: Uint8Array;
  mime: string;
}

export interface TtsCache {
  get(key: string): CachedAudio | undefined;
  set(key: string, value: CachedAudio): void;
  readonly size: number;
  /** 命中/未命中次数（日志与单测用） */
  readonly hits: number;
  readonly misses: number;
}

/**
 * 内存 LRU（条数上限）。`get` 会把命中的键挪到队尾，`set` 超出上限就丢队首。
 * 只存字节，不存文本 —— 键是 sha256，所以缓存本身也不留原文。
 */
export function createTtsCache(maxEntries = DEFAULT_TTS_CACHE_ENTRIES): TtsCache {
  const limit = Math.max(1, Math.floor(maxEntries));
  const store = new Map<string, CachedAudio>();
  let hits = 0;
  let misses = 0;

  return {
    get(key) {
      const value = store.get(key);
      if (!value) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      // 重新插入 = 挪到队尾（Map 保持插入顺序）
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > limit) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
    get size() {
      return store.size;
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
  };
}

/** 缓存键：`sha256(voice + text)`。voice 参与哈希，所以换音色不会串音。 */
export function ttsCacheKey(voice: string, text: string): string {
  return createHash("sha256").update(`${voice}\n${text}`).digest("hex");
}

// ================================================================== 路由层

export interface TtsRouterOptions {
  /** 英文那一路：Deepgram Aura 代理（null = 没配 key） */
  deepgram: TtsProxy | null;
  /** 中文那一路的回退：`edge-tts` CLI（null = 没装 / 显式关闭） */
  edge: EdgeTtsSynthesizer | null;
  /** 中文那一路的快路径：原生 WebSocket（null = 未启用） */
  edgeWs?: EdgeWsClient | null;
  /** 原生路径的 voice/rate/pitch；缺省取 `edge` 上的生效值（保证两级同音色） */
  edgeVoice?: EdgeVoiceParams;
  /** `cli` = 跳过原生；缺省看 `ETTS_MODE`（显式设成 `cli` 时同样跳过） */
  mode?: "auto" | "cli";
  cache?: TtsCache;
  cacheEntries?: number;
  /** 只喂 voice / 字节数 / 耗时 / 命中与否，绝不喂文本 */
  log?: (line: string) => void;
}

export interface TtsRouter extends TtsProxy {
  /** 路由层一定实现流式（`TtsProxy` 上它是可选的，这里收紧成必选） */
  synthesizeStream(raw: unknown): Promise<TtsStreamResult>;
  /** 两条路各自可用性（诊断用，不含任何凭据） */
  readonly routes: { english: boolean; chinese: boolean };
  readonly cache: TtsCache;
  /** 原生快路径状态（诊断区用）：配了没、还在不在用、为什么关了 */
  readonly native: {
    configured: boolean;
    enabled: boolean;
    offReason: string | null;
    lastDrop: { reason: string; at: number } | null;
  };
}

/** `lang` 只做入参校验，不参与分流 —— 原因见 createTtsRouter 里的注释 */
function parseLang(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed && trimmed.length <= 16 ? trimmed : null;
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** 原生路径：第一块已经拿到（`openNative` 保证），其余边收边吐 */
async function* headThenRest(
  first: Uint8Array,
  rest: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield first;
  yield* rest;
}

async function joinChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

type TextCheck = { ok: true; text: string } | { ok: false; status: number; reason: TtsReason };

function checkText(raw: unknown): TextCheck {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const text = record?.text;
  if (typeof text !== "string") return { ok: false, status: 400, reason: "text-required" };
  if (!text.trim()) return { ok: false, status: 400, reason: "text-required" };
  if (text.length > MAX_TTS_CHARS) return { ok: false, status: 400, reason: "text-too-long" };
  return { ok: true, text };
}

/**
 * `/api/tts` 的实现：按文本语言分流 + 共用一份字节缓存。
 *
 * 分流判据只有一个：**文本里有没有 CJK**。
 * 为什么不看客户端传的 `lang`：客户端 UI 语言默认是 `zh-CN`，用它来判会把纯英文句子
 * 也送进 Edge（双语混排时音色来回跳），而「英文走 Aura、中文走 Edge」是产品定死的。
 * 所以 `lang` 目前只被接受（并为将来预留）而不改变路由 —— 有单测钉住这一点。
 *
 * 中文三级链：**原生 WS → `edge-tts` CLI → `tts-unavailable`**。
 *  - 原生失败（握手/令牌/6s 无音频/中途断流）→ 记下来，本进程内不再试原生，只用 CLI。
 *    这是刻意的：令牌或网络坏了的时候，每句先白等一个握手比直接走 CLI 更糟。
 *  - CLI 也失败才回 `tts-unavailable`（客户端据此回退浏览器 TTS）。
 *  - 开关：`ETTS_MODE=cli`（或构造参数 `mode:"cli"`）直接跳过原生。
 */
export function createTtsRouter(options: TtsRouterOptions): TtsRouter {
  const cache = options.cache ?? createTtsCache(options.cacheEntries);
  const log = options.log ?? (() => {});
  const { deepgram, edge } = options;
  const edgeWs = options.edgeWs ?? null;
  const edgeVoice: EdgeVoiceParams | null =
    options.edgeVoice ?? (edge ? { voice: edge.voice, rate: edge.rate, pitch: edge.pitch } : null);

  const envMode = (process.env.ETTS_MODE ?? "").trim().toLowerCase();
  const cliOnly = options.mode ? options.mode === "cli" : envMode === "cli";
  let nativeOffReason: string | null = cliOnly ? "mode-cli" : edgeWs ? null : "not-configured";

  const nativeEnabled = (): boolean => nativeOffReason === null && edgeWs !== null;

  /** 首次失败即关掉原生（本进程内不再尝试）；`detail` 只带类别/时长，不带文本 */
  function disableNative(reason: string, detail = ""): void {
    if (nativeOffReason !== null) return;
    nativeOffReason = reason;
    log(`[tts] native=off reason=${reason}${detail} fallback=cli (本进程内不再尝试原生)`);
  }

  function edgeKey(): string | null {
    if (!edge) return null;
    // 缓存键必须含 rate/pitch：改了角色语速/音高还命中旧缓存，等于参数白改
    return `edge:${edge.voice}:${edge.rate}:${edge.pitch}`;
  }

  function zhParams(): EdgeVoiceParams | null {
    if (edgeVoice) return edgeVoice;
    return edge ? { voice: edge.voice, rate: edge.rate, pitch: edge.pitch } : null;
  }

  interface NativeHead {
    first: Uint8Array;
    rest: AsyncGenerator<Uint8Array>;
  }

  /**
   * 打开原生流并**取到第一块**：拿到才说明这条路真的能用。
   * 失败返回 null（已记下原因、关掉原生），由调用方接着试 CLI。
   */
  async function openNative(text: string, signal?: AbortSignal): Promise<NativeHead | null> {
    const params = zhParams();
    if (!nativeEnabled() || !edgeWs || !params) return null;
    const started = performance.now();
    // signal 透传：客户端一打断，这条 Edge 连接立刻中止，名额立刻还回池子
    const iterator = edgeWs.synthesizeStream(text, params, signal);
    try {
      const head = await iterator.next();
      const ms = Math.round(performance.now() - started);
      if (head.done || !head.value || head.value.byteLength === 0) {
        log(`[tts] route=zh native=empty ${ms}ms`);
        disableNative("empty");
        return null;
      }
      log(`[tts] route=zh native=first-chunk bytes=${head.value.byteLength} ${ms}ms`);
      return { first: head.value, rest: iterator };
    } catch (error) {
      const kind = error instanceof EdgeWsError ? error.kind : "error";
      const ms = Math.round(performance.now() - started);
      log(`[tts] route=zh native=fail kind=${kind} ${ms}ms`);
      disableNative(kind, ` ${ms}ms`);
      return null;
    }
  }

  /** CLI 那一步：整句一次产出，失败回 null（不在这里做日志分类，CLI 自己会记） */
  async function runCli(text: string): Promise<Uint8Array | null> {
    if (!edge || !edge.available) return null;
    const result = await edge.synthesize(text);
    return result.ok ? result.bytes : null;
  }

  async function synthesizeEdge(text: string, signal?: AbortSignal): Promise<TtsResult> {
    const keyBase = edgeKey();
    if (!keyBase) {
      log(`[tts] route=zh voice=none reason=tts-unavailable`);
      return { ok: false, status: 503, reason: "tts-unavailable" };
    }
    const key = ttsCacheKey(keyBase, text);
    const cached = cache.get(key);
    if (cached) {
      log(`[tts] route=zh voice=${edge?.voice} bytes=${cached.bytes.byteLength} cache=hit`);
      return { ok: true, bytes: cached.bytes, mime: cached.mime };
    }

    const started = performance.now();
    const native = await openNative(text, signal);
    if (native) {
      try {
        // 非流式调用方要的是整块：中途断流时**还没往客户端写任何东西**，所以可以整段回退 CLI
        const bytes = await joinChunks(headThenRest(native.first, native.rest));
        const ms = Math.round(performance.now() - started);
        cache.set(key, { bytes, mime: "audio/mpeg" });
        log(`[tts] route=zh voice=${edge?.voice} bytes=${bytes.byteLength} ${ms}ms native=yes cache=miss`);
        return { ok: true, bytes, mime: "audio/mpeg" };
      } catch (error) {
        const kind = error instanceof EdgeWsError ? error.kind : "error";
        log(`[tts] route=zh native=abort kind=${kind}`);
        disableNative(kind, " mid-stream");
      }
    }

    const cliBytes = await runCli(text);
    const ms = Math.round(performance.now() - started);
    if (!cliBytes) {
      log(`[tts] route=zh voice=${edge?.voice} reason=tts-unavailable ${ms}ms`);
      return { ok: false, status: 503, reason: "tts-unavailable" };
    }
    cache.set(key, { bytes: cliBytes, mime: "audio/mpeg" });
    log(`[tts] route=zh voice=${edge?.voice} bytes=${cliBytes.byteLength} ${ms}ms native=no cache=miss`);
    return { ok: true, bytes: cliBytes, mime: "audio/mpeg" };
  }

  async function synthesizeEnglish(text: string, signal?: AbortSignal): Promise<TtsResult> {
    if (!deepgram || !deepgram.configured) {
      return { ok: false, status: 503, reason: "not-configured" };
    }
    const key = ttsCacheKey(`deepgram:${DEEPGRAM_SPEAK_MODEL}`, text);
    const cached = cache.get(key);
    if (cached) {
      log(`[tts] route=en bytes=${cached.bytes.byteLength} cache=hit`);
      return { ok: true, bytes: cached.bytes, mime: cached.mime };
    }
    const result = await deepgram.synthesize({ text }, { signal });
    if (!result.ok) return result;
    cache.set(key, { bytes: result.bytes, mime: result.mime });
    return result;
  }

  /**
   * 流式（`?stream=1`）的中文链。返回 `ok` 时第一块已经在手，之后可以边收边转发。
   *
   * 缓存策略：**只读不写**。理由有两条，都不是偏好：
   *  1. 写整块缓存就必须先把整句收完，那正好把「第一块先播」这件事毁掉；
   *  2. 只缓存第一块没用 —— MP3 解码要连续数据，重放时后面几块还得现合成，
   *     用户会在分片接缝处听到一个停顿，比从头合成还难受。
   * 所以流式路径命中已有的整块缓存就直接一整块吐出去（最快），否则不落缓存。
   */
  async function streamEdge(text: string, signal?: AbortSignal): Promise<TtsStreamResult> {
    const keyBase = edgeKey();
    if (!keyBase) {
      log(`[tts] route=zh voice=none reason=tts-unavailable`);
      return { ok: false, status: 503, reason: "tts-unavailable" };
    }
    const cached = cache.get(ttsCacheKey(keyBase, text));
    if (cached) {
      log(`[tts] route=zh stream=1 bytes=${cached.bytes.byteLength} cache=hit`);
      return { ok: true, mime: cached.mime, source: "cache", chunks: singleChunk(cached.bytes) };
    }

    const native = await openNative(text, signal);
    if (native) {
      return {
        ok: true,
        mime: "audio/mpeg",
        source: "native",
        chunks: headThenRest(native.first, native.rest),
      };
    }

    const cliBytes = await runCli(text);
    if (cliBytes) {
      log(`[tts] route=zh stream=1 bytes=${cliBytes.byteLength} native=no cache=miss`);
      return { ok: true, mime: "audio/mpeg", source: "cli", chunks: singleChunk(cliBytes) };
    }
    log(`[tts] route=zh voice=${edge?.voice} reason=tts-unavailable stream=1`);
    return { ok: false, status: 503, reason: "tts-unavailable" };
  }

  return {
    cache,

    get routes() {
      return {
        english: deepgram?.configured === true,
        // 原生可用也算「中文这一路可用」：CLI 没装但 WS 能用，中文照样不该退浏览器
        chinese: edge?.available === true || edgeWs !== null,
      };
    },

    get native() {
      return {
        configured: edgeWs !== null,
        enabled: nativeEnabled(),
        offReason: nativeOffReason,
        lastDrop: edgeWs?.stats.lastDrop ?? null,
      };
    },

    get configured() {
      return deepgram?.configured === true || edge?.available === true || edgeWs !== null;
    },

    async synthesize(raw: unknown, opts?: TtsRequestOptions): Promise<TtsResult> {
      const check = checkText(raw);
      if (!check.ok) return { ok: false, status: check.status, reason: check.reason };
      const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
      // 只为「格式不对的请求被挡住」而解析，不参与分流
      const lang = parseLang(record?.lang);
      const routed = containsCjk(check.text) ? "zh" : "en";
      log(`[tts] route=${routed} lang=${lang ?? "-"} chars=${check.text.length}`);
      return routed === "zh" ? synthesizeEdge(check.text, opts?.signal) : synthesizeEnglish(check.text, opts?.signal);
    },

    async synthesizeStream(raw: unknown, opts?: TtsRequestOptions): Promise<TtsStreamResult> {
      const check = checkText(raw);
      if (!check.ok) return { ok: false, status: check.status, reason: check.reason };
      const routed = containsCjk(check.text) ? "zh" : "en";
      if (routed === "zh") return streamEdge(check.text, opts?.signal);
      // 英文那一路（Deepgram）没有流式接口：仍然是整块拿到再一次吐出。
      // 不是「假装流式」—— `chunks` 只有一个分片，客户端拿到的时序与不带 stream 一样。
      const result = await synthesizeEnglish(check.text, opts?.signal);
      if (!result.ok) return { ok: false, status: result.status, reason: result.reason };
      return { ok: true, mime: result.mime, source: "buffer", chunks: singleChunk(result.bytes) };
    },
  };
}
