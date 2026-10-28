/**
 * HTTP / SSE 层测试：
 * ① turn 一定以 turn.end 收尾  ② 事件 epoch 原样回显  ③ cancel 能打断在跑的 turn
 * ④ 服务端自持历史会合并进 DirectorInput.history  ⑤ 参数错误不炸服务
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createApp, type App } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { MockDirector } from "../../src/server/director/mock.ts";
import type { CancelResult, Director, DirectorInput, SessionEvent, SessionInfo } from "../../src/shared/protocol.ts";

/** 记录导演拿到的输入，用来验证历史合并 */
class RecordingDirector implements Director {
  readonly name = "recording-mock";
  readonly inputs: DirectorInput[] = [];
  readonly #inner = new MockDirector({ delayScale: 0 });

  async *stream(input: DirectorInput, signal: AbortSignal): AsyncIterable<SessionEvent> {
    this.inputs.push(input);
    yield* this.#inner.stream(input, signal);
  }
}

const testConfig = loadConfig({ NODE_ENV: "development" });

function frame(event: SessionEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function parseFrames(text: string): SessionEvent[] {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      expect(chunk.startsWith("data: ")).toBe(true);
      return JSON.parse(chunk.slice(6)) as SessionEvent;
    });
}

function turnBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    epoch: 7,
    userText: "外面雨好大",
    scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
    history: [],
    ...overrides,
  };
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

async function readAll(response: Response): Promise<SessionEvent[]> {
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return parseFrames(await response.text());
}

