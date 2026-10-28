/**
 * 阿里百炼 fun-asr 通道的服务端测试：全部 stub，不联网、不碰真 key、不依赖真实 ffmpeg。
 *
 * 钉住四件事：
 *  ① provider 选择：配了 DASHSCOPE_API_KEY 就走阿里，没配就走 Deepgram 老逻辑（不删）
 *  ② 阿里通道：给一段 webm 字节 → 产出 final 文本（转码器与 WS 都是假的）
 *  ③ **不发 speech_started**：上游没有这个信号，我们也不伪造 —— 伪造比没有更糟
 *  ④ 上游报错 → 客户端收到一条 error（而不是卡住或抛异常）
 */
import { describe, expect, test } from "bun:test";
import {
  ALI_ASR_MODEL,
  ALI_ASR_WS_URL,
  createAliSttBridge,
  normalizeWav,
  parseAliEvent,
  type AudioEncoder,
} from "../../src/server/aliStt.ts";
import { createSttBridge, type SttClientMessage, type UpstreamSocket } from "../../src/server/stt.ts";
import { loadConfig } from "../../src/server/config.ts";
import { createApp } from "../../src/server/app.ts";

const FAKE_KEY = "dashscope-test-key";

/** 假的转码器：把任意字节变成一段固定 wav（不依赖真实 ffmpeg） */
function fakeEncoderFactory(): { factory: () => AudioEncoder; written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    factory: () => ({
      write(chunk) {
        written.push(chunk);
      },
      async finish() {
        return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);
      },
    }),
  };
}

interface FakeSocket extends UpstreamSocket {
  sent: Array<string | Uint8Array>;
  audio: Uint8Array[];
  closed: boolean;
}

/**
 * 假的阿里上游：收到 run-task 回 task-started；收到 finish-task 回一条终稿。
 * 行为对齐实测协议（终稿在 payload.output.sentence.text + sentence_end）。
 */
