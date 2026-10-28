/**
 * 生成式插图服务端：Cloudflare Workers AI（flux-1-schnell）→ data URL。
 *
 * 四件事，缺一不可：
 *   1. 配额三层：每会话 2 张、进程级每日 60 张、未配置 env 走 not-configured（正常状态）。
 *   2. 缓存：同 prompt 只烧一次钱（sha256(prompt) → dataUrl），命中不计配额。
 *   3. 失败重试一次：非 200 / success:false / 缺 result.image / 解码后 <10KB 都算失败。
 *   4. 绝不 500：所有异常收口成 { ok:false, reason }，客户端据此静默回落。
 *
 * 密钥纪律（硬约束）：
 *   · 只从 process.env.CF_ACCOUNT_ID / CF_AI_TOKEN 读，读进内存立刻用掉；
 *   · 日志只有 status 与耗时，绝不打印 token、不打印 prompt、不回显上游 body；
 *   · 响应里只有 dataUrl / reason，没有任何凭据痕迹。
 *
 * 为什么 quota 与 cache 都是内存态：这是 72 小时 take-home 的单进程演示，
 * 内存计数跨天按日期重置即可；多实例部署要换成共享存储（见 README 的边界说明）。
 */

import { createHash } from "node:crypto";
import {
  buildPromptWithVariant,
  type IllustrateReason,
  type IllustrateRequest,
  type IllustrateResponse,
} from "../shared/illustrate.ts";
import type { SessionStore } from "./sessions.ts";

/** 每会话上限（命中即 session-limit） */
export const MAX_PER_SESSION = 2;
/** 进程级每日上限（跨天按 UTC 日期重置） */
export const MAX_DAILY = 60;
/** 解码后小于这个字节数就当「坏图」，重试一次 */
export const MIN_IMAGE_BYTES = 10 * 1024;
export const ILLUSTRATE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
export const UPSTREAM_TIMEOUT_MS = 20_000;
/** 首次失败后重试一次 → 总共最多 2 次上游请求 */
const MAX_ATTEMPTS = 2;

export interface IllustrateConfig {
  accountId: string;
  token: string;
}

export type IllustrateFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** 读 env。缺任何一项都返回 null（= 未配置，正常状态，不是错误）。 */
export function resolveIllustrateConfig(
  env: Record<string, string | undefined>,
): IllustrateConfig | null {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const token = env.CF_AI_TOKEN?.trim();
  if (!accountId || !token) return null;
  return { accountId, token };
}

