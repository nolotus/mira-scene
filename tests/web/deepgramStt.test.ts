/**
 * DeepgramStt 客户端测试：全部 stub（假 socket / 假 recorder / 假麦克风），不联网、无真音频。
 *
 * 钉住的是「时序与回退」，不是音质：
 *  ① 预热时机 —— start() 当场就把 WS 建出去（建连实测 ~1s，等第一帧就丢第一句）
 *  ② 帧格式 —— MediaRecorder 100ms 切片原样推给 WS
 *  ③ 事件透出 —— interim / final / speech_started 各自到达上层回调
 *  ④ 回退链 —— ws 失败 → Web Speech → 纯文字，且原因写进 diagnostics
 */
import { describe, expect, test } from "bun:test";
import {
  AUTO_FINISH_QUIET_MS,
  AUTO_FINISH_SENTENCE_MS,
  CHUNK_MS,
  RECORDER_MIME,
  autoFinishDelayMs,
  createDeepgramStt,
  type DeepgramSttDiagnostics,
  type MediaStreamLike,
  type RecorderLike,
  type VoiceSocketLike,
  FINISH_UTTERANCE,
} from "../../src/web/voice/deepgramStt";
import type { SttController, SttOptions, SttTranscript } from "../../src/web/voice/stt";

class FakeSocket implements VoiceSocketLike {
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  send(data: string | Blob | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  open(): void {
    this.onopen?.();
  }
  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  fail(): void {
    this.onerror?.();
  }
}

class FakeRecorder implements RecorderLike {
  started: number[] = [];
  stopped = 0;
  ondataavailable: ((event: { data: Blob | null }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  start(timeslice?: number): void {
    this.started.push(timeslice ?? 0);
  }
  stop(): void {
    this.stopped += 1;
  }
  chunk(): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
  }
}

/** 真 MediaRecorder 的形状：有 onstop，且最后一个数据块在 stop 事件之前到达 */
class StopAwareRecorder extends FakeRecorder {
  onstop: (() => void) | null = null;
  fireStop(): void {
    this.onstop?.();
  }
}

class FakeStream implements MediaStreamLike {
  stopped = 0;
  getTracks(): Array<{ stop(): void }> {
    return [
      {
        stop: () => {
          this.stopped += 1;
        },
      },
    ];
  }
}

interface FallbackProbe {
  controller: SttController;
  starts: number;
  aborts: number;
  stop(): void;
}

function makeFallback(supported = true): FallbackProbe {
  const probe: FallbackProbe = {
    starts: 0,
    aborts: 0,
    stop: () => {},
    controller: {
      supported,
      get listening() {
        return probe.starts > 0;
      },
      start() {
        if (!supported) return false;
        probe.starts += 1;
        return true;
      },
      stop() {},
      abort() {
        probe.aborts += 1;
      },
      setLang() {},
    },
  };
  return probe;
}

interface Harness {
  socket: FakeSocket;
  recorder: FakeRecorder;
  stream: FakeStream;
  fallback: FallbackProbe;
  urls: string[];
  diagnostics: DeepgramSttDiagnostics[];
  transcripts: SttTranscript[];
  speechStarted: number;
  speechFinal: string[];
  errors: Array<{ message: string; code: string }>;
  options: Parameters<typeof createDeepgramStt>[0];
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  const socket = new FakeSocket();
  const recorder = new FakeRecorder();
  const stream = new FakeStream();
  const fallback = makeFallback((overrides.fallbackSupported as boolean | undefined) ?? true);
  const urls: string[] = [];
  const diagnostics: DeepgramSttDiagnostics[] = [];
  const transcripts: SttTranscript[] = [];
  const speechFinal: string[] = [];
  const errors: Array<{ message: string; code: string }> = [];
  const state: Harness = {
    socket,
    recorder,
    stream,
    fallback,
    urls,
    diagnostics,
    transcripts,
    speechStarted: 0,
    speechFinal,
    errors,
    options: {},
  };

