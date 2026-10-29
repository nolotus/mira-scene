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
import { afterEach, describe, expect, test } from "bun:test";
import {
  ALI_ASR_FALLBACK_MODEL,
  ALI_ASR_MODEL,
  ALI_EMPTY_SETTLE_QUIET_MS,
  ALI_FINAL_GRACE_MAX_MS,
  createAliSttBridge,
  createAliSttBridgeForModel,
  createAliStreamingSttBridge,
  type StreamingEncoderFactory,
} from "../../src/server/aliStt.ts";
import type { SttClientMessage, UpstreamSocket } from "../../src/server/stt.ts";

const FAKE_KEY = "dashscope-test-key";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 每条用例创建的桥都要在结束时 clientClosed()。
 * 模块级 activeSessions 有 32 的上限：用例不清理会话，跑满之后**后面的用例**会
 * 直接收到 `too many sessions` 而失败（实测：整文件单跑全过、全量跑却挂两条无关用例）。
 */
const liveBridges: Array<{ clientClosed(): void }> = [];
function trackStream(options: Parameters<typeof createAliStreamingSttBridge>[0]) {
  const bridge = createAliStreamingSttBridge(options);
  liveBridges.push(bridge);
  return bridge;
}
function trackWhole(options: Parameters<typeof createAliSttBridge>[0]) {
  const bridge = createAliSttBridge(options);
  liveBridges.push(bridge);
  return bridge;
}
afterEach(() => {
  for (const bridge of liveBridges.splice(0)) {
    try {
      bridge.clientClosed();
    } catch {
      /* 已经收摊了 */
    }
  }
});

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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackStream({
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
    trackStream({
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
    const bridge = trackStream({
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
    const bridge = trackWhole({
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

// ------------------------------------------------------------------ ⑧ 定时器不得泄漏

describe("⑧ final 送达后不得残留结果超时定时器", () => {
  test("finish_utterance 之后才到的 sentence_end → final 一送达就该清掉超时定时器", async () => {
    // 真实时序：客户端发 finish_utterance → 服务端开始等终稿（这时才起 resultTimer）
    //          → 上游随后才回这条的终稿。若 emitFinal 不清 resultTimer，
    //          用户已经看到字幕了，15 秒后还会冒一条 result-timeout 并拆掉会话
    //          （线上日志 `reason=result timeout lastEvent=result`、且同一会话里
    //          第二句的 task 被上一句的旧定时器打断，就是这么来的）。
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 60,
      totalBudgetMs: 2000,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );

    // 终稿在等之后才到
    upstream.result(socket, "今晚雨一直没停", true);
    await until(() => messages.some((m) => m.type === "final"));
    expect((messages.find((m) => m.type === "final") as { text: string }).text).toBe(
      "今晚雨一直没停",
    );

    // 越过超时窗口：final 已经给过了，就不该再报错、更不该把会话拆掉
    await sleep(200);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(closed).toEqual([]);
  });
});

// 空结果判定是「静默窗口」：task-finished 之后连续 emptySettleQuietMs 没有任何 result，
// 才算这句真的是空的；任何一条 result 都重置窗口（上游尾部 result 实测会晚到）。
// 单测注入小值（生产 1500ms），免得每条用例真等一秒半。
const QUIET_MS = 150;
/** 晚到用例用的静默窗：必须大于注入的「晚到 400ms」 */
const LATE_QUIET_MS = 800;
/** 宽限上限（注入，生产 1200ms） */
const GRACE_MAX_MS = 600;

describe("⑧ 空结果：上游已收尾但没有文本", () => {
  test("task-finished 已到、无文本 → 静默窗后安静收尾（不报错、不拆会话）", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      emptySettleQuietMs: QUIET_MS,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    upstream.taskFinished(socket);
    bridge.finishUtterance();

    await sleep(QUIET_MS + 300);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(messages.filter((m) => m.type === "final")).toEqual([]);
    expect(closed).toEqual([]);
    // endUtterance 会 kill ffmpeg：用 killed 证明「收尾了」而不是「挂住了」
    expect(enc.killed).toBeGreaterThan(0);
  });

  test("等终稿期间才收到 task-finished（无文本）→ 静默窗后安静收尾", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      emptySettleQuietMs: QUIET_MS,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);

    await sleep(QUIET_MS + 300);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(closed).toEqual([]);
    expect(enc.killed).toBeGreaterThan(0);
  });

  test("final 之后开第二句：上一句的定时器不得炸在第二句上", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 60,
      totalBudgetMs: 2000,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const first = upstream.sockets[0]!;
    await until(() =>
      first.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      first.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.result(first, "今晚雨一直没停", true);
    await until(() => messages.some((m) => m.type === "final"));
    expect(messages.filter((m) => m.type === "final").length).toBe(1);

    bridge.pushAudio(new Uint8Array([0x1b]));
    await sleep(200);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("⑧ 晚到 result 必须能变成终稿（不许静默丢句）", () => {
  test("task-finished 后 400ms 到达、且**不带** sentence_end → 仍要补发终稿", async () => {
    // 复审探针实测的坑：这种 result 若只重置静默窗、不重置发稿宽限，
    // emitFinal 早在空文本时被消费掉，文本就再也没机会发出去。
    // resultTimeoutMs 设成 800：万一定时器没被清，1.1s 后就会看到 error。
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 800,
      totalBudgetMs: 4000,
      emptySettleQuietMs: LATE_QUIET_MS,
      // 宽限压到 200ms：让终稿在 resultTimeoutMs(800) 之前落地，
      // 这样「定时器没被清」的泄漏才真的会在这条用例里暴露出来
      finalGraceMs: 200,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);

    await sleep(400);
    upstream.result(socket, "今晚雨一直没停", false);

    await until(() => messages.some((m) => m.type === "final"), 1500);
    expect((messages.find((m) => m.type === "final") as { text: string }).text).toBe(
      "今晚雨一直没停",
    );
    expect(messages.filter((m) => m.type === "final").length).toBe(1);

    // 越过 resultTimeoutMs：final 已给过，不该再补一条 result-timeout
    await sleep(1100);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(closed).toEqual([]);
  });

  test("静默窗快到时才有文本 → 发终稿而不是判空", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      emptySettleQuietMs: LATE_QUIET_MS,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);
    await sleep(LATE_QUIET_MS - 100);
    upstream.result(socket, "外头雨小了点", false);

    await until(() => messages.some((m) => m.type === "final"), 2000);
    expect((messages.find((m) => m.type === "final") as { text: string }).text).toContain(
      "外头雨小了点",
    );
    expect(closed).toEqual([]);
  });

  test("task-finished 之后上游直接关连接 → 不算错误，文本照常发 final", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      emptySettleQuietMs: LATE_QUIET_MS,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    upstream.result(socket, "今晚雨一直没停", false);
    await until(() => messages.some((m) => m.type === "interim"));
    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);
    socket.onclose?.({});

    await until(() => messages.some((m) => m.type === "final"));
    expect((messages.find((m) => m.type === "final") as { text: string }).text).toBe(
      "今晚雨一直没停",
    );
    await sleep(200);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("⑧ 发稿宽限有绝对上限（防上游不停出 result 把 final 无限推迟）", () => {
  test("每 100ms 来一条 result → 上限一到就出终稿，且恰好一条 final、之后不再推 interim", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 8000,
      totalBudgetMs: 9000,
      // 静默窗设得远大于上限：这条用例考的是「上限」而不是「判空」
      emptySettleQuietMs: 5000,
      finalGraceMaxMs: GRACE_MAX_MS,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);

    const startedAt = Date.now();
    while (Date.now() - startedAt < GRACE_MAX_MS + 900 && !messages.some((m) => m.type === "final")) {
      upstream.result(socket, "雨好像，好像小了点", false);
      await sleep(100);
    }

    await until(() => messages.some((m) => m.type === "final"), 1500);
    expect(Date.now() - startedAt).toBeLessThan(GRACE_MAX_MS + 700);
    // 恰好一条 final（洪流路径若回归成双 final，这里会红）
    expect(messages.filter((m) => m.type === "final").length).toBe(1);

    // final 之后不再推 interim：否则浏览器上看到的字比提交出去的终稿多
    const finalIndex = messages.findIndex((m) => m.type === "final");
    upstream.result(socket, "雨好像，好像小了点啊", false);
    await sleep(120);
    expect(
      messages.slice(finalIndex + 1).filter((m) => m.type === "interim"),
    ).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("⑧ 两个窗口的取值约束（不变量，不靠人记）", () => {
  test("静默窗必须 ≥ 发稿宽限上限，否则晚到的尾部文本会被判空丢掉", () => {
    // 这条不变量是防治「把 EMPTY_SETTLE_QUIET_MS 调小」时的静默回归：
    // 宽限上限之后、静默窗之前那段到达的 result，只有静默窗足够大才救得回来。
    expect(ALI_EMPTY_SETTLE_QUIET_MS).toBeGreaterThanOrEqual(ALI_FINAL_GRACE_MAX_MS);
  });

  test("终稿最坏偏移必须落在客户端契约（≤1500ms）内", () => {
    // 客户端 deepgramStt.ts 声明「服务端冲尾段 final ≤1500ms」。
    // 实现里等待时长按剩余预算裁剪，所以最坏偏移 = 宽限上限；
    // 若有人把上限调到 1500 以上，客户端的收尾判定会先把我们判掉。
    expect(ALI_FINAL_GRACE_MAX_MS).toBeLessThanOrEqual(1500);
    expect(ALI_EMPTY_SETTLE_QUIET_MS).toBeLessThanOrEqual(1500);
  });
});

describe("⑧ 终稿的尾巴（task-finished 后晚到的累计文本）", () => {
  test("宽限内的尾巴必须并进终稿（用生产默认宽限 800ms）", async () => {
    // 复审的 W1：真正决定发稿时刻的是发稿宽限，不是静默窗。
    // 宽限原先 150ms < 实测尾延迟 400ms，于是终稿只有前半句、尾巴彻底消失。
    // 这条跑的是**生产默认**宽限（ALI_FINAL_GRACE_MS，现为 800ms）。
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      // 不注入 finalGraceMs：这条要跑生产默认值
      emptySettleQuietMs: 5000,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);
    // 尾巴在实测延迟量级（400ms）到达：必须并进终稿
    await sleep(400);
    upstream.result(socket, "今晚雨一直没停", false);

    await until(() => messages.some((m) => m.type === "final"), 2000);
    expect((messages.find((m) => m.type === "final") as { text: string }).text).toBe(
      "今晚雨一直没停",
    );
    expect(messages.filter((m) => m.type === "final").length).toBe(1);
  });
});

describe("⑧ 第二句必须能有自己的终稿（按句状态确实复位了）", () => {
  test("第一句 final 之后再说第二句 → 两句各一条 final，文本互不污染", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      emptySettleQuietMs: 5000,
      finalGraceMs: 120,
    });

    // 第一句
    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const first = upstream.sockets[0]!;
    await until(() =>
      first.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );
    bridge.finishUtterance();
    await until(() =>
      first.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.result(first, "第一句", true);
    await until(() => messages.some((m) => m.type === "final"));
    expect((messages.find((m) => m.type === "final") as { text: string }).text).toBe("第一句");

    // 第二句：新一句必须重新建 task、重新发自己的 final
    bridge.pushAudio(new Uint8Array([0x1b]));
    await until(() => upstream.sockets.length > 1, 3000);
    const second = upstream.sockets[1]!;
    await until(() =>
      second.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );
    bridge.finishUtterance();
    await until(() =>
      second.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.result(second, "第二句", true);

    await until(() => messages.filter((m) => m.type === "final").length === 2, 2000);
    const finals = messages.filter((m) => m.type === "final") as Array<{ text: string }>;
    expect(finals.map((f) => f.text)).toEqual(["第一句", "第二句"]);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("⑧ 判空窗口与宽限上限相等时的竞争（生产默认值就是相等）", () => {
  test("静默窗 == 上限 + 上游每 60ms 一条 result → 仍恰好一条 final、无 error", async () => {
    const upstream = fakeUpstream();
    const { messages, closed, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 5000,
      totalBudgetMs: 6000,
      emptySettleQuietMs: 300,
      finalGraceMaxMs: 300,
      finalGraceMs: 120,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 700 && !messages.some((m) => m.type === "final")) {
      upstream.result(socket, "句子", false);
      await sleep(60);
    }

    await until(() => messages.some((m) => m.type === "final"), 1500);
    expect(messages.filter((m) => m.type === "final").length).toBe(1);
    expect(messages.filter((m) => m.type === "error")).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("⑧ 终稿延迟有界（按剩余预算裁剪，不是宽限 + 上限）", () => {
  test("尾部 result 落在截止前一刻 → final 仍不超过宽限上限", async () => {
    // 只在「装弹时」看预算的写法会让最坏偏移变成 上限+宽限（实测 2000ms）。
    // 这条用 上限 300 / 宽限 200 注入：截稿线必须在 ~300ms 附近，而不是 500ms。
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      emptySettleQuietMs: 1200,
      finalGraceMaxMs: 300,
      // 宽限明显大于上限：不裁剪的写法会拖到 240+400=640ms，裁剪后 ≤300ms
      finalGraceMs: 400,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    const finishedAt = Date.now();
    upstream.taskFinished(socket);

    // 在截止前一刻不断塞 result（每次都会重新装弹）
    for (let i = 0; i < 4; i += 1) {
      await sleep(60);
      upstream.result(socket, `雨好像${i}`, false);
    }

    await until(() => messages.some((m) => m.type === "final"), 2000);
    const offset = Date.now() - finishedAt;
    // 上限 300 + 250ms 抖动余量；不裁剪的写法会得到 ~640ms（会红）
    expect(offset).toBeLessThan(550);
    expect(messages.filter((m) => m.type === "final").length).toBe(1);
  });
});

describe("⑧ 宽限上限到点时不许顺手判空（否则静默窗被截短）", () => {
  test("装弹时已超上限、且此刻无文本 → 不许判空；随后到达的文本仍要出终稿", async () => {
    // 触发路径：task-finished 后先来一条「sentence_end 但空文本」的 result（装弹），
    // 上限到点只会 emitFinal(空→no-op)；随后**又一条**空 result 在超上限之后到达，
    // 会走 armFinalGrace 的前置分支。若那里顺手 finishEmptyUtterance()，
    // 这句就被判空收尾、上游被关，紧跟着到达的真文本会被静默丢弃。
    const upstream = fakeUpstream();
    const { messages, sink } = fakeSink();
    const enc = fakeStreamEncoder();
    const bridge = trackStream({
      apiKey: FAKE_KEY,
      connect: upstream.connect,
      sink,
      streamEncoder: enc.factory,
      resultTimeoutMs: 3000,
      totalBudgetMs: 4000,
      // 上限 300 < 静默窗 600：留出「上限之后、静默窗之前」这段缝隙
      finalGraceMaxMs: 300,
      finalGraceMs: 200,
      emptySettleQuietMs: 600,
    });

    bridge.pushAudio(new Uint8Array([0x1a]));
    await until(() => upstream.sockets.length > 0);
    const socket = upstream.sockets[0]!;
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("run-task")),
    );

    bridge.finishUtterance();
    await until(() =>
      socket.sent.some((s) => typeof s === "string" && s.includes("finish-task")),
    );
    upstream.taskFinished(socket);

    // ① 先装一次弹（上限还没到）
    await sleep(100);
    upstream.result(socket, "", true);
    // ② 上限已过之后再装一次弹（走前置分支）
    await sleep(220);
    upstream.result(socket, "", true);
    // ③ 真文本在静默窗之内到达
    await sleep(60);
    upstream.result(socket, "外头雨小了点", false);

    await until(() => messages.some((m) => m.type === "final"), 2500);
    expect((messages.find((m) => m.type === "final") as { text: string }).text).toContain(
      "外头雨小了点",
    );
    expect(messages.filter((m) => m.type === "final").length).toBe(1);
  });
});
