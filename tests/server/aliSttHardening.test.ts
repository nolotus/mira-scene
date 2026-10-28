/**
 * 阿里百炼 fun-asr 通道的**加固**测试（对应独立审查的 7 条 HIGH）。
 *
 * 钉住的都是「会真炸」的路径，不是风格意见：
 *   ① 进程纪律：任何收尾路径都必须 kill 掉 ffmpeg 子进程，且不重复 kill；
 *   ② 会话资源上限：帧数 / 转码输出 / 并发会话越界 → 明确 error，不静默；
 *   ③ 预算：预热 / 转码 / 上游往返都有硬上限，到点必须有结论；
 *   ④ 结果超时：必须给客户端一条 error（不能静默丢整句）；
 *   ⑤ ffmpeg 起不来：异常不许逃出 pushAudio；
 *   ⑥ 句子边界：只由显式 finish_utterance 决定（帧间隔抖动不许切句）；
 *   ⑦ 能力上报：上游不发 speech_started → 客户端改走 energy VAD（不伪造）。
 */
import { describe, expect, test } from "bun:test";
import {
  ALI_ASR_MODEL,
  ALI_ASR_WS_URL,
  createAliSttBridge,
  createFfmpegEncoder,
  type AudioEncoder,
  type EncoderFactory,
} from "../../src/server/aliStt.ts";
import { createSttBridge, type SttClientMessage, type UpstreamSocket } from "../../src/server/stt.ts";
import { resolveBargeInSource } from "../../src/web/voice/bargeInSource";

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

interface TrackedEncoder {
  killed: number;
  finished: number;
}

/** 会记账的假转码器：记录 kill 次数（进程纪律）与 finish 次数 */
function trackingEncoder(behaviour: "ok" | "throw" | "hang" = "ok"): {
  factory: EncoderFactory;
  encoders: TrackedEncoder[];
} {
  const encoders: TrackedEncoder[] = [];
  const factory: EncoderFactory = () => {
    const record: TrackedEncoder = { killed: 0, finished: 0 };
    encoders.push(record);
    const encoder: AudioEncoder = {
      write() {},
      async finish() {
        record.finished += 1;
        if (behaviour === "throw") throw new Error("ffmpeg exited 1");
        if (behaviour === "hang") await new Promise(() => {});
        return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01]);
      },
      kill() {
        record.killed += 1;
      },
    };
    return encoder;
  };
  return { factory, encoders };
}

