/**
 * 打断链路的服务端一环：客户端断开/中止 → 上游合成立刻中止。
 *
 * 这是「下一轮不必等旧轮的 TTS 队列排空」的最后一环：
 * 客户端 abort 掉那条 /api/tts 请求 → 服务端把 abort 透传给 Edge WS →
 * 那条连接立刻弃掉、并发名额立刻还回池子 → 下一轮的第一句不用排队等它跑完。
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import { createTtsRouter, type TtsProxy } from "../../src/server/tts.ts";
import type { EdgeWsClient } from "../../src/server/edgeTtsWs.ts";

describe("/api/tts 的中止链路", () => {
  test("客户端 abort → 合成请求拿到的 signal 立刻 aborted", async () => {
    let captured: AbortSignal | undefined;
    const tts: TtsProxy = {
      configured: true,
      async synthesize(_raw, opts) {
        captured = opts?.signal;
        return { ok: true, bytes: new Uint8Array([1, 2, 3]), mime: "audio/mpeg" };
      },
    };
    const app = createApp({ tts });
    const controller = new AbortController();
    const request = new Request("http://localhost/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好。" }),
      signal: controller.signal,
    });
    const response = await app.fetch(request);
    expect(response.status).toBe(200);
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);

    controller.abort();
    expect(captured?.aborted).toBe(true);
  });

  test("路由层把 signal 透传给 Edge WS（打断即弃连）", async () => {
    let captured: AbortSignal | undefined;
    const edgeWs: EdgeWsClient = {
      async *synthesizeStream(_text, _params, signal) {
        captured = signal;
        yield new Uint8Array([1, 2, 3]);
      },
      stats: { active: 0, queued: 0, open: 0, connects: 0, lastDrop: null },
      close() {},
      async serverTime() {
        return null;
      },
    };
    const fakeEdge = {
      bin: "edge-tts",
      voice: "zh-CN-XiaoxiaoNeural",
      rate: "+0%",
      pitch: "+0Hz",
      available: true,
      async probe() {
        return true;
      },
      async synthesize() {
        return { ok: false as const, reason: "tts-unavailable" as const };
      },
      stats: { active: 0, queued: 0 },
    };
    const router = createTtsRouter({
      deepgram: null,
      edge: fakeEdge,
      edgeWs,
      edgeVoice: { voice: "zh-CN-XiaoxiaoNeural", rate: "+0%", pitch: "+0Hz" },
    });
    const controller = new AbortController();
    const result = await router.synthesize({ text: "你好。" }, { signal: controller.signal });
    expect(result.ok).toBe(true);
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);

    controller.abort();
    expect(captured?.aborted).toBe(true);
  });

  test("英文那一路（Deepgram 代理）也吃 signal", async () => {
    let captured: AbortSignal | undefined;
    const router = createTtsRouter({
      deepgram: {
        configured: true,
        async synthesize(_raw, opts) {
          captured = opts?.signal;
          return { ok: true, bytes: new Uint8Array([1]), mime: "audio/mpeg" };
        },
      },
      edge: null,
    });
    const controller = new AbortController();
    const result = await router.synthesize({ text: "hello there" }, { signal: controller.signal });
    expect(result.ok).toBe(true);
    expect(captured).toBeDefined();
    controller.abort();
    expect(captured?.aborted).toBe(true);
  });
});
