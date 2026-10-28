/**
 * HTTP 层：路由 + SSE 推送 + 静态托管。
 *
 * 单独抽成 createApp() 是为了两件事：
 * 1. src/server/index.ts 只负责「起进程」，测试可以直接拿 app.fetch 打请求，不占端口；
 * 2. 导演可以被注入（测试里塞一个加速的 MockDirector）。
 *
 * 事件生命周期由服务端统一收口：turn.start 一定在最先、turn.end 一定在最后，
 * 即使导演抛错或被打断也一样 —— 客户端只需要盯最后一条 turn.end。
 */
import { extname, join, resolve, sep } from "node:path";
import type { Director, DirectorInput, SceneSnapshot, SessionEvent, SessionInfo, TurnRequest } from "../shared/protocol.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createDirector, directorModeOf } from "./director/index.ts";
import { isEmotion, isPose, isSceneVariant, validateDirective } from "./scene/validate.ts";
import { SessionStore, TurnRegistry } from "./sessions.ts";

export interface AppOptions {
  config?: ServerConfig;
  director?: Director;
  sessions?: SessionStore;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  readonly config: ServerConfig;
  readonly director: Director;
  readonly sessions: SessionStore;
  readonly turns: TurnRegistry;
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
  const director = options.director ?? createDirector(config);
  const sessions = options.sessions ?? new SessionStore();
  const turns = new TurnRegistry();

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

    if (path === "/api/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, origin);
      return json({ ok: true }, 200, origin);
    }

    if (path === "/api/session") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, origin);
      const body = (await safeJson(request)) as { sessionId?: unknown } | null;
      const requested = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const sessionId = requested || crypto.randomUUID();
      sessions.ensure(sessionId);
      const mode = directorModeOf(director);
      const info: SessionInfo = {
        sessionId,
        mode,
        directorName: director.name,
        // 零密钥可跑：mock 档不需要任何私钥
        keyless: mode === "mock",
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
      return streamTurn(parsed.value, origin);
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
  function streamTurn(body: TurnRequest, origin: string | null): Response {
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
        const push = (event: SessionEvent): void => {
          if (state.closed) return;
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

          push({ type: "turn.start", turnId, epoch, at: Date.now() });

          try {
            for await (const event of director.stream(input, signal)) {
              // 生命周期事件只能由服务端发，导演层如果自己也发就丢掉，避免重复 turn.end
              if (event.type === "turn.start" || event.type === "turn.end") continue;

              if (event.type === "directive") {
                // 最后一道白名单：即使导演漏校验，脏指令也不会到渲染层
                const directive = validateDirective(event.directive);
                if (!directive) continue;
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
            push({ type: "turn.end", turnId, epoch, interrupted, timings });
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

  return { fetch: handleFetch, config, director, sessions, turns };
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

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
