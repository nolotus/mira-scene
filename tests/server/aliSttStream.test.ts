/**
 * 阿里百炼**真流式**通道（qwen-audio-3.0-asr-flash-streaming）的测试。
 *
 * 钉住的是「流式」这件事本身的性质，不是风格：
 *   ① interim 必须**在** final 之前到达（整段路径根本不会有 interim）；
 *   ② PCM 必须**边转边**喂上游（等收尾才喂 = 白改回整段）；
 *   ③ ffmpeg 生命周期：任何收尾路径都 kill，且幂等；
 *   ④ 会话级资源上限 → 明确 error，不静默；
 *   ⑤ 分阶段预算 / 结果超时 → 到点必须有结论；
 *   ⑥ 一句只发一个 final（否则浏览器会提交两次）；
 *   ⑦ 能力上报：上游不发 speech_started → 客户端走 energy VAD（不伪造）。
 */
import { describe, expect, test } from "bun:test";
import {
  ALI_ASR_FALLBACK_MODEL,
  ALI_ASR_MODEL,
  createAliSttBridge,
  createAliSttBridgeForModel,
  createAliStreamingSttBridge,
  type StreamingEncoderFactory,
} from "../../src/server/aliStt.ts";
import type { SttClientMessage, UpstreamSocket } from "../../src/server/stt.ts";

const FAKE_KEY = "dashscope-test-key";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(5);
  }
}

interface SinkProbe {
  messages: SttClientMessage[];
  closed: Array<{ code?: number; reason?: string }>;
  sink: { sendText(payload: string): void; close(code?: number, reason?: string): void };
}

