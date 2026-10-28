/**
 * 按会话切换导演：解析 → 回落 → 会话级固化。
 *
 * 钉住四件事：
 * ① `?director=` 只认 live / mock，别的一律当「没指定」；
 * ② 无 key 时请求 live 也温和回落 Mock，并把原因说清楚（keyless 诚实为 true）；
 * ③ `DIRECTOR=mock` 是强制档，URL 请求 live 也无效，原因记 forced-mock；
 * ④ 档位在**建会话时**定下，之后每轮 turn 都用同一个导演（不重读 URL / env）。
 *
 * 用 directorFactory 注入带名字的假导演，就能直接断言「这一轮是哪个档位在演」，
 * 不需要真去打模型。
 */
import { describe, expect, test } from "bun:test";
import { createApp, type App } from "../../src/server/app.ts";
import { loadConfig, type ServerConfig } from "../../src/server/config.ts";
import { MockDirector } from "../../src/server/director/mock.ts";
import { resolveDirectorMode } from "../../src/server/director/resolve.ts";
import { parseDirectorRequest } from "../../src/shared/director.ts";
import type { Director, DirectorInput, SessionEvent, SessionInfo } from "../../src/shared/protocol.ts";

/** 带名字的假导演：记下自己接过哪些 turn，内部用 Mock 出事件（零网络） */
class TaggedDirector implements Director {
  readonly seen: DirectorInput[] = [];
  readonly #inner = new MockDirector({ delayScale: 0 });

  constructor(readonly name: string) {}

  async *stream(input: DirectorInput, signal: AbortSignal): AsyncIterable<SessionEvent> {
    this.seen.push(input);
    yield* this.#inner.stream(input, signal);
  }
}

function appWithTaggedDirectors(config: ServerConfig): { app: App; made: Map<string, TaggedDirector> } {
  const made = new Map<string, TaggedDirector>();
  const app = createApp({
    config,
    directorFactory: (mode) => {
      const director = new TaggedDirector(`${mode}-tagged`);
      made.set(mode, director);
      return director;
    },
  });
  return { app, made };
}