describe("GET /api/health", () => {
  test("返回 ok", async () => {
    const app = createApp({ config: testConfig });
    const response = await app.fetch(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("POST /api/session", () => {
  test("无密钥环境返回 mock + keyless=true", async () => {
    const app = createApp({ config: loadConfig({ NODE_ENV: "development" }) });
    const response = await app.fetch(
      new Request("http://localhost/api/session", { method: "POST", body: JSON.stringify({ sessionId: "sess-a" }) }),
    );
    expect(response.status).toBe(200);
    const info = (await response.json()) as SessionInfo;
    expect(info.sessionId).toBe("sess-a");
    expect(info.mode).toBe("mock");
    expect(info.keyless).toBe(true);
    expect(info.directorName.length).toBeGreaterThan(0);
  });

  test("没给 sessionId 时自动生成一个", async () => {
    const app = createApp({ config: testConfig });
    const response = await app.fetch(new Request("http://localhost/api/session", { method: "POST" }));
    const info = (await response.json()) as SessionInfo;
    expect(info.sessionId.length).toBeGreaterThan(8);
  });
});

describe("POST /api/turn · SSE", () => {
  let app: App;
  let director: RecordingDirector;

  beforeEach(() => {
    director = new RecordingDirector();
    app = createApp({ config: testConfig, director });
  });

  test("以 turn.start 开头、turn.end 收尾，且 epoch 原样回显", async () => {
    const response = await postTurn(app, turnBody());
    expect(response.status).toBe(200);
    const events = await readAll(response);

    expect(events.length).toBeGreaterThan(3);
    expect(events[0]?.type).toBe("turn.start");
    expect(events[events.length - 1]?.type).toBe("turn.end");

    for (const event of events) expect(event.epoch).toBe(7);

    const end = events[events.length - 1];
    expect(end?.type === "turn.end" ? end.interrupted : true).toBe(false);
    expect(end?.type === "turn.end" ? typeof end.timings?.total : "missing").toBe("number");

    // 中间既有台词也有结构化指令
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
    expect(events.some((event) => event.type === "directive")).toBe(true);
  });

  test("服务端自持历史会合并进第二轮 DirectorInput.history", async () => {
    await readAll(await postTurn(app, turnBody({ turnId: "turn-1", userText: "你好" })));
    await readAll(
      await postTurn(app, turnBody({ turnId: "turn-2", epoch: 8, userText: "你在等谁啊", history: [] })),
    );

    expect(director.inputs.length).toBe(2);
    const second = director.inputs[1];
    expect(second?.history.length).toBeGreaterThanOrEqual(2);
    expect(second?.history[0]).toEqual({ role: "user", text: "你好" });
    expect(second?.history[1]?.role).toBe("character");
    expect(second?.epoch).toBe(8);
  });

  test("非法 body 返回 400，不进入 SSE", async () => {
    const missing = await postTurn(app, { sessionId: "s", userText: "hi" });
    expect(missing.status).toBe(400);

    const badEpoch = await postTurn(app, turnBody({ epoch: "seven" }));
    expect(badEpoch.status).toBe(400);
  });

  test("导演抛错时也会发 turn.end，不会挂住客户端", async () => {
    const broken: Director = {
      name: "broken",
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<SessionEvent> {
        throw new Error("boom");
      },
    };
    const brokenApp = createApp({ config: testConfig, director: broken });
    const events = await readAll(await postTurn(brokenApp, turnBody({ turnId: "turn-broken" })));

    expect(events[0]?.type).toBe("turn.start");
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events[events.length - 1]?.type).toBe("turn.end");
  });
});

describe("POST /api/turn/:turnId/cancel", () => {
  test("打断在跑的 turn：turn.end.interrupted = true", async () => {
    // 略慢的节奏，保证 cancel 落在流中间
    const app = createApp({ config: testConfig, director: new MockDirector({ delayScale: 0.1 }) });
    const response = await postTurn(app, turnBody({ turnId: "turn-cancel", epoch: 3 }));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const decoder = new TextDecoder();
    const events: SessionEvent[] = [];
    let buffer = "";
    let cancelResult: CancelResult | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const chunk of frames) {
        if (!chunk.trim()) continue;
        events.push(JSON.parse(chunk.replace(/^data: /, "")) as SessionEvent);

        if (!cancelResult) {
          const cancelResponse = await app.fetch(
            new Request("http://localhost/api/turn/turn-cancel/cancel", { method: "POST" }),
          );
          expect(cancelResponse.status).toBe(200);
          cancelResult = (await cancelResponse.json()) as CancelResult;
        }
      }
    }

    expect(cancelResult).not.toBeNull();
    expect(cancelResult?.cancelled).toBe(true);
    expect(cancelResult?.epoch).toBe(3);

    const last = events[events.length - 1];
    expect(last?.type).toBe("turn.end");
    expect(last?.type === "turn.end" ? last.interrupted : false).toBe(true);
    // 被打断的 turn 不该把整段台词都演完
    expect(events.filter((event) => event.type === "text.delta").length).toBeLessThan(24);
  });

  test("打断不存在的 turn 返回 cancelled=false", async () => {
    const app = createApp({ config: testConfig });
    const response = await app.fetch(new Request("http://localhost/api/turn/nope/cancel", { method: "POST" }));
    const result = (await response.json()) as CancelResult;
    expect(result.cancelled).toBe(false);
  });
});

describe("GET /api/session/:id", () => {
  test("返回该会话的历史（供回放/调试）", async () => {
    const app = createApp({ config: testConfig, director: new MockDirector({ delayScale: 0 }) });
    const events = await readAll(await postTurn(app, turnBody({ sessionId: "sess-history" })));
    const spoken = events
      .flatMap((event) => (event.type === "text.delta" ? [event.text] : []))
      .join("");

    const response = await app.fetch(new Request("http://localhost/api/session/sess-history"));
    expect(response.status).toBe(200);
    const record = (await response.json()) as {
      sessionId: string;
      messages: Array<{ role: string; text: string }>;
      turns: number;
    };

    expect(record.sessionId).toBe("sess-history");
    expect(record.messages.length).toBe(2);
    expect(record.messages[0]).toMatchObject({ role: "user", text: "外面雨好大" });
    expect(record.messages[1]).toMatchObject({ role: "character", text: spoken });
    expect(record.turns).toBe(1);
  });

  test("未知会话 404", async () => {
    const app = createApp({ config: testConfig });
    const response = await app.fetch(new Request("http://localhost/api/session/nobody"));
    expect(response.status).toBe(404);
  });
});

describe("CORS", () => {
  test("开发模式放行 localhost:5173，预检直接 204", async () => {
    const app = createApp({ config: testConfig });
    const preflight = await app.fetch(
      new Request("http://localhost/api/turn", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const session = await app.fetch(
      new Request("http://localhost/api/session", {
        method: "POST",
        headers: { origin: "http://localhost:5173" },
        body: JSON.stringify({ sessionId: "sess-cors" }),
      }),
    );
    expect(session.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  test("生产模式不加 CORS 头", async () => {
    const app = createApp({ config: loadConfig({ NODE_ENV: "production" }) });
    const response = await app.fetch(
      new Request("http://localhost/api/health", { headers: { origin: "http://localhost:5173" } }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("SSE 帧格式", () => {
  test("每条事件都是 `data: <json>\\n\\n`", async () => {
    const app = createApp({ config: testConfig, director: new MockDirector({ delayScale: 0 }) });
    const response = await postTurn(app, turnBody({ turnId: "turn-frames" }));
    const text = await response.text();
    const frames = text.split("\n\n").filter((chunk) => chunk.trim().length > 0);
    expect(frames.length).toBeGreaterThan(2);
    for (const chunk of frames) {
      expect(chunk.startsWith("data: ")).toBe(true);
      const parsed = JSON.parse(chunk.slice(6)) as SessionEvent;
      expect(typeof parsed.type).toBe("string");
      expect(frame(parsed).startsWith("data: ")).toBe(true);
    }
  });
});
