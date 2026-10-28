/**
 * `POST /api/tts?stream=1`：边收边转发。
 *
 * 三个必须成立的点：
 *  1. 显式要流式时才 chunked；**不带 stream 的响应与改造前一致**（有 content-length、整块 MP3）；
 *  2. 第一块早于最后一块到达（不是攒完再发）；
 *  3. 还没开始转发就失败时，沿用原来的 JSON `{reason}` 契约。
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import type { TtsProxy, TtsStreamResult } from "../../src/server/tts.ts";

const METHOD_BODY = { text: "你好。" };

interface FakeOptions {
  stream?: () => Promise<TtsStreamResult>;
  chunks?: Uint8Array[];
  delayMs?: number;
}

function fakeTts(options: FakeOptions = {}): TtsProxy {
  const full = options.chunks ?? [new Uint8Array([1, 2, 3])];
  return {
    configured: true,
    async synthesize() {
      const total = full.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of full) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { ok: true, bytes: merged, mime: "audio/mpeg" };
    },
    synthesizeStream:
      options.stream ??
      (async () => ({
        ok: true,
        mime: "audio/mpeg",
        source: "native",
        chunks: (async function* () {
          for (const chunk of full) {
            if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            yield chunk;
          }
        })(),
      })),
  };
}

function post(path: string, headers: Record<string, string> = {}, body: unknown = METHOD_BODY) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function readAll(res: Response): Promise<{ chunks: Uint8Array[]; times: number[] }> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  const times: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      times.push(performance.now());
    }
  }
  return { chunks, times };
}

describe("?stream=1：chunked，且第一块早于最后一块", () => {
  test("三块逐块到达，没有 content-length", async () => {
    const app = createApp({
      config: loadConfig({}),
      tts: fakeTts({ chunks: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])] }),
    });
    const res = await app.fetch(post("/api/tts?stream=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    // 没有长度 = 走 chunked（有长度就不可能「边收边发」）
    expect(res.headers.get("content-length")).toBeNull();

    const { chunks, times } = await readAll(res);
    expect(chunks.map((chunk) => Array.from(chunk))).toEqual([[1], [2], [3]]);
    // 第一块严格早于最后一块：证明是逐块转发，不是攒完再发
    expect(times[0]!).toBeLessThan(times[times.length - 1]!);
  });

  test("`Accept: audio/mpeg` 等价于 ?stream=1", async () => {
    const app = createApp({ config: loadConfig({}), tts: fakeTts() });
    const res = await app.fetch(post("/api/tts", { accept: "audio/mpeg" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
  });

  test("还没转发就失败 → 原 JSON 契约（status + reason）", async () => {
    const app = createApp({
      config: loadConfig({}),
      tts: fakeTts({
        stream: async () => ({ ok: false, status: 503, reason: "tts-unavailable" }),
      }),
    });
    const res = await app.fetch(post("/api/tts?stream=1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ reason: "tts-unavailable" });
  });
});

describe("不带 stream：行为不变", () => {
  test("整块 MP3 + content-length（既有客户端不受影响）", async () => {
    const app = createApp({
      config: loadConfig({}),
      tts: fakeTts({ chunks: [new Uint8Array([1, 2]), new Uint8Array([3])] }),
    });
    const res = await app.fetch(post("/api/tts"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("3");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  test("浏览器默认的 `Accept: */*` 不会被误判成流式", async () => {
    const app = createApp({ config: loadConfig({}), tts: fakeTts() });
    const res = await app.fetch(post("/api/tts", { accept: "*/*" }));
    expect(res.headers.get("content-length")).toBe("3");
  });

  test("出错的响应体里没有多余字段（只有 reason）", async () => {
    const app = createApp({
      config: loadConfig({}),
      tts: {
        configured: true,
        async synthesize() {
          return { ok: false, status: 400, reason: "text-required" };
        },
      },
    });
    const res = await app.fetch(post("/api/tts", {}, {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "text-required" });
  });
});
