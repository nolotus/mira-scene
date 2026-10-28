/**
 * 结构化输出能力探测 —— 「先问端点会不会，再决定用哪种约束」。
 *
 * 背景：`response_format: {type:"json_object"}` 是 DeepSeek / OpenAI 都能吃的下限，
 * 但更硬的 `json_schema`（严格 JSON Schema）只有部分端点支持，硬发过去会被 400/422 打回。
 * 所以这里做一次**极小的**能力探测，结果按 (baseUrl, model) 缓存在进程内，之后不再探。
 *
 * 探测纪律：
 *   · 请求是固定的探针 prompt，**不用真实对话内容**（也就不会把用户台词发给额外请求）；
 *   · max_tokens 很小、不带 stream，成本可忽略；
 *   · 只看状态码判定，**不打印响应体**（有的上游会在响应里回显 token/计费信息）；
 *   · 不确定（超时、401、429、5xx、连不上）不当成「不支持」，只当成「这次先用 json_object」，
 *     而且**不缓存**——下次真调用再试一次，避免一次网络抖动把能力永久降级。
 */
import { DIRECTIVE_VOCAB } from "../scene/validate.ts";
import type { LlmProvider, LlmStructMode } from "../config.ts";

export type StructuredOutputStrategy = "json_schema" | "json_object";

export interface StructuredOutputDecision {
  strategy: StructuredOutputStrategy;
  /** 判定依据：探测请求的状态码（没发请求 → null）。诊断只暴露这个，不含响应体 */
  status: number | null;
  reason: "forced" | "supported" | "unsupported" | "unknown";
}

export interface ProbeOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  /** 测试注入用；默认用全局 fetch */
  fetchImpl?: typeof fetch;
}

const PROBE_TIMEOUT_MS = 4_000;
/** 探针 prompt 固定写死：与用户对话无关，也不含任何会话内容 */
const PROBE_PROMPT = "Reply with the JSON object {\"ok\":true} and nothing else.";
const PROBE_SCHEMA_NAME = "mira_probe";

/** 探针专用 schema：越小越好，只为试探「端点收不收 json_schema」 */
const PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const;

/**
 * 导演输出用的 JSON Schema。
 *
 * 键顺序故意是 cues 先、say 后：模型照这个顺序写，服务端就能在台词还没开始流之前
 * 拿到全部 cue 的 atChar，于是可以真正「说到第 N 个字符时」把指令投递出去，
 * 而不是等 JSON 尾巴（那时台词早说完了，视觉又变成补拍）。
 *
 * 关于 `strict`：这里显式写 false 而不是 true。OpenAI 语义下 strict:true 要求
 * 「所有 properties 都在 required 里」，而指令是 7 选 1 的联合，做不到不改数据形状就满足
 * （除非把每个字段都写成 null 联合）。语义正确性由既有的 validateDirective 白名单兜底，
 * schema 负责「形状与枚举别跑偏」，这个组合比一个会被 400 拒掉的 strict:true 更可靠。
 */
export const DIRECTOR_JSON_SCHEMA = {
  type: "object",
  properties: {
    cues: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          atChar: { type: "integer", minimum: 0 },
          d: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["emotion", "pose", "action", "camera", "vfx", "scene", "branch"],
              },
              emotion: { type: "string", enum: DIRECTIVE_VOCAB.emotion },
              pose: { type: "string", enum: DIRECTIVE_VOCAB.pose },
              action: { type: "string", enum: DIRECTIVE_VOCAB.action },
              move: { type: "string", enum: DIRECTIVE_VOCAB.camera },
              vfx: { type: "string", enum: DIRECTIVE_VOCAB.vfx },
              scene: { type: "string", enum: DIRECTIVE_VOCAB.scene },
              options: {
                type: "array",
                maxItems: 4,
                items: {
                  type: "object",
                  properties: { id: { type: "string" }, label: { type: "string" } },
                  required: ["id", "label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        required: ["atChar", "d"],
        additionalProperties: false,
      },
    },
    say: { type: "string" },
  },
  required: ["cues", "say"],
  additionalProperties: false,
} as const;

