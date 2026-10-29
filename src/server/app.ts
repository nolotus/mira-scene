/**
 * HTTP 层：路由 + SSE 推送 + 静态托管。
 *
 * 单独抽成 createApp() 是为了两件事：
 * 1. src/server/index.ts 只负责「起进程」，测试可以直接拿 app.fetch 打请求，不占端口；
 * 2. 导演可以被注入（测试里塞一个加速的 MockDirector）。
 *
 * 导演的分辨（live / 回落 mock）发生在**会话创建时**：
 *   URL `?director=live` → POST /api/session → resolveDirectorMode() →
 *   结果存进 SessionRecord.director → 之后每轮 /api/turn 只读会话里那份，不重读 URL / env。
 *
 * 事件生命周期由服务端统一收口：turn.start 一定在最先、turn.end 一定在最后，
 * 即使导演抛错或被打断也一样 —— 客户端只需要盯最后一条 turn.end。
 */
import { extname, join, resolve, sep } from "node:path";
import {
  parseDirectorRequest,
  type DirectorMode,
  type DirectorRequest,
} from "../shared/director.ts";
import type { Director, DirectorInput, SceneSnapshot, SessionEvent, SessionInfo, TurnRequest } from "../shared/protocol.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createDirector } from "./director/index.ts";
import { resolveDirectorMode, type DirectorAvailability, type DirectorResolution } from "./director/resolve.ts";
import { createIllustrationService, type IllustrationService } from "./illustrate.ts";
import { GATE_PATH, gateAttemptKey, gatePage, gateSuccess, gateTooManyAttempts, hasGateCookie, safeEqual } from "./gate.ts";
import { isEmotion, isPose, isSceneVariant, validateDirective } from "./scene/validate.ts";
import { SessionStore, TurnRegistry } from "./sessions.ts";
import {
  STT_MODEL,
  createSttBridge,
  type SttAudioFormat,
  type SttBridge,
  type UpstreamConnect,
} from "./stt.ts";
import {
  getActiveModel,
  handleSttAdminRequest,
  openRecordingSttBridge,
} from "./sttAdmin.ts";
import type { EncoderFactory, StreamingEncoderFactory } from "./aliStt.ts";
import { createEdgeTtsSynthesizer, type EdgeTtsSynthesizer } from "./edgeTts.ts";
import { createTtsProxy, createTtsRouter, type TtsProxy } from "./tts.ts";
import type { EdgeWsClient } from "./edgeTtsWs.ts";

/**
 * /api/voice/status 的响应体。
 * 三个 false 都是正常态，不是错误码：
 *  - `stt` / `tts` 对应 Deepgram key（没配就 false）
 *  - `ttsZh` 对应本地 `edge-tts` CLI（启动时 `--version` 探测的结果，缓存复用）
 */
export interface VoiceStatus {
  stt: boolean;
  tts: boolean;
  sttModel: string;
  ttsZh: boolean;
  /**
   * 实际在用的 STT provider：`ali` = 阿里百炼 fun-asr，`deepgram` = 老通道。
   * 客户端据此知道「这条通道的行为差异」（整段识别 vs 流式）。
   */
  sttProvider?: "ali" | "deepgram" | "none";
  /**
   * 上游**会不会**发 `speech_started`。
   *
   * 阿里百炼整段识别**不发**它 → 客户端不能拿它做「用户开口」的打断触发源，
   * 必须改走 energy VAD（服务端**不伪造** speech_started：伪造比没有更糟）。
   */
  supportsSpeechStarted?: boolean;
  /**
   * 原生快路径的状态（诊断区用）：`enabled=false` 时 `offReason` 说明为什么
   * （`mode-cli` / `timeout` / `auth` / `request-failed` …），`lastDrop` 是最近一次弃连原因。
   * 没有这一路时该字段不出现 —— 旧客户端读到的 JSON 与改造前一致。
   */
  ttsNative?: { enabled: boolean; offReason: string | null; lastDrop: string | null };
}