/** 上游：run-task → task-started；finish-task → 一条终稿 */
function okConnect(text = "你在这儿坐了很久了吧，要不要再来一杯。") {
  const sockets: Array<UpstreamSocket & { sent: Array<string | Uint8Array>; audio: Uint8Array[] }> = [];
  const connect = (): UpstreamSocket => {
    const socket = {
      sent: [] as Array<string | Uint8Array>,
      audio: [] as Uint8Array[],
      send(data: string | Uint8Array) {
        socket.sent.push(data);
        if (typeof data !== "string") {
          socket.audio.push(data);
          return;
        }
        if (data.includes("run-task")) {
          queueMicrotask(() =>
            socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-started" } }) }),
          );
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
  return { connect, sockets };
}

/** 上游：连接刚建好就报错（模拟「还在收音频时上游炸了」） */
function erroringConnect() {
  const connect = (): UpstreamSocket => {
    const socket: UpstreamSocket = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    queueMicrotask(() => {
      socket.onopen?.();
      queueMicrotask(() =>
        socket.onmessage?.({
          data: JSON.stringify({ payload: { output: { type: "error", error: { message: "boom" } } } }),
        }),
      );
    });
    return socket;
  };
  return { connect };
}

// ------------------------------------------------------------------ ① 进程纪律

describe("① 进程纪律：ffmpeg 子进程在任何收尾路径都被 kill（且只 kill 一次）", () => {
  test("上游在收音频时报错 → 明确失败（此时还没起 ffmpeg，没有进程可泄漏）", async () => {
    const { connect } = erroringConnect();
    const { messages, sink } = fakeSink();
    const { factory, encoders } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    await until(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "upstream-error",
    });
    // 整段转码 = 收尾时才起 ffmpeg → 累积阶段根本没有 ffmpeg 进程
    expect(encoders).toHaveLength(0);
    expect(bridge.closed).toBe(true);
  });

  test("上游在收尾阶段报错 → 转码器被 kill（恰好一次）", async () => {
    // 上游：run-task 回 task-started；finish-task 之后回一条错误
    const connect = (): UpstreamSocket => {
      const socket: UpstreamSocket = {
        send(data: string | Uint8Array) {
          if (typeof data === "string" && data.includes("run-task")) {
            queueMicrotask(() =>
              socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-started" } }) }),
            );
            return;
          }
          if (typeof data === "string" && data.includes("finish-task")) {
            queueMicrotask(() =>
              socket.onmessage?.({
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
      queueMicrotask(() => socket.onopen?.());
      return socket;
    };
    const { messages, sink } = fakeSink();
    const { factory, encoders } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));

    expect(encoders).toHaveLength(1);
    expect(encoders[0]!.killed).toBe(1);
    expect(bridge.closed).toBe(true);
  });

  test("客户端中途断开（还在累积时）→ 不起 ffmpeg（没有进程可泄漏）", async () => {
    const { connect } = okConnect();
    const { sink } = fakeSink();
    const { factory, encoders } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.clientClosed();
    await until(() => bridge.closed);

    expect(encoders).toHaveLength(0);
    expect(bridge.closed).toBe(true);
  });

  test("客户端在转码途中断开 → 转码器被 kill（恰好一次）", async () => {
    const { connect } = okConnect();
    const { sink } = fakeSink();
    // 转码卡住（finish 永不返回）：模拟「客户端在转码途中跑了」
    const { factory, encoders } = trackingEncoder("hang");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      totalBudgetMs: 60,
    });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => encoders[0] !== undefined);
    bridge.clientClosed();
    await until(() => encoders[0]!.killed === 1);

    expect(encoders[0]!.killed).toBe(1);
    expect(bridge.closed).toBe(true);
  });

  test("转码失败 → 失败的转码器被 kill（每个转码器恰好一次）", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory, encoders } = trackingEncoder("throw");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));

    // 边收边解的那个 + 整段重试的那个：两个都被 kill，且各一次
    expect(encoders.length).toBeGreaterThanOrEqual(2);
    for (const encoder of encoders) expect(encoder.killed).toBe(1);
  });

  test("正常收尾 → 转码器也被 kill（幂等，不重复）", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory, encoders } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "final"));

    expect(encoders).toHaveLength(1);
    expect(encoders[0]!.killed).toBe(1);
  });

  test("createFfmpegEncoder：kill() 真的杀掉子进程，且重复调用只杀一次", () => {
    const original = Bun.spawn;
    const kills: number[] = [];
    const fakeChild = {
      stdin: { write() {}, flush() {}, end() {} },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
      kill() {
        kills.push(1);
        return true;
      },
    };
    (Bun as unknown as { spawn: unknown }).spawn = () => fakeChild;
    try {
      const encoder = createFfmpegEncoder();
      encoder.write(new Uint8Array([1, 2, 3]));
      encoder.kill?.();
      encoder.kill?.(); // 幂等：不该杀第二次
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = original;
    }
    expect(kills).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ ② 会话资源上限

describe("② 会话资源上限：越界就是明确的 error（不是静默截断）", () => {
  test("帧数越界 → too-many-frames", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      maxFrames: 2,
    });

    bridge.pushAudio(new Uint8Array([1]));
    bridge.pushAudio(new Uint8Array([2]));
    bridge.pushAudio(new Uint8Array([3]));
    await until(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "too-many-frames",
    });
    expect(bridge.closed).toBe(true);
  });

  test("转码输出越界 → transcode-too-large", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      maxWavBytes: 4, // 假转码器交回 6 字节 → 越界
    });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "transcode-too-large",
    });
    expect(bridge.closed).toBe(true);
  });

  test("并发会话越界 → too-many-sessions（明确失败，不静默排队）", async () => {
    const { connect } = okConnect();
    const probe = fakeSink();
    const bridge = createSttBridge({
      config: null,
      dashscope: { apiKey: FAKE_KEY, wsUrl: ALI_ASR_WS_URL, model: ALI_ASR_MODEL },
      connect,
      sink: probe.sink,
      encoder: () => trackingEncoder("ok").factory("webm-opus"),
    });
    // 直接用阿里桥测并发上限（createSttBridge 不透传 maxSessions）
    void bridge;
    const { createAliSttBridge } = await import("../../src/server/aliStt.ts");
    const first = fakeSink();
    const a = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink: first.sink,
      encoder: () => trackingEncoder("ok").factory("webm-opus"),
      maxSessions: 1,
    });
    const second = fakeSink();
    const b = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink: second.sink,
      encoder: () => trackingEncoder("ok").factory("webm-opus"),
      maxSessions: 1,
    });
    void a;
    expect(second.messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "too-many-sessions",
    });
    expect(b.closed).toBe(true);
  });
});

