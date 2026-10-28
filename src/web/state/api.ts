/**
 * HTTP / SSE 客户端。
 *
 * 为什么不用 EventSource：协议是 `POST /api/turn`（要带 TurnRequest），
 * EventSource 只支持 GET，所以这里用 fetch + ReadableStream 手工解析 SSE。
 *
 * 所有请求都有超时与可读错误：
 *  - 首事件超时（默认 8s，题目要求）→ ApiError("timeout")
 *  - 事件间空闲超时（默认 30s）→ ApiError("timeout")
 *  - HTTP 非 2xx → ApiError("http", 带 status 与服务端正文摘要)
 *  - 断网 → ApiError("network")
 *  - 用户主动打断/取消 → ApiError("aborted")，上层静默处理
 */

import type {
  CancelResult,
  SessionEvent,
  SessionInfo,
  TurnRequest,
} from "../../shared/protocol";

export type ApiErrorKind =
  | "network"
  | "http"
  | "timeout"
  | "parse"
  | "aborted"
  | "server";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly detail: string | null;

  constructor(kind: ApiErrorKind, message: string, extra: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.detail = extra.detail ?? null;
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof ApiError && err.kind === "aborted";
}

/** 面向用户的一句话解释（状态条用） */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case "timeout":
        return err.message;
      case "network":
        return "网络中断：连不上本地服务（npm run dev 是否在跑？）";
      case "http":
        return `服务返回 ${err.status ?? "?"}${err.detail ? `：${err.detail}` : ""}`;
      case "server":
        return `服务端错误：${err.message}`;
      case "parse":
        return "响应格式无法解析（不是合法的 SSE 事件）";
      case "aborted":
        return "请求已取消";
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface HealthInfo {
  ok: boolean;
  mode?: "mock" | "live";
  detail?: string;
  [key: string]: unknown;
}

export interface TurnStreamHandlers {
  onEvent(event: SessionEvent): void;
  /** 收到第一个事件时回调（用于「首 token 延迟」观测） */
  onFirstEvent?(): void;
  /** 流正常结束 */
  onDone?(): void;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** 8s 内没有任何事件 → 判超时（题目硬要求） */
  firstEventTimeoutMs?: number;
  /** 已有事件之后，事件间最长静默 */
  idleTimeoutMs?: number;
  baseUrl?: string;
}

export interface SessionApi {
  health(signal?: AbortSignal): Promise<HealthInfo>;
  createSession(signal?: AbortSignal): Promise<SessionInfo>;
  streamTurn(req: TurnRequest, handlers: TurnStreamHandlers, opts?: StreamOptions): Promise<void>;
  cancelTurn(turnId: string, epoch: number, signal?: AbortSignal): Promise<CancelResult>;
}

const JSON_TIMEOUT_MS = 6_000;
export const FIRST_EVENT_TIMEOUT_MS = 8_000;
const IDLE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- 低层工具

/** 把「外部 signal」与「本地超时」合并成一个 controller，并保证清理。 */
function withTimeout(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; didTimeout: () => boolean; cancel: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    outer?.removeEventListener("abort", onOuterAbort);
  };

  return { signal: controller.signal, didTimeout: () => timedOut, cancel };
}