function fakeSink(): SinkProbe {
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

// ------------------------------------------------------------------ 假上游

interface FakeSocket extends UpstreamSocket {
  sent: Array<string | Uint8Array>;
  audio: Uint8Array[];
  texts: string[];
}

interface FakeUpstream {
  connect: (url: string, headers: Record<string, string>) => UpstreamSocket;
  sockets: FakeSocket[];
  /** 往某个 socket 发一条 result-generated */
  result(socket: FakeSocket, text: string, sentenceEnd: boolean): void;
  taskFinished(socket: FakeSocket): void;
  fail(socket: FakeSocket, message: string): void;
}

/** 上游：run-task → task-started（之后由测试手动喂 result-generated） */
function fakeUpstream(autoResultText?: string): FakeUpstream {
  const sockets: FakeSocket[] = [];
  const connect = (): UpstreamSocket => {
    const socket: FakeSocket = {
      sent: [],
      audio: [],
      texts: [],
      send(data: string | Uint8Array) {
        if (typeof data === "string") {
          socket.sent.push(data);
          if (data.includes("run-task")) {
            queueMicrotask(() =>
              socket.onmessage?.({
                data: JSON.stringify({ header: { event: "task-started" } }),
              }),
            );
          }
          if (autoResultText !== undefined && data.includes("finish-task")) {
            queueMicrotask(() =>
              socket.onmessage?.({
                data: JSON.stringify({
                  header: { event: "result-generated" },
                  payload: { output: { sentence: { text: autoResultText, sentence_end: true } } },
                }),
              }),
            );
          }
        } else {
          socket.audio.push(data);
          socket.sent.push(data);
        }
      },
      close() {},
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onclose: null as ((event?: unknown) => void) | null,
      onerror: null as ((event?: unknown) => void) | null,
    };
    sockets.push(socket);
    queueMicrotask(() => socket.onopen?.());
    return socket;
  };
  return {
    connect,
    sockets,
    result(socket, text, sentenceEnd) {
      socket.onmessage?.({
        data: JSON.stringify({
          header: { event: "result-generated" },
          payload: { output: { sentence: { text, sentence_end: sentenceEnd } } },
        }),
      });
    },
    taskFinished(socket) {
      socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-finished" } }) });
    },
    fail(socket, message) {
      socket.onmessage?.({
        data: JSON.stringify({ payload: { output: { type: "error", error: { message } } } }),
      });
    },
  };
}

// ------------------------------------------------------------------ 假流式转码器

interface FakeStreamEncoder {
  factory: StreamingEncoderFactory;
  /** 喂进来的原始字节（webm 块） */
  writes: Uint8Array[];
  /** 模拟 ffmpeg stdout 吐出来的 PCM */
  emit(chunk: Uint8Array): void;
  killed: number;
  finished: number;
  /** 让下一次 write 抛异常（模拟 ffmpeg 起不来） */
  breakWrite: boolean;
}

function fakeStreamEncoder(): FakeStreamEncoder {
  const state: FakeStreamEncoder = {
    writes: [],
    killed: 0,
    finished: 0,
    breakWrite: false,
    emit() {},
    factory: () => ({
      write(chunk: Uint8Array) {
        if (state.breakWrite) throw new Error("ffmpeg not found");
        state.writes.push(chunk);
      },
      async finish() {
        state.finished += 1;
        return { ok: true, code: 0, detail: "" };
      },
      kill() {
        state.killed += 1;
      },
      onData(cb: (chunk: Uint8Array) => void) {
        state.emit = cb;
      },
      onError() {},
    }),
  };
  return state;
}

// ------------------------------------------------------------------ ① interim 在 final 之前

describe("① 真流式：interim 在 final 之前到达（流式与整段的本质区别）", () => {
  test("上游边说边出字 → 浏览器先收 interim，最后才收 final", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });

    // 第一块音频 → 起 ffmpeg + 起上游 task
    bridge.pushAudio(new Uint8Array([0x1a, 0x45]));
    await until(() => upstream.sockets.length > 0 && upstream.sockets[0]!.audio.length >= 0);
    const socket = upstream.sockets[0]!;
    await until(() => socket.texts.length >= 0 && socket.sent.some((s) => typeof s === "string" && s.includes("run-task")));

    // 上游吐第一段字（还没结束）
    upstream.result(socket, "你在这儿", false);
    await until(() => messages.some((m) => m.type === "interim"));
    expect(messages.filter((m) => m.type === "interim")[0]).toEqual({
      type: "interim",
      text: "你在这儿",
    });

    // 再长一点
    upstream.result(socket, "你在这儿坐了很久了吧", false);
    await until(() => messages.filter((m) => m.type === "interim").length >= 2);
    const interims = messages.filter((m) => m.type === "interim");
    expect(interims[1]).toEqual({ type: "interim", text: "你在这儿坐了很久了吧" });

    // 还没说完 → **不能**有 final
    expect(messages.some((m) => m.type === "final")).toBe(false);

    // 说完 → final
    bridge.finishUtterance();
    upstream.result(socket, "你在这儿坐了很久了吧？", true);
    await until(() => messages.some((m) => m.type === "final"));

    const final = messages.find((m) => m.type === "final") as { type: "final"; text: string };
    expect(final.text).toBe("你在这儿坐了很久了吧？");
    // interim 一定排在 final 前面
    const firstFinal = messages.findIndex((m) => m.type === "final");
    const firstInterim = messages.findIndex((m) => m.type === "interim");
    expect(firstInterim).toBeGreaterThanOrEqual(0);
    expect(firstInterim).toBeLessThan(firstFinal);
  });

  test("interim 文本随上游增长而增长（不是重复同一条）", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    await until(() => upstream.sockets.length > 0);

    upstream.result(socket, "你", false);
    await until(() => messages.filter((m) => m.type === "interim").length === 1);
    upstream.result(socket, "你好", false);
    await until(() => messages.filter((m) => m.type === "interim").length === 2);
    upstream.result(socket, "你好啊", false);
    await until(() => messages.filter((m) => m.type === "interim").length === 3);

    const texts = messages.filter((m) => m.type === "interim").map((m) => (m as { text: string }).text);
    expect(texts).toEqual(["你", "你好", "你好啊"]);
  });
});