// ------------------------------------------------------------------ ③ 预算：到点必须有结论

describe("③ 预算：每个阶段都有硬上限，到点必须有结论", () => {
  test("上游不出终稿 → result-timeout（不是静默丢整句）", async () => {
    // 上游只回 task-started，finish-task 之后**什么都不回**
    const connect = (): UpstreamSocket => {
      const socket: UpstreamSocket = {
        send(data: string | Uint8Array) {
          if (typeof data === "string" && data.includes("run-task")) {
            queueMicrotask(() =>
              socket.onmessage?.({ data: JSON.stringify({ header: { event: "task-started" } }) }),
            );
          }
        },
        close() {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      queueMicrotask(() => socket.onopen?.());
      return socket;
    };
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      resultTimeoutMs: 60,
    });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "result-timeout",
    });
    expect(messages.some((m) => m.type === "final")).toBe(false);
    expect(bridge.closed).toBe(true);
  });

  test("转码卡住 → 收尾预算到点报错（不会挂成僵尸）", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("hang");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      totalBudgetMs: 60,
    });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));

    expect(messages.find((m) => m.type === "error")).toEqual({ type: "error", reason: "timeout" });
    expect(bridge.closed).toBe(true);
  });

  test("收尾成功后预算计时器作废（不会在下一句都结束之后炸出假 timeout）", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      totalBudgetMs: 60,
    });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "final"));

    // 等过预算时长：这一句**已经**有结论了，不该再冒出 timeout
    await sleep(200);
    expect(messages.some((m) => m.type === "error")).toBe(false);
    expect(bridge.closed).toBe(false);
  });

  test("预热握手迟迟不来 → 收尾时明确失败（预热阶段也在预算内）", async () => {
    // 连接永远不会 open / task-started
    const connect = (): UpstreamSocket => ({
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    });
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      totalBudgetMs: 60,
    });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"), 3000);

    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "upstream-unavailable",
    });
    expect(bridge.closed).toBe(true);
  });
});

// ------------------------------------------------------------------ ⑤ ffmpeg 起不来

describe("⑤ ffmpeg 起不来：异常不许逃出 pushAudio", () => {
  test("转码器工厂抛错 → 报 audio-encode-failed，不抛到 WS handler 上层", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: () => {
        throw new Error("ffmpeg: command not found");
      },
    });

    // 累积阶段不碰 ffmpeg（整段转码在收尾时），异常不会逃出 pushAudio
    expect(() => bridge.pushAudio(new Uint8Array([1, 2, 3]))).not.toThrow();
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));
    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "audio-encode-failed",
    });
    expect(bridge.closed).toBe(true);
  });

  test("写管道失败 → 报 audio-encode-failed", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: () => ({
        write() {
          throw new Error("EPIPE");
        },
        async finish() {
          return new Uint8Array(0);
        },
        kill() {},
      }),
    });

    expect(() => bridge.pushAudio(new Uint8Array([1, 2, 3]))).not.toThrow();
    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "error"));
    expect(messages.find((m) => m.type === "error")).toEqual({
      type: "error",
      reason: "audio-encode-failed",
    });
  });
});

// ------------------------------------------------------------------ ⑥ 句子边界

