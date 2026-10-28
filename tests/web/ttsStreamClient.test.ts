/**
 * 客户端流式播放：**收到第一块就开始播**，同时不破坏「2 槽有序预取」的字幕同步。
 *
 * 手法：把 `StreamTTS.pushChunk` 换成一个记录器（不碰 AudioContext / 不解码），
 * 于是被验证的是「什么时候、按什么顺序把分片交给播放器」这条时序。
 * 真实 MP3 解码仍然没有覆盖 —— 与既有 voiceTts.test.ts 的诚实声明一致。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RoutedTTS, StreamTTS, type SpeakStream } from "../../src/web/voice/tts.ts";

interface Pushed {
  seq: number;
  bytes: number;
  at: number;
}

let pushed: Pushed[] = [];
const original = StreamTTS.prototype.pushChunk;

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  pushed = [];
  StreamTTS.prototype.pushChunk = function record(chunk: { seq: number; dataUrl: string }): void {
    pushed.push({ seq: chunk.seq, bytes: chunk.dataUrl.length, at: performance.now() });
  };
});

afterEach(() => {
  StreamTTS.prototype.pushChunk = original;
});

/** 中文走 Edge（ttsZh=true）的档位，其余关掉 */
const status = () => ({ stt: false, tts: false, ttsZh: true, sttModel: "nova-2" }) as never;

function makeTts(speakStream: SpeakStream): RoutedTTS {
  return new RoutedTTS({ getStatus: status, speakStream });
}

/** 可手动放行的分片流 */
function gatedStream(chunkBytes: number, firstDelay = 0): { stream: SpeakStream; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream: SpeakStream = async () => ({
    ok: true,
    chunks: (async function* () {
      if (firstDelay) await tick(firstDelay);
      yield new Uint8Array(chunkBytes);
      await gate;
      yield new Uint8Array(chunkBytes);
    })(),
  });
  return { stream, release };
}

describe("首块即播", () => {
  test("第一块在整句合成结束之前就进了播放器", async () => {
    const { stream, release } = gatedStream(1200);
    const tts = makeTts(stream);
    tts.speak("第一句。");
    await tick(10);
    // 流还挂在第二块上，但第一块已经交给播放器 —— 这就是「不用等整句」
    expect(pushed.length).toBe(1);
    release();
    await tick(10);
    expect(pushed.length).toBe(2);
    expect(pushed.map((item) => item.seq)).toEqual([1, 2]);
    tts.dispose();
  });

  test("不足 1KB 的零头也必须在流结束时补上（丢了就缺句尾）", async () => {
    const speakStream: SpeakStream = async () => ({
      ok: true,
      chunks: (async function* () {
        for (let index = 0; index < 5; index += 1) yield new Uint8Array(300);
      })(),
    });
    const tts = makeTts(speakStream);
    tts.speak("短句。");
    await tick(10);
    // 4 × 300 = 1200 ≥ 1024 先入队；结尾 300 再补一块
    expect(pushed.length).toBe(2);
    tts.dispose();
  });
});

describe("2 槽预取不乱序（字幕同步的命门）", () => {
  test("后一句的流先完成，也必须等前一句的分片全部播完再入队", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const speakStream: SpeakStream = async (text) => ({
      ok: true,
      chunks:
        text.startsWith("甲")
          ? (async function* () {
              yield new Uint8Array(1200); // 前一句：先给一块，然后挂住
              await gateA;
              yield new Uint8Array(1200);
            })()
          : (async function* () {
              yield new Uint8Array(3000); // 后一句：立刻整块给完
            })(),
    });
    const tts = makeTts(speakStream);
    tts.speak("甲句。乙句。");
    await tick(20);

    // 后一句已经合成完了，但播放器只应收到前一句的第一块
    expect(pushed.length).toBe(1);
    releaseA();
    await tick(20);
    // 前一句两块（1.6KB × 2）→ 后一句一块（4KB）；长度顺序即句子顺序
    expect(pushed.length).toBe(3);
    expect(pushed[2]!.bytes).toBeGreaterThan(pushed[0]!.bytes);
    expect(pushed.map((item) => item.seq)).toEqual([1, 2, 3]);
    tts.dispose();
  });

  test("某一句流失败 → 只降级这一句（本机音），下一句照常走流", async () => {
    const spoken: string[] = [];
    const speakStream: SpeakStream = async (text) => {
      if (text.startsWith("坏")) return { ok: false, reason: "tts-unavailable" };
      return { ok: true, chunks: (async function* () { yield new Uint8Array(1200); })() };
    };
    const tts = new RoutedTTS({
      getStatus: status,
      speakStream,
      onBrowserFallback: () => spoken.push("fallback"),
    });
    tts.speak("坏句。好句。");
    await tick(20);
    expect(spoken).toEqual(["fallback"]); // 只报一次
    expect(pushed.length).toBe(1); // 好句仍然出了音频
    tts.dispose();
  });
});

describe("打断", () => {
  test("cancel 之后迟到的分片不许入队", async () => {
    const { stream, release } = gatedStream(1200);
    const tts = makeTts(stream);
    tts.speak("会被打断。");
    await tick(10);
    expect(pushed.length).toBe(1);
    tts.cancel();
    release();
    await tick(20);
    expect(pushed.length).toBe(1); // 没有追加
    tts.dispose();
  });
});
