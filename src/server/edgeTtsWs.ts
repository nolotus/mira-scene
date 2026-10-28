/**
 * Edge TTS 原生 WebSocket 客户端：**中文合成的快路径**。
 *
 * 为什么要它：现有的 CLI（`edge-tts`）每句都要 `spawn python` → 解释器启动 → 包 import
 * → 建 TLS/WS → 合成。一句的 ~1.7s 里，绝大部分是「进程 + 建连」，只有很小一块是音频本身。
 * 这里把进程和连接都省掉：进程彻底没有，连接在同音色/语速/音高的连续请求之间复用。
 *
 * 协议（以本机 `edge_tts` 源码为准，未做逆向猜测）：
 *  - URL：`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
 *    `?TrustedClientToken=…&ConnectionId=…&Sec-MS-GEC=…&Sec-MS-GEC-Version=…`
 *  - 令牌：Unix 秒 + 11644473600 → 向下取整到 300s 窗口 → ×1e7（Windows FILETIME 的 100ns 计数）
 *    → `sha256("<ticks><TrustedClientToken>")` 的大写十六进制。
 *  - 出站帧是**文本**帧：`Key:value\r\n…\r\n\r\n` + body（没有长度前缀）。
 *  - 入站帧：文本帧用 `\r\n\r\n` 定位头尾；二进制帧前 2 字节是大端头长度，`Path:audio` 的 body 是 MP3 分片。
 *
 * ⚠ 与本机 `edge_tts/drm.py` 的**已知分歧**（不是笔误，是可复现证据）：
 * 该文件的 `_sha256_digest()` 并不是标准 SHA-256（第 14 轮常量被替换成 0xC9DC06A7、
 * sigma 有额外 XOR 偏移、还多出 data[:7]/data[7:] 的切分），并且它会额外拼出一段 16 hex 的
 * `_cs64_digest` 前缀，输出形如 `<16 hex>-<64 hex>`。同一输入下：
 *   ticks 串 `1341169920000000006A5AA1D4EAFF4E9FB37E23D68491D6F4`
 *   标准 SHA-256 = 42D1947403FD94975436C65DBFCA8003073F9CB5C3F1CE25AF8961A11D7C3DFE
 *   drm.py 输出  = 723A6EBC411B23BB-214991EA6B1E401F3D777A699DDDEE75E29740EA7A5DCD1007366FA1090DD267
 * 这里**按标准 SHA-256（node:crypto）实现**，理由是它同时符合「用 node:crypto、别照抄手写哈希」
 * 的指示和公开可知的协议形态（Sec-MS-GEC 是 64 hex）。如果真实握手回 403 才说明服务端要的是
 * drm.py 那一版，届时只需注入一个 `tokenFor`（见 `EdgeWsOptions.tokenFor`），不必改本文件其它逻辑。
 *
 * 失败一律抛 `EdgeWsError`（只带类别，不带文本），由上层 `tts.ts` 回退 CLI。
 * 日志纪律：只有 voice / 字节数 / 帧数 / 耗时 / 失败类别，**绝不出现文本**。
 */

import { randomUUID } from "node:crypto";
import { generateSecMsGec, TRUSTED_CLIENT_TOKEN } from "./edgeTtsDrm.ts";

export const EDGE_WS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
export { TRUSTED_CLIENT_TOKEN };
/** 由 `edgeTtsDrm.ts` 逐位移植自本机 `drm.py`（不是标准 SHA-256，见该文件头） */
export const secMsGec = generateSecMsGec;
/** 与本机 `constants.py` 的 `CHROMIUM_FULL_VERSION` / `SEC_MS_GEC_VERSION` 对齐 */
export const CHROMIUM_FULL_VERSION = "143.0.3650.75";
export const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0] ?? "143";
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
/** 输出格式固定：24kHz / 48kbps / 单声道 MP3（与 CLI 的默认产物一致，客户端解码路径不用改） */
export const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
/** 6s 没有任何音频就认为这条路坏了（与 CLI 的超时同一量级） */
export const WS_AUDIO_TIMEOUT_MS = 6_000;
/** 空闲 15s 关连接：连续句子的间隔远小于它，长静音时又不白占一条 WS */
export const WS_IDLE_CLOSE_MS = 15_000;
/** 并发上限沿用 CLI 的 2 */
export const MAX_WS_CONCURRENT = 2;
/** 握手上限：正常是百毫秒级 */
export const WS_HANDSHAKE_TIMEOUT_MS = 6_000;
/** 排队上限（超过并发上限时） */
export const WS_QUEUE_TIMEOUT_MS = 10_000;
/** Windows FILETIME 的纪元差（秒） */
export const WIN_EPOCH_SECONDS = 11_644_473_600;
/** 令牌窗口（秒） */
export const TOKEN_WINDOW_SECONDS = 300;

