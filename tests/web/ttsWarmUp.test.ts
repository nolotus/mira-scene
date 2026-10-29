/**
 * 首句 TTS 预热测试。
 *
 * 预热 = 在用户还在打字/说话的时候，先发一次**极短**的合成请求，
 * 把上游的连接冷启（Edge WS 握手实测约 1.2s）挪出首句的关键路径。
 *
 * 约束：
 *  · 只做一次（重复 warmUp 不重复预热）；
 *  · 预热文本必须极短、且落在同一条合成路上（中文走 Edge，纯英文走 Deepgram）；
 *  · 预热的音频不进播放器（预热只是捂热连接）。
 */
import { describe, expect, test } from "bun:test";
import { RoutedTTS, type SpeakRequest } from "../../src/web/voice/tts";

function makeTts(status: { tts: boolean; ttsZh: boolean }): {
  tts: RoutedTTS;
  texts: string[];
} {
  const texts: string[] = [];
  const speakRequest: SpeakRequest = async (text) => {
    texts.push(text);
    return { ok: true, bytes: new Uint8Array(8).buffer };
  };
  const tts = new RoutedTTS({
    getStatus: () => status,
    speakRequest,
    speakStream: null,
  });
  return { tts, texts };
}

describe("首句预热", () => {
  test("warmUp 触发一次极短的预热请求", () => {
    const { tts, texts } = makeTts({ tts: false, ttsZh: true });
    tts.warmUp();
    expect(texts.length).toBe(1);
    expect(texts[0]?.length ?? 99).toBeLessThanOrEqual(2);
    expect(texts[0]).toContain("。");
  });

  test("重复 warmUp 不重复预热（只捂一次）", () => {
    const { tts, texts } = makeTts({ tts: false, ttsZh: true });
    tts.warmUp();
    tts.warmUp();
    tts.warmUp();
    expect(texts.length).toBe(1);
  });

  test("纯英文时预热文本走英文那一路", () => {
    const { tts, texts } = makeTts({ tts: true, ttsZh: false });
    tts.warmUp();
    expect(texts.length).toBe(1);
    expect(texts[0]).toBe("ok");
  });

  test("服务端音色不可用时不预热（不白烧一次请求）", () => {
    const { tts, texts } = makeTts({ tts: false, ttsZh: false });
    tts.warmUp();
    expect(texts.length).toBe(0);
  });
});
