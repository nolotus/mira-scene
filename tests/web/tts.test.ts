import { describe, expect, test } from "bun:test";
import { base64ToArrayBuffer, splitSpeech } from "../../src/web/voice/tts";

describe("TTS 断句（纯函数）", () => {
  test("只在整句出现后才产出片段，未完成的尾巴留在 rest", () => {
    const first = splitSpeech("欢迎光临。今晚");
    expect(first.segments).toEqual(["欢迎光临。"]);
    expect(first.rest).toBe("今晚");

    const second = splitSpeech(`${first.rest}的雨很大！`);
    expect(second.segments).toEqual(["今晚的雨很大！"]);
    expect(second.rest).toBe("");
  });

  test("flush 时把残句也读出来", () => {
    const held = splitSpeech("雨停之前别急着走", { flush: false });
    expect(held.segments).toEqual([]);
    expect(held.rest).toBe("雨停之前别急着走");

    const flushed = splitSpeech("雨停之前别急着走", { flush: true });
    expect(flushed.segments).toEqual(["雨停之前别急着走"]);
    expect(flushed.rest).toBe("");
  });

  test("没有标点的长文本会被切块，保证能开口", () => {
    const long = "雨".repeat(120);
    const { segments, rest } = splitSpeech(long);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => s.length <= 84)).toBe(true);
    expect(rest.length).toBeLessThanOrEqual(84);
  });

  test("长句在软停顿处换气，且不丢字", () => {
    // 超过 42 字后遇到的第一个逗号处换气
    const text = `${"雨".repeat(50)}，然后她说，打烊前最后一杯咖啡是免费的。`;
    const { segments } = splitSpeech(text, { flush: true });
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.join("")).toBe(text);
  });
});

describe("音频分片解码", () => {
  test("base64 与 data URL 两种形态都能还原字节", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const base64 = btoa(String.fromCharCode(...bytes));

    const plain = new Uint8Array(base64ToArrayBuffer(base64));
    expect(Array.from(plain)).toEqual([0, 1, 2, 250, 255]);

    const dataUrl = new Uint8Array(base64ToArrayBuffer(`data:audio/mpeg;base64,${base64}`));
    expect(Array.from(dataUrl)).toEqual([0, 1, 2, 250, 255]);
  });
});