  state.options = {
    lang: "zh-CN",
    deps: {
      openSocket: (url: string) => {
        urls.push(url);
        return socket;
      },
      getMic: async () => stream,
      createRecorder: () => recorder,
      createFallback: (_options: SttOptions) => fallback.controller,
      sttUrl: (lang: string) => `ws://test/api/stt?lang=${lang}`,
    },
    onDiagnostic: (value: DeepgramSttDiagnostics) => diagnostics.push(value),
    onTranscript: (value: SttTranscript) => transcripts.push(value),
    onSpeechStarted: () => {
      state.speechStarted += 1;
    },
    onSpeechFinal: (text: string) => speechFinal.push(text),
    onError: (message: string, code: string) => errors.push({ message, code }),
    ...overrides,
  };
  return state;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("DeepgramStt 预热", () => {
  test("start() 当场建连（不等第一帧音频），不是用户开口才连", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    expect(h.urls).toHaveLength(0);
    expect(stt.start()).toBe(true);
    // 关键断言：同一 tick 内 socket 已经被创建
    expect(h.urls).toHaveLength(1);
    expect(h.urls[0]).toContain("api/stt");
    expect(h.urls[0]).toContain("lang=zh-CN");
    await flush();
    expect(h.recorder.started).toEqual([CHUNK_MS]);
    stt.abort();
  });

  test("prewarm() 只建一条连接，重复调用不重连", () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.prewarm();
    stt.prewarm();
    expect(h.urls).toHaveLength(1);
    expect(stt.diagnostics.prewarm).toBe("connecting");
    h.socket.open();
    expect(stt.diagnostics.prewarm).toBe("ready");
    stt.abort();
  });

  test("100ms ∈ MediaRecorder 切片；mime 必须是 webm/opus（容器模式实测可用）", () => {
    expect(CHUNK_MS).toBe(100);
    expect(RECORDER_MIME).toBe("audio/webm;codecs=opus");
  });
});

describe("DeepgramStt 数据与事件", () => {
  test("录音帧原样推给 WS；未 open 前的帧进 pre-roll，open 后按序补发", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.recorder.chunk();
    expect(h.socket.sent).toHaveLength(0); // 还没 open：进队列，不发（也不丢）
    h.socket.open();
    // open 后立刻补发握手窗口攒下的帧（旧实现直接丢弃 → Deepgram 收不到用户第一句）
    expect(h.socket.sent).toHaveLength(1);
    h.recorder.chunk();
    expect(h.socket.sent).toHaveLength(2);
    stt.abort();
  });

  test("interim / final / speech_started 各自到达上层，final 触发 onSpeechFinal", () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    h.socket.open();

    h.socket.emit({ type: "interim", text: "外面还在" });
    h.socket.emit({ type: "final", text: "外面还在下雨吗" });
    h.socket.emit({ type: "speech_started" });
    h.socket.emit({ type: "utterance_end" });

    expect(h.transcripts).toEqual([
      { text: "外面还在", final: false },
      { text: "外面还在下雨吗", final: true },
    ]);
    expect(h.speechStarted).toBe(1);
    expect(h.speechFinal).toEqual(["外面还在下雨吗"]);
    stt.abort();
  });

  test("stop() 只停录音，WS 与麦克风保持待命（下一句不用再等 1 秒）", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.open();
    stt.stop();
    expect(h.recorder.stopped).toBe(1);
    expect(h.socket.closed).toBeNull();
    expect(h.stream.stopped).toBe(0);
    stt.abort();
  });
  test("stop() = 「这句说完了」：发 finish_utterance 文字帧，WS 与麦克风都留着", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.open();
    stt.stop();
    const texts = h.socket.sent.filter((item) => typeof item === "string");
    expect(texts).toEqual([FINISH_UTTERANCE]);
    expect(h.socket.closed).toBeNull();
    expect(h.stream.stopped).toBe(0);
    stt.abort();
  });

  test("真 MediaRecorder 顺序：最后一个数据块到了、stop 事件之后，才发 finish_utterance", async () => {
    const h = harness();
    const recorder = new StopAwareRecorder();
    h.options!.deps!.createRecorder = () => recorder;
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.open();

    stt.stop();
    // 反了就会丢句尾：此时最后一块音频还没送出去
    expect(h.socket.sent.filter((item) => typeof item === "string")).toHaveLength(0);
    recorder.fireStop();
    expect(h.socket.sent.filter((item) => typeof item === "string")).toEqual([FINISH_UTTERANCE]);
    stt.abort();
  });

  test("abort() = 「彻底断开」：不发 finish_utterance，直接关 WS（服务端按 close 收尾）", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.open();
    stt.abort();
    expect(h.socket.sent.filter((item) => typeof item === "string")).toHaveLength(0);
    expect(h.socket.closed?.code).toBe(1000);
  });
});