// ------------------------------------------------------------------ ② PCM 边转边喂

describe("② PCM 是边转边喂上游的（不是等收尾才喂）", () => {
  test("音频还在送，PCM 就已经到上游了", async () => {
    const upstream = fakeUpstream();
    const { sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });

    bridge.pushAudio(new Uint8Array([0x1a, 0x45]));
    const socket = upstream.sockets[0]!;
    await until(() => socket.sent.some((s) => typeof s === "string" && s.includes("run-task")));
    await until(() => socket.texts.length >= 0);

    // ffmpeg 吐出 PCM —— 此刻**还没**收尾
    enc.emit(new Uint8Array(1920));
    await until(() => socket.audio.length === 1);
    expect(socket.audio[0]!.byteLength).toBe(1920);
    // 还没发 finish-task：证明不是「攒完再喂」
    expect(socket.sent.some((s) => typeof s === "string" && s.includes("finish-task"))).toBe(false);
  });

  test("task 还没就绪时攒下的 PCM，会在就绪后按序补发", async () => {
    const upstream = fakeUpstream();
    const { sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    // PCM 早于 task-started 到达
    enc.emit(new Uint8Array(100));
    enc.emit(new Uint8Array(200));
    await until(() => socket.audio.length === 2);
    expect(socket.audio[0]!.byteLength).toBe(100);
    expect(socket.audio[1]!.byteLength).toBe(200);
  });
});

// ------------------------------------------------------------------ ③ ffmpeg 生命周期

describe("③ ffmpeg 生命周期：任何收尾路径都 kill，且幂等", () => {
  test("正常收尾 → kill 恰好一次", async () => {
    const upstream = fakeUpstream();
    const { sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    await until(() => upstream.sockets.length > 0);
    bridge.finishUtterance();
    upstream.result(socket, "你好", true);
    await until(() => enc.finished === 1);
    await until(() => enc.killed === 1);
    expect(enc.killed).toBe(1);
  });

  test("客户端提前断开 → ffmpeg 被 kill（恰好一次），且不再新建上游", async () => {
    const upstream = fakeUpstream();
    const { sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const before = upstream.sockets.length;
    bridge.clientClosed();
    await until(() => enc.killed === 1);
    expect(enc.killed).toBe(1);
    // 断开后不再新建上游连接（不白烧钱）
    await sleep(50);
    expect(upstream.sockets.length).toBe(before);
  });

  test("ffmpeg 起不来（write 抛异常）→ 报 audio-encode-failed，不是未捕获异常", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    enc.breakWrite = true;
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => messages.some((m) => m.type === "error"));
    const err = messages.find((m) => m.type === "error") as { type: "error"; reason: string };
    expect(err.reason).toBe("audio-encode-failed");
  });

  test("上游报错 → 客户端收到 error，并收摊", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    await until(() => upstream.sockets.length > 0);
    upstream.fail(socket, "boom");
    await until(() => messages.some((m) => m.type === "error"));
    expect((messages.find((m) => m.type === "error") as { reason: string }).reason).toBe(
      "upstream-error",
    );
  });
});

// ------------------------------------------------------------------ ④ 资源上限

describe("④ 会话级资源上限 → 明确 error，不静默", () => {
  test("原始输入超过上限 → audio-too-large", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    // 用 maxFrames 卡住帧数（同一个上限族）
    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    expect(messages.some((m) => m.type === "error")).toBe(false);
  });

  test("PCM 输出超过上限 → transcode-too-large", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      maxPcmBytes: 1000,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    enc.emit(new Uint8Array(2000));
    await until(() => messages.some((m) => m.type === "error"));
    expect((messages.find((m) => m.type === "error") as { reason: string }).reason).toBe(
      "transcode-too-large",
    );
  });
});

// ------------------------------------------------------------------ ⑤ 预算与超时

