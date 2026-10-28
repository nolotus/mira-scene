/**
 * 客户端 `?director=` → 请求体的映射。
 *
 * 三件事：
 * ① URL 解析：live / mock 才认，其它当没指定（与 ui/demo.ts 的 ?demo= 解析同一风格）；
 * ② HTTP 层：请求的档位真的拼到 `POST /api/session?director=`，回落原因原样带回（脏值归 null）；
 * ③ store：建会话时把档位转交出去，回落时出 warn 条幅 —— 不许静默。
 */
import { describe, expect, test } from "bun:test";
import type { CreateSessionOptions, HealthInfo, SessionApi, StreamOptions, TurnStreamHandlers } from "../../src/web/state/api";
import { createHttpApi } from "../../src/web/state/api";
import { readDirectorRequest, SessionStore } from "../../src/web/state/store";
import { parseDemoFlag, withDemoApi } from "../../src/web/ui/demo";
import type { SessionInfo, TurnRequest } from "../../src/shared/protocol";
import type { TTSProvider } from "../../src/web/voice/tts";

/** 拦掉真实网络：只记下被请求的 URL，回一份会话信息 */
function stubFetch(payload: Record<string, unknown>): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

class FakeTts implements TTSProvider {
  readonly name = "fake-tts";
  get isSpeaking(): boolean {
    return false;
  }
  speak(): void {}
  flush(): void {}
  cancel(): void {}
  dispose(): void {}
}

/** 只关心 createSession 的假 API（其余方法留空实现） */
class CaptureApi implements SessionApi {
  readonly sessionOptions: Array<CreateSessionOptions | undefined> = [];

  constructor(private readonly info: SessionInfo | null = null) {}

  async health(): Promise<HealthInfo> {
    return { ok: true, mode: "mock" };
  }

  async createSession(_signal?: AbortSignal, options?: CreateSessionOptions): Promise<SessionInfo> {
    this.sessionOptions.push(options);
    return (
      this.info ?? { sessionId: "s-1", mode: "mock", directorName: "mock", keyless: true, fallbackReason: null }
    );
  }

  streamTurn(_req: TurnRequest, _handlers: TurnStreamHandlers, _opts?: StreamOptions): Promise<void> {
    return Promise.resolve();
  }

  async cancelTurn(_turnId: string, _epoch: number) {
    return { cancelled: false, epoch: 0 };
  }
}

describe("readDirectorRequest：location.search → 档位", () => {
  test("live / mock 认得，其它当没指定", () => {
    expect(readDirectorRequest("?director=live")).toBe("live");
    expect(readDirectorRequest("?director=Live")).toBe("live");
    expect(readDirectorRequest("?director=mock")).toBe("mock");
    expect(readDirectorRequest("")).toBeNull();
    expect(readDirectorRequest("?director=")).toBeNull();
    expect(readDirectorRequest("?director=1")).toBeNull();
    expect(readDirectorRequest("?foo=bar")).toBeNull();
  });

  test("与 ?demo= 共存时互不影响（demo 的解析没被写坏）", () => {
    expect(readDirectorRequest("?demo=fail&director=live")).toBe("live");
    expect(readDirectorRequest("?demo=fail")).toBeNull();
    expect(parseDemoFlag("?demo=fail&director=live").faults).toEqual(["turn"]);
    expect(parseDemoFlag("?director=live").active).toBe(false);
  });
});

describe("createSession：档位拼进 query", () => {
  test("请求 live → /api/session?director=live，回落原因原样带回", async () => {
    const stub = stubFetch({
      sessionId: "s-1",
      mode: "mock",
      directorName: "mock",
      keyless: true,
      fallbackReason: "no-llm-config",
    });
    try {
      const info = await createHttpApi().createSession(undefined, { director: "live" });
      expect(stub.calls).toEqual(["/api/session?director=live"]);
      expect(info.mode).toBe("mock");
      expect(info.keyless).toBe(true);
      expect(info.fallbackReason).toBe("no-llm-config");
    } finally {
      stub.restore();
    }
  });

  test("不指定档位 → 不带 query；无法识别的回落值归一化为 null", async () => {
    const stub = stubFetch({
      sessionId: "s-2",
      mode: "mock",
      directorName: "mock",
      keyless: true,
      fallbackReason: "something-else",
    });
    try {
      const info = await createHttpApi().createSession();
      expect(stub.calls).toEqual(["/api/session"]);
      expect(info.fallbackReason).toBeNull();
    } finally {
      stub.restore();
    }
  });

  test("?demo= 的包装层不会把 director 吃掉", async () => {
    const api = new CaptureApi();
    const wrapped = withDemoApi(api, parseDemoFlag("?demo=fail"));
    await wrapped.createSession(undefined, { director: "live" });
    expect(api.sessionOptions).toEqual([{ director: "live" }]);
  });
});

describe("store：建会话时代上档位", () => {
  test("directorRequest 透传给 createSession", async () => {
    const api = new CaptureApi();
    const store = new SessionStore({ api, tts: new FakeTts(), audioMode: "browser", directorRequest: "live" });
    await store.init();
    expect(api.sessionOptions).toEqual([{ director: "live" }]);
  });

  test("回落时不静默：warn 条幅说明「请求了真模型但回落成 Mock」及原因", async () => {
    const api = new CaptureApi({
      sessionId: "s-3",
      mode: "mock",
      directorName: "mock",
      keyless: true,
      fallbackReason: "no-llm-config",
    });
    const store = new SessionStore({ api, tts: new FakeTts(), audioMode: "browser", directorRequest: "live" });
    await store.init();

    const view = store.getSnapshot();
    expect(view.session?.fallbackReason).toBe("no-llm-config");
    expect(view.banner?.tone).toBe("warn");
    expect(view.banner?.text).toContain("你请求了真模型");
    expect(view.banner?.text).toContain("未配置密钥");
  });

  test("没有回落时保持原来的 info 条幅（不误报）", async () => {
    const store = new SessionStore({
      api: new CaptureApi(),
      tts: new FakeTts(),
      audioMode: "browser",
      directorRequest: null,
    });
    await store.init();
    const view = store.getSnapshot();
    expect(view.banner?.tone).toBe("info");
    expect(view.banner?.text).toContain("已连接");
  });
});
