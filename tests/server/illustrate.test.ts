/**
 * 服务端插图服务：配额三层 / 缓存 / 重试 / 密钥不外泄。
 *
 * 全部 stub fetch —— 测试不发任何真实请求，也不读任何真实 key。
 * 每个 stub 都记录调用次数与请求体，用来证明「重试恰好一次」「缓存命中不联网」。
 */
import { describe, expect, test } from "bun:test";
import { MAX_DAILY, MAX_PER_SESSION, createIllustrationService, promptKey, resolveIllustrateConfig, type IllustrateFetch } from "../../src/server/illustrate.ts";
import { createApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { SessionStore } from "../../src/server/sessions.ts";
import { BEAT_CLAUSE, PROMPT_PREFIX, buildPrompt, normalizeBeat } from "../../src/shared/illustrate.ts";

/** 12KB 解码后 → 通过「<10KB 当坏图」这一关 */
const BIG_IMAGE = Buffer.alloc(12 * 1024, 7).toString("base64");
/** 0.5KB → 必须被判为坏图并重试 */
const SMALL_IMAGE = Buffer.alloc(512, 1).toString("base64");

const TOKEN = "cf-token-for-test-not-real";
const ENV = { CF_ACCOUNT_ID: "acct-test-0001", CF_AI_TOKEN: TOKEN };

interface Plan {
  status?: number;
  body?: unknown;
  throws?: boolean;
}

interface Stub {
  fetchImpl: IllustrateFetch;
  calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }>;
}