function fakeAliConnect(text = "你在这儿坐了很久了吧，要不要再来一杯。") {
  const sockets: FakeSocket[] = [];
  const connect = (url: string, headers: Record<string, string>): UpstreamSocket => {
    const socket: FakeSocket = {
      sent: [],
      audio: [],
      closed: false,
      send(data) {
        socket.sent.push(data);
        if (typeof data !== "string") {
          socket.audio.push(data);
          return;
        }
        if (data.includes("run-task")) {
          queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-started" } }) }));
          return;
        }
        if (data.includes("finish-task")) {
          queueMicrotask(() =>
            socket.onmessage?.({
              data: JSON.stringify({
                header: { event: "result-generated" },
                payload: { output: { sentence: { text, sentence_end: true } } },
              }),
            }),
          );
        }
      },
      close() {
        socket.closed = true;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    sockets.push(socket);
    // 真实 socket 的握手是异步的：晚一拍再触发 onopen
    queueMicrotask(() => socket.onopen?.());
    void url;
    void headers;
    return socket;
  };
  return { connect, sockets };
}

function fakeSink() {
  const messages: SttClientMessage[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    messages,
    closed,
    sink: {
      sendText(payload: string) {
        messages.push(JSON.parse(payload) as SttClientMessage);
      },
      close(code?: number, reason?: string) {
        closed.push({ code, reason });
      },
    },
  };
}

/** 等到条件成立（测试里不 sleep 固定时长，避免抖动） */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ------------------------------------------------------------------ 纯函数

describe("parseAliEvent", () => {
  test("task-started / result-generated / error 都能认出来", () => {
    expect(parseAliEvent(JSON.stringify({ header: { event: "task-started" } }))).toEqual({
      kind: "task-started",
    });
    const result = parseAliEvent(
      JSON.stringify({
        header: { event: "result-generated" },
        payload: { output: { sentence: { text: " 你好 ", sentence_end: true } } },
      }),
    );
    expect(result).toEqual({ kind: "result", text: "你好", sentenceEnd: true });
    const err = parseAliEvent(
      JSON.stringify({ payload: { output: { type: "error", error: { message: "boom" } } } }),
    );
    expect(err).toEqual({ kind: "error", reason: "boom" });
  });

  test("认不出来 / 坏 JSON 不当错误（只是 other）", () => {
    expect(parseAliEvent("not json").kind).toBe("other");
    expect(parseAliEvent(JSON.stringify({ header: { event: "whatever" } })).kind).toBe("other");
  });
});

// ------------------------------------------------------------------ wav 规整

describe("normalizeWav", () => {
  test("把 ffmpeg 的管道输出整成标准 44 字节头 + 真实长度", () => {
    // 造一个「ffmpeg 风格」的 wav：长度字段是占位 0xFFFFFFFF，中间夹一个 LIST 块
    const data = new Uint8Array(1000).fill(7);
    const src = new Uint8Array(44 + 26 + 8 + data.byteLength);
    const view = new DataView(src.buffer);
    src.set([0x52, 0x49, 0x46, 0x46], 0);
    view.setUint32(4, 0xffffffff, true);
    src.set([0x57, 0x41, 0x56, 0x45], 8);
    src.set([0x66, 0x6d, 0x74, 0x20], 12);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    src.set([0x4c, 0x49, 0x53, 0x54], 36); // LIST
    view.setUint32(40, 26, true);
    src.set([0x64, 0x61, 0x74, 0x61], 70);
    view.setUint32(74, 0xffffffff, true);
    src.set(data, 78);

    const out = normalizeWav(src);
    const outView = new DataView(out.buffer);
    expect(out.byteLength).toBe(44 + data.byteLength);
    expect(outView.getUint32(24, true)).toBe(16000); // 采样率没被动
    expect(outView.getUint16(22, true)).toBe(1); // 声道没被动
    expect(outView.getUint32(40, true)).toBe(data.byteLength); // data 长度是真实值
    expect(outView.getUint32(4, true)).toBe(out.byteLength - 8); // RIFF 长度是真实值
    expect(out.subarray(44)).toEqual(data); // 音频数据逐字节不变
  });

  test("不是 wav 就原样返回（不猜、不改）", () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    expect(normalizeWav(junk)).toEqual(junk);
  });
});

// ------------------------------------------------------------------ app 层

describe("app：Deepgram key 被吊销时的语音状态", () => {
  test("只有 DASHSCOPE_API_KEY 时 stt 仍然是 true，模型报百炼那个", () => {
    const config = loadConfig({ NODE_ENV: "development", DASHSCOPE_API_KEY: FAKE_KEY });
    const app = createApp({ config });
    expect(app.voice.stt).toBe(true);
    expect(app.voice.sttModel).toBe(ALI_ASR_MODEL);
    // 响应里不能有 key 的痕迹
    expect(JSON.stringify(app.voice)).not.toContain(FAKE_KEY);
  });

  test("两个 key 都没配 → stt=false（正常态）", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    const app = createApp({ config });
    expect(app.voice.stt).toBe(false);
  });
});

// ------------------------------------------------------------------ provider 选择

describe("createSttBridge 的 provider 选择", () => {
  test("配了 DASHSCOPE_API_KEY → 走阿里（URL 是百炼那条）", async () => {
    const { connect, sockets } = fakeAliConnect();
    const { messages, sink } = fakeSink();
    const bridge = createSttBridge({
      config: null,
      dashscope: { apiKey: FAKE_KEY, wsUrl: ALI_ASR_WS_URL, model: ALI_ASR_MODEL },
      connect,
      sink,
      encoder: () => fakeEncoderFactory().factory(),
    });
    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "final"));
    expect(sockets.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.type === "final")).toBe(true);
  });

  test("没配 DASHSCOPE_API_KEY → 仍然走 Deepgram 老逻辑（路径没被删）", async () => {
    const urls: string[] = [];
    const upstream: UpstreamSocket = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const bridge = createSttBridge({
      config: { apiKey: "dg-key" },
      dashscope: null,
      connect: (url) => {
        urls.push(url);
        return upstream;
      },
      sink: fakeSink().sink,
    });
    expect(urls[0]).toContain("api.deepgram.com");
    expect(bridge.closed).toBe(false);
  });
});

