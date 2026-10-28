/**
 * BrowserTTS 回归测试 —— 用假的 speechSynthesis 精确复现真实浏览器的三个坑：
 *  1. 一次只念一句（按句入队）；
 *  2. 中文音色优先；
 *  3. **cancel() 之后浏览器补发的 onend/onerror 不能推进队列、不能把状态拉回「说话中」**。
 *
 * 第 3 条是题目「打断后旧回调不许改回现状」在 TTS 侧的对应物，
 * 靠「代际令牌」实现；这里故意手动触发过期回调来验证护栏。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { BrowserTTS } from "../../src/web/voice/tts";

class FakeUtterance {
  static all: FakeUtterance[] = [];
  text: string;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(text: string) {
    this.text = text;
    FakeUtterance.all.push(this);
  }
}

class FakeSynth {
  speaking = false;
  pending = false;
  paused = false;
  spoken: string[] = [];
  cancelCalls = 0;

  speak(utterance: FakeUtterance): void {
    this.spoken.push(utterance.text);
    this.speaking = true;
  }
  cancel(): void {
    this.cancelCalls += 1;
    this.speaking = false;
    this.pending = false;
  }
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  getVoices(): Array<{ name: string; lang: string; localService: boolean }> {
    return [
      { name: "Microsoft Huihui", lang: "zh-CN", localService: false },
      { name: "Tingting", lang: "zh-CN", localService: true },
      { name: "Alex", lang: "en-US", localService: true },
    ];
  }
  addEventListener(): void {
    /* noop */
  }
}

const scope = globalThis as unknown as Record<string, unknown>;
let synth: FakeSynth;

beforeAll(() => {
  scope["SpeechSynthesisUtterance"] = FakeUtterance;
  scope["window"] = globalThis;
});

afterAll(() => {
  delete scope["window"];
  delete scope["SpeechSynthesisUtterance"];
});

beforeEach(() => {
  synth = new FakeSynth();
  (globalThis as unknown as { speechSynthesis: FakeSynth }).speechSynthesis = synth;
  FakeUtterance.all = [];
});

const lastUtterance = (): FakeUtterance => {
  const utterance = FakeUtterance.all.at(-1);
  if (!utterance) throw new Error("没有产生 utterance");
  return utterance;
};

describe("BrowserTTS：按句入队", () => {
  test("一次只念一句，onend 之后才念下一句；onSegment 与开口同步", () => {
    const segments: string[] = [];
    const tts = new BrowserTTS({ lang: "zh-CN", onSegment: (text) => segments.push(text) });

    tts.speak("欢迎光临。今晚的雨很大！");
    expect(synth.spoken).toEqual(["欢迎光临。"]);
    expect(segments).toEqual(["欢迎光临。"]);
    expect(tts.isSpeaking).toBe(true);

    lastUtterance().onend?.();
    expect(synth.spoken).toEqual(["欢迎光临。", "今晚的雨很大！"]);
    expect(segments).toEqual(["欢迎光临。", "今晚的雨很大！"]);

    lastUtterance().onend?.();
    expect(segments.at(-1)).toBe(""); // 队列读完
    expect(tts.isSpeaking).toBe(false);
    tts.dispose();
  });

  test("半句不开口：没有句末标点前不发 utterance，flush 时补读", () => {
    const tts = new BrowserTTS({ lang: "zh-CN" });
    tts.speak("雨停之前");
    expect(synth.spoken).toEqual([]);
    tts.speak("，别急着走。");
    expect(synth.spoken).toEqual(["雨停之前，别急着走。"]);

    tts.speak("还有半句");
    tts.flush();
    // flush 只把残句排进队列，不会插队打断正在念的句子（顺序优先于「立刻说完」）
    expect(synth.spoken).toEqual(["雨停之前，别急着走。"]);
    lastUtterance().onend?.();
    expect(synth.spoken).toEqual(["雨停之前，别急着走。", "还有半句"]);
    tts.dispose();
  });

  test("中文音色优先：zh-CN + 名字命中 + 本地音色", () => {
    const tts = new BrowserTTS({ lang: "zh-CN" });
    tts.speak("你好。");
    const voice = lastUtterance().voice as { name: string; lang: string } | null;
    expect(voice?.name).toBe("Tingting");
    expect(voice?.lang).toBe("zh-CN");
    tts.dispose();
  });
});

describe("BrowserTTS：cancel 的代际令牌", () => {
  test("cancel() 立即静音并清队列，过期 onend/onerror 不会把状态拉回 speaking", () => {
    const segments: string[] = [];
    const tts = new BrowserTTS({ lang: "zh-CN", onSegment: (text) => segments.push(text) });

    tts.speak("第一句。第二句。第三句。");
    const first = lastUtterance();
    expect(synth.spoken).toEqual(["第一句。"]);
    const cancelsBefore = synth.cancelCalls;

    tts.cancel();

    expect(synth.cancelCalls).toBe(cancelsBefore + 1);
    expect(tts.isSpeaking).toBe(false);
    expect(segments.at(-1)).toBe("");
    const spokenAfterCancel = synth.spoken.length;

    // 真实浏览器会把被取消 utterance 的回调补发出来（Chrome/Safari 都会）
    first.onend?.();
    first.onerror?.(new Event("error"));
    first.onend?.();

    expect(synth.spoken).toHaveLength(spokenAfterCancel); // 没有偷偷念下一句
    expect(tts.isSpeaking).toBe(false); // 状态没有被旧回调拉回 speaking
    tts.dispose();
  });

  test("打断后新的一轮从头开始念，旧轮的残余句子不再出现", () => {
    const tts = new BrowserTTS({ lang: "zh-CN" });
    tts.speak("旧的一。旧的一的二。");
    const stale = lastUtterance();
    tts.cancel();

    tts.speak("新的一轮。");
    expect(synth.spoken.at(-1)).toBe("新的一轮。");

    stale.onend?.();
    lastUtterance().onend?.();
    expect(synth.spoken).toEqual(["旧的一。", "新的一轮。"]); // 旧轮第二句被 cancel 清掉了
    tts.dispose();
  });

  test("cancel 之后可以重新 speak（speechSynthesis 被 resume/cancel 组合不会卡死）", () => {
    const tts = new BrowserTTS({ lang: "zh-CN" });
    tts.speak("第一句。");
    tts.cancel();
    tts.speak("第二句。");
    expect(synth.spoken.at(-1)).toBe("第二句。");
    expect(tts.isSpeaking).toBe(true);
    tts.dispose();
  });
});