/** 按顺序消费 plan，用完后重复最后一个 */
function stubFetch(plans: Plan[]): Stub {
  const calls: Stub["calls"] = [];
  const fetchImpl: IllustrateFetch = async (url, init) => {
    calls.push({ url, init });
    const plan = plans[Math.min(calls.length - 1, plans.length - 1)] ?? {};
    if (plan.throws) throw new Error("network down");
    return new Response(JSON.stringify(plan.body ?? {}), {
      status: plan.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function okPlan(image = BIG_IMAGE): Plan {
  return { status: 200, body: { success: true, result: { image } } };
}

function makeSessions(...ids: string[]): SessionStore {
  const sessions = new SessionStore();
  for (const id of ids) sessions.ensure(id);
  return sessions;
}

function makeService(options: {
  plans?: Plan[];
  env?: Record<string, string | undefined>;
  sessions?: SessionStore;
  now?: () => number;
  maxDaily?: number;
  maxPerSession?: number;
} = {}) {
  const sessions = options.sessions ?? makeSessions("s1", "s2", "s3", "s4");
  const stub = stubFetch(options.plans ?? [okPlan()]);
  const logs: string[] = [];
  const service = createIllustrationService({
    sessions,
    env: options.env ?? ENV,
    fetch: stub.fetchImpl,
    log: (line) => logs.push(line),
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxDaily !== undefined ? { maxDaily: options.maxDaily } : {}),
    ...(options.maxPerSession !== undefined ? { maxPerSession: options.maxPerSession } : {}),
  });
  return { sessions, stub, service, logs };
}

const req = (sessionId: string, beatId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId,
  beatId,
  scene: "cafe_night",
  ...extra,
});

// ---------------------------------------------------------------- prompt 纯函数

describe("buildPrompt", () => {
  test("固定前缀包含全部外观锚点（年龄/雨衣/发夹/暴雨夜/打烊咖啡馆/胶片颗粒/无水印）", () => {
    const prompt = buildPrompt("cafe_night", "storm");
    expect(prompt.startsWith(PROMPT_PREFIX)).toBe(true);
    for (const anchor of [
      "26-year-old",
      "amber raincoat",
      "silver star hair clip",
      "stormy night",
      "about to close",
      "film grain",
      "no watermark",
      "no text",
    ]) {
      expect(prompt).toContain(anchor);
    }
  });

  test("同一输入永远得到同一段文本（缓存键的前提）", () => {
    expect(buildPrompt("cafe_night", "storm")).toBe(buildPrompt("cafe_night", "storm"));
    expect(promptKey(buildPrompt("cafe_night", "storm"))).toBe(promptKey(buildPrompt("cafe_night", "storm")));
  });

  test("三个 beat 各自的专属情境都拼得进去，且互不相同", () => {
    const storm = buildPrompt("cafe_night", "storm");
    const window = buildPrompt("cafe_night", "window_call");
    const warm = buildPrompt("cafe_night", "warm");
    expect(storm).toContain(BEAT_CLAUSE.storm);
    expect(window).toContain(BEAT_CLAUSE.window_call);
    expect(warm).toContain(BEAT_CLAUSE.warm);
    expect(new Set([storm, window, warm]).size).toBe(3);
  });

  test("beatId 归一：导演/片段层的命名都能落到同一支", () => {
    expect(normalizeBeat("storm-strip")).toBe("storm");
    expect(normalizeBeat("warm_beat")).toBe("warm");
    expect(normalizeBeat("window_call")).toBe("window_call");
    expect(normalizeBeat("whatever")).toBe("default");
    // 前缀不变，只有情境变
    expect(buildPrompt("cafe_night", "storm-strip")).toBe(buildPrompt("cafe_night", "storm"));
  });

  test("scene 变体只改环境句，不改前缀", () => {
    const night = buildPrompt("cafe_night", "storm");
    const closing = buildPrompt("cafe_closing", "storm");
    expect(night).not.toBe(closing);
    expect(closing.startsWith(PROMPT_PREFIX)).toBe(true);
  });
});

// ---------------------------------------------------------------- 配置

describe("resolveIllustrateConfig", () => {
  test("缺任一 env 都是 null（= not-configured 的正常状态）", () => {
    expect(resolveIllustrateConfig({})).toBeNull();
    expect(resolveIllustrateConfig({ CF_ACCOUNT_ID: "a" })).toBeNull();
    expect(resolveIllustrateConfig({ CF_AI_TOKEN: "t" })).toBeNull();
    expect(resolveIllustrateConfig({ CF_ACCOUNT_ID: "a", CF_AI_TOKEN: "t" })).toEqual({
      accountId: "a",
      token: "t",
    });
  });
});

// ---------------------------------------------------------------- 请求校验

describe("入参校验", () => {
  test("非法 body → bad-request（不联网）", async () => {
    const { stub, service } = makeService();
    expect(await service.illustrate(null)).toEqual({ ok: false, reason: "bad-request" });
    expect(await service.illustrate({})).toEqual({ ok: false, reason: "bad-request" });
    expect(await service.illustrate({ sessionId: "s1" })).toEqual({ ok: false, reason: "bad-request" });
    expect(stub.calls.length).toBe(0);
  });

  test("会话必须已存在 → no-session（不联网）", async () => {
    const { stub, service } = makeService();
    const result = await service.illustrate(req("ghost", "storm"));
    expect(result).toEqual({ ok: false, reason: "no-session" });
    expect(stub.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------- 配额三层

describe("配额：未配置", () => {
  test("env 缺失 → not-configured，且一次上游请求都不发", async () => {
    const { stub, service } = makeService({ env: {} });
    expect(await service.illustrate(req("s1", "storm"))).toEqual({ ok: false, reason: "not-configured" });
    expect(stub.calls.length).toBe(0);
    expect(service.configured).toBe(false);
  });
});

describe("配额：每会话上限", () => {
  test(`第 ${MAX_PER_SESSION + 1} 张（不同 prompt）→ session-limit`, async () => {
    const { stub, service } = makeService();
    expect(MAX_PER_SESSION).toBe(2);
    expect((await service.illustrate(req("s1", "storm"))).ok).toBe(true);
    expect((await service.illustrate(req("s1", "window_call"))).ok).toBe(true);
    expect(await service.illustrate(req("s1", "warm"))).toEqual({ ok: false, reason: "session-limit" });
    expect(stub.calls.length).toBe(2);
  });

  test("配额按会话隔离：s1 用满不影响 s2", async () => {
    const { service } = makeService();
    await service.illustrate(req("s1", "storm"));
    await service.illustrate(req("s1", "window_call"));
    expect((await service.illustrate(req("s2", "storm"))).ok).toBe(true);
  });
});

describe("配额：每日上限", () => {
  test("达到进程级每日上限 → daily-limit", async () => {
    const { stub, service } = makeService({ maxDaily: 2 });
    // 每次用不同 beat（= 不同 prompt），否则第二张会走缓存而不是消耗配额
    expect((await service.illustrate(req("s1", "storm"))).ok).toBe(true);
    expect((await service.illustrate(req("s2", "window_call"))).ok).toBe(true);
    expect(await service.illustrate(req("s3", "warm"))).toEqual({ ok: false, reason: "daily-limit" });
    // 第三次被挡在配额里，没有发出上游请求
    expect(stub.calls.length).toBe(2);
    expect(MAX_DAILY).toBe(60);
  });

  test("跨天按日期重置", async () => {
    let clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { service } = makeService({ maxDaily: 1, now: () => clock });
    expect((await service.illustrate(req("s1", "storm"))).ok).toBe(true);
    expect(await service.illustrate(req("s2", "window_call"))).toEqual({ ok: false, reason: "daily-limit" });
    clock += 24 * 60 * 60 * 1000; // 第二天
    expect((await service.illustrate(req("s2", "window_call"))).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- 缓存

describe("缓存", () => {
  test("同 prompt 第二次命中缓存：cached:true、不联网、不占配额", async () => {
    const { stub, service } = makeService();
    const first = await service.illustrate(req("s1", "storm"));
    expect(first.ok && first.cached).toBe(false);

    const second = await service.illustrate(req("s1", "storm"));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.cached).toBe(true);
      expect(second.dataUrl).toBe(`data:image/jpeg;base64,${BIG_IMAGE}`);
    }
    expect(stub.calls.length).toBe(1);
  });

  test("缓存命中不把会话额度用掉：两张生成后仍可命中，新 prompt 才 session-limit", async () => {
    const { service } = makeService();
    await service.illustrate(req("s1", "storm"));
    await service.illustrate(req("s1", "window_call"));

    const hit = await service.illustrate(req("s1", "storm"));
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.cached).toBe(true);

    // 命中没有 +1 额度，所以第三张新图仍然被会话上限挡（上限本来就已经到达）
    expect(await service.illustrate(req("s1", "warm"))).toEqual({ ok: false, reason: "session-limit" });
  });

  test("缓存键随 variant 变化（同一 beat 的另一个机位是另一张图）", async () => {
    const { stub, service } = makeService();
    await service.illustrate(req("s1", "storm", { variant: "wide" }));
    await service.illustrate(req("s1", "storm", { variant: "close" }));
    expect(stub.calls.length).toBe(2);
    const second = await service.illustrate(req("s1", "storm", { variant: "close" }));
    expect(second.ok && second.cached).toBe(true);
  });
});

// ---------------------------------------------------------------- 失败与重试

describe("上游失败：重试恰好一次", () => {
  test("两次都非 200 → upstream，且只打了两枪", async () => {
    const { stub, service } = makeService({ plans: [{ status: 500, body: { success: false } }] });
    expect(await service.illustrate(req("s1", "storm"))).toEqual({ ok: false, reason: "upstream" });
    expect(stub.calls.length).toBe(2);
  });

  test("第一次 500、第二次成功 → 仍然返回图（重试起了作用）", async () => {
    const { stub, service } = makeService({
      plans: [{ status: 503, body: {} }, okPlan()],
    });
    const result = await service.illustrate(req("s1", "storm"));
    expect(result.ok).toBe(true);
    expect(stub.calls.length).toBe(2);
  });

  test("success:false / 缺 result.image / 解码后 <10KB 都算失败并重试", async () => {
    for (const body of [
      { success: false, result: {} },
      { success: true, result: {} },
      { success: true, result: { image: SMALL_IMAGE } },
    ]) {
      const { stub, service } = makeService({ plans: [{ status: 200, body }] });
      expect(await service.illustrate(req("s1", "storm"))).toEqual({ ok: false, reason: "upstream" });
      expect(stub.calls.length).toBe(2);
    }
  });

  test("网络异常 → upstream（不抛出到调用方）", async () => {
    const { service } = makeService({ plans: [{ throws: true }] });
    expect(await service.illustrate(req("s1", "storm"))).toEqual({ ok: false, reason: "upstream" });
  });

  test("失败不抛异常：服务端调用方永远拿到 { ok:false }", async () => {
    const { service } = makeService({ plans: [{ throws: true }] });
    const result = await service.illustrate(req("s1", "storm"));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- 密钥纪律

describe("密钥纪律", () => {
  test("token 不进响应、不进日志、不走 URL（只在 authorization 头里）", async () => {
    const { stub, service, logs } = makeService();
    const result = await service.illustrate(req("s1", "storm"));
    expect(JSON.stringify(result)).not.toContain(TOKEN);

    expect(stub.calls.length).toBe(1);
    const call = stub.calls[0]!;
    expect(call.url).not.toContain(TOKEN);
    expect(call.url).toContain("/accounts/acct-test-0001/ai/run/");
    expect(call.init.headers.authorization).toBe(`Bearer ${TOKEN}`);

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("acct-test-0001");
      expect(line).toMatch(/status=\d{3}|status=-/);
    }
  });
});

// ---------------------------------------------------------------- 路由

describe("POST /api/illustrate", () => {
  const config = loadConfig({ NODE_ENV: "development" });

  test("未被配置的服务端返回 200 + not-configured（不是 500/4xx）", async () => {
    const sessions = makeSessions("s-route");
    const { service } = makeService({ sessions, env: {} });
    const app = createApp({ config, sessions, illustrate: service });
    const response = await app.fetch(
      new Request("http://localhost/api/illustrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s-route", beatId: "storm", scene: "cafe_night" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: "not-configured" });
  });

  test("配好 env：第一张 ok、第二张同 prompt 走缓存", async () => {
    const sessions = makeSessions("s-route");
    const { service } = makeService({ sessions });
    const app = createApp({ config, sessions, illustrate: service });
    const post = async (): Promise<unknown> => {
      const response = await app.fetch(
        new Request("http://localhost/api/illustrate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: "s-route", beatId: "storm", scene: "cafe_night" }),
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = (await post()) as { ok: boolean; cached?: boolean; dataUrl?: string };
    expect(first.ok).toBe(true);
    expect(first.cached).toBe(false);
    expect(first.dataUrl?.startsWith("data:image/jpeg;base64,")).toBe(true);

    const second = (await post()) as { ok: boolean; cached?: boolean };
    expect(second.ok).toBe(true);
    expect(second.cached).toBe(true);
  });

  test("GET 不被接受（405），错误方法不会去烧上游", async () => {
    const sessions = makeSessions("s-route");
    const { service, stub } = makeService({ sessions });
    const app = createApp({ config, sessions, illustrate: service });
    const response = await app.fetch(new Request("http://localhost/api/illustrate"));
    expect(response.status).toBe(405);
    expect(stub.calls.length).toBe(0);
  });
});