// ------------------------------------------------------------------ 阿里通道主路径

describe("阿里通道：webm 字节 → final 文本", () => {
  test("产出 final，且**从不**发 speech_started", async () => {
    const { connect, sockets } = fakeAliConnect();
    const { messages, sink } = fakeSink();
    const { factory, written } = fakeEncoderFactory();
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: () => factory(),
    });

    // 模拟浏览器 MediaRecorder 的 webm 块
    bridge.pushAudio(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    bridge.pushAudio(new Uint8Array([0x00, 0x11, 0x22]));
    bridge.finishUtterance();

    await until(() => messages.some((m) => m.type === "final"));
    const finals = messages.filter((m) => m.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual({ type: "final", text: "你在这儿坐了很久了吧，要不要再来一杯。" });

    // 关键约束：上游没有 speech_started，我们**不伪造**
    expect(messages.some((m) => m.type === "speech_started")).toBe(false);
    // 也不该有 interim（整段识别模型没有 interim）
    expect(messages.some((m) => m.type === "interim")).toBe(false);

    // 转码器**一次性**拿到整段音频（不是边收边喂）：
    // 浏览器的 webm 分块流边收边喂会让 ffmpeg 探测失败（Invalid data found）
    expect(written.length).toBe(1);
    expect(written[0]!.byteLength).toBe(7);
    // 上游收到了 wav + finish-task
    const socket = sockets[0]!;
    expect(socket.audio.length).toBe(1);
    expect(socket.sent.some((s) => typeof s === "string" && s.includes("finish-task"))).toBe(true);
    // run-task 的报文里模型名要对
    const runTask = socket.sent.find((s) => typeof s === "string" && s.includes("run-task"));
    expect(typeof runTask === "string" && runTask.includes(ALI_ASR_MODEL)).toBe(true);
  });

  test("没有音频时收尾：不发 final，也不炸", async () => {
    const { connect } = fakeAliConnect();
    const { messages, sink } = fakeSink();
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: () => fakeEncoderFactory().factory(),
    });
    bridge.finishUtterance();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages.filter((m) => m.type === "final")).toHaveLength(0);
    expect(messages.filter((m) => m.type === "error")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ 错误路径

describe("阿里通道的错误路径", () => {
  test("上游报错 → 客户端收到 error，不是静默卡住", async () => {
    const { messages, sink } = fakeSink();
    const upstream: UpstreamSocket = {
      send(data) {
        if (typeof data === "string" && data.includes("run-task")) {
          queueMicrotask(() =>
            upstream.onmessage?.({ data: JSON.stringify({ header: { event: "task-started" } }) }),
          );
          return;
        }
        if (typeof data === "string" && data.includes("finish-task")) {
          queueMicrotask(() =>
            upstream.onmessage?.({
              data: JSON.stringify({ payload: { output: { type: "error", error: { message: "boom" } } } }),
            }),
          );
        }
      },
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    // 握手是异步的（真实 socket 不会同步就绪）
    queueMicrotask(() => upstream.onopen?.());
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect: () => upstream,
      sink,
      encoder: () => fakeEncoderFactory().factory(),
    });
    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));
    expect(messages.find((m) => m.type === "error")).toEqual({ type: "error", reason: "upstream-error" });
    expect(bridge.closed).toBe(true);
  });

  test("转码失败（ffmpeg 不可用）→ 报 audio-encode-failed，不是未捕获异常", async () => {
    const { connect } = fakeAliConnect();
    const { messages, sink } = fakeSink();
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: () => ({
        write() {},
        async finish() {
          throw new Error("ffmpeg exited 1");
        },
      }),
    });
    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));
    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "audio-encode-failed",
    });
  });
});