/** 只带类别：文本、token 都不许进错误信息 */
export type EdgeWsFailureKind =
  | "handshake"
  | "auth"
  | "timeout"
  | "protocol"
  | "closed"
  | "aborted"
  | "empty"
  | "queue-timeout";

export class EdgeWsError extends Error {
  constructor(readonly kind: EdgeWsFailureKind) {
    super(`edge-ws:${kind}`);
    this.name = "EdgeWsError";
  }
}

// ================================================================== 令牌

/**
 * `Sec-MS-GEC`。`unixSeconds` 是**已校正**的时间（见 `clock-skew`）。
 * 实现体在 `edgeTtsDrm.ts`：逐位移植本机 `drm.py`（含 CS64 前缀与改过的 SHA-256 常量）。
 */
export function secMsGecToken(
  unixSeconds: number,
  trustedToken: string = TRUSTED_CLIENT_TOKEN,
): string {
  return generateSecMsGec(unixSeconds, trustedToken);
}

// ================================================================== 帧编解码

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeHeaders(headers: Record<string, string>): string {
  let out = "";
  for (const [key, value] of Object.entries(headers)) out += `${key}:${value}\r\n`;
  return `${out}\r\n`;
}

/** 出站文本帧：头 + 空行 + body，**没有** 2 字节长度前缀（客户端发出去的就是这种） */
export function encodeTextFrame(headers: Record<string, string>, body: string): string {
  return `${encodeHeaders(headers)}${body}`;
}

/** 入站二进制帧的形态（服务端 → 我们）：2 字节大端头长度 + 头 + body */
export function encodeBinaryFrame(headers: Record<string, string>, body: Uint8Array): Uint8Array {
  const header = encoder.encode(encodeHeaders(headers));
  if (header.byteLength > 0xffff) throw new EdgeWsError("protocol");
  const out = new Uint8Array(2 + header.byteLength + body.byteLength);
  out[0] = (header.byteLength >> 8) & 0xff;
  out[1] = header.byteLength & 0xff;
  out.set(header, 2);
  out.set(body, 2 + header.byteLength);
  return out;
}

export interface DecodedFrame {
  headers: Record<string, string>;
  body: Uint8Array;
}

function parseHeaderBlock(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\r\n")) {
    if (!line) continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index)] = line.slice(index + 1);
  }
  return headers;
}

/** 二进制帧：2 字节大端头长度。头长度含结尾的 `\r\n`，body 从 `2+len` 开始（没有额外空行）。 */
export function decodeBinaryFrame(data: Uint8Array): DecodedFrame {
  if (data.byteLength < 2) throw new EdgeWsError("protocol");
  const headerLength = (data[0]! << 8) | data[1]!;
  if (headerLength > data.byteLength - 2) throw new EdgeWsError("protocol");
  const headers = parseHeaderBlock(decoder.decode(data.subarray(2, 2 + headerLength)));
  return { headers, body: data.subarray(2 + headerLength) };
}

/** 文本帧：`Path:…` 这类控制帧，头以空行结束 */
export function decodeTextFrame(text: string): DecodedFrame {
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) throw new EdgeWsError("protocol");
  return {
    headers: parseHeaderBlock(text.slice(0, split)),
    body: encoder.encode(text.slice(split + 4)),
  };
}

// ================================================================== 文本清洗 / SSML

/** `remove_incompatible_characters` 的同义实现：服务端不接受这几个控制字符 */
export function stripUnsupportedChars(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) ? " " : char;
  }
  return out;
}

export function escapeSsml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface EdgeVoiceParams {
  voice: string;
  /** 带符号百分比（`-8%`） */
  rate: string;
  /** 带符号 Hz（`-3Hz`） */
  pitch: string;
}

export function buildSsml(text: string, params: EdgeVoiceParams, volume = "+0%"): string {
  const safe = escapeSsml(stripUnsupportedChars(text));
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${params.voice}'>` +
    `<prosody pitch='${params.pitch}' rate='${params.rate}' volume='${volume}'>` +
    `${safe}</prosody></voice></speak>`
  );
}

