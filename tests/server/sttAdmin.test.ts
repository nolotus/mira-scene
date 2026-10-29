/**
 * 运行时 ASR 切换后台的测试：全部本地，不联网、不碰真 key。
 *
 * 钉住六件事：
 *  ① fail-closed：没配 ADMIN_TOKEN 时，页面与 API 一律 404
 *  ② token 不匹配 → 401，且响应体**不**回显正确的 token
 *  ③ 正确 token：GET 回 { active, options, recent }，POST 切换后 GET 确认已变
 *  ④ 切换是幂等的（切到当前模型不报错）；未知模型 → 400
 *  ⑤ 切换只影响**新开的**会话：新会话的 run-task 里就是新模型（老会话不变）
 *  ⑥ 最近识别：环形缓冲 10 条、只存内存、记 firstTextMs / finalMs
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import {
  STT_MODEL_OPTIONS,
  getActiveModel,
  openRecordingSttBridge,
  recentSttRecognitions,
  resetSttAdminState,
} from "../../src/server/sttAdmin.ts";
import type { BrowserSink, SttBridge, UpstreamConnect } from "../../src/server/stt.ts";
import type { StreamingEncoderFactory } from "../../src/server/aliStt.ts";

const TOKEN = "test-token-abc";
const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash-streaming";

function appWithToken(token: string | undefined) {
  // 配一个假 DASHSCOPE key：这样「默认模型」就是阿里那档（qwen-audio-3.0…），
  // 而不是没配 key 时回落的 Deepgram nova-2。
  const config = loadConfig({
    NODE_ENV: "development",
    ADMIN_TOKEN: token,
    DASHSCOPE_API_KEY: "fake-key",
  });
  return createApp({ config });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  resetSttAdminState();
});

describe("fail-closed：没配 ADMIN_TOKEN 一律 404", () => {
  test("API 的 GET / POST 都是 404", async () => {
    const app = appWithToken(undefined);
    const get = await app.fetch(new Request("http://localhost/api/stt/admin/config?token=whatever"));
    expect(get.status).toBe(404);
    const post = await app.fetch(
      new Request("http://localhost/api/stt/admin/config?token=whatever", {
        method: "POST",
        body: JSON.stringify({ model: "fun-asr-flash-2026-06-15" }),
      }),
    );
    expect(post.status).toBe(404);
  });

  test("后台页面也是 404（连 token 带上也不放行）", async () => {
    const app = appWithToken(undefined);
    const res = await app.fetch(new Request("http://localhost/admin?token=whatever"));
    expect(res.status).toBe(404);
  });
});

describe("鉴权", () => {
  test("无 token → 401；错 token → 401；响应体不回显正确的 token", async () => {
    const app = appWithToken(TOKEN);
    const noToken = await app.fetch(new Request("http://localhost/api/stt/admin/config"));
    expect(noToken.status).toBe(401);
    const wrong = await app.fetch(new Request("http://localhost/api/stt/admin/config?token=nope"));
    expect(wrong.status).toBe(401);
    const body = await wrong.text();
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("token");
  });

  test("页面：错 token → 401（且不回显正确 token）", async () => {
    const app = appWithToken(TOKEN);
    const res = await app.fetch(new Request("http://localhost/admin?token=nope"));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(TOKEN);
  });
});

describe("配置读写", () => {
  test("GET 回 active / options / recent", async () => {
    const app = appWithToken(TOKEN);
    const res = await app.fetch(new Request(`http://localhost/api/stt/admin/config?token=${TOKEN}`));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.active).toBe(DEFAULT_MODEL);
    expect((body.options as unknown[]).length).toBe(STT_MODEL_OPTIONS.length);
    expect(body.recent).toEqual([]);
  });

  test("POST 切换后 GET 确认已变；切到当前模型幂等", async () => {
    const app = appWithToken(TOKEN);
    const post = async (model: string): Promise<Response> =>
      app.fetch(
        new Request(`http://localhost/api/stt/admin/config?token=${TOKEN}`, {
          method: "POST",
          body: JSON.stringify({ model }),
        }),
      );

    const switched = await post("fun-asr-flash-2026-06-15");
    expect(switched.status).toBe(200);
    expect((await readJson(switched)).active).toBe("fun-asr-flash-2026-06-15");
    expect(getActiveModel()).toBe("fun-asr-flash-2026-06-15");

    const get = await app.fetch(new Request(`http://localhost/api/stt/admin/config?token=${TOKEN}`));
    expect((await readJson(get)).active).toBe("fun-asr-flash-2026-06-15");

    // 幂等：切到当前模型不报错
    const again = await post("fun-asr-flash-2026-06-15");
    expect(again.status).toBe(200);
    expect((await readJson(again)).active).toBe("fun-asr-flash-2026-06-15");
  });

  test("未知模型 → 400，且不改当前模型", async () => {
    const app = appWithToken(TOKEN);
    const res = await app.fetch(
      new Request(`http://localhost/api/stt/admin/config?token=${TOKEN}`, {
        method: "POST",
        body: JSON.stringify({ model: "not-a-model" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(getActiveModel()).toBe(null);
  });

  test("HTML 页面：服务端渲染，含当前模型、选项与「回到场景」链接", async () => {
    const app = appWithToken(TOKEN);
    const res = await app.fetch(new Request(`http://localhost/admin?token=${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain(DEFAULT_MODEL);
    for (const option of STT_MODEL_OPTIONS) expect(html).toContain(option.id);
    expect(html).toContain('href="/"');
    // 页面里除了 token 自身，不该出现别的东西
    expect(html).toContain("回到场景");
  });

  test("表单提交（浏览器那条路）→ 303 回后台页面", async () => {
    const app = appWithToken(TOKEN);
    const res = await app.fetch(
      new Request(`http://localhost/api/stt/admin/config?token=${TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ model: "qwen-audio-3.1-asr-flash-streaming" }).toString(),
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin?token=${TOKEN}`);
    expect(getActiveModel()).toBe("qwen-audio-3.1-asr-flash-streaming");
  });
});

describe("最近识别记录", () => {
  test("记录 firstTextMs / finalMs，只在内存里，环形上限 10 条", async () => {
    const sent: string[] = [];
    const sink: BrowserSink = {
      sendText: (payload) => sent.push(payload),
      close: () => {},
    };
    const bridge: SttBridge = {
      pushAudio: () => {},
      finishUtterance: () => {},
      clientClosed: () => {},
      closed: false,
      lastUpstreamType: null,
    };
    // 观测层把消息拦在**内侧**：这里要用它交给桥的那个 sink，不是原始 sink
    let inner: BrowserSink = sink;
    const recording = openRecordingSttBridge({
      sink,
      model: "fun-asr-flash-2026-06-15",
      open: (observed) => {
        inner = observed;
        return bridge;
      },
    });

    recording.pushAudio(new Uint8Array(100));
    await Bun.sleep(5);
    inner.sendText(JSON.stringify({ type: "interim", text: "你在这儿" }));
    await Bun.sleep(5);
    recording.finishUtterance();
    await Bun.sleep(5);
    inner.sendText(JSON.stringify({ type: "final", text: "你在这儿坐了很久了吧？" }));

    const recent = recentSttRecognitions();
    expect(recent.length).toBe(1);
    expect(recent[0]?.model).toBe("fun-asr-flash-2026-06-15");
    expect(recent[0]?.text).toBe("你在这儿坐了很久了吧？");
    expect(recent[0]?.firstTextMs).toBeGreaterThanOrEqual(0);
    expect(recent[0]?.finalMs).toBeGreaterThanOrEqual(0);
    expect(recent[0]?.at).toMatch(/^\d{2}:\d{2}:\d{2}$/);

    // 环形上限：再记 12 条，只留最近 10 条，且最新的在前
    for (let index = 0; index < 12; index += 1) {
      inner.sendText(JSON.stringify({ type: "final", text: `第${index}句` }));
    }
    const list = recentSttRecognitions();
    expect(list.length).toBe(10);
    expect(list[0]?.text).toBe("第11句");
  });
});

describe("切换只影响新开的会话", () => {
  test("切换后新会话的 run-task 用的是新模型，老会话不变", async () => {
    const runTasks: string[] = [];
    const connect: UpstreamConnect = () => {
      const socket = {
        send: (data: string) => {
          runTasks.push(data);
        },
        close: () => {},
        onopen: null as (() => void) | null,
        onmessage: null as ((event: { data: string }) => void) | null,
        onclose: null as (() => void) | null,
        onerror: null as ((event: unknown) => void) | null,
      };
      // 建连后立刻 open：上游随后收到 run-task（里面带模型名）
      queueMicrotask(() => socket.onopen?.());
      return socket as never;
    };

    // 假转码器：写一块就吐一块 PCM（不 spawn ffmpeg）
    const fakeStreamEncoder: StreamingEncoderFactory = () => {
      let onData: ((chunk: Uint8Array) => void) | null = null;
      return {
        write: () => {
          onData?.(new Uint8Array(3200));
        },
        finish: async () => ({ ok: true, code: 0, detail: "" }),
        kill: () => {},
        onData: (cb) => {
          onData = cb;
        },
        onError: () => {},
      };
    };

    const config = loadConfig({
      NODE_ENV: "development",
      ADMIN_TOKEN: TOKEN,
      DASHSCOPE_API_KEY: "fake-key",
    });
    const app = createApp({ config, sttConnect: connect, sttStreamEncoder: fakeStreamEncoder });

    // 会话 A：默认模型（第一块音频到达才建 task）
    const sessionA = app.openSttStream({ sendText: () => {}, close: () => {} }, { lang: "zh-CN" });
    sessionA?.pushAudio(new Uint8Array(64));
    await Bun.sleep(30);
    expect(runTasks.length).toBeGreaterThan(0);
    expect(runTasks[0]).toContain(DEFAULT_MODEL);

    // 切模型
    const post = await app.fetch(
      new Request(`http://localhost/api/stt/admin/config?token=${TOKEN}`, {
        method: "POST",
        body: JSON.stringify({ model: "fun-asr-realtime-2026-02-28" }),
      }),
    );
    expect(post.status).toBe(200);

    // 老会话不受影响：它已经用旧模型建好 task 了
    sessionA?.pushAudio(new Uint8Array(64));
    await Bun.sleep(20);
    expect(runTasks.every((task) => task.includes(DEFAULT_MODEL))).toBe(true);

    // 新会话用新模型
    const sessionB = app.openSttStream({ sendText: () => {}, close: () => {} }, { lang: "zh-CN" });
    sessionB?.pushAudio(new Uint8Array(64));
    await Bun.sleep(30);
    const last = runTasks[runTasks.length - 1];
    expect(last).toContain("fun-asr-realtime-2026-02-28");

    // 状态接口也报新模型
    const status = await app.fetch(new Request("http://localhost/api/voice/status"));
    expect((await readJson(status)).sttModel).toBe("fun-asr-realtime-2026-02-28");
  });
});
