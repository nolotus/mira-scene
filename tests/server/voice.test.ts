/**
 * 语音服务端测试：全部 stub，不联网、不碰真 key。
 *
 * 钉住四件事：
 *  ① /api/voice/status 如实反映 env（无 key → 两个 false，是正常态不是错误）
 *  ② /api/tts：中文在发上游**之前**就被 400 拦掉；英文转发时 URL/头部/body 都对
 *  ③ Deepgram 原始 payload → 精简消息的纯函数（interim / final / SpeechStarted / UtteranceEnd / 空结果）
 *  ④ 桥：预热期的帧要排队、闭合要清另一侧、没配 key 时 WS 门禁回 503
 */
import { describe, expect, test } from "bun:test";
import { createApp, sttUpgradeGate, type VoiceStatus } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import {
  FLUSH_TIMEOUT_MS,
  createSttBridge,
  parseSttControl,
  sttUpstreamUrl,
  toClientMessage,
  type SttClientMessage,
  type UpstreamSocket,
} from "../../src/server/stt.ts";
import { createTtsProxy, upstreamSpeakUrl, type TtsFetch } from "../../src/server/tts.ts";

const FAKE_KEY = "dg-voice-test-key";

function appWithVoice(env: Record<string, string | undefined>, ttsFetch?: TtsFetch) {
  const config = loadConfig({ NODE_ENV: "development", ...env });
  const tts = createTtsProxy({
    config: config.deepgram ? { apiKey: config.deepgram.apiKey } : null,
    fetch: ttsFetch,
    log: () => {},
  });
  return { app: createApp({ config, tts }), config };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------- status

describe("GET /api/voice/status", () => {
  test("没有 key：stt / tts 都是 false（正常态，200 不是错误）", async () => {
    const { app } = appWithVoice({});
    expect(app.voice).toEqual({
      stt: false,
      tts: false,
      sttModel: "nova-2",
      // 没注入 Edge 桩、也没探测 → 中文合成不可用（回退浏览器，正常态）
      ttsZh: false,
    } satisfies VoiceStatus);
    const res = await app.fetch(new Request("http://localhost/api/voice/status"));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ stt: false, tts: false, sttModel: "nova-2", ttsZh: false });
  });

  test("有 key：stt / tts 都是 true，模型固定 nova-2（中文只有它能用）", async () => {
    const { app } = appWithVoice({ DEEPGRAM_API_KEY: FAKE_KEY });
    const res = await app.fetch(new Request("http://localhost/api/voice/status"));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ stt: true, tts: true, sttModel: "nova-2", ttsZh: false });
  });

  test("POST 不被接受（405）", async () => {
    const { app } = appWithVoice({});
    const res = await app.fetch(new Request("http://localhost/api/voice/status", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  test("响应体里没有 key 的任何痕迹", async () => {
    const { app } = appWithVoice({ DEEPGRAM_API_KEY: FAKE_KEY });
    const body = await (await app.fetch(new Request("http://localhost/api/voice/status"))).text();
    expect(body.includes(FAKE_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------- TTS

describe("POST /api/tts", () => {
  test("中文 400 unsupported-language，且绝不碰上游", async () => {
    let calls = 0;
    const { app } = appWithVoice({ DEEPGRAM_API_KEY: FAKE_KEY }, async () => {
      calls += 1;
      throw new Error("上游不该被调用");
    });
    const res = await app.fetch(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "外面还在下雨吗" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await readJson(res)).toEqual({ reason: "unsupported-language" });
    expect(calls).toBe(0);
  });

  test("英文转发：URL / Token 头 / body 都对，回 MP3 字节", async () => {
    const seen: Array<{ url: string; init: Parameters<TtsFetch>[1] }> = [];
    const { app } = appWithVoice({ DEEPGRAM_API_KEY: FAKE_KEY }, async (url, init) => {
      seen.push({ url, init });
      return new Response(new Uint8Array(1024));
    });

    const res = await app.fetch(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "the rain outside" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(upstreamSpeakUrl());
    expect(seen[0]?.url).toContain("model=aura-asteria-en");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.headers.authorization).toBe(`Token ${FAKE_KEY}`);
    expect(JSON.parse(seen[0]?.init.body ?? "{}")).toEqual({ text: "the rain outside" });
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });

  test("上游失败 → 502 upstream-error（不明说上游细节）", async () => {
    const { app } = appWithVoice({ DEEPGRAM_API_KEY: FAKE_KEY }, async () => new Response("boom", { status: 500 }));
    const res = await app.fetch(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello there" }),
      }),
    );
    expect(res.status).toBe(502);
    expect(await readJson(res)).toEqual({ reason: "upstream-error" });
  });

  test("没有 key 时英文 → 503 not-configured（客户端据此回退浏览器 TTS）", async () => {
    const { app } = appWithVoice({});
    const res = await app.fetch(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello there" }),
      }),
    );
    expect(res.status).toBe(503);
    expect(await readJson(res)).toEqual({ reason: "not-configured" });
  });
});

// ---------------------------------------------------------------- 精简消息

describe("toClientMessage", () => {
  const interim = {
    type: "Results",
    is_final: false,
    channel: { alternatives: [{ transcript: "外面还在下雨", confidence: 0.9, words: [{ word: "外面" }] }] },
  };
  const final = {
    type: "Results",
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: "外面还在下雨吗，我在便利店" }] },
  };

  test("interim → {type:'interim', text}，不把 words/confidence 透出去", () => {
    const message = toClientMessage(JSON.stringify(interim));
    expect(message).toEqual({ type: "interim", text: "外面还在下雨" });
    expect(JSON.stringify(message).includes("confidence")).toBe(false);
  });

  test("final → {type:'final', text}", () => {
    expect(toClientMessage(JSON.stringify(final))).toEqual({
      type: "final",
      text: "外面还在下雨吗，我在便利店",
    });
  });

  test("SpeechStarted / UtteranceEnd", () => {
    expect(toClientMessage('{"type":"SpeechStarted","channel":[0],"timestamp":0.96}')).toEqual({
      type: "speech_started",
    });
    expect(toClientMessage('{"type":"UtteranceEnd","channel":[0],"last_word_end":2.5}')).toEqual({
      type: "utterance_end",
    });
  });

  test("空结果 / 握手 Metadata / 垃圾输入 / 非字符串 → null", () => {
    expect(
      toClientMessage(
        JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "" }] } }),
      ),
    ).toBeNull();
    expect(
      toClientMessage(JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{}] } })),
    ).toBeNull();
    expect(toClientMessage('{"type":"Metadata","request_id":"x"}')).toBeNull();
    expect(toClientMessage("not json")).toBeNull();
    expect(toClientMessage("")).toBeNull();
    expect(toClientMessage(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(toClientMessage(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------- 上游参数

describe("sttUpstreamUrl", () => {
  test("默认容器模式：不声明 encoding / sample_rate（webm/opus 实测可用）", () => {
    const url = new URL(sttUpstreamUrl());
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("api.deepgram.com");
    expect(url.searchParams.get("model")).toBe("nova-2");
    expect(url.searchParams.get("language")).toBe("zh");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.get("endpointing")).toBe("300");
    expect(url.searchParams.get("vad_events")).toBe("true");
    expect(url.searchParams.get("encoding")).toBeNull();
    expect(url.searchParams.get("sample_rate")).toBeNull();
  });

  test("linear16 分支仍在：PCM 直送时用实测过的那套参数", () => {
    const url = new URL(sttUpstreamUrl({ format: "linear16" }));
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("22050");
    expect(url.searchParams.get("channels")).toBe("1");
  });

  test("语言：zh-CN → zh，en-US → en", () => {
    expect(new URL(sttUpstreamUrl({ lang: "zh-CN" })).searchParams.get("language")).toBe("zh");
    expect(new URL(sttUpstreamUrl({ lang: "en-US" })).searchParams.get("language")).toBe("en");
  });
});

// ---------------------------------------------------------------- 桥

class FakeUpstream implements UpstreamSocket {
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

interface SinkProbe {
  messages: SttClientMessage[];
  closeCalls: Array<{ code?: number; reason?: string }>;
  sink: { sendText(payload: string): void; close(code?: number, reason?: string): void };
}

function makeSink(): SinkProbe {
  const probe: SinkProbe = { messages: [], closeCalls: [], sink: null as never };
  probe.sink = {
    sendText(payload: string) {
      probe.messages.push(JSON.parse(payload) as SttClientMessage);
    },
    close(code?: number, reason?: string) {
      probe.closeCalls.push({ code, reason });
    },
  };
  return probe;
}

describe("createSttBridge", () => {
  test("建连用 Token 头；预热期的帧排队、open 后按序补发", () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    let sawUrl = "";
    let sawHeaders: Record<string, string> = {};
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: (url, headers) => {
        sawUrl = url;
        sawHeaders = headers;
        return upstream;
      },
    });

    expect(sawHeaders.Authorization).toBe(`Token ${FAKE_KEY}`);
    expect(sawUrl).toContain("model=nova-2");

    // 上游还没 open：帧先排队（不丢第一句）
    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    expect(upstream.sent).toHaveLength(0);
    upstream.onopen?.();
    expect(upstream.sent).toHaveLength(1);
    bridge.pushAudio(new Uint8Array([4]));
    expect(upstream.sent).toHaveLength(2);
  });

  test("上游消息只以精简格式转给浏览器", () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    createSttBridge({ config: { apiKey: FAKE_KEY }, sink: probe.sink, log: () => {}, connect: () => upstream });

    upstream.onmessage?.({
      data: JSON.stringify({
        type: "Results",
        is_final: false,
        channel: { alternatives: [{ transcript: "外面还在" }] },
        metadata: { request_id: "abc" },
      }),
    });
    upstream.onmessage?.({ data: '{"type":"Metadata","request_id":"abc"}' });
    upstream.onmessage?.({ data: '{"type":"SpeechStarted","timestamp":0.96}' });

    expect(probe.messages).toEqual([
      { type: "interim", text: "外面还在" },
      { type: "speech_started" },
    ]);
  });

  test("浏览器断开 → 先给上游发 CloseStream，等尾段 final 才关（不硬断）", () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => upstream,
    });
    upstream.onopen?.();
    bridge.pushAudio(new Uint8Array([1]));
    expect(upstream.sent).toHaveLength(1);

    bridge.clientClosed();
    // ① 没有立刻硬断：先让上游 flush 尾段
    expect(upstream.closed).toBeNull();
    expect(upstream.sent.at(-1)).toBe('{"type":"CloseStream"}');

    // ② 尾段 final 到了：一定转发，然后才关上游
    upstream.onmessage?.({
      data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "外面还在下雨吗" }] } }),
    });
    expect(probe.messages.at(-1)).toEqual({ type: "final", text: "外面还在下雨吗" });
    expect(upstream.closed?.code).toBe(1000);
    expect(bridge.closed).toBe(true);
    expect(bridge.lastUpstreamType).toBe("Results(is_final=true)");

    // ③ 关完就不再往上游推音频
    bridge.pushAudio(new Uint8Array([2]));
    expect(upstream.sent).toHaveLength(2);
  });

  test("上游先断 → 浏览器收到 error 收摊信号，桥标记为关闭", () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => upstream,
    });
    upstream.onclose?.();
    expect(probe.messages.at(-1)).toEqual({ type: "error", reason: "upstream-closed" });
    expect(probe.closeCalls).toHaveLength(1);
    expect(bridge.closed).toBe(true);
  });

  test("建连抛错 → 客户端拿到 error，不留半开连接", () => {
    const probe = makeSink();
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => {
        throw new Error("dns fail");
      },
    });
    expect(probe.messages).toEqual([{ type: "error", reason: "upstream-unavailable" }]);
    expect(bridge.closed).toBe(true);
  });
});