async function postSession(app: App, search = "", body: Record<string, unknown> = {}): Promise<SessionInfo> {
  const response = await app.fetch(
    new Request(`http://localhost/api/session${search}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as SessionInfo;
}

function turnBody(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId,
    turnId: "turn-1",
    epoch: 1,
    userText: "外面雨好大",
    scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
    history: [],
    ...overrides,
  };
}

async function drain(response: Response): Promise<SessionEvent[]> {
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return (await response.text())
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => JSON.parse(chunk.slice(6)) as SessionEvent);
}

async function postTurn(app: App, body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const PLACEHOLDER_KEY = "placeholder-not-a-real-key";

describe("parseDirectorRequest：只认 live / mock", () => {
  test("大小写与空白不敏感", () => {
    expect(parseDirectorRequest("live")).toBe("live");
    expect(parseDirectorRequest(" LIVE ")).toBe("live");
    expect(parseDirectorRequest("Mock")).toBe("mock");
  });

  test("其它一切（含空/缺省/数字）都当没指定，不静默变 live", () => {
    for (const raw of [null, undefined, "", "  ", "1", "true", "on", "lives", "live "]) {
      if (raw === "live ") continue; // 尾随空白是允许的
      expect(parseDirectorRequest(raw)).toBeNull();
    }
  });
});

describe("resolveDirectorMode：请求 × 环境 × 有无 key", () => {
  const noKey = { envMode: null, liveAvailable: false };
  const withKey = { envMode: null, liveAvailable: true };

  test("无 key：请求 live 回落 no-llm-config；不指定则默认 mock 且无回落原因", () => {
    expect(resolveDirectorMode("live", noKey)).toEqual({ mode: "mock", reason: "no-llm-config" });
    expect(resolveDirectorMode(null, noKey)).toEqual({ mode: "mock", reason: null });
  });

  test("有 key：请求 live 就是 live；不指定仍默认 mock", () => {
    expect(resolveDirectorMode("live", withKey)).toEqual({ mode: "live", reason: null });
    expect(resolveDirectorMode(null, withKey)).toEqual({ mode: "mock", reason: null });
    expect(resolveDirectorMode("mock", withKey)).toEqual({ mode: "mock", reason: null });
  });

  test("DIRECTOR=live 让所有会话默认 live；没 key 时同样温和回落", () => {
    expect(resolveDirectorMode(null, { envMode: "live", liveAvailable: true })).toEqual({
      mode: "live",
      reason: null,
    });
    expect(resolveDirectorMode(null, { envMode: "live", liveAvailable: false })).toEqual({
      mode: "mock",
      reason: "no-llm-config",
    });
  });

  test("DIRECTOR=mock 强制：URL 请求 live 也无效，原因 forced-mock", () => {
    expect(resolveDirectorMode("live", { envMode: "mock", liveAvailable: true })).toEqual({
      mode: "mock",
      reason: "forced-mock",
    });
    // 没请求 live 就不必挂回落原因
    expect(resolveDirectorMode(null, { envMode: "mock", liveAvailable: true })).toEqual({
      mode: "mock",
      reason: null,
    });
  });
});

describe("POST /api/session · 档位落点", () => {
  test("无 LLM env：?director=live 回落 mock，keyless=true，原因 no-llm-config，且 turn 照常出事件", async () => {
    const { app, made } = appWithTaggedDirectors(loadConfig({ NODE_ENV: "development" }));
    const info = await postSession(app, "?director=live");

    expect(info.mode).toBe("mock");
    expect(info.keyless).toBe(true);
    expect(info.fallbackReason).toBe("no-llm-config");
    expect(info.directorName).toBe("mock-tagged");

    const events = await drain(await postTurn(app, turnBody(info.sessionId)));
    expect(events[0]?.type).toBe("turn.start");
    expect(events[events.length - 1]?.type).toBe("turn.end");
    expect(made.get("mock")?.seen.length).toBe(1);
  });

  test("有 LLM env（占位 key）：?director=live 得 live，不带参数得 mock", async () => {
    const { app } = appWithTaggedDirectors(
      loadConfig({ NODE_ENV: "development", MIRA_LLM_API_KEY: PLACEHOLDER_KEY }),
    );

    const live = await postSession(app, "?director=live");
    expect(live.mode).toBe("live");
    expect(live.keyless).toBe(false);
    expect(live.fallbackReason).toBeNull();
    expect(live.directorName).toBe("live-tagged");

    const plain = await postSession(app);
    expect(plain.mode).toBe("mock");
    expect(plain.keyless).toBe(true);
    expect(plain.fallbackReason).toBeNull();
  });

  test("DIRECTOR=mock：?director=live 回落 mock，原因 forced-mock", async () => {
    const { app } = appWithTaggedDirectors(
      loadConfig({ NODE_ENV: "development", DIRECTOR: "mock", MIRA_LLM_API_KEY: PLACEHOLDER_KEY }),
    );
    const info = await postSession(app, "?director=live");
    expect(info.mode).toBe("mock");
    expect(info.fallbackReason).toBe("forced-mock");
  });

  test("DIRECTOR=live：不带参数也默认 live", async () => {
    const { app } = appWithTaggedDirectors(
      loadConfig({ NODE_ENV: "development", DIRECTOR: "live", MIRA_LLM_API_KEY: PLACEHOLDER_KEY }),
    );
    const info = await postSession(app);
    expect(info.mode).toBe("live");
    expect(info.fallbackReason).toBeNull();
  });
});

describe("档位跟着会话走", () => {
  test("建会话后每轮 turn 都用该会话的导演；再次建同名会话不改写档位", async () => {
    const { app, made } = appWithTaggedDirectors(
      loadConfig({ NODE_ENV: "development", MIRA_LLM_API_KEY: PLACEHOLDER_KEY }),
    );

    const live = await postSession(app, "?director=live");
    const mock = await postSession(app, "?director=mock");
    expect(live.mode).toBe("live");
    expect(mock.mode).toBe("mock");

    await drain(await postTurn(app, turnBody(live.sessionId, { turnId: "t-live-1", epoch: 1 })));
    await drain(await postTurn(app, turnBody(live.sessionId, { turnId: "t-live-2", epoch: 2 })));
    await drain(await postTurn(app, turnBody(mock.sessionId, { turnId: "t-mock-1", epoch: 1 })));

    expect(made.get("live")?.seen.map((input) => input.turnId)).toEqual(["t-live-1", "t-live-2"]);
    expect(made.get("mock")?.seen.map((input) => input.turnId)).toEqual(["t-mock-1"]);

    // 同名会话再建一次：URL 说什么都不算，档位仍是最初那份
    const again = await postSession(app, "?director=mock", { sessionId: live.sessionId });
    expect(again.mode).toBe("live");
    expect(again.fallbackReason).toBeNull();
  });

  test("没先建会话就发 turn（老客户端）：按服务端默认档位跑，不炸", async () => {
    const { app, made } = appWithTaggedDirectors(loadConfig({ NODE_ENV: "development" }));
    const events = await drain(await postTurn(app, turnBody("sess-orphan")));
    expect(events[0]?.type).toBe("turn.start");
    expect(events[events.length - 1]?.type).toBe("turn.end");
    expect(app.sessions.directorOf("sess-orphan")).toEqual({ mode: "mock", reason: null });
    expect(made.get("mock")?.seen.length).toBe(1);
  });
});