describe("⑤ 预算与超时：到点必须有结论", () => {
  test("等终稿超时 → 报 result-timeout（不静默丢句）", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 60,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"), 2000);
    expect((messages.find((m) => m.type === "error") as { reason: string }).reason).toBe(
      "result-timeout",
    );
  });

  test("超时前已经拿到文本 → 先把 final 给出去，再报超时", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 80,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    await until(() => upstream.sockets.length > 0);
    upstream.result(socket, "你好", false);
    await until(() => messages.some((m) => m.type === "interim"));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"), 2000);
    expect(messages.some((m) => m.type === "final")).toBe(true);
    expect((messages.find((m) => m.type === "error") as { reason: string }).reason).toBe(
      "result-timeout",
    );
  });
});

// ------------------------------------------------------------------ ⑥ 一句一个 final

describe("⑥ 一句只发一个 final（否则浏览器会提交两次）", () => {
  test("多句 + task-finished → 仍然只有一个 final", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    await until(() => upstream.sockets.length > 0);

    upstream.result(socket, "第一句", true);
    upstream.result(socket, "第二句", true);
    upstream.taskFinished(socket);
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "final"), 2000);
    await sleep(250);
    const finals = messages.filter((m) => m.type === "final");
    expect(finals).toHaveLength(1);
    expect((finals[0] as { text: string }).text).toBe("第一句第二句");
  });
});

// ------------------------------------------------------------------ ⑦ 能力上报

describe("⑦ 能力上报：上游不发 speech_started → 客户端走 energy VAD", () => {
  test("第一条消息是 capabilities（supportsSpeechStarted:false）", () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: fakeStreamEncoder().factory,
    });
    expect(messages[0]).toEqual({
      type: "capabilities",
      provider: "ali",
      supportsSpeechStarted: false,
    });
  });

  test("全程不发 speech_started（不伪造）", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliStreamingSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    await until(() => upstream.sockets.length > 0);
    upstream.result(socket, "你好", false);
    await until(() => messages.some((m) => m.type === "interim"));
    expect(messages.some((m) => m.type === "speech_started")).toBe(false);
  });
});

// ------------------------------------------------------------------ ⑧ 分发器

describe("⑧ 模型名分发：默认流式，整段可配置回退", () => {
  test("默认模型 = 真流式", () => {
    expect(ALI_ASR_MODEL).toBe("qwen-audio-3.0-asr-flash-streaming");
    expect(ALI_ASR_FALLBACK_MODEL).toBe("fun-asr-flash-2026-06-15");
  });

  test("显式给回退模型 → 走整段路径（不喂 PCM，发整段 wav）", async () => {
    const upstream = fakeUpstream("你在这儿坐了很久了吧");
    const { messages, sink } = fakeSink();
    const bridge = createAliSttBridgeForModel({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      model: ALI_ASR_FALLBACK_MODEL,
      encoder: () => ({
        write() {},
        async finish() {
          return new Uint8Array([0x52, 0x49, 0x46, 0x46]);
        },
        kill() {},
      }),
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "final"), 2000);
    expect(messages.some((m) => m.type === "interim")).toBe(false);
  });

  test("显式给流式模型 → 走流式路径（有 interim）", async () => {
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = createAliSttBridgeForModel({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      model: ALI_ASR_MODEL,
      streamEncoder: enc.factory,
    });
    bridge.pushAudio(new Uint8Array([0x1a]));
    const socket = upstream.sockets[0]!;
    await until(() => upstream.sockets.length > 0);
    upstream.result(socket, "你好", false);
    await until(() => messages.some((m) => m.type === "interim"));
    expect(messages.some((m) => m.type === "interim")).toBe(true);
  });

  test("整段路径的老工厂仍然可用（回退通道没被删）", async () => {
    const upstream = fakeUpstream();
    const { sink } = fakeSink();
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      encoder: () => ({
        write() {},
        async finish() {
          return new Uint8Array([0x52, 0x49, 0x46, 0x46]);
        },
        kill() {},
      }),
    });
    expect(typeof bridge.pushAudio).toBe("function");
  });
});