async function readBodySnippet(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return text.trim().slice(0, 200) || null;
  } catch {
    return null;
  }
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs = JSON_TIMEOUT_MS,
): Promise<T> {
  const guard = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: guard.signal });
    if (!res.ok) {
      const detail = await readBodySnippet(res);
      throw new ApiError("http", `${init.method ?? "GET"} ${url} 失败`, {
        status: res.status,
        detail: detail ?? undefined,
      });
    }
    const text = await res.text();
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError("parse", `${url} 返回的不是 JSON`, { detail: text.slice(0, 120) });
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (guard.didTimeout()) {
      throw new ApiError("timeout", `请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    if (signal?.aborted) throw new ApiError("aborted", "请求已取消");
    throw new ApiError("network", "网络请求失败", { detail: err instanceof Error ? err.message : String(err) });
  } finally {
    guard.cancel();
  }
}

// ---------------------------------------------------------------- SSE 解析

interface SseBlock {
  event: string | null;
  data: string;
}

/** 解析一个 SSE 帧（空行分隔的一组 field 行） */
export function parseSseBlock(lines: string[]): SseBlock | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      // 规范：冒号后若有一个空格则去掉一个
      const rest = line.slice(5);
      data.push(rest.startsWith(" ") ? rest.slice(1) : rest);
      continue;
    }
    // 容错：有些实现直接吐一整行 JSON
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) data.push(trimmed);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

// ---------------------------------------------------------------- 实现

export interface HttpApiOptions {
  baseUrl?: string;
}

export function createHttpApi(options: HttpApiOptions = {}): SessionApi {
  const base = options.baseUrl ?? "";

  async function streamTurn(
    req: TurnRequest,
    handlers: TurnStreamHandlers,
    opts: StreamOptions = {},
  ): Promise<void> {
    const url = `${opts.baseUrl ?? base}/api/turn`;
    const firstEventTimeoutMs = opts.firstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS;
    const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    const outer = opts.signal;

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sawEvent = false;

    const armWatchdog = (ms: number) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
    };

    const onOuterAbort = () => controller.abort();
    if (outer) {
      if (outer.aborted) throw new ApiError("aborted", "请求已取消");
      outer.addEventListener("abort", onOuterAbort, { once: true });
    }
    armWatchdog(firstEventTimeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await readBodySnippet(res);
        throw new ApiError("http", `POST /api/turn 失败`, {
          status: res.status,
          detail: detail ?? undefined,
        });
      }
      if (!res.body) {
        throw new ApiError("parse", "服务端没有返回事件流（response.body 为空）");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let frame: string[] = [];

      const flush = () => {
        if (frame.length === 0) return;
        const block = parseSseBlock(frame);
        frame = [];
        if (!block) return;
        const payload = block.data.trim();
        if (!payload || payload === "[DONE]" || payload === "done") return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // 坏帧不该炸掉整条流：跳过，继续读下一个事件
          return;
        }
        if (block.event === "error" && !isSessionEvent(parsed)) {
          const message =
            typeof parsed === "object" && parsed !== null && "message" in parsed
              ? String((parsed as { message: unknown }).message)
              : payload;
          handlers.onEvent({
            type: "error",
            turnId: req.turnId,
            epoch: req.epoch,
            message,
            recoverable: true,
          });
          return;
        }
        if (!isSessionEvent(parsed)) return;

        sawEvent = true;
        if (sawEvent) armWatchdog(idleTimeoutMs);
        handlers.onFirstEvent?.();
        handlers.onEvent(parsed);
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") flush();
          else frame.push(line);
          nl = buffer.indexOf("\n");
        }
      }

      // 流结束时把残留解码完
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        if (tail.trim() !== "") frame.push(tail);
      }
      flush();

      if (!sawEvent) {
        throw new ApiError("parse", "事件流结束了但没有收到任何事件");
      }
      handlers.onDone?.();
    } catch (err) {
      if (timedOut) {
        throw new ApiError(
          "timeout",
          sawEvent
            ? `模型 ${Math.round(idleTimeoutMs / 1000)}s 没有继续输出，已中断本轮`
            : `模型 ${Math.round(firstEventTimeoutMs / 1000)}s 内没有响应（首事件超时）`,
        );
      }
      if (err instanceof ApiError) throw err;
      if (controller.signal.aborted) throw new ApiError("aborted", "请求已取消");
      throw new ApiError("network", "事件流中断", {
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }

  return {
    async health(signal) {
      const raw = await requestJson<Record<string, unknown>>(`${base}/api/health`, {
        method: "GET",
      }, signal);
      return {
        ...raw,
        ok: raw["ok"] === true || raw["status"] === "ok" || raw["healthy"] === true,
      } as HealthInfo;
    },

    async createSession(signal) {
      const raw = await requestJson<Partial<SessionInfo>>(`${base}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }, signal);
      if (!raw.sessionId) {
        throw new ApiError("parse", "POST /api/session 没有返回 sessionId");
      }
      return {
        sessionId: raw.sessionId,
        mode: raw.mode === "live" ? "live" : "mock",
        directorName: raw.directorName ?? "unknown",
        keyless: raw.keyless !== false,
      };
    },

    async cancelTurn(turnId, epoch, signal) {
      return requestJson<CancelResult>(
        `${base}/api/turn/${encodeURIComponent(turnId)}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ epoch }),
        },
        signal,
        3_000,
      );
    },

    streamTurn,
  };
}

/** 轻量形状校验：只认协议里的事件类型，其它一律当坏帧 */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; epoch?: unknown; turnId?: unknown };
  if (typeof candidate.type !== "string") return false;
  if (typeof candidate.epoch !== "number") return false;
  switch (candidate.type) {
    case "turn.start":
    case "text.delta":
    case "directive":
    case "audio.chunk":
    case "audio.end":
    case "turn.end":
    case "error":
      return true;
    default:
      return false;
  }
}