export interface AppOptions {
  config?: ServerConfig;
  /** 注入一个导演，两个档位都用它（测试用；会盖过 directorFactory） */
  director?: Director;
  /** 按档位造导演（测试用：想在 live / mock 下拿到不同的假导演） */
  directorFactory?: (mode: DirectorMode) => Director;
  sessions?: SessionStore;
  /** 生成式插图服务（测试注入 stub fetch / 配额；默认按 process.env 现场创建） */
  illustrate?: IllustrationService;
  /** 语音合成代理（测试注入 stub fetch / 假配置；默认按 config 现场创建路由层） */
  tts?: TtsProxy;
  /**
   * 中文语音合成（Edge CLI）。默认按 config.edgeTts 现场创建 ——
   * 注意**不在 createApp 里探测**（探测会 spawn 进程，测试里建 app 不该起进程）。
   * 生产入口 index.ts 探测好再传进来。
   */
  edge?: EdgeTtsSynthesizer;
  /** 上游 STT 建连函数（测试注入假 socket；默认连 wss://api.deepgram.com） */
  sttConnect?: UpstreamConnect;
  /** 阿里整段路径的转码器工厂（测试注入假的，避免真的 spawn ffmpeg） */
  sttEncoder?: EncoderFactory;
  /** 阿里流式路径的转码器工厂（测试注入假的，避免真的 spawn ffmpeg） */
  sttStreamEncoder?: StreamingEncoderFactory;
  /** 中文的快路径：原生 WS（默认不建 —— 建连由 index.ts 显式做，测试里可以注入假实现） */
  edgeWs?: EdgeWsClient;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  readonly config: ServerConfig;
  /** 环境默认档位的导演（服务端自检/日志用；单轮实际用哪个看 directorFor） */
  readonly director: Director;
  readonly sessions: SessionStore;
  readonly turns: TurnRegistry;
  /** 生成式插图（配额/缓存都在它里面；环境没配时它只会回 not-configured） */
  readonly illustrate: IllustrationService;
  /** 语音合成代理（含 CJK 拦截；环境没配 key 时只会回 not-configured） */
  readonly tts: TtsProxy;
  /** /api/voice/status 的值（真实反映 env） */
  readonly voice: VoiceStatus;
  /**
   * 开一条 STT 桥：WS `/api/stt` 升级成功后由 index.ts 调。
   * 没配 key 时回 null（调用方应回 503 + 明确的 reason，不要静默失败）。
   */
  openSttStream(sink: {
    sendText(payload: string): void;
    close(code?: number, reason?: string): void;
  }, options?: { lang?: "zh-CN" | "en-US"; format?: SttAudioFormat }): SttBridge | null;
  /** 档位 → 导演实例（同档位复用同一个实例） */
  directorFor(mode: DirectorMode): Director;
}

/** 客户端没送 scene 时的默认画面（Mira 靠在吧台，握着杯子） */
const DEFAULT_SCENE: SceneSnapshot = {
  scene: "cafe_night",
  emotion: "neutral",
  pose: "hold_cup",
  playedBeats: [],
};