// ---------------------------------------------------------------- 上游收尾（CloseStream）

/** 收尾超时是时间行为，只能用真时钟证伪；上限 1500ms 在测试里调成 25ms 级别 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function resultsPayload(text: string, isFinal: boolean): { data: string } {
  return {
    data: JSON.stringify({
      type: "Results",
      is_final: isFinal,
      channel: { alternatives: [{ transcript: text }] },
    }),
  };
}

const CLOSE_STREAM = '{"type":"CloseStream"}';

describe("createSttBridge 收尾（证伪/证实「硬断吞 final」假设）", () => {
  test("控制消息：finish_utterance 与 Deepgram 的叫法 CloseStream 等价；垃圾文本不认", () => {
    expect(parseSttControl('{"type":"finish_utterance"}')).toBe("finish_utterance");
    expect(parseSttControl('{"type":"CloseStream"}')).toBe("finish_utterance");
    expect(parseSttControl("not json")).toBeNull();
    // 上游专属的心跳不该被浏览器借道转发
    expect(parseSttControl('{"type":"KeepAlive"}')).toBeNull();
    expect(FLUSH_TIMEOUT_MS).toBe(1500);
  });

  test("上游不响应 CloseStream → 到点硬断，不挂死（上限在测试里是 25ms）", async () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    const logs: string[] = [];
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: (line) => logs.push(line),
      connect: () => upstream,
      flushTimeoutMs: 25,
    });
    upstream.onopen?.();
    bridge.pushAudio(new Uint8Array([1]));

    bridge.clientClosed();
    // 刚发完 CloseStream：还没断
    expect(upstream.sent.at(-1)).toBe(CLOSE_STREAM);
    expect(upstream.closed).toBeNull();
    expect(bridge.closed).toBe(false);

    await sleep(70);
    expect(upstream.closed?.code).toBe(1000);
    expect(bridge.closed).toBe(true);
    // 诊断：能看出是超时断的，并留下最后一条上游消息类型
    expect(logs.some((line) => line.includes("reason=client-closed-timeout") && line.includes("lastUpstream="))).toBe(
      true,
    );
  });

  test("「说完一句」：上游先发 final 再关 → final 一定转发，浏览器连接留着，且不多推 error", () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => upstream,
    });
    upstream.onopen?.();
    bridge.pushAudio(new Uint8Array([1]));
    upstream.onmessage?.(resultsPayload("外面还在", false));

    bridge.finishUtterance();
    expect(upstream.sent.at(-1)).toBe(CLOSE_STREAM);
    expect(probe.closeCalls).toEqual([]); // 浏览器一侧绝不能被关
    expect(bridge.closed).toBe(false);

    // 上游吐尾段 final，然后自己把连接关了（CloseStream 的正常结局）
    upstream.onmessage?.(resultsPayload("外面还在下雨吗,我在顿利", true));
    upstream.onclose?.();

    expect(probe.messages).toEqual([
      { type: "interim", text: "外面还在" },
      { type: "final", text: "外面还在下雨吗,我在顿利" },
    ]);
    // 「上游收尾自己关」不是错误：不许再给客户端塞一条 upstream-closed
    expect(probe.messages.some((message) => message.type === "error")).toBe(false);
    expect(probe.closeCalls).toEqual([]);
    expect(upstream.closed?.code).toBe(1000);
    expect(bridge.lastUpstreamType).toBe("Results(is_final=true)");
  });

  test("UtteranceEnd 也算尾段到齐（客户端只开 vad_events 时也能收尾）", () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => upstream,
    });
    upstream.onopen?.();
    bridge.finishUtterance();
    upstream.onmessage?.({ data: '{"type":"UtteranceEnd","channel":[0],"last_word_end":2.5}' });

    expect(probe.messages).toEqual([{ type: "utterance_end" }]);
    expect(upstream.closed?.code).toBe(1000);
    expect(bridge.closed).toBe(false);
  });

  test("下一句：浏览器 WS 不关，新音频自动补建一条上游，排队帧不丢", () => {
    const upstreams: FakeUpstream[] = [];
    const probe = makeSink();
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => {
        const created = new FakeUpstream();
        upstreams.push(created);
        return created;
      },
    });
    expect(upstreams).toHaveLength(1);
    const first = upstreams[0] as FakeUpstream;
    first.onopen?.();
    bridge.pushAudio(new Uint8Array([1]));

    bridge.finishUtterance();
    first.onmessage?.(resultsPayload("第一句", true));
    expect(upstreams).toHaveLength(1); // 尾段吐完才关；下一句还没来，不白建

    // 第二句的音频到了：立刻补建上游，握手期间的帧先排队
    bridge.pushAudio(new Uint8Array([2]));
    expect(upstreams).toHaveLength(2);
    const second = upstreams[1] as FakeUpstream;
    expect(second.sent).toHaveLength(0);
    second.onopen?.();
    expect(second.sent).toHaveLength(1);
    expect(bridge.closed).toBe(false);
    expect(probe.closeCalls).toEqual([]);
  });

  test("尾段还没吐完就来的音频：排队给下一句，绝不塞进正在 flush 的上游", () => {
    const upstreams: FakeUpstream[] = [];
    const probe = makeSink();
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => {
        const created = new FakeUpstream();
        upstreams.push(created);
        return created;
      },
    });
    const first = upstreams[0] as FakeUpstream;
    first.onopen?.();
    bridge.pushAudio(new Uint8Array([1]));
    bridge.finishUtterance();
    bridge.pushAudio(new Uint8Array([9]));

    // 正在 flush 的上游只收到「音频 1 + CloseStream」，没有第二句的帧
    expect(first.sent.filter((item) => typeof item !== "string")).toHaveLength(1);
    expect(first.sent.at(-1)).toBe(CLOSE_STREAM);

    first.onmessage?.(resultsPayload("第一句", true));
    // 排队帧还在 → 收尾结束当场补建，不用等下一次 pushAudio
    expect(upstreams).toHaveLength(2);
    (upstreams[1] as FakeUpstream).onopen?.();
    expect(upstreams[1]?.sent).toHaveLength(1);
    expect(bridge.closed).toBe(false);
    expect(probe.closeCalls).toEqual([]);
  });

  test("握手还没回来就断开 → 到点收摊，不留永远等着的会话", async () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    const logs: string[] = [];
    const bridge = createSttBridge({
      config: { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: (line) => logs.push(line),
      connect: () => upstream,
      flushTimeoutMs: 20,
    });
    // 故意不 open
    bridge.clientClosed();
    expect(bridge.closed).toBe(false);

    await sleep(60);
    expect(upstream.closed?.code).toBe(1000);
    expect(bridge.closed).toBe(true);
    expect(logs.some((line) => line.includes("tail=no-open"))).toBe(true);
  });

  test("没配 key：WS 门禁仍是 503 not-configured（收尾逻辑不碰准入）", async () => {
    const gate = sttUpgradeGate({ stt: false });
    expect(gate?.status).toBe(503);
    expect(await readJson(gate as Response)).toEqual({ type: "error", reason: "not-configured" });
  });
});

// ---------------------------------------------------------------- 升级门禁

describe("sttUpgradeGate", () => {
  test("没配 key → 503 + reason not-configured（不是静默失败）", async () => {
    const gate = sttUpgradeGate({ stt: false });
    expect(gate).not.toBeNull();
    expect(gate?.status).toBe(503);
    expect(await readJson(gate as Response)).toEqual({ type: "error", reason: "not-configured" });
  });

  test("配了 key → 放行（null）", () => {
    expect(sttUpgradeGate({ stt: true })).toBeNull();
  });

  test("没配 key 时 openSttStream 也回 null（不建上游连接）", () => {
    const { app } = appWithVoice({});
    expect(app.openSttStream({ sendText: () => {}, close: () => {} })).toBeNull();
  });

  test("配了 key 时 openSttStream 建桥，并把上游接上", () => {
    const upstream = new FakeUpstream();
    const probe = makeSink();
    const { app } = appWithVoice({ DEEPGRAM_API_KEY: FAKE_KEY });
    const bridge = createSttBridge({
      config: app.config.deepgram ?? { apiKey: FAKE_KEY },
      sink: probe.sink,
      log: () => {},
      connect: () => upstream,
    });
    expect(bridge.closed).toBe(false);
    expect(upstream.sent).toHaveLength(0);
  });
});
