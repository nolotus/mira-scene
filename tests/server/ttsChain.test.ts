/**
 * 中文三级链：**native → CLI → tts-unavailable**（含 `ETTS_MODE=cli` 与「首次失败即降级并记住」）。
 *
 * 全部用假实现：假 WS（可控制成功/失败/中途断流）、假 CLI（只计数）。
 * 这里验证的是**链路的决策**，不是音频质量。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createTtsRouter } from "../../src/server/tts.ts";
import type { EdgeTtsSynthesizer } from "../../src/server/edgeTts.ts";
import { EdgeWsError, type EdgeWsClient, type EdgeVoiceParams } from "../../src/server/edgeTtsWs.ts";

const PARAMS: EdgeVoiceParams = {
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "-8%",
  pitch: "-3Hz",
};

interface FakeCli {
  synth: EdgeTtsSynthesizer;
  calls: () => number;
}

function fakeCli(options: { ok?: boolean; available?: boolean; bytes?: number[] } = {}): FakeCli {
  let calls = 0;
  const ok = options.ok ?? true;
  const bytes = new Uint8Array(options.bytes ?? [0x11, 0x22]);
  const synth = {
    bin: "edge-tts",
    voice: PARAMS.voice,
    rate: PARAMS.rate,
    pitch: PARAMS.pitch,
    available: options.available ?? true,
    probe: async () => options.available ?? true,
    stats: { active: 0, queued: 0 },
    async synthesize() {
      calls += 1;
      return ok ? { ok: true as const, bytes, mime: "audio/mpeg" as const } : { ok: false as const, reason: "tts-unavailable" as const };
    },
  } as unknown as EdgeTtsSynthesizer;
  return { synth, calls: () => calls };
}

interface FakeWs {
  client: EdgeWsClient;
  calls: () => number;
}

function fakeWs(options: { chunks?: number[][]; fail?: boolean; failAfterFirst?: boolean } = {}): FakeWs {
  let calls = 0;
  const chunks = options.chunks ?? [[0xaa], [0xbb]];
  const client: EdgeWsClient = {
    stats: { active: 0, queued: 0, open: 0, connects: 0, lastDrop: null },
    close() {},
    serverTime: async () => null,
    async *synthesizeStream(_text: string, _params: EdgeVoiceParams) {
      calls += 1;
      if (options.fail) throw new EdgeWsError("auth");
      for (let index = 0; index < chunks.length; index += 1) {
        if (options.failAfterFirst && index === 1) throw new EdgeWsError("closed");
        yield new Uint8Array(chunks[index]!);
      }
    },
  };
  return { client, calls: () => calls };
}

function router(options: { cli?: FakeCli; ws?: FakeWs; mode?: "auto" | "cli" } = {}) {
  const cli = options.cli ?? fakeCli();
  const created = createTtsRouter({
    deepgram: null,
    edge: cli.synth,
    edgeWs: options.ws?.client ?? null,
    edgeVoice: PARAMS,
    mode: options.mode,
    log: () => {},
  });
  return { tts: created, cli, ws: options.ws };
}

const ZH = { text: "你好，我是角色。" };

afterEach(() => {
  delete process.env.ETTS_MODE;
});

describe("native → CLI → unavailable", () => {
  test("原生成功：不碰 CLI，字节是多块拼起来的", async () => {
    const { tts, cli, ws } = router({ ws: fakeWs({ chunks: [[1], [2, 3]] }) });
    const result = await tts.synthesize(ZH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    expect(cli.calls()).toBe(0);
    expect(ws!.calls()).toBe(1);
    expect(tts.native.enabled).toBe(true);
  });

  test("原生失败 → CLI 被调用，结果来自 CLI", async () => {
    const { tts, cli, ws } = router({ ws: fakeWs({ fail: true }), cli: fakeCli({ bytes: [9, 8, 7] }) });
    const result = await tts.synthesize(ZH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.bytes)).toEqual([9, 8, 7]);
    expect(cli.calls()).toBe(1);
    expect(ws!.calls()).toBe(1);
  });

  test("原生中途断流（已经拿到过一块）→ 非流式仍可整段回退 CLI", async () => {
    const { tts, cli } = router({ ws: fakeWs({ failAfterFirst: true }), cli: fakeCli({ bytes: [4] }) });
    const result = await tts.synthesize(ZH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.bytes)).toEqual([4]);
    expect(cli.calls()).toBe(1);
  });

  test("两条都失败 → 503 tts-unavailable（客户端据此回退浏览器）", async () => {
    const { tts } = router({ ws: fakeWs({ fail: true }), cli: fakeCli({ ok: false }) });
    const result = await tts.synthesize(ZH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.reason).toBe("tts-unavailable");
  });

  test("首次失败即降级并记住：第二句不再白等原生", async () => {
    const { tts, cli, ws } = router({ ws: fakeWs({ fail: true }), cli: fakeCli({ bytes: [5] }) });
    await tts.synthesize({ text: "第一句。" });
    await tts.synthesize({ text: "第二句。" });
    expect(ws!.calls()).toBe(1); // 只试过一次
    expect(cli.calls()).toBe(2);
    expect(tts.native.enabled).toBe(false);
    expect(tts.native.offReason).toBe("auth");
  });

  test("ETTS_MODE=cli 或 mode:\"cli\" → 原生一次都不试", async () => {
    const explicit = router({ ws: fakeWs(), mode: "cli" });
    await explicit.tts.synthesize(ZH);
    expect(explicit.ws!.calls()).toBe(0);
    expect(explicit.cli.calls()).toBe(1);
    expect(explicit.tts.native.offReason).toBe("mode-cli");

    process.env.ETTS_MODE = "cli";
    const fromEnv = router({ ws: fakeWs() });
    await fromEnv.tts.synthesize(ZH);
    expect(fromEnv.ws!.calls()).toBe(0);
    expect(fromEnv.tts.native.offReason).toBe("mode-cli");
  });
});

describe("缓存策略", () => {
  test("非流式：命中整块缓存（键含 voice/rate/pitch），第二次不再合成", async () => {
    const { tts, cli, ws } = router({ ws: fakeWs({ chunks: [[1, 2]] }) });
    await tts.synthesize(ZH);
    await tts.synthesize(ZH);
    expect(ws!.calls()).toBe(1);
    expect(cli.calls()).toBe(0);
    expect(tts.cache.size).toBe(1);
  });

  test("流式：**只读不写** —— 首次不进缓存，命中已有的整块缓存时一块吐出", async () => {
    const { tts, ws } = router({ ws: fakeWs({ chunks: [[1], [2]] }) });
    const first = await tts.synthesizeStream(ZH);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.source).toBe("native");
    expect(tts.cache.size).toBe(0); // 流式不落缓存

    // 非流式调用一次 → 缓存建立
    await tts.synthesize(ZH);
    expect(tts.cache.size).toBe(1);

    const second = await tts.synthesizeStream(ZH);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.source).toBe("cache");
    const chunks: Uint8Array[] = [];
    for await (const chunk of second.chunks) chunks.push(chunk);
    expect(chunks).toHaveLength(1); // 整块一次性
    void ws;
  });

  test("流式：原生失败 → CLI 整块作为一个分片", async () => {
    const { tts } = router({ ws: fakeWs({ fail: true }), cli: fakeCli({ bytes: [3, 3, 3] }) });
    const result = await tts.synthesizeStream(ZH);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("cli");
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.chunks) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0]!)).toEqual([3, 3, 3]);
  });

  test("流式：两条都失败 → 还没转发就回 503（沿用 JSON 契约）", async () => {
    const { tts } = router({ ws: fakeWs({ fail: true }), cli: fakeCli({ ok: false }) });
    const result = await tts.synthesizeStream(ZH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.reason).toBe("tts-unavailable");
  });
});

describe("分流与入参校验不变（向后兼容）", () => {
  test("中文 400 级别校验：缺 text / 空文本 / 超长", async () => {
    const { tts } = router({ ws: fakeWs() });
    expect(await tts.synthesize({})).toEqual({ ok: false, status: 400, reason: "text-required" });
    expect(await tts.synthesize({ text: "   " })).toEqual({ ok: false, status: 400, reason: "text-required" });
    expect(await tts.synthesize({ text: "字".repeat(401) })).toEqual({
      ok: false,
      status: 400,
      reason: "text-too-long",
    });
  });

  test("纯英文不进 Edge：没有 Deepgram 时是 not-configured", async () => {
    const { tts, cli, ws } = router({ ws: fakeWs() });
    const result = await tts.synthesize({ text: "hello there" });
    expect(result).toEqual({ ok: false, status: 503, reason: "not-configured" });
    expect(cli.calls()).toBe(0);
    expect(ws!.calls()).toBe(0);
  });
});
