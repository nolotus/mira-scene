/**
 * 语音合成（TTS）代理：Deepgram `/v1/speak`。
 *
 * 为什么只放英文过：
 * Deepgram 的 Aura 音色（aura-asteria-en）只有英语模型。把中文文本喂进去**不报错**，
 * 它照样回一段 MP3 —— 只是那段音是废的（实测 round-trip 转回来是「位于市政府」）。
 * 所以语言过滤必须发生在**发上游之前**：含 CJK 直接 400，让客户端回退浏览器 TTS。
 * 这一层宁可多说一句 no，也不让用户听到一段听不懂的声音。
 *
 * 为什么必须代理而不能让浏览器直连：
 * 直连需要把 key 交给浏览器。本 key 又没有 `POST /v1/auth/grant` 权限（实测 403），
 * 签不出短时 token，所以**没有安全的浏览器直连方案**，只能服务端代理。
 *
 * 密钥纪律：key 只在内存里拼 header，绝不进响应、日志、错误信息。
 */

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
  | "upstream-error";

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