const DIST_DIR = resolve(import.meta.dir, "..", "..", "dist");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function createApp(options: AppOptions = {}): App {
  const config = options.config ?? loadConfig();
  const sessions = options.sessions ?? new SessionStore();
  const turns = new TurnRegistry();
  // 插图服务：会话表共用同一个实例，所以「会话必须已存在」用的是真实会话，
  // 而不是一张按需创建的影子表。env 没配时它只会回 not-configured（正常状态）。
  const illustrate = options.illustrate ?? createIllustrationService({ sessions });

  // 语音：STT 与 TTS 共用同一个 Deepgram key。没配 key 时两者都「不可用」，
  // 但这是正常态 —— 文字通道与 Mock 导演完全不受影响。
  const deepgram = config.deepgram;
  // 阿里百炼：Deepgram key 被吊销时的回退通道。配了就**优先**用它（服务端代理，
  // 浏览器端协议不变，客户端感知不到换了供应商）。
  const dashscope = config.dashscope;
  const edge =
    options.edge ??
    createEdgeTtsSynthesizer({
      bin: config.edgeTts.bin,
      voice: config.edgeTts.voice,
      rate: config.edgeTts.rate,
      pitch: config.edgeTts.pitch,
      // 日志由 index.ts 统一开；这里默认闭嘴
      log: () => {},
    });
  const tts =
    options.tts ??
    createTtsRouter({
      deepgram: createTtsProxy({
        config: deepgram ? { apiKey: deepgram.apiKey } : null,
        // 上游日志由 index.ts 打开；测试里注入的 log 会盖掉默认的 console.warn
        log: () => {},
      }),
      edge,
      edgeWs: options.edgeWs ?? null,
      cacheEntries: config.edgeTts.cacheEntries,
    });
  /**
   * 每次现算：`ttsZh` 取决于探测结果，而探测在 createApp 之后才可能落定
   * （index.ts 先 await probe 再建 app；测试里注入 stub 直接给结论）。
   */
  const voiceStatus = (): VoiceStatus => {
    const native = tts.native ?? null;
    const base: VoiceStatus = {
      // 任一 provider 配了，语音输入就可用
      stt: deepgram !== null || dashscope !== null,
      tts: tts.configured,
      // 报**实际在用**的那个模型（阿里优先；运行时切换过就报切换后的那个）
      sttModel: dashscope ? (getActiveModel() ?? dashscope.model) : STT_MODEL,
      // 中文可用 = CLI 探到了 或者 原生 WS 配了（两者任一都能出声）
      ttsZh: tts.routes?.chinese ?? edge.available,
      // 能力上报：阿里整段识别**不发** speech_started → 客户端改走 energy VAD
      sttProvider: dashscope ? "ali" : deepgram !== null ? "deepgram" : "none",
      supportsSpeechStarted: dashscope ? false : true,
    };
    // 没有原生那一路时**整个字段不出现**：旧客户端拿到的 JSON 与改造前逐字节一致
    return native
      ? {
          ...base,
          ttsNative: {
            enabled: native.enabled,
            offReason: native.offReason,
            lastDrop: native.lastDrop?.reason ?? null,
          },
        }
      : base;
  };

  const sttConnect: UpstreamConnect =
    options.sttConnect ??
    ((url, headers) => {
      // Bun 的全局 WebSocket 支持第二参数带 header（浏览器不支持 —— 这是服务端代码）。
      // 结构上它就是 UpstreamSocket：send/close/onopen/onmessage/onclose/onerror。
      const socket = new WebSocket(url, { headers } as never);
      return socket as unknown as ReturnType<UpstreamConnect>;
    });

  const openSttStream: App["openSttStream"] = (sink, opts) => {
    // 两个 provider 都没配 → 没有语音输入（门禁会先回 503）
    if (!deepgram && !dashscope) return null;
    if (dashscope) {
      // **建会话这一刻**定下用哪个模型：运行时切过的优先，没切过用配置里的默认。
      // 切换只影响**新开的**会话 —— 正在说的那句不中途换模型。
      const model = getActiveModel() ?? dashscope.model;
      return openRecordingSttBridge({
        sink,
        model,
        open: (recordingSink) =>
          createSttBridge({
            config: deepgram,
            dashscope: { ...dashscope, model },
            connect: sttConnect,
            sink: recordingSink,
            lang: opts?.lang,
            format: opts?.format,
            encoder: options.sttEncoder,
            streamEncoder: options.sttStreamEncoder,
          }),
      });
    }
    return createSttBridge({
      config: deepgram,
      connect: sttConnect,
      sink,
      lang: opts?.lang,
      format: opts?.format,
    });
  };

  /** 「回落」判断的输入：环境想要什么 + 有没有可用真模型（不含任何密钥内容） */
  const availability: DirectorAvailability = {
    envMode: config.directorEnvMode,
    liveAvailable: config.llm !== null,
  };

  const injected = options.director;
  const factory = options.directorFactory;
  const directorCache = new Map<DirectorMode, Director>();

  /** 档位 → 导演（同档位复用同一实例）。逐轮只按会话里记下的档位取，绝不在这里改档位。 */
  const directorFor = (mode: DirectorMode): Director => {
    if (injected) return injected;
    const cached = directorCache.get(mode);
    if (cached) return cached;
    const created = factory
      ? factory(mode)
      : createDirector({
          directorMode: mode,
          llm: config.llm,
          mockDelayScale: config.mockDelayScale,
        });
    directorCache.set(mode, created);
    return created;
  };

  /** 环境默认档位的导演（服务端日志/自检用） */
  const director = directorFor(config.directorMode);

  /** 客户端没指定档位时的会话导演 = 环境默认档位 */
  const defaultChoice = (): DirectorResolution => resolveDirectorMode(null, availability);

  const corsFor = (origin: string | null): Record<string, string> => {
    if (config.isProd || !origin || !config.devOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "origin",
    };
  };

  const json = (value: unknown, status: number, origin: string | null): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...corsFor(origin) },
    });

  async function handleFetch(request: Request): Promise<Response> {
    // 测试里可能给的是相对 URL，统一给个兜底 base
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsFor(origin) });
    }

    // ── 访问口令（应用层 gate；只有配了 GATE_PASSWORD 才生效）──
    // 为什么不用 Caddy basic auth：它会破坏 WS 升级握手（实测经反代带 auth 时 /api/stt 400，
    // 直连 101），麦克风就废了。cookie 在 WS 升级时会被浏览器自动带上，三处一道门。
    const gatePassword = config.gatePassword;
    if (gatePassword) {
      const secure = url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
      if (path === GATE_PATH) {
        if (request.method === "GET") return gatePage({ secure });
        const form = await request.formData().catch(() => null);
        const submitted = typeof form?.get("password") === "string" ? String(form.get("password")) : "";
        if (gateTooManyAttempts(gateAttemptKey(request))) {
          return new Response("尝试过于频繁，请 5 分钟后再试。", {
            status: 429,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        if (!safeEqual(submitted, gatePassword)) return gatePage({ error: "口令不对，再试一次。", secure });
        return gateSuccess(gatePassword, secure);
      }
      const open = path === "/api/health";
      if (!open && !hasGateCookie(request, gatePassword)) {
        if (path.startsWith("/api/")) return json({ error: "locked", reason: "gate" }, 401, origin);
        return gatePage({ secure });
      }
    }

    // 运行时 ASR 切换后台（/admin 页面 + /api/stt/admin/config）。
    // 没配 ADMIN_TOKEN 时它整套 404（fail-closed）—— 处理函数自己返回 null 表示「不是后台的请求」。
    const adminResponse = await handleSttAdminRequest(request, url, {
      adminToken: config.adminToken,
      defaultModel: dashscope ? dashscope.model : STT_MODEL,
    });
    if (adminResponse) return adminResponse;

    if (path === "/api/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, origin);
      return json({ ok: true }, 200, origin);
    }

    // 语音通道能力：只暴露「有没有」，绝不暴露 key 的任何痕迹。
    // 没有 DEEPGRAM_API_KEY 时 stt/tts 都是 false —— 这是正常态，不是错误码。
    if (path === "/api/voice/status") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, origin);
      return json(voiceStatus(), 200, origin);
    }

    // 语音合成：成功直接回 MP3 字节（客户端塞进 StreamTTS 的播放路径）；
    // 失败回 { reason }，客户端据此回退 BrowserTTS（不会让用户听到废音）。
    if (path === "/api/tts") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
      const body = await safeJson(request);
      // 流式只在**显式要**的时候才走：不带 stream 的请求一个字节都不变（既有客户端不受影响）
      if (wantsStreamedAudio(url, request.headers) && tts.synthesizeStream) {
        const streamed = await tts.synthesizeStream(body, { signal: request.signal });
        // 还没开始转发就失败：沿用原来的 JSON 契约（客户端照样能读 reason 回退）
        if (!streamed.ok) return json({ reason: streamed.reason }, streamed.status, origin);
        return new Response(chunksToStream(streamed.chunks), {
          status: 200,
          headers: {
            "content-type": streamed.mime,
            // 没有 content-length → 走 chunked；Bun 会自动加 transfer-encoding
            "cache-control": "no-store",
            ...corsFor(origin),
          },
        });
      }
      const result = await tts.synthesize(body, { signal: request.signal });
      if (!result.ok) return json({ reason: result.reason }, result.status, origin);
      return new Response(result.bytes.slice().buffer, {
        status: 200,
        headers: {
          "content-type": result.mime,
          "content-length": String(result.bytes.byteLength),
          "cache-control": "no-store",
          ...corsFor(origin),
        },
      });
    }

    if (path === "/api/session") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
      const body = (await safeJson(request)) as { sessionId?: unknown; director?: unknown } | null;
      const requested = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const sessionId = requested || crypto.randomUUID();
      // 档位来源：query 优先（?director=live），其次 body.director，都没有 = 不指定
      const directorRequest: DirectorRequest = parseDirectorRequest(
        url.searchParams.get("director") ?? (typeof body?.director === "string" ? body.director : null),
      );
      // 已存在的会话保留它创建时的档位（档位跟着会话走，重连/重入不会被 URL 改掉）
      const existing = sessions.get(sessionId);
      const choice = existing?.director ?? resolveDirectorMode(directorRequest, availability);
      const record = sessions.ensure(sessionId, choice);
      const served = directorFor(record.director.mode);
      const info: SessionInfo = {
        sessionId,
        mode: record.director.mode,
        directorName: served.name,
        // 零密钥可跑：mock 档不需要任何私钥
        keyless: record.director.mode === "mock",
        // 请求了 live 却回落时，这里说明原因（界面必须显示，不许静默）
        fallbackReason: record.director.reason,
      };
      return json(info, 200, origin);
    }

    const cancelMatch = /^\/api\/turn\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
      const turnId = decodeURIComponent(cancelMatch[1] ?? "");
      const result = turns.cancel(turnId);
      return json(result, 200, origin);
    }

    if (path === "/api/turn") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
      const parsed = parseTurnRequest(await safeJson(request));
      if (!parsed.ok) return json({ error: parsed.error }, 400, origin);
      // 本轮用哪个导演：只认会话里记下的那份（URL/env 在这一步一律不读）
      const record = sessions.ensure(parsed.value.sessionId, defaultChoice());
      return streamTurn(parsed.value, origin, directorFor(record.director.mode));
    }

    if (path === "/api/illustrate") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
      // 生成式插图：失败/未配置/超配额一律 200 + { ok:false, reason }，
      // 客户端据此静默回落（不给失败样式），所以这里刻意不用 4xx/5xx 表达业务状态。
      const result = await illustrate.illustrate(await safeJson(request));
      return json(result, 200, origin);
    }

    const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(path);
    if (sessionMatch) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, origin);
      const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
      const record = sessions.get(sessionId);
      if (!record) return json({ error: "session not found", sessionId }, 404, origin);
      return json(record, 200, origin);
    }

    if (path.startsWith("/api/")) return json({ error: "not found", path }, 404, origin);

    return serveStatic(path, origin);
  }

  /** 生产模式从 dist/ 出静态文件 + SPA fallback；开发模式交给 vite */
  async function serveStatic(path: string, origin: string | null): Promise<Response> {
    if (!config.isProd) {
      return new Response("开发模式下前端由 vite 提供：http://localhost:5173\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", ...corsFor(origin) },
      });
    }

    const relative = path.replace(/^\/+/, "");
    const candidate = resolve(DIST_DIR, relative);
    // 防目录穿越：解析结果必须仍在 dist 内
    if (candidate === DIST_DIR || candidate.startsWith(DIST_DIR + sep)) {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        const type = MIME_TYPES[extname(candidate).toLowerCase()];
        return new Response(file, {
          headers: { ...(type ? { "content-type": type } : {}), ...corsFor(origin) },
        });
      }
      // 有扩展名的当资源处理，找不到就 404，不要回 index.html
      if (extname(candidate)) {
        return new Response("not found", { status: 404, headers: corsFor(origin) });
      }
    }

    const indexFile = Bun.file(join(DIST_DIR, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: { "content-type": "text/html; charset=utf-8", ...corsFor(origin) },
      });
    }
    return new Response("dist/ 尚未构建，先跑 bun run build\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", ...corsFor(origin) },
    });
  }

  /**
   * 一次 turn 的 SSE 流。
   * 顺序保证：turn.start →（directive / text.delta / error 任意交织）→ turn.end。
   * 被打断时 turn.end.interrupted = true。
   */
  function streamTurn(body: TurnRequest, origin: string | null, director: Director): Response {
    const { sessionId, turnId, epoch, userText } = body;
    const record = sessions.ensure(sessionId);
    // 服务端历史优先；没有（比如新会话/回放）才用客户端送来的 history
    const history = record.messages.length > 0 ? sessions.history(sessionId) : body.history;

    sessions.append(sessionId, "user", userText);
    const turn = turns.begin({ turnId, sessionId, epoch });
    const signal = turn.controller.signal;

    const input: DirectorInput = { userText, scene: body.scene, history, turnId, epoch };
    const encoder = new TextEncoder();
    const startedAt = performance.now();
    const state = { closed: false };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const elapsed = (): number => Math.round(performance.now() - startedAt);
        const push = (event: SessionEvent, opts?: { force?: boolean }): void => {
          // closed = 流已收尾/客户端断开；aborted = 本轮被 cancel。
          // cancel 之后不允许再推导演产出：客户端已经把这一轮作废了，
          // 继续推只会在「已打断」之后又冒出字幕（本地已 abort 时则是白烧 token）。
          // force 只留给收尾的 turn.end —— 它是客户端判定「这轮结束」的唯一信号，
          // 被 cancel 的轮次反而更需要它把 interrupted=true 送达。
          if (state.closed) return;
          if (signal.aborted && !opts?.force) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            state.closed = true;
          }
        };

        void (async () => {
          const timings: Record<string, number> = {};
          let said = "";
          let interrupted = false;
          /**
           * 一轮最多放行一条 scene：提示词里虽然写了「一轮最多一条」，但那是软约束，
           * 模型偶尔会吐两条 → 画面在同一轮里连跳两次（审查 2026-10-29 指出）。
           * 白名单校验之后再做这一道硬去重，代价只有一行状态。
           */
          let sceneSent = false;

          push({ type: "turn.start", turnId, epoch, at: Date.now() });

          try {
            for await (const event of director.stream(input, signal)) {
              // 被打断就立刻停：导演如果没理会 signal，这里也不能继续往外喂事件
              if (signal.aborted) break;
              // 生命周期事件只能由服务端发，导演层如果自己也发就丢掉，避免重复 turn.end
              if (event.type === "turn.start" || event.type === "turn.end") continue;

              if (event.type === "directive") {
                // 最后一道白名单：即使导演漏校验，脏指令也不会到渲染层
                const directive = validateDirective(event.directive);
                if (!directive) continue;
                if (directive.kind === "scene") {
                  // 一轮一条 + 不要切成当前场景（后者模型偶尔会做，画面会白闪一次）
                  if (sceneSent || directive.scene === input.scene.scene) continue;
                  sceneSent = true;
                }
                timings.firstDirective ??= elapsed();
                push({ ...event, directive });
                continue;
              }

              if (event.type === "text.delta") {
                timings.firstText ??= elapsed();
                said += event.text;
              }

              push(event);
            }
          } catch (error) {
            push({
              type: "error",
              turnId,
              epoch,
              message: `导演层异常：${error instanceof Error ? error.message : String(error)}`,
              recoverable: true,
            });
          } finally {
            interrupted = signal.aborted;
            timings.total = elapsed();
            if (said.trim()) sessions.append(sessionId, "character", said.trim());
          push({ type: "turn.end", turnId, epoch, interrupted, timings }, { force: true });
            turns.finish(turnId);
            state.closed = true;
            try {
              controller.close();
            } catch {
              // 客户端已断开，流已关闭
            }
          }
        })();
      },
      cancel() {
        // 客户端断开（关页面/切走）：立即停止产出，不再往空气里写事件
        state.closed = true;
        if (!turn.controller.signal.aborted) turn.controller.abort(new Error("client disconnected"));
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // 关掉 nginx 之类的缓冲，事件才能逐条冒出来
        "x-accel-buffering": "no",
        ...corsFor(origin),
      },
    });
  }

  return {
    fetch: handleFetch,
    config,
    director,
    sessions,
    turns,
    illustrate,
    tts,
    // getter：探测结果可能在 app 建好之后才落定，快照会读到过期的 false
    get voice() {
      return voiceStatus();
    },
    openSttStream,
    directorFor,
  };
}