export function upstreamUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${ILLUSTRATE_MODEL}`;
}

/** 缓存键：prompt 的 sha256（客户端用 prompt 本体做 localStorage 键，两边同源同文本） */
export function promptKey(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export interface QuotaSnapshot {
  /** 每日已用（含失败尝试） */
  daily: number;
  date: string;
  /** 有过的会话条目数（诊断用） */
  sessions: number;
}

export interface IllustrationServiceOptions {
  sessions: SessionStore;
  env?: Record<string, string | undefined>;
  /** 测试注入；默认全局 fetch。真实环境下本服务是唯一出口 */
  fetch?: IllustrateFetch;
  now?: () => number;
  timeoutMs?: number;
  maxPerSession?: number;
  maxDaily?: number;
  /** 日志出口（默认 console.warn）；只喂 status / 耗时 / 原因标签 */
  log?: (line: string) => void;
}

export interface IllustrationService {
  illustrate(raw: unknown): Promise<IllustrateResponse>;
  /** 是否配齐 env（不含任何密钥内容，可用于自检与诊断） */
  readonly configured: boolean;
  /** 某个请求对应的 prompt（诊断/单测用；与客户端缓存键同一段文本） */
  promptFor(input: IllustrateRequest): string;
  quota(): QuotaSnapshot;
}

interface AttemptResult {
  dataUrl?: string;
  /** 失败原因标签，只用于日志（不含上游 body） */
  error?: string;
  status: number | null;
}

export function createIllustrationService(options: IllustrationServiceOptions): IllustrationService {
  const { sessions } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxPerSession = options.maxPerSession ?? MAX_PER_SESSION;
  const maxDaily = options.maxDaily ?? MAX_DAILY;
  const log = options.log ?? ((line: string) => console.warn(line));
  const doFetch: IllustrateFetch =
    options.fetch ?? ((url, init) => fetch(url, init));

  /** prompt sha256 → dataUrl。命中不计配额，也不打网络。 */
  const cache = new Map<string, string>();
  /** sessionId → 已成功生成的张数（只计成功：上游失败不扣用户额度） */
  const perSession = new Map<string, number>();
  /** 每日已尝试次数（含失败：它是全进程的钱包护栏） */
  let daily = { date: "", count: 0 };

  const today = (): string => new Date(now()).toISOString().slice(0, 10);

  function rollDay(): void {
    const date = today();
    if (daily.date === date) return;
    daily = { date, count: 0 };
  }

  /**
   * 一次上游调用。所有失败形态都归一成 AttemptResult（不出异常）：
   * 非 200 / 响应不是 JSON / success:false / 缺 result.image / 解码后过小 / 超时 / 网络错误。
   */
  async function attempt(config: IllustrateConfig, prompt: string, attemptIndex: number): Promise<AttemptResult> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), timeoutMs);
    let status: number | null = null;
    try {
      const response = await doFetch(upstreamUrl(config.accountId), {
        method: "POST",
        headers: {
          // 唯一出现凭据的地方：请求头，不进日志、不进响应
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });
      status = response.status;
      if (!response.ok) {
        return finish({ error: "http", status }, started, "http", attemptIndex);
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        return finish({ error: "json", status }, started, "json", attemptIndex);
      }

      const image = readImage(payload);
      if (image === null) {
        return finish({ error: "shape", status }, started, "shape", attemptIndex);
      }
      if (Buffer.byteLength(image, "base64") < MIN_IMAGE_BYTES) {
        return finish({ error: "small", status }, started, "small", attemptIndex);
      }
      return finish({ dataUrl: `data:image/jpeg;base64,${image}`, status }, started, "ok", attemptIndex);
    } catch {
      // 超时 / 网络 / 解析异常都走这里；不打 error 详情，避免把请求细节带进日志
      return finish({ error: "network", status }, started, "network", attemptIndex);
    } finally {
      clearTimeout(timer);
    }
  }

  function finish(result: AttemptResult, started: number, tag: string, attemptIndex: number): AttemptResult {
    const ms = Math.round(performance.now() - started);
    log(`[illustrate] upstream attempt=${attemptIndex} tag=${tag} status=${result.status ?? "-"} ${ms}ms`);
    return result;
  }

  /** 上游成功失败的判据集中在这里：success:false 或缺 image 都算失败（要重试） */
  function readImage(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as { success?: unknown; result?: { image?: unknown } };
    if (record.success === false) return null;
    const image = record.result?.image;
    if (typeof image !== "string") return null;
    const trimmed = image.trim();
    return trimmed === "" ? null : trimmed;
  }

  async function generate(config: IllustrateConfig, prompt: string): Promise<AttemptResult> {
    let last: AttemptResult = { error: "unknown", status: null };
    for (let index = 1; index <= MAX_ATTEMPTS; index += 1) {
      const result = await attempt(config, prompt, index);
      if (result.dataUrl) return result;
      last = result;
    }
    return last;
  }

  function parse(raw: unknown): IllustrateRequest | null {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    const beatId = typeof record.beatId === "string" ? record.beatId.trim() : "";
    if (!sessionId || !beatId) return null;
    const scene = typeof record.scene === "string" ? record.scene.trim().slice(0, 64) : undefined;
    const variant = typeof record.variant === "string" ? record.variant.trim().slice(0, 32) : undefined;
    return {
      sessionId: sessionId.slice(0, 128),
      beatId: beatId.slice(0, 64),
      ...(scene ? { scene } : {}),
      ...(variant ? { variant } : {}),
    };
  }

  function promptFor(input: IllustrateRequest): string {
    return buildPromptWithVariant(input.scene ?? null, input.beatId, input.variant ?? null);
  }

  async function illustrate(raw: unknown): Promise<IllustrateResponse> {
    const startedAt = performance.now();
    const fail = (reason: IllustrateReason): IllustrateResponse => ({ ok: false, reason });

    const input = parse(raw);
    if (!input) return fail("bad-request");

    // 会话必须已存在：插图归属于一段具体对话，不能凭空给匿名请求烧图
    if (!sessions.get(input.sessionId)) return fail("no-session");

    const config = resolveIllustrateConfig(env);
    // 未配置 = 正常状态：客户端要能识别成「功能不可用」，而不是「出错了」
    if (!config) return fail("not-configured");

    const prompt = promptFor(input);
    const key = promptKey(prompt);

    // ① 缓存：同 prompt 第二次直接拿，不计配额、不联网
    const cached = cache.get(key);
    if (cached) {
      return { ok: true, dataUrl: cached, cached: true, ms: Math.round(performance.now() - startedAt) };
    }

    // ② 每会话配额（只计成功张数）
    const used = perSession.get(input.sessionId) ?? 0;
    if (used >= maxPerSession) return fail("session-limit");

    // ③ 进程级每日配额（按 UTC 日期重置；计数含失败尝试）
    rollDay();
    if (daily.count >= maxDaily) return fail("daily-limit");
    daily.count += 1;

    const result = await generate(config, prompt);
    if (!result.dataUrl) return fail("upstream");

    cache.set(key, result.dataUrl);
    perSession.set(input.sessionId, used + 1);
    return {
      ok: true,
      dataUrl: result.dataUrl,
      cached: false,
      ms: Math.round(performance.now() - startedAt),
    };
  }

  return {
    illustrate,
    get configured() {
      return resolveIllustrateConfig(env) !== null;
    },
    promptFor,
    quota: () => ({ daily: daily.count, date: daily.date, sessions: perSession.size }),
  };
}