/** 服务端要 JS 风格的日期串（`Date.toString()` 的形态），不是 RFC 1123 */
export function wsTimestamp(ms: number): string {
  const date = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

/** `Path:speech.config`：告诉服务端要什么格式、要不要 metadata */
export function configFrame(): string {
  return encodeTextFrame(
    {
      "X-Timestamp": wsTimestamp(Date.now()),
      "Content-Type": "application/json; charset=utf-8",
      Path: "speech.config",
    },
    '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
      '"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},' +
      `"outputFormat":"${OUTPUT_FORMAT}"}}}}`,
  );
}

export function ssmlFrame(text: string, params: EdgeVoiceParams, requestId = randomUUID().replace(/-/g, "")): string {
  return encodeTextFrame(
    {
      "X-RequestId": requestId,
      "Content-Type": "application/ssml+xml",
      "X-Timestamp": `${wsTimestamp(Date.now())}Z`,
      Path: "ssml",
    },
    buildSsml(text, params),
  );
}

// ================================================================== 连接

/** 只要求这几个能力：发、关、四个事件回调（Bun 的 WebSocket 与测试里的假实现都满足） */
export interface WsLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type WsConnect = (url: string, headers: Record<string, string>) => WsLike;

/** 默认建连：Bun 的全局 WebSocket 支持第二参数带 header（服务端代码，不是浏览器） */
export function defaultWsConnect(url: string, headers: Record<string, string>): WsLike {
  const socket = new WebSocket(url, { headers } as never);
  return socket as unknown as WsLike;
}

function wsHeaders(): Record<string, string> {
  return {
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "Sec-WebSocket-Version": "13",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  };
}

function buildUrl(token: string, connectionId: string): string {
  const query =
    `TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${connectionId}` +
    `&Sec-MS-GEC=${token}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  return `${EDGE_WS_URL}?${query}`;
}

/** 一次合成请求的收件箱：WS 回调往里塞，迭代器从里取 */
class Inbox {
  private readonly chunks: Uint8Array[] = [];
  done = false;
  error: EdgeWsError | null = null;
  frames = 0;
  bytes = 0;
  private waker: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.frames += 1;
    this.bytes += chunk.byteLength;
    this.wake();
  }

  take(): Uint8Array | undefined {
    return this.chunks.shift();
  }

  fail(error: EdgeWsError): void {
    if (!this.error) this.error = error;
    this.done = true;
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waker = resolve;
    });
  }

  private wake(): void {
    const waker = this.waker;
    this.waker = null;
    waker?.();
  }
}

interface Connection {
  readonly key: string;
  readonly params: EdgeVoiceParams;
  readonly ws: WsLike;
  busy: boolean;
  closed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  current: Inbox | null;
}

export interface EdgeWsOptions {
  /** 注入建连（测试用假 WS）；生产用全局 WebSocket */
  connect?: WsConnect;
  /** 注入时钟（秒） */
  now?: () => number;
  /** 注入令牌生成（默认标准 SHA-256；见文件头关于 drm.py 分歧的说明） */
  tokenFor?: (unixSeconds: number) => string;
  /** 握手失败后取服务端时间用的 HTTP 请求；返回服务端 unix 秒或 null */
  serverTime?: () => Promise<number | null>;
  maxConcurrent?: number;
  audioTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  queueTimeoutMs?: number;
  idleMs?: number;
  log?: (line: string) => void;
}

export interface EdgeWsStats {
  active: number;
  queued: number;
  open: number;
  connects: number;
  /**
   * 最近一次**主动弃连**的原因（诊断区用）。
   * 弃连语义：某次合成出错后 socket 状态未知，且服务端可能还在往这条连接推上一句的
   * 残余音频 —— 复用会让下一句听到上一句的尾巴，所以出错即弃、绝不复用。
   */
  lastDrop: { reason: string; at: number } | null;
}

export interface EdgeWsClient {
  synthesizeStream(
    text: string,
    params: EdgeVoiceParams,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array>;
  readonly stats: EdgeWsStats;
  /** 关掉所有连接（进程退出/测试清理用） */
  close(): void;
  /** 服务端在它的视角下认为的当前时间（秒），失败回 null */
  serverTime(): Promise<number | null>;
}

/** 默认的服务端时间：一次普通 HTTP GET，只读 `Date` 头（不解析 body，不带任何凭据） */
async function defaultServerTime(): Promise<number | null> {
  try {
    const res = await fetch(`https://${EDGE_WS_URL.split("/")[2]}/consumer/speech/synthesize/readaloud/voices/list`, {
      method: "HEAD",
      headers: { "User-Agent": wsHeaders()["User-Agent"] ?? "mira-scene" },
    });
    const header = res.headers.get("date");
    if (!header) return null;
    const parsed = Date.parse(header);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  } catch {
    return null;
  }
}