// ------------------------------------------------------------------ 请求解析

type ParsedTurn = { ok: true; value: TurnRequest } | { ok: false; error: string };

function parseTurnRequest(raw: unknown): ParsedTurn {
  if (!raw || typeof raw !== "object") return { ok: false, error: "body 必须是 JSON 对象" };
  const record = raw as Record<string, unknown>;

  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const turnId = typeof record.turnId === "string" ? record.turnId.trim() : "";
  const epoch = typeof record.epoch === "number" && Number.isFinite(record.epoch) ? Math.trunc(record.epoch) : Number.NaN;
  const userText = typeof record.userText === "string" ? record.userText.slice(0, 2000) : "";

  if (!sessionId) return { ok: false, error: "缺少 sessionId" };
  if (!turnId) return { ok: false, error: "缺少 turnId" };
  if (!Number.isFinite(epoch)) return { ok: false, error: "epoch 必须是数字" };

  return {
    ok: true,
    value: {
      sessionId,
      turnId,
      epoch,
      userText,
      scene: parseScene(record.scene),
      history: parseHistory(record.history),
    },
  };
}

function parseScene(raw: unknown): SceneSnapshot {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SCENE };
  const record = raw as Record<string, unknown>;
  const playedBeats = Array.isArray(record.playedBeats)
    ? record.playedBeats.filter((item): item is string => typeof item === "string").slice(0, 32)
    : [];
  return {
    scene: isSceneVariant(record.scene) ? record.scene : DEFAULT_SCENE.scene,
    emotion: isEmotion(record.emotion) ? record.emotion : DEFAULT_SCENE.emotion,
    pose: isPose(record.pose) ? record.pose : DEFAULT_SCENE.pose,
    playedBeats,
  };
}

