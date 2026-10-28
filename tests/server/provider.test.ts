/**
 * 真模型 provider 的选型与解析：
 * 优先级（MIRA_LLM_* > DEEPSEEK_API_KEY > keyless）、
 * mode 只由「显式 DIRECTOR=live 且解析到 key」决定，以及密钥不外泄。
 *
 * 这里所有 key 都是假值，绝不发真实网络请求（唯一的上游测试指向本机不可达端口）。
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import { LLM_DEFAULTS, loadConfig, resolveLlmProvider } from "../../src/server/config.ts";
import { LiveDirector, createDirector } from "../../src/server/director/index.ts";
import { MockDirector } from "../../src/server/director/mock.ts";
import type { DirectorInput, SessionEvent } from "../../src/shared/protocol.ts";

const FAKE_DEEPSEEK = "sk-deepseek-fake-for-tests";
const FAKE_CUSTOM = "sk-custom-fake-for-tests";

const input: DirectorInput = {
  userText: "你好",
  scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
  history: [],
  turnId: "turn-live",
  epoch: 5,
};

describe("resolveLlmProvider", () => {
  test("没有任何 key → null（keyless 是正常状态）", () => {
    expect(resolveLlmProvider({})).toBeNull();
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.llm).toBeNull();
    expect(config.directorMode).toBe("mock");
  });

  test("DEEPSEEK_API_KEY → deepseek 默认配置（api.deepseek.com + deepseek-chat）", () => {
    const provider = resolveLlmProvider({ DEEPSEEK_API_KEY: FAKE_DEEPSEEK });
    expect(provider?.id).toBe("deepseek");
    expect(provider?.baseUrl).toBe("https://api.deepseek.com");
    expect(provider?.model).toBe("deepseek-chat");
    expect(provider?.model).toBe(LLM_DEFAULTS.deepseek.model);
    expect(provider?.label).not.toContain(FAKE_DEEPSEEK);
  });

  test("MIRA_LLM_* 显式覆盖优先级最高", () => {
    const provider = resolveLlmProvider({
      MIRA_LLM_API_KEY: FAKE_CUSTOM,
      MIRA_LLM_BASE_URL: "https://llm.internal.example/v1/",
      MIRA_LLM_MODEL: "my-instruct-model",
      DEEPSEEK_API_KEY: FAKE_DEEPSEEK,
    });
    expect(provider?.id).toBe("custom");
    expect(provider?.baseUrl).toBe("https://llm.internal.example/v1");
    expect(provider?.model).toBe("my-instruct-model");
    expect(provider?.apiKey).toBe(FAKE_CUSTOM);
  });

  test("只给 MIRA_LLM_BASE_URL/MODEL 但没有 key → 不算覆盖", () => {
    expect(resolveLlmProvider({ MIRA_LLM_BASE_URL: "https://x.example", MIRA_LLM_MODEL: "m" })).toBeNull();
  });

  test("空白 key 视作没有", () => {
    expect(resolveLlmProvider({ DEEPSEEK_API_KEY: "   " })).toBeNull();
  });
});

describe("mode 规则", () => {
  test("有 key 但没显式 DIRECTOR=live → 仍然 mock", () => {
    const config = loadConfig({ NODE_ENV: "development", DEEPSEEK_API_KEY: FAKE_DEEPSEEK });
    expect(config.llm?.id).toBe("deepseek");
    expect(config.directorMode).toBe("mock");
    expect(createDirector(config)).toBeInstanceOf(MockDirector);
  });

  test("DIRECTOR=live 但没有 key → 回退 mock（不是错误）", () => {
    const config = loadConfig({ NODE_ENV: "development", DIRECTOR: "live" });
    expect(config.directorMode).toBe("mock");
    expect(createDirector(config)).toBeInstanceOf(MockDirector);
  });

  test("DIRECTOR=live + key → LiveDirector，名字里不含密钥", () => {
    const config = loadConfig({ NODE_ENV: "development", DIRECTOR: "live", DEEPSEEK_API_KEY: FAKE_DEEPSEEK });
    expect(config.directorMode).toBe("live");
    const director = createDirector(config);
    expect(director).toBeInstanceOf(LiveDirector);
    expect(director.name).toBe("live-deepseek");
    expect(director.name).not.toContain(FAKE_DEEPSEEK);
  });
});

describe("密钥不外泄", () => {
  test("/api/session 的响应里不出现任何 key", async () => {
    const config = loadConfig({ NODE_ENV: "development", DIRECTOR: "live", DEEPSEEK_API_KEY: FAKE_DEEPSEEK });
    const app = createApp({ config });
    const response = await app.fetch(new Request("http://localhost/api/session", { method: "POST", body: "{}" }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(FAKE_DEEPSEEK);
    const info = JSON.parse(text) as { mode: string; keyless: boolean; directorName: string };
    expect(info.mode).toBe("live");
    // 当前生效的是真模型 → 不是 keyless
    expect(info.keyless).toBe(false);
    expect(info.directorName).toBe("live-deepseek");
  });

  test("keyless 时 keyless=true、mode=mock", async () => {
    const app = createApp({ config: loadConfig({ NODE_ENV: "development" }) });
    const response = await app.fetch(new Request("http://localhost/api/session", { method: "POST", body: "{}" }));
    const info = (await response.json()) as { mode: string; keyless: boolean };
    expect(info).toMatchObject({ mode: "mock", keyless: true });
  });
});

describe("LiveDirector · 上游不可用时的优雅降级", () => {
  test("连不上上游 → 发 recoverable error 后结束，不 hang", async () => {
    // 指向本机不可达端口，确定性地失败
    const director = new LiveDirector({
      apiKey: FAKE_DEEPSEEK,
      baseUrl: "http://127.0.0.1:1",
      model: "deepseek-chat",
      label: "deepseek",
      timeoutMs: 800,
    });

    const events: SessionEvent[] = [];
    const startedAt = performance.now();
    for await (const event of director.stream(input, new AbortController().signal)) {
      events.push(event);
    }
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(3000);
    expect(events.length).toBe(1);
    const [only] = events;
    expect(only?.type).toBe("error");
    expect(only?.type === "error" ? only.recoverable : false).toBe(true);
    expect(only?.epoch).toBe(5);
    // 错误消息里不能带出密钥
    expect(only?.type === "error" ? only.message : "").not.toContain(FAKE_DEEPSEEK);
  });
});
