/**
 * 句子级取消（打断）测试。
 *
 * 被钉住的三件事：
 *  1. 打断后**当前这句话立刻停**，在飞的合成请求被 abort
 *     （服务端那一路的 Edge 名额随之立刻释放 —— 下一轮不必等旧轮队列排空）；
 *  2. **已生成、尚未播的后续句子作废**：迟到的音频不进播放器；
 *  3. 取消**之后**新派发的句子不受影响（句子 id 更大）—— 管道没有被拆坏。
 *
 * 诚实声明：这里没有真实音频。MP3 是假字节，AudioContext 是假的，
 * 验证的是「取消 / 作废 / 作用域」这条时序，不是真实解码播放。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RoutedTTS, type SpeakStream } from "../../src/web/voice/tts";

// ---------------------------------------------------------------- 假 AudioContext

const started: number[] = [];

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  async decodeAudioData(_buffer: ArrayBuffer): Promise<{ duration: number }> {
    return { duration: 0.25 };
  }
  createBufferSource() {
    return {
      buffer: null as unknown,
      connect() {},
      start() {
        started.push(1);
      },
      stop() {},
      onended: null as (() => void) | null,
    };
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(() => {
  scope["window"] = globalThis;
  scope["AudioContext"] = FakeAudioContext;
});

afterAll(() => {
  delete scope["window"];
  delete scope["AudioContext"];
});

beforeEach(() => {
  started.length = 0;
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

// ---------------------------------------------------------------- 假合成流

/** 手动驱动的分片流：测试自己决定「什么时候来音频」「什么时候结束」 */
class FakeStream {
  private readonly queue: Uint8Array[] = [];
  private done = false;
  private waiter: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    this.queue.push(chunk);
    this.wake();
  }

  finish(): void {
    this.done = true;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      while (this.queue.length > 0) {
        const chunk = this.queue.shift();
        if (chunk) yield chunk;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

interface FakeCall {
  text: string;
  signal: AbortSignal | undefined;
  stream: FakeStream;
}

function makeTts(): { tts: RoutedTTS; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const speakStream: SpeakStream = (text, signal) => {
    const stream = new FakeStream();
    calls.push({ text, signal, stream });
    return Promise.resolve({ ok: true, chunks: stream });
  };
  const tts = new RoutedTTS({
    getStatus: () => ({ tts: true, ttsZh: true }),
    speakStream,
  });
  return { tts, calls };
}

const chunk = (): Uint8Array => new Uint8Array(2048).fill(7);

describe("句子级取消", () => {
  test("打断中止在飞的合成请求（服务端名额立刻释放）", async () => {
    const { tts, calls } = makeTts();
    tts.speak("外面还在下雨吗。");
    await tick();
    expect(calls.length).toBe(1);
    expect(calls[0]?.signal?.aborted).toBe(false);

    tts.cancelSentence();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  test("取消只作废到此刻发出的句子：新句子不受影响，管道也没被拆坏", async () => {
    const { tts, calls } = makeTts();
    tts.speak("外面还在下雨吗。");
    await tick();
    tts.cancelSentence();

    // 取消之后新派发的句子：它的 signal 不能被刚才那次取消 abort
    tts.speak("那我们进去吧。");
    await tick();
    expect(calls.length).toBe(2);
    expect(calls[1]?.signal?.aborted).toBe(false);

    // 新句子照常出声（说明队列没卡死）
    calls[1]?.stream.push(chunk());
    await tick();
    expect(started.length).toBeGreaterThan(0);
  });

  test("取消之后迟到的音频不出声（迟到不回放）", async () => {
    const { tts, calls } = makeTts();
    tts.speak("外面还在下雨吗。");
    tts.speak("带伞了吗。");
    await tick();
    expect(calls.length).toBe(2);

    tts.cancelSentence();
    // 迟到的分片：合成请求已经中止，但服务端仍可能把已发出的音频送回来
    calls[0]?.stream.push(chunk());
    calls[1]?.stream.push(chunk());
    await tick();
    expect(started.length).toBe(0);
  });

  test("已生成、尚未播的后续句子在取消时被丢弃", async () => {
    const { tts, calls } = makeTts();
    tts.speak("第一句。");
    tts.speak("第二句。");
    await tick();
    expect(calls.length).toBe(2);

    // 第一句先到（正在播），第二句也已生成 —— 但队首还没结束，第二句不能出声
    calls[0]?.stream.push(chunk());
    await tick();
    expect(started.length).toBe(1);
    calls[1]?.stream.push(chunk());
    await tick();
    expect(started.length).toBe(1); // 第二句还在排队，没出声

    // 打断：第二句（已生成、未播）作废
    tts.cancelSentence();
    // 第一句此刻收尾：若第二句还活着，它会在这一刻被送进播放器
    calls[0]?.stream.finish();
    await tick();
    expect(started.length).toBe(1);
  });

  test("打断时丢掉残句：半句不能被下一轮首句拼进去", async () => {
    const { tts, calls } = makeTts();
    tts.speak("外面还在下"); // 没有句号 → 残句留在 buffer
    await tick();
    tts.cancelSentence();
    const before = calls.length;
    tts.speak("你今晚一个人吗。");
    await tick();
    const requested = calls.slice(before).map((c) => String(c.text ?? ""));
    expect(requested.some((t) => t.includes("外面还在下"))).toBe(false);
    expect(requested.some((t) => t.includes("你今晚一个人吗"))).toBe(true);
  });

  test("整轮 cancel 同样中止在飞请求（老语义不回退）", async () => {
    const { tts, calls } = makeTts();
    tts.speak("外面还在下雨吗。");
    await tick();
    tts.cancel();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});
