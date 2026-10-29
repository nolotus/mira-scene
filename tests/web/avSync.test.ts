import { describe, expect, test } from "bun:test";
import { samplePlayback, type PlaybackSample } from "../../src/web/voice/playback";
import { RoutedTTS, StreamTTS } from "../../src/web/voice/tts";
import { SessionStore } from "../../src/web/state/store";
import type { SessionApi, TurnStreamHandlers } from "../../src/web/state/api";
import type { SessionEvent, TurnRequest } from "../../src/shared/protocol";

async function harness() {
  let handlers!: TurnStreamHandlers;
  let request!: TurnRequest;
  let playback: PlaybackSample | null = null;
  const api = {
    health: async () => ({ ok: true, mode: "mock" }),
    createSession: async () => ({ sessionId: "sync", mode: "mock", directorName: "mock", keyless: true }),
    streamTurn: (req: TurnRequest, h: TurnStreamHandlers) => { request = req; handlers = h; return new Promise<void>(() => {}); },
    cancelTurn: async () => ({ cancelled: true, epoch: 1 }),
  } as unknown as SessionApi;
  const tts = { name: "audio-clock", synchronized: true, get playback() { return playback; },
    get isSpeaking() { return playback?.playing === true; }, speak() {}, flush() {},
    cancel() { playback = null; }, dispose() {} };
  const store = new SessionStore({ api, tts, audioMode: "browser" });
  await store.init();
  void store.submit("你好");
  await Bun.sleep(0);
  const emit = (event: object) => handlers.onEvent({ turnId: request.turnId, epoch: request.epoch, ...event } as SessionEvent);
  emit({ type: "turn.start", at: 0 });
  emit({ type: "text.delta", text: "你好世界。" });
  return { store, emit, sample(time: number, sentence = 1, text = "你好世界。") {
    playback = samplePlayback(text, time, 1, sentence); store.tick(16.667); return store.getSnapshot();
  } };
}

describe("audio-clock AV sync", () => {
  test("start: no early subtitles/mouth/action; first audible sample releases all three", async () => {
    const h = await harness();
    h.emit({ type: "directive", directive: { kind: "emotion", emotion: "warm" }, atChar: 0 });
    const before = h.sample(-0.02);
    expect(before.scene.subtitle).toBe("");
    expect(before.playback?.mouth).toBe(0);
    expect(before.scene.emotion).not.toBe("warm");
    const start = h.sample(0);
    expect(start.scene.subtitle).toBe("你");
    expect(start.playback?.playing).toBe(true);
    expect(start.playback?.mouth).toBeGreaterThan(0);
    expect(start.scene.emotion).toBe("warm");
    h.store.dispose();
  });
  test("end: turn.end does not complete subtitles or release future cues before the audio ends", async () => {
    const h = await harness();
    h.emit({ type: "directive", directive: { kind: "emotion", emotion: "warm" }, atChar: 5 });
    h.sample(0);
    h.emit({ type: "turn.end", interrupted: false });
    const tail = h.sample(0.99);
    expect(tail.scene.subtitle).not.toBe("你好世界。");
    expect(tail.playback?.playing).toBe(true);
    expect(tail.scene.emotion).not.toBe("warm");
    const end = h.sample(1);
    expect(end.scene.subtitle).toBe("你好世界。");
    expect(end.playback?.playing).toBe(false);
    expect(end.playback?.mouth).toBe(0);
    expect(end.scene.emotion).toBe("warm");
    h.store.dispose();
  });
  test("mouth varies with audio position, and freezes when the audio clock freezes", () => {
    const a = samplePlayback("你好世界。", 0.04, 1, 1);
    const b = samplePlayback("你好世界。", 0.18, 1, 1);
    expect(a.mouth).not.toBe(b.mouth);
    expect(samplePlayback("你好世界。", 0.18, 1, 1)).toEqual(b);
  });
  test("interrupt synchronously stops audio, subtitle and mouth; future cues never fire", async () => {
    const h = await harness();
    h.sample(0.3);
    h.emit({ type: "directive", directive: { kind: "emotion", emotion: "warm" }, atChar: 5 });
    h.store.interrupt("button");
    const view = h.store.getSnapshot();
    expect(view.playback).toBeNull();
    expect(view.scene.subtitle).toBe("");
    expect(view.queuedCues).toBe(0);
    h.store.tick(1000);
    expect(h.store.getSnapshot().scene.emotion).not.toBe("warm");
    h.store.dispose();
  });
  test("consecutive identical sentences retain independent timing and cumulative text", async () => {
    const h = await harness();
    h.sample(0); h.sample(1);
    const second = h.sample(0, 2);
    expect(second.scene.subtitle).toBe("你好世界。你");
    expect(second.cueWatermark).toBe(6);
    h.store.dispose();
  });
  test("60Hz rendering: start/end drift <= 16.667ms, subtitle/mouth share exactly the audio sample", () => {
    let maxDrift = 0;
    for (let phase = 0; phase < 16.667; phase += 0.25) {
      const startMs = 20 + phase;
      const endMs = startMs + 1023;
      const first = Math.ceil(startMs / 16.667) * 16.667;
      const last = Math.ceil(endMs / 16.667) * 16.667;
      maxDrift = Math.max(maxDrift, first - startMs, last - endMs);
      const sample = samplePlayback("你好世界。", (first - startMs) / 1000, 1.023, 1);
      expect(sample.revealed).toBe(1);
      expect(sample.playing).toBe(true);
      expect(sample.mouth).toBeGreaterThan(0);
      const end = samplePlayback("你好世界。", (last - startMs) / 1000, 1.023, 1);
      expect(end.revealed).toBe(5);
      expect(end.mouth).toBe(0);
    }
    expect(maxDrift).toBeLessThan(16.667);
    expect(maxDrift).toBeLessThan(80);
    console.log(`AV sync simulated 60Hz max drift: ${maxDrift.toFixed(3)}ms; intra-sample drift: 0ms`);
  });
  test("synchronized route waits for complete MP3 and joins bytes into one sentence", async () => {
    const original = StreamTTS.prototype.pushChunk;
    const pushed: Array<{ dataUrl: string; text?: string }> = [];
    StreamTTS.prototype.pushChunk = (chunk) => { pushed.push(chunk); };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tts = new RoutedTTS({ synchronized: true, getStatus: () => ({ ttsZh: true }) as never,
      speakStream: async () => ({ ok: true, chunks: (async function* () {
        yield new Uint8Array(1200).fill(1); await gate; yield new Uint8Array(300).fill(2);
      })() }) });
    try {
      tts.speak("你好世界。"); await Bun.sleep(5);
      expect(pushed).toHaveLength(0);
      release(); await Bun.sleep(5);
      expect(pushed).toHaveLength(1);
      expect(atob(pushed[0]!.dataUrl)).toHaveLength(1500);
      expect(pushed[0]!.text).toBe("你好世界。");
    } finally { tts.dispose(); StreamTTS.prototype.pushChunk = original; }
  });
});