describe("⑥ 句子边界：只由显式 finish_utterance 决定", () => {
  test("帧间隔抖动（>120ms）不会把一条录音切两半", async () => {
    const { connect, sockets } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    bridge.pushAudio(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    // 模拟浏览器调度抖动：两帧之间隔 200ms（旧的 120ms「静默」阈值会在这里误判）
    await sleep(200);
    bridge.pushAudio(new Uint8Array([0x00, 0x11, 0x22]));
    await sleep(80);

    // 关键：还没收到 finish_utterance，就**不许**有 final（旧实现会在这里提前收尾）
    expect(messages.some((m) => m.type === "final")).toBe(false);

    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "final"));

    const finals = messages.filter((m) => m.type === "final");
    expect(finals).toHaveLength(1);
    // 整段一次性送给上游（没有被切成两半）
    expect(sockets[0]!.audio).toHaveLength(1);
  });

  test("分块 webm：整段**一次性**转码（不是边收边喂 —— 那会让 ffmpeg 探测失败）", async () => {
    const { connect, sockets } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory, encoders } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    // 模拟 MediaRecorder：第一块只有 176B（EBML 头），后面是裸 cluster
    bridge.pushAudio(new Uint8Array(176).fill(1));
    bridge.pushAudio(new Uint8Array(1948).fill(2));
    bridge.pushAudio(new Uint8Array(965).fill(3));
    // 累积阶段**不许**起 ffmpeg（边收边喂 = 线上「Invalid data found」的根因）
    expect(encoders).toHaveLength(0);

    bridge.finishUtterance();
    await until(() => messages.some((m) => m.type === "final"));

    // 转码器只被调用一次，且拿到的是**整段**（176+1948+965）
    expect(encoders).toHaveLength(1);
    expect(encoders[0]!.finished).toBe(1);
    expect(encoders[0]!.killed).toBe(1);
    // 上游收到的是一段完整的 wav（不是三段碎片）
    expect(sockets[0]!.audio).toHaveLength(1);
  });

  test("单句绝对时长兜底：到点强制收尾（给 final，不是错误）", async () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({
      apiKey: FAKE_KEY,
      connect,
      sink,
      encoder: factory,
      maxUtteranceMs: 60,
    });

    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    await until(() => messages.some((m) => m.type === "final"), 3000);

    expect(messages.filter((m) => m.type === "final")).toHaveLength(1);
    expect(messages.some((m) => m.type === "error")).toBe(false);
  });
});

// ------------------------------------------------------------------ 收尾态不新建上游（WARNING）

describe("收尾态：客户端断开后不再新建上游连接", () => {
  test("clientClosed() 之后不新建上游（不白烧一条连接）", async () => {
    let connects = 0;
    const connect = (): UpstreamSocket => {
      connects += 1;
      const socket: UpstreamSocket = {
        send() {},
        close() {},
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      return socket;
    };
    const { sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    expect(connects).toBe(1); // 预热建了一条
    bridge.pushAudio(new Uint8Array([1, 2, 3]));
    bridge.clientClosed();
    await sleep(50);

    expect(connects).toBe(1); // 没有新建第二条
    expect(bridge.closed).toBe(true);
  });
});

// ------------------------------------------------------------------ ⑦ 能力上报

describe("⑦ 能力上报：上游不发 speech_started → 客户端改走 energy VAD", () => {
  test("阿里桥的第一条消息就是 capabilities（supportsSpeechStarted:false）", () => {
    const { connect } = okConnect();
    const { messages, sink } = fakeSink();
    const { factory } = trackingEncoder("ok");
    const bridge = createAliSttBridge({ apiKey: FAKE_KEY, connect, sink, encoder: factory });

    expect(messages[0]).toEqual({
      type: "capabilities",
      provider: "ali",
      supportsSpeechStarted: false,
    });
    // 绝**不**伪造 speech_started
    expect(messages.some((m) => m.type === "speech_started")).toBe(false);
    bridge.clientClosed();
  });

  test("Deepgram 桥上报 supportsSpeechStarted:true", () => {
    const upstream: UpstreamSocket = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const { messages, sink } = fakeSink();
    createSttBridge({ config: { apiKey: "dg-key" }, connect: () => upstream, sink, log: () => {} });
    expect(messages[0]).toEqual({
      type: "capabilities",
      provider: "deepgram",
      supportsSpeechStarted: true,
    });
  });

  test("客户端按能力选触发源：false → energy（保留 AEC 门槛），true → deepgram", () => {
    const energy = resolveBargeInSource({
      bargeInEnabled: true,
      sttChannel: "deepgram",
      aec: "on",
      supportsSpeechStarted: false,
    });
    expect(energy.source).toBe("energy");
    expect(energy.reason).toBe("no-speech-started");
    // 能量 VAD 要真的能触发打断（不能只做电平显示）
    expect(energy.energyForLevelOnly).toBe(false);

    const deepgram = resolveBargeInSource({
      bargeInEnabled: true,
      sttChannel: "deepgram",
      aec: "on",
      supportsSpeechStarted: true,
    });
    expect(deepgram.source).toBe("deepgram");
    expect(deepgram.energyForLevelOnly).toBe(true);
  });

  test("AEC 门槛不受影响：读不到 AEC 仍然 none（不会因为 energy 而放宽）", () => {
    const decision = resolveBargeInSource({
      bargeInEnabled: true,
      sttChannel: "deepgram",
      aec: "unknown",
      supportsSpeechStarted: false,
    });
    expect(decision.source).toBe("none");
    expect(decision.energyForLevelOnly).toBe(true);
  });
});