function parseHistory(raw: unknown): Array<{ role: "user" | "character"; text: string }> {
  if (!Array.isArray(raw)) return [];
  const history: Array<{ role: "user" | "character"; text: string }> = [];
  for (const item of raw.slice(-40)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const role = record.role === "user" || record.role === "character" ? record.role : null;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!role || !text) continue;
    history.push({ role, text: text.slice(0, 2000) });
  }
  return history;
}

/**
 * 只有**显式**要流式才流式：
 *  - `?stream=1`
 *  - `Accept: audio/mpeg`（浏览器 `fetch` 默认发 `*\/*`，不会命中，所以既有客户端行为不变）
 * 不按「有没有 Accept 头」猜：猜错会让老客户端拿到 chunked 响应，虽然能播但会丢掉 content-length。
 */
function wantsStreamedAudio(url: URL, headers: Headers): boolean {
  if (url.searchParams.get("stream") === "1") return true;
  const accept = (headers.get("accept") ?? "").toLowerCase();
  return accept.split(",").some((part) => part.trim().startsWith("audio/mpeg"));
}

/**
 * 异步迭代器 → `ReadableStream`：拿一块写一块，不攒整句。
 * 迭代器在转发中途抛错时 `controller.error()` —— 此时状态码已经发出去了，
 * 客户端会看到短读/连接中断（它已经播了收到的部分）。这条路径只在 native 中途断流时走到。
 */
function chunksToStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      // 客户端断开：把生成器收掉（它会释放连接名额/丢弃 WS 连接）
      await iterator.return?.(undefined);
    },
  });
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * WS `/api/stt` 升级前的门禁。
 * 没配 Deepgram → 503 + 明确的 reason（客户端据此走 Web Speech / 纯文字回退），
 * 而不是先接受连接再让客户端干等字幕。返回 null 表示可以升级。
 */
export function sttUpgradeGate(voice: { stt: boolean }): Response | null {
  if (voice.stt) return null;
  return new Response(JSON.stringify({ type: "error", reason: "not-configured" }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
