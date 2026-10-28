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

  test("某一句流失败 → 重试一次；仍失败只静音这一句，绝不出第二个音色", async () => {
    const issues: string[] = [];
    const fallbacks: string[] = [];
    let badCalls = 0;
    const speakStream: SpeakStream = async (text) => {
      if (text.startsWith("坏")) {
        badCalls += 1;
        return { ok: false, reason: "tts-unavailable" };
      }
      return { ok: true, chunks: (async function* () { yield new Uint8Array(1200); })() };
    };
    const tts = new RoutedTTS({
      getStatus: status,
      speakStream,
      onBrowserFallback: () => fallbacks.push("fallback"),
      onSynthIssue: (reason) => issues.push(reason),
    });
    tts.speak("坏句。好句。");
    await tick(40);
    expect(badCalls).toBe(2); // 首发 + 一次重试
    expect(issues.length).toBe(1); // 只报一次
    expect(fallbacks).toEqual([]); // 绝不启用本机音（双声的根因）
    expect(pushed.length).toBe(1); // 好句仍然出了音频
    tts.dispose();
  });

  test("重试成功就不算失败（服务端探测竞态的真实形态）", async () => {
    let calls = 0;
    const speakStream: SpeakStream = async () => {
      calls += 1;
      if (calls === 1) return { ok: false, reason: "not-configured" };
      return { ok: true, chunks: (async function* () { yield new Uint8Array(1200); })() };
    };
    const tts = new RoutedTTS({
      getStatus: status,
      speakStream,
      onSynthIssue: () => {
        throw new Error("重试成功时不该报 issue");
      },
    });
    tts.speak("只有一句。");
    await tick(40);
    expect(calls).toBe(2);
    expect(pushed.length).toBe(1);
    tts.dispose();
  });

  test("纯标点片段不发请求也不出声（`…` 曾被判成英文 → 503 → 第二个音色）", async () => {
    let calls = 0;
    const speakStream: SpeakStream = async () => {
      calls += 1;
      return { ok: true, chunks: (async function* () { yield new Uint8Array(1200); })() };
    };
    const tts = new RoutedTTS({ getStatus: status, speakStream });
    tts.speak("……");
    tts.speak("。");
    tts.flush();
    await tick(20);
    expect(calls).toBe(0);
    expect(pushed.length).toBe(0);
    tts.dispose();
  });

  test("主音色可用时，夹带的英文碎片也走角色管道（不启系统音）", async () => {
    const texts: string[] = [];
    const speakStream: SpeakStream = async (text) => {
      texts.push(text);
      return { ok: true, chunks: (async function* () { yield new Uint8Array(1200); })() };
    };
    const tts = new RoutedTTS({
      getStatus: status,
      speakStream,
      onBrowserFallback: () => {
        throw new Error("主音色可用时不该启用系统音");
      },
    });
    tts.speak("OK。你好。");
    await tick(30);
    expect(texts).toEqual(["OK。", "你好。"]); // 两句都交给同一条服务端管道
    tts.dispose();
  });

  test("已经出声的句子中途断流 → 不重试（否则前半句会重播）", async () => {
    let calls = 0;
    const speakStream: SpeakStream = async () => {
      calls += 1;
      return {
        ok: true,
        chunks: (async function* () {
          yield new Uint8Array(1200);
          throw new Error("network");
        })(),
      };
    };
    const issues: string[] = [];
    const tts = new RoutedTTS({
      getStatus: status,
      speakStream,
      onSynthIssue: (reason) => issues.push(reason),
    });
    tts.speak("半句就断。");
    await tick(40);
    expect(calls).toBe(1); // 不重试
    expect(pushed.length).toBe(1); // 只有已经送出的那一块，没有从头再来
    expect(issues.length).toBe(1);
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
