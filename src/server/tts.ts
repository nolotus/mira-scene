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

export interface TtsProxyOptions {
  config: TtsConfig | null;
  /** 测试注入；生产用全局 fetch */
  fetch?: TtsFetch;
  timeoutMs?: number;
  /** 只喂状态码与字节数，绝不喂文本 */
  log?: (line: string) => void;
}

export interface TtsProxy {
  readonly configured: boolean;
  synthesize(raw: unknown): Promise<TtsResult>;
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

    async synthesize(raw: unknown): Promise<TtsResult> {
      const text = typeof raw === "object" && raw !== null && "text" in raw ? (raw as { text?: unknown }).text : undefined;
      if (typeof text !== "string") return { ok: false, status: 400, reason: "text-required" };

      const rejected = validate(text);
      if (rejected) return rejected;
      if (!config) return { ok: false, status: 503, reason: "not-configured" };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
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
  /** 中文那一路：Edge TTS（null = 没装 CLI / 显式关闭） */
  edge: EdgeTtsSynthesizer | null;
  cache?: TtsCache;
  cacheEntries?: number;
  /** 只喂 voice / 字节数 / 耗时 / 命中与否，绝不喂文本 */
  log?: (line: string) => void;
}

export interface TtsRouter extends TtsProxy {
  /** 两条路各自可用性（诊断用，不含任何凭据） */
  readonly routes: { english: boolean; chinese: boolean };
  readonly cache: TtsCache;
}

/** `lang` 只做入参校验，不参与分流 —— 原因见 createTtsRouter 里的注释 */
function parseLang(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed && trimmed.length <= 16 ? trimmed : null;
}

/**
 * `/api/tts` 的实现：按文本语言分流 + 共用一份字节缓存。
 *
 * 分流判据只有一个：**文本里有没有 CJK**。
 * 为什么不看客户端传的 `lang`：客户端 UI 语言默认是 `zh-CN`，用它来判会把纯英文句子
 * 也送进 Edge（双语混排时音色来回跳），而「英文走 Aura、中文走 Edge」是产品定死的。
 * 所以 `lang` 目前只被接受（并为将来预留）而不改变路由 —— 有单测钉住这一点。
 */
export function createTtsRouter(options: TtsRouterOptions): TtsRouter {
  const cache = options.cache ?? createTtsCache(options.cacheEntries);
  const log = options.log ?? (() => {});
  const { deepgram, edge } = options;

  async function synthesizeEdge(text: string): Promise<TtsResult> {
    if (!edge || !edge.available) {
      log(`[tts] route=zh voice=none reason=tts-unavailable`);
      return { ok: false, status: 503, reason: "tts-unavailable" };
    }
    // 缓存键必须含 rate/pitch：改了角色语速/音高还命中旧缓存，等于参数白改
    const voice = edge.voice;
    const key = ttsCacheKey(`edge:${voice}:${edge.rate}:${edge.pitch}`, text);
    const cached = cache.get(key);
    if (cached) {
      log(`[tts] route=zh voice=${voice} bytes=${cached.bytes.byteLength} cache=hit`);
      return { ok: true, bytes: cached.bytes, mime: cached.mime };
    }
    const started = performance.now();
    const result = await edge.synthesize(text);
    const ms = Math.round(performance.now() - started);
    if (!result.ok) {
      log(`[tts] route=zh voice=${voice} reason=${result.reason} ${ms}ms`);
      return { ok: false, status: 503, reason: "tts-unavailable" };
    }
    cache.set(key, { bytes: result.bytes, mime: result.mime });
    log(`[tts] route=zh voice=${voice} bytes=${result.bytes.byteLength} ${ms}ms cache=miss`);
    return { ok: true, bytes: result.bytes, mime: result.mime };
  }

  async function synthesizeEnglish(text: string): Promise<TtsResult> {
    if (!deepgram || !deepgram.configured) {
      return { ok: false, status: 503, reason: "not-configured" };
    }
    const key = ttsCacheKey(`deepgram:${DEEPGRAM_SPEAK_MODEL}`, text);
    const cached = cache.get(key);
    if (cached) {
      log(`[tts] route=en bytes=${cached.bytes.byteLength} cache=hit`);
      return { ok: true, bytes: cached.bytes, mime: cached.mime };
    }
    const result = await deepgram.synthesize({ text });
    if (!result.ok) return result;
    cache.set(key, { bytes: result.bytes, mime: result.mime });
    return result;
  }

  return {
    cache,

    get routes() {
      return { english: deepgram?.configured === true, chinese: edge?.available === true };
    },

    get configured() {
      return deepgram?.configured === true || edge?.available === true;
    },

    async synthesize(raw: unknown): Promise<TtsResult> {
      const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
      const text = record?.text;
      if (typeof text !== "string") return { ok: false, status: 400, reason: "text-required" };
      if (!text.trim()) return { ok: false, status: 400, reason: "text-required" };
      if (text.length > MAX_TTS_CHARS) return { ok: false, status: 400, reason: "text-too-long" };
      // 只为「格式不对的请求被挡住」而解析，不参与分流
      const lang = parseLang(record?.lang);
      const routed = containsCjk(text) ? "zh" : "en";
      log(`[tts] route=${routed} lang=${lang ?? "-"} chars=${text.length}`);
      return routed === "zh" ? synthesizeEdge(text) : synthesizeEnglish(text);
    },
  };
}