/** 拼成请求里的 response_format（json_schema 档位用） */
export function jsonSchemaResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "mira_turn_plan",
      description: "这一轮要说的话，以及每条视觉指令在台词里的字符位置",
      strict: false,
      schema: DIRECTOR_JSON_SCHEMA,
    },
  };
}

/** json_object 档位用（DeepSeek 的现状：能保证是 JSON，但不能钉死 schema） */
export function jsonObjectResponseFormat(): Record<string, unknown> {
  return { type: "json_object" };
}

const cache = new Map<string, StructuredOutputDecision>();
const inflight = new Map<string, Promise<StructuredOutputDecision>>();

function cacheKey(options: { baseUrl: string; model: string }): string {
  return `${options.baseUrl.replace(/\/+$/, "")}|${options.model}`;
}

/** 测试用：清掉进程内缓存与在途探测 */
export function resetStructuredOutputCache(): void {
  cache.clear();
  inflight.clear();
}

/** 诊断用：缓存了多少个端点结论 */
export function structuredOutputCacheSize(): number {
  return cache.size;
}

/**
 * 发一次探针请求，判定端点收不收 json_schema。
 * 返回 status=null 表示「没拿到可用结论」（网络错误/超时），调用方必须按未知处理。
 */
export async function probeJsonSchemaSupport(
  options: ProbeOptions,
): Promise<{ supported: boolean | null; status: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const headers: Record<string, string> = { "content-type": "application/json", ...options.extraHeaders };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        // 探针只花几个 token，不产生真实台词
        max_tokens: 8,
        temperature: 0,
        stream: false,
        response_format: {
          type: "json_schema",
          json_schema: { name: PROBE_SCHEMA_NAME, strict: true, schema: PROBE_SCHEMA },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { supported: null, status: null };
  }

  // 只读状态码判定，响应体直接丢弃（不打印、不外传）
  const status = response.status;
  try {
    await response.body?.cancel();
  } catch {
    // 忽略：探针不需要响应体
  }

  if (status >= 200 && status < 300) return { supported: true, status };
  // 400/422 = 端点明确不认识这个 response_format（或 schema 被拒）
  if (status === 400 || status === 422) return { supported: false, status };
  return { supported: null, status };
}

/**
 * 决定这一轮用哪种结构化输出。`auto` 只探一次（per baseUrl+model），
 * 之后同一进程里所有轮次直接复用结论。
 */
export async function resolveStructuredOutput(input: {
  mode: LlmStructMode;
  provider: Pick<LlmProvider, "baseUrl" | "model" | "apiKey" | "extraHeaders">;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<StructuredOutputDecision> {
  if (input.mode === "json_object") return { strategy: "json_object", status: null, reason: "forced" };
  if (input.mode === "json_schema") return { strategy: "json_schema", status: null, reason: "forced" };

  const key = cacheKey(input.provider);
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const probe = probeJsonSchemaSupport({
    baseUrl: input.provider.baseUrl,
    model: input.provider.model,
    apiKey: input.provider.apiKey,
    extraHeaders: input.provider.extraHeaders,
    fetchImpl: input.fetchImpl,
    timeoutMs: input.timeoutMs,
  }).then(({ supported, status }): StructuredOutputDecision => {
    if (supported === true) {
      const decision: StructuredOutputDecision = { strategy: "json_schema", status, reason: "supported" };
      cache.set(key, decision);
      return decision;
    }
    if (supported === false) {
      const decision: StructuredOutputDecision = { strategy: "json_object", status, reason: "unsupported" };
      cache.set(key, decision);
      return decision;
    }
    // 未知：这次退回 json_object，但不缓存 —— 下次真调用还有机会用上更硬的约束
    return { strategy: "json_object", status, reason: "unknown" };
  });

  inflight.set(key, probe);
  try {
    return await probe;
  } finally {
    inflight.delete(key);
  }
}
