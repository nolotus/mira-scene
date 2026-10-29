/**
 * TTS Provider 选择与 audio.chunk 播放路径测试。
 *
 * 诚实声明（报告里也要写）：这里**没有任何真实音频**。MP3 字节是假的，
 * AudioContext 是假的，`decodeAudioData` 只是立刻回一个 buffer。
 * 被验证的只是「路由 + 分片入队 + 解码调用 + 打断后不再出声」这条时序，
 * 不是「Deepgram 的 MP3 能被浏览器正确解码播放」。后者需要真 key + 真浏览器。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  RoutedTTS,
  arrayBufferToBase64,
  containsCjk,
  createVoiceTts,
  selectTtsChannel,
  type SpeakRequest,
} from "../../src/web/voice/tts";

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

const okBytes = (n = 512) => ({ ok: true as const, bytes: new Uint8Array(n).buffer });

describe("selectTtsChannel", () => {
  test("矩阵：CJK 永远走浏览器；纯英文且 status 可用才走 Deepgram", () => {
    const on = { tts: true };
    const off = { tts: false };
    expect(selectTtsChannel("外面还在下雨吗", on)).toBe("browser");
    expect(selectTtsChannel("外面还在下雨吗", off)).toBe("browser");
    expect(selectTtsChannel("the rain outside", on)).toBe("deepgram");
    expect(selectTtsChannel("the rain outside", off)).toBe("browser");
    expect(selectTtsChannel("the rain outside", null)).toBe("browser");
    expect(selectTtsChannel("the rain outside", undefined)).toBe("browser");
    expect(selectTtsChannel("   ", on)).toBe("browser");
  });

  test("中英混排只要含 CJK 就走浏览器（Aura 是纯英语模型）", () => {
    expect(selectTtsChannel("好，ok", { tts: true })).toBe("browser");
    expect(selectTtsChannel("ok，好", { tts: true })).toBe("browser");
    expect(selectTtsChannel("full-width：，", { tts: true })).toBe("browser");
  });

  test("containsCjk 与服务端判据一致（覆盖假名/全角/兼容表意）", () => {
    expect(containsCjk("ひらがな")).toBe(true);
    expect(containsCjk("ＡＢＣ")).toBe(true);
    expect(containsCjk("hello")).toBe(false);
    expect(containsCjk("hello 123 !?")).toBe(false);
  });
});

describe("arrayBufferToBase64", () => {
  test("能被 atob 还原成同一串字节", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const base64 = arrayBufferToBase64(bytes.buffer);
    const restored = atob(base64);
    expect(restored.length).toBe(bytes.length);
    expect(Array.from(restored, (ch) => ch.charCodeAt(0))).toEqual(Array.from(bytes));
  });
});

describe("RoutedTTS", () => {
  test("中文分句完全不请求 /api/tts（行为与改造前一致）", () => {
    let calls = 0;
    const speakRequest: SpeakRequest = async () => {
      calls += 1;
      return okBytes();
    };
    const tts = new RoutedTTS({ getStatus: () => ({ tts: true }), speakRequest });
    tts.speak("外面还在下雨吗。");
    tts.flush();
    expect(calls).toBe(0);
    expect(tts.lastError).toBeNull();
    tts.dispose();
  });

  test("纯英文 + status 可用 → 请求 MP3 并走 audio.chunk 播放路径", async () => {
    const requests: string[] = [];
    const speakRequest: SpeakRequest = async (text) => {
      requests.push(text);
      return okBytes(1024);
    };
    const tts = new RoutedTTS({ getStatus: () => ({ tts: true }), speakRequest });
    tts.warmUp();
    tts.speak("The rain outside.");
    tts.flush();
    await tick();

    // 预热（"ok"）先发一次：它不是台词请求，台词请求仍然只有那一句
    expect(requests.filter((text) => text !== "ok")).toEqual(["The rain outside."]);
    expect(requests.length).toBe(2); // 预热 1 次 + 台词 1 次
    expect(started.length).toBe(1); // 分片确实被解码并排队播放
    expect(tts.lastError).toBeNull();
    tts.dispose();
  });

  test("服务端 400 unsupported-language → 回退浏览器且记录原因（不静音）", async () => {
    const speakRequest: SpeakRequest = async () => ({ ok: false, reason: "unsupported-language" });
    const tts = new RoutedTTS({ getStatus: () => ({ tts: true }), speakRequest });
    tts.speak("The rain outside.");
    tts.flush();
    await tick();
    expect(tts.lastError).toContain("unsupported-language");
    tts.dispose();
  });

  test("网络/上游失败同样回退，不抛异常", async () => {
    const speakRequest: SpeakRequest = async () => ({ ok: false, reason: "upstream-error" });
    const tts = new RoutedTTS({ getStatus: () => ({ tts: true }), speakRequest });
    tts.speak("Hello there.");
    tts.flush();
    await tick();
    expect(tts.lastError).toContain("upstream-error");
    tts.dispose();
  });

  test("cancel() 之后迟到的 MP3 不许出声（代际令牌）", async () => {
    const deferred: { resolve: ((value: { ok: true; bytes: ArrayBuffer }) => void) | null } = { resolve: null };
    const speakRequest: SpeakRequest = () =>
      new Promise((resolve) => {
        deferred.resolve = resolve as (value: { ok: true; bytes: ArrayBuffer }) => void;
      });
    const tts = new RoutedTTS({ getStatus: () => ({ tts: true }), speakRequest });
    tts.warmUp();
    tts.speak("The rain outside.");
    tts.flush();
    await tick();
    expect(deferred.resolve).not.toBeNull();

    tts.cancel();
    deferred.resolve?.(okBytes(1024));
    await tick();

    expect(started.length).toBe(0); // 迟到的那段一次都没播
    tts.dispose();
  });

  test("cancel() 之后再说下一句仍然能出声（令牌只作废旧请求，不废掉 provider）", async () => {
    const speakRequest: SpeakRequest = async () => okBytes(256);
    const tts = new RoutedTTS({ getStatus: () => ({ tts: true }), speakRequest });
    tts.warmUp();
    tts.speak("First line.");
    tts.flush();
    await tick();
    tts.cancel();
    tts.speak("Second line.");
    tts.flush();
    await tick();
    expect(started.length).toBeGreaterThanOrEqual(1);
    tts.dispose();
  });

  test("status 不到（null）时一律走浏览器：默认永远可用", async () => {
    let calls = 0;
    const speakRequest: SpeakRequest = async () => {
      calls += 1;
      return okBytes();
    };
    const tts = new RoutedTTS({ getStatus: () => null, speakRequest });
    tts.speak("The rain outside.");
    tts.flush();
    await tick();
    expect(calls).toBe(0);
    expect(tts.name).toBe("browser");
    tts.dispose();
  });
});

describe("createVoiceTts", () => {
  test("?audio=stream 保持既有行为（返回带 pushChunk 的 StreamTTS）", () => {
    const tts = createVoiceTts({ mode: "stream" });
    expect(typeof (tts as { pushChunk?: unknown }).pushChunk).toBe("function");
    expect(typeof (tts as { warmUp?: unknown }).warmUp).toBe("function");
  });

  test("默认模式返回路由层（中文也不炸）", () => {
    const tts = createVoiceTts({ getStatus: () => null });
    expect(typeof (tts as { warmUp?: unknown }).warmUp).toBe("function");
    tts.speak("外面还在下雨吗。");
    tts.flush();
    tts.dispose();
  });
});
