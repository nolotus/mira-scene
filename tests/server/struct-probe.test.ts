/**
 * 结构化输出能力探测（json_schema）—— 全 stub，不联网。
 *
 * 要钉住的是「别把能力猜错」：
 *   200 → 用 json_schema；400/422 → 退回 json_object；401/超时/连不上 → 当未知，
 *   这次先退回 json_object 但**不缓存**（下次还能再试，不被一次抖动永久降级）。
 * 以及「只探一次」：同一 (baseUrl, model) 的结论缓存进进程。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  loadConfig,
  resolveLlmMode,
  resolveLlmStructMode,
  type LlmProvider,
} from "../../src/server/config.ts";
import { LiveDirector } from "../../src/server/director/live.ts";
import {
  DIRECTOR_JSON_SCHEMA,
  jsonObjectResponseFormat,
  jsonSchemaResponseFormat,
  probeJsonSchemaSupport,
  resetStructuredOutputCache,
  resolveStructuredOutput,
  structuredOutputCacheSize,
} from "../../src/server/director/struct-probe.ts";
import type { DirectorInput, SessionEvent } from "../../src/shared/protocol.ts";

const provider: LlmProvider = {
  id: "deepseek",
  baseUrl: "https://stub.invalid/probe",
  apiKey: "sk-fake-for-tests",
  model: "stub-model",
  label: "deepseek",
};

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function stub(status: number, options: { throws?: boolean } = {}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as RequestInit | undefined;
    calls.push({
      url: String(url),
      body: JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>,
      headers: (request?.headers ?? {}) as Record<string, string>,
    });
    if (options.throws) throw new Error("connect ECONNREFUSED");
    return new Response(status === 200 ? '{"ok":true}' : "rejected", { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("env 解析（MIRA_LLM_STRUCT / MIRA_LLM_MODE）", () => {
  test("缺省 → auto / chat", () => {
    expect(resolveLlmStructMode({})).toBe("auto");
    expect(resolveLlmMode({})).toBe("chat");
  });

  test("合法值原样、大小写与空白容忍", () => {
    expect(resolveLlmStructMode({ MIRA_LLM_STRUCT: " json_schema " })).toBe("json_schema");
    expect(resolveLlmStructMode({ MIRA_LLM_STRUCT: "JSON_OBJECT" })).toBe("json_object");
    expect(resolveLlmMode({ MIRA_LLM_MODE: "tool" })).toBe("tool");
  });

  test("拼错/不支持的值回落默认，不抛错", () => {
    expect(resolveLlmStructMode({ MIRA_LLM_STRUCT: "schema" })).toBe("auto");
    expect(resolveLlmMode({ MIRA_LLM_MODE: "function_call" })).toBe("chat");
  });

  test("loadConfig 带上这两个字段", () => {
    const config = loadConfig({ NODE_ENV: "development", MIRA_LLM_STRUCT: "json_object", MIRA_LLM_MODE: "tool" });
    expect(config.llmStruct).toBe("json_object");
    expect(config.llmMode).toBe("tool");
    expect(loadConfig({}).llmStruct).toBe("auto");
  });
});

describe("探针请求形状", () => {
  beforeEach(() => resetStructuredOutputCache());

  test("极小的固定请求：max_tokens 很小、非流式、json_schema，且不含任何对话内容", async () => {
    const { fetchImpl, calls } = stub(200);
    const result = await probeJsonSchemaSupport({ ...provider, fetchImpl });

    expect(result).toEqual({ supported: true, status: 200 });
    const [call] = calls;
    expect(call?.url).toBe("https://stub.invalid/probe/chat/completions");
    expect(call?.headers.authorization).toBe("Bearer sk-fake-for-tests");
    expect(call?.body.max_tokens).toBe(8);
    expect(call?.body.stream).toBe(false);
    expect((call?.body.response_format as { type?: string }).type).toBe("json_schema");

    // 探针 prompt 是写死的，绝不带用户台词（这里正好断言它不含测试里的对话词）
    const messages = JSON.stringify(call?.body.messages);
    expect(messages).not.toContain("雨");
    expect(messages).toContain("ok");
  });
});

describe("resolveStructuredOutput · 判定与缓存", () => {
  beforeEach(() => resetStructuredOutputCache());

  test("auto + 200 → json_schema（supported）", async () => {
    const { fetchImpl, calls } = stub(200);
    const decision = await resolveStructuredOutput({ mode: "auto", provider, fetchImpl });
    expect(decision).toEqual({ strategy: "json_schema", status: 200, reason: "supported" });
    expect(calls).toHaveLength(1);
    expect(structuredOutputCacheSize()).toBe(1);
  });

  test("auto + 400 → json_object（unsupported），并缓存", async () => {
    const { fetchImpl, calls } = stub(400);
    expect(await resolveStructuredOutput({ mode: "auto", provider, fetchImpl })).toEqual({
      strategy: "json_object",
      status: 400,
      reason: "unsupported",
    });
    // 第二次不再探
    expect(await resolveStructuredOutput({ mode: "auto", provider, fetchImpl })).toEqual({
      strategy: "json_object",
      status: 400,
      reason: "unsupported",
    });
    expect(calls).toHaveLength(1);
  });

  test("auto + 422 → json_object（unsupported）", async () => {
    const { fetchImpl } = stub(422);
    expect((await resolveStructuredOutput({ mode: "auto", provider, fetchImpl })).strategy).toBe("json_object");
  });

  test("auto + 401（不是 schema 的问题）→ 当未知、不缓存，下次还会再探", async () => {
    const { fetchImpl, calls } = stub(401);
    const first = await resolveStructuredOutput({ mode: "auto", provider, fetchImpl });
    expect(first).toEqual({ strategy: "json_object", status: 401, reason: "unknown" });
    expect(structuredOutputCacheSize()).toBe(0);
    await resolveStructuredOutput({ mode: "auto", provider, fetchImpl });
    expect(calls).toHaveLength(2);
  });

  test("连不上 → 未知、不缓存，本轮退回 json_object", async () => {
    const { fetchImpl } = stub(0, { throws: true });
    expect(await resolveStructuredOutput({ mode: "auto", provider, fetchImpl })).toEqual({
      strategy: "json_object",
      status: null,
      reason: "unknown",
    });
    expect(structuredOutputCacheSize()).toBe(0);
  });

  test("强制档位不发请求", async () => {
    const { fetchImpl, calls } = stub(200);
    expect(await resolveStructuredOutput({ mode: "json_object", provider, fetchImpl })).toEqual({
      strategy: "json_object",
      status: null,
      reason: "forced",
    });
    expect(await resolveStructuredOutput({ mode: "json_schema", provider, fetchImpl })).toEqual({
      strategy: "json_schema",
      status: null,
      reason: "forced",
    });
    expect(calls).toHaveLength(0);
  });

  test("并发调用共享同一次探测（不会同时打两次）", async () => {
    const { fetchImpl, calls } = stub(200);
    const [a, b] = await Promise.all([
      resolveStructuredOutput({ mode: "auto", provider, fetchImpl }),
      resolveStructuredOutput({ mode: "auto", provider, fetchImpl }),
    ]);
    expect(a.strategy).toBe("json_schema");
    expect(b.strategy).toBe("json_schema");
    expect(calls).toHaveLength(1);
  });
});

describe("schema 定义", () => {
  test("cues 在 say 之前（服务端才能在台词开播前拿到 atChar）", () => {
    expect(Object.keys(DIRECTOR_JSON_SCHEMA.properties)).toEqual(["cues", "say"]);
    const item = DIRECTOR_JSON_SCHEMA.properties.cues.items;
    expect(item.required).toEqual(["atChar", "d"]);
    expect(item.properties.d.required).toEqual(["kind"]);
    expect(item.properties.atChar.type).toBe("integer");
  });

  test("response_format 两种形状", () => {
    expect(jsonObjectResponseFormat()).toEqual({ type: "json_object" });
    const schema = jsonSchemaResponseFormat() as {
      type: string;
      json_schema: { name: string; schema: unknown };
    };
    expect(schema.type).toBe("json_schema");
    expect(schema.json_schema.name).toBe("mira_turn_plan");
    expect(schema.json_schema.schema).toBe(DIRECTOR_JSON_SCHEMA);
  });
});

describe("LiveDirector · tool 模式只有配置位", () => {
  const input: DirectorInput = {
    userText: "你好",
    scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
    history: [],
    turnId: "turn-tool",
    epoch: 1,
  };

  test("返回明确「未实现」错误，且不发任何上游请求", async () => {
    const { fetchImpl, calls } = stub(200);
    const director = new LiveDirector({
      apiKey: "sk-fake-for-tests",
      baseUrl: "https://stub.invalid/tool",
      model: "stub-model",
      fetchImpl,
      mode: "tool",
    });
    const events: SessionEvent[] = [];
    for await (const event of director.stream(input, new AbortController().signal)) events.push(event);

    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const [error] = events;
    expect(error?.type).toBe("error");
    if (error?.type === "error") expect(error.message).toContain("未实现");
  });
});