describe("DeepgramStt 回退链", () => {
  test("status 说 stt=false → 不建连，直接 Web Speech", () => {
    const h = harness({ available: () => false });
    const stt = createDeepgramStt(h.options);
    expect(stt.channel).toBe("webspeech");
    expect(stt.start()).toBe(true);
    expect(h.urls).toHaveLength(0);
    expect(h.fallback.starts).toBe(1);
  });

  test("WS 报错 → Web Speech 接手，原因写进 diagnostics", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.fail();

    expect(stt.channel).toBe("webspeech");
    expect(stt.diagnostics.reason).toBe("ws-error");
    expect(h.diagnostics.at(-1)?.channel).toBe("webspeech");
    // 正在听 → 回退后 Web Speech 自动接手
    expect(h.fallback.starts).toBe(1);
    // 上游与麦克风都收干净
    expect(h.socket.closed?.code).toBe(1000);
    expect(h.stream.stopped).toBe(1);
  });

  test("服务端回 {'type':'error'} → 回退，且不把 reason 变成空串", () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    h.socket.open();
    h.socket.emit({ type: "error", reason: "not-configured" });
    expect(stt.channel).toBe("webspeech");
    expect(stt.diagnostics.reason).toBe("not-configured");
  });

  test("Deepgram 与 Web Speech 都不可用 → 纯文字，且明确告诉用户只能打字", () => {
    const h = harness({ available: () => false, fallbackSupported: false });
    const stt = createDeepgramStt(h.options);
    expect(stt.channel).toBe("none");
    expect(stt.supported).toBe(false);
    expect(stt.start()).toBe(false);
    expect(h.errors.at(-1)?.message).toContain("只能打字");
  });

  test("回退之后上游再冒事件也不再生效（不重复回退、不重复报错）", () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    h.socket.open();
    h.socket.fail();
    const before = h.diagnostics.length;
    h.socket.fail();
    h.socket.emit({ type: "error" });
    expect(h.diagnostics.length).toBe(before);
  });
});

describe("DeepgramStt 其它", () => {
  test("abort() 关 socket + 停麦克风；之后再 start 会重连", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    stt.abort();
    expect(h.socket.closed?.code).toBe(1000);
    expect(h.stream.stopped).toBe(1);
    stt.start();
    expect(h.urls).toHaveLength(2);
  });

  test("setLang 换语言：关掉旧连接，下次用新的 language 参数", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    stt.setLang("en-US");
    expect(h.socket.closed?.code).toBe(1000);
    stt.start();
    expect(h.urls.at(-1)).toContain("lang=en-US");
    stt.abort();
  });

  test("麦克风被拒 → onError(denied)，不把 WS 也拖下水", async () => {
    const h = harness({
      deps: {
        openSocket: (url: string) => {
          h.urls.push(url);
          return h.socket;
        },
        getMic: async () => {
          throw new Error("NotAllowedError");
        },
        createRecorder: () => h.recorder,
        createFallback: () => h.fallback.controller,
        sttUrl: () => "ws://test/api/stt",
      },
    });
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    expect(h.errors.at(-1)?.code).toBe("denied");
    expect(stt.channel).toBe("deepgram"); // 麦克风问题是权限，不是通道问题
    stt.abort();
  });
});