function paramsKey(params: EdgeVoiceParams): string {
  return `${params.voice}|${params.rate}|${params.pitch}`;
}

export function createEdgeWsClient(options: EdgeWsOptions = {}): EdgeWsClient {
  const connect = options.connect ?? defaultWsConnect;
  const log = options.log ?? (() => {});
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? MAX_WS_CONCURRENT);
  const audioTimeoutMs = options.audioTimeoutMs ?? WS_AUDIO_TIMEOUT_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? WS_HANDSHAKE_TIMEOUT_MS;
  const queueTimeoutMs = options.queueTimeoutMs ?? WS_QUEUE_TIMEOUT_MS;
  const idleMs = options.idleMs ?? WS_IDLE_CLOSE_MS;
  const tokenFor = options.tokenFor ?? ((unix: number) => secMsGecToken(unix));
  const serverTimeFn = options.serverTime ?? defaultServerTime;

  /** 本机时钟偏移（秒）：401/403 之后用服务端 `Date` 校正一次，之后一直带着 */
  let skewSeconds = 0;
  const now = options.now
    ? () => options.now!() + skewSeconds
    : () => Date.now() / 1000 + skewSeconds;

  const pool: Connection[] = [];
  let lastDrop: { reason: string; at: number } | null = null;
  let active = 0;
  const waiting: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  let connects = 0;

  function acquireSlot(): Promise<boolean> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve(true);
        },
        timer: setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          resolve(false);
        }, queueTimeoutMs),
      };
      waiting.push(waiter);
    });
  }

  function releaseSlot(): void {
    const next = waiting.shift();
    if (next) {
      next.grant();
      return;
    }
    active = Math.max(0, active - 1);
  }

  function dropConnection(conn: Connection, reason: string): void {
    conn.closed = true;
    lastDrop = { reason, at: Date.now() };
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
    const index = pool.indexOf(conn);
    if (index >= 0) pool.splice(index, 1);
    try {
      conn.ws.close(1000);
    } catch {
      /* 已经关了 */
    }
  }

  function scheduleIdleClose(conn: Connection): void {
    if (conn.closed) return;
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    if (idleMs <= 0) {
      dropConnection(conn, "idle");
      return;
    }
    conn.idleTimer = setTimeout(() => {
      conn.idleTimer = null;
      if (!conn.busy) dropConnection(conn, "idle");
    }, idleMs);
    // 空闲回收不该拖住进程退出
    if (typeof conn.idleTimer === "object" && conn.idleTimer && "unref" in conn.idleTimer) {
      (conn.idleTimer as { unref: () => void }).unref();
    }
  }

  /** 建一条新连接并等它 open；失败抛 `EdgeWsError` */
  function openConnection(params: EdgeVoiceParams, token: string): Promise<Connection> {
    return new Promise<Connection>((resolve, reject) => {
      let settled = false;
      let socket: WsLike;
      const fail = (kind: EdgeWsFailureKind): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          /* 无所谓 */
        }
        reject(new EdgeWsError(kind));
      };
      const timer = setTimeout(() => fail("handshake"), handshakeTimeoutMs);
      try {
        connects += 1;
        socket = connect(buildUrl(token, randomUUID().replace(/-/g, "")), wsHeaders());
      } catch {
        settled = true;
        clearTimeout(timer);
        reject(new EdgeWsError("handshake"));
        return;
      }
      const conn: Connection = {
        key: paramsKey(params),
        params,
        ws: socket,
        busy: false,
        closed: false,
        idleTimer: null,
        current: null,
      };
      // 回包分发：控制帧（文本）与音频帧（二进制）走同一条路
      socket.onmessage = (event) => {
        const inbox = conn.current;
        if (!inbox) return;
        try {
          const data = event.data;
          if (typeof data === "string") {
            const frame = decodeTextFrame(data);
            const path = frame.headers["Path"];
            if (path === "turn.end") inbox.finish();
            return;
          }
          const bytes =
            data instanceof Uint8Array
              ? data
              : data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : Array.isArray(data)
                  ? new Uint8Array(data)
                  : null;
          if (!bytes) {
            inbox.fail(new EdgeWsError("protocol"));
            return;
          }
          const frame = decodeBinaryFrame(bytes);
          const path = frame.headers["Path"];
          if (path === "turn.end") {
            inbox.finish();
            return;
          }
          if (path === "audio") {
            if (frame.body.byteLength > 0) inbox.push(frame.body);
            return;
          }
          // audio.metadata / turn.start / response：对播放无用，直接忽略
        } catch {
          inbox.fail(new EdgeWsError("protocol"));
        }
      };
      socket.onerror = () => {
        if (!settled) {
          fail("handshake");
          return;
        }
        conn.current?.fail(new EdgeWsError("closed"));
      };
      socket.onclose = () => {
        conn.closed = true;
        if (!settled) {
          fail("handshake");
          return;
        }
        conn.current?.fail(new EdgeWsError("closed"));
      };
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(conn);
      };
    });
  }

  async function acquireConnection(params: EdgeVoiceParams): Promise<Connection> {
    const key = paramsKey(params);
    const idle = pool.find((item) => item.key === key && !item.busy && !item.closed);
    if (idle) {
      idle.busy = true;
      if (idle.idleTimer) clearTimeout(idle.idleTimer);
      idle.idleTimer = null;
      return idle;
    }
    let conn: Connection;
    try {
      conn = await openConnection(params, tokenFor(now()));
    } catch (error) {
      // 握手被拒：可能是本机时钟偏了 → 用一次 HTTP `Date` 校正后重试一次
      const kind = error instanceof EdgeWsError ? error.kind : "handshake";
      if (kind !== "handshake") throw error;
      const serverSeconds = await serverTimeFn();
      if (serverSeconds === null) throw new EdgeWsError("auth");
      skewSeconds = serverSeconds - (options.now ? options.now() : Date.now() / 1000);
      log(`[tts:ws] clock-skew adjusted=${Math.round(skewSeconds)}s`);
      try {
        conn = await openConnection(params, tokenFor(now()));
      } catch {
        throw new EdgeWsError("auth");
      }
    }
    conn.busy = true;
    pool.push(conn);
    return conn;
  }

  async function* pump(
    conn: Connection,
    text: string,
    params: EdgeVoiceParams,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<Uint8Array> {
    const inbox = new Inbox();
    conn.current = inbox;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => inbox.fail(new EdgeWsError("aborted"));
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => inbox.fail(new EdgeWsError("timeout")), audioTimeoutMs);
      if (timer && typeof timer === "object" && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }
    };
    try {
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) throw new EdgeWsError("aborted");
      conn.ws.send(configFrame());
      conn.ws.send(ssmlFrame(text, params));
      arm();
      for (;;) {
        const chunk = inbox.take();
        if (chunk) {
          arm();
          yield chunk;
          continue;
        }
        if (inbox.error) throw inbox.error;
        if (inbox.done) return;
        await inbox.wait();
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      conn.current = null;
      const ms = Date.now() - started;
      log(
        `[tts:ws] voice=${params.voice} bytes=${inbox.bytes} frames=${inbox.frames} ${ms}ms` +
          `${inbox.error ? ` fail=${inbox.error.kind}` : ""}`,
      );
    }
  }

  async function* synthesizeStream(
    text: string,
    params: EdgeVoiceParams,
    signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    if (!text.trim()) throw new EdgeWsError("empty");
    const granted = await acquireSlot();
    if (!granted) throw new EdgeWsError("queue-timeout");
    let conn: Connection | null = null;
    let failed = false;
    try {
      conn = await acquireConnection(params);
      yield* pump(conn, text, params, signal);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (conn) {
        // 出错后 socket 状态未知，且服务端可能还在往这条连接推上一句的音频 —— 直接丢掉
        if (failed || conn.closed) dropConnection(conn, failed ? "request-failed" : "peer-closed");
        else {
          conn.busy = false;
          scheduleIdleClose(conn);
        }
      }
      releaseSlot();
    }
  }

  return {
    synthesizeStream,
    get stats() {
      return {
        active,
        queued: waiting.length,
        open: pool.filter((item) => !item.closed).length,
        connects,
        lastDrop,
      };
    },
    close() {
      for (const conn of [...pool]) dropConnection(conn, "client-close");
    },
    serverTime: serverTimeFn,
  };
}

/** 从 WS 客户端拿一整个句子的音频（非流式接口/回退判断用） */
export async function collectStream(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
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