describe("静音自动收尾：接线（不只是纯函数）", () => {
  /** 等到「带标点应收尾」的阈值之后再留 200ms 余量 */
  const SENTENCE_WAIT = AUTO_FINISH_SENTENCE_MS + 200;

  test("带句末标点的 interim → 短阈值内真的触发 recorder.stop（接线没被改回默认值）", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.open();
    h.socket.emit({ type: "interim", text: "外面还在下雨吗？" });
    expect(h.recorder.stopped).toBe(0);
    // 650ms：短阈值（750）还没到 → 必须仍是 0
    await Bun.sleep(Math.max(200, AUTO_FINISH_SENTENCE_MS - 100));
    expect(h.recorder.stopped).toBe(0);
    // 850ms：越过 750、未到默认 900 → 必须已经收尾（把 750 改回 450 或删掉短阈值都会让这条 fail）
    await Bun.sleep(250);
    expect(h.recorder.stopped).toBe(1);
    stt.abort();
  });

  test("不带句末标点的 interim → 同一时刻还没收尾（长句不被腰斩）", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.open();
    h.socket.emit({ type: "interim", text: "我想说的是" });
    // 在「默认阈值」之前一点点检查：不能收尾（短阈值只给带标点的长句）
    await Bun.sleep(Math.max(200, AUTO_FINISH_QUIET_MS - 250));
    expect(h.recorder.stopped).toBe(0);
    // 过了默认阈值才收尾
    await Bun.sleep(500);
    expect(h.recorder.stopped).toBe(1);
    stt.abort();
  }, 5000);

  test("空白 interim 不会取消上一条真实文本已挂的计时器", async () => {
    const h = harness();
    const stt = createDeepgramStt(h.options);
    stt.start();
    await flush();
    h.socket.open();
    h.socket.emit({ type: "interim", text: "外面还在下雨吗？" });
    h.socket.emit({ type: "interim", text: "   " });
    await Bun.sleep(SENTENCE_WAIT);
    expect(h.recorder.stopped).toBe(1);
    stt.abort();
  });
});

describe("静音自动收尾的阈值自适应", () => {
  test("句末标点 → 短阈值（不必等满 900ms）", () => {
    // 句末标点 + 至少 AUTO_FINISH_MIN_CHARS 个字才走短阈值
    for (const text of ["外面还在下雨吗？", "我知道这件事了。", "真的吗你说什么！"]) {
      expect(autoFinishDelayMs(text)).toBe(AUTO_FINISH_SENTENCE_MS);
    }
    // 太短（「好。」「嗯。」）不算一句说完 —— 线上实测这里切半句会让回答牛头不对马嘴
    for (const text of ["好。", "嗯。", "OK!"]) {
      expect(autoFinishDelayMs(text)).toBe(AUTO_FINISH_QUIET_MS);
    }
  });

  test("没有句末标点（长句说到一半）→ 仍旧等默认阈值，不腰斩", () => {
    for (const text of ["我想说的是", "你今天晚上", "雨好像小了一点点但"]) {
      expect(autoFinishDelayMs(text)).toBe(AUTO_FINISH_QUIET_MS);
    }
  });

  test("边界与标点族：正好 6 字走短阈值；…、．、ASCII . 都算句末", () => {
    expect(autoFinishDelayMs("我们吃饭吧。")).toBe(AUTO_FINISH_SENTENCE_MS); // 正好 6 字
    expect(autoFinishDelayMs("外面还在下雨吗…")).toBe(AUTO_FINISH_SENTENCE_MS);
    expect(autoFinishDelayMs("外面还在下雨吗．")).toBe(AUTO_FINISH_SENTENCE_MS);
    expect(autoFinishDelayMs("is it raining.")).toBe(AUTO_FINISH_SENTENCE_MS);
  });

  test("句内停顿不算句子结束", () => {
    for (const text of ["我想说的是，", "嗯、那个", "先等一下 然后"]) {
      expect(autoFinishDelayMs(text)).toBe(AUTO_FINISH_QUIET_MS);
    }
  });

  test("空白不给阈值（不收尾）", () => {
    expect(autoFinishDelayMs("")).toBeNull();
    expect(autoFinishDelayMs("   ")).toBeNull();
  });

  test("短阈值必须显著小于默认阈值，且仍远大于句内自然停顿", () => {
    expect(AUTO_FINISH_SENTENCE_MS).toBeLessThan(AUTO_FINISH_QUIET_MS);
    expect(AUTO_FINISH_SENTENCE_MS).toBeGreaterThanOrEqual(600);
  });
});
