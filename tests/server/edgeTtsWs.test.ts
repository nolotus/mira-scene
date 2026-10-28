/**
 * 原生 WS 客户端：帧编解码 + 连接复用 + 并发上限 + 失败类别 + 弃连诊断。
 *
 * 纪律：**不联网、不真连 WS**。`connect` 注入假 socket；`now`/`serverTime`/`tokenFor` 都可钉死，
 * 所以令牌与时钟偏移的行为是确定的，不依赖本机时间。
 *
 * 时序约定：假 socket 在 `queueMicrotask` 里 open（必须早于发帧，否则请求会挂在握手上）；
 * 测试脚本挂在「ssml 帧发出」这一刻，此时客户端已经准备好接收（`conn.current` 已就位）。
 */
import { describe, expect, test } from "bun:test";
import {
  EdgeWsError,
  createEdgeWsClient,
  decodeBinaryFrame,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  secMsGecToken,
  type WsLike,
} from "../../src/server/edgeTtsWs.ts";
import { generateSecMsGec } from "../../src/server/edgeTtsDrm.ts";

const PARAMS = { voice: "zh-CN-XiaoxiaoNeural", rate: "-8%", pitch: "-3Hz" };
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 假 socket：`script` 在 ssml 帧发出时跑 */
class FakeWs implements WsLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;

  constructor(private readonly script: (ws: FakeWs) => void = () => {}) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (typeof data === "string" && data.includes("Path:ssml")) this.script(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  audio(bytes: Uint8Array): void {
    this.onmessage?.({
      data: encodeBinaryFrame({ "Content-Type": "audio/mpeg", Path: "audio" }, bytes),
    });
  }

  turnEnd(): void {
    this.onmessage?.({ data: "X-RequestId:abc\r\nPath:turn.end\r\n\r\n" });
  }

  handshakeFail(): void {
    this.onerror?.({});
  }
}

interface FactoryOptions {
  /** ssml 发出后干什么（发音频 / 立刻 turn.end / 什么都不做） */
  script?: (ws: FakeWs, index: number) => void;
  /** 这些序号的连接在握手上失败（模拟 403） */
  failAt?: number[];
}

function factory(options: FactoryOptions = {}) {
  const sockets: FakeWs[] = [];
  const urls: string[] = [];
  const connect = (url: string): WsLike => {
    const index = sockets.length;
    urls.push(url);
    const socket = new FakeWs((self) => options.script?.(self, index));
    sockets.push(socket);
    queueMicrotask(() => {
      if (options.failAt?.includes(index)) socket.handshakeFail();
      else socket.open();
    });
    return socket;
  };
  return { connect, sockets, urls };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

/** 一发音频就结束的脚本 */
const oneShot = (bytes = [1, 2, 3]) => (ws: FakeWs) => {
  ws.audio(new Uint8Array(bytes));
  ws.turnEnd();
};

describe("帧编解码（2 字节大端头长 + 头 + body）", () => {
  test("二进制往返：Path:audio 的头长、body 逐字节一致", () => {
    const body = new TextEncoder().encode("ID3fake-mp3-bytes");
    const frame = encodeBinaryFrame({ "Content-Type": "audio/mpeg", Path: "audio" }, body);
    expect((frame[0]! << 8) | frame[1]!).toBe(frame.byteLength - 2 - body.byteLength);
    const decoded = decodeBinaryFrame(frame);
    expect(decoded.headers["Path"]).toBe("audio");
    expect(decoded.headers["Content-Type"]).toBe("audio/mpeg");
    expect(Buffer.from(decoded.body).equals(Buffer.from(body))).toBe(true);
  });

  test("头长跨 255 的边界（两字节大端，不是一字节）", () => {
    const longValue = "v".repeat(300);
    const frame = encodeBinaryFrame({ Path: "audio", "X-RequestId": longValue }, new Uint8Array([1]));
    const length = (frame[0]! << 8) | frame[1]!;
    expect(length).toBeGreaterThan(255);
    expect(decodeBinaryFrame(frame).headers["X-RequestId"]).toBe(longValue);
  });

  test("空 body 合法；头长越界 / 太短都算协议错", () => {
    const empty = encodeBinaryFrame({ Path: "turn.end" }, new Uint8Array(0));
    expect(decodeBinaryFrame(empty).body.byteLength).toBe(0);
    expect(() => decodeBinaryFrame(new Uint8Array([0]))).toThrow(EdgeWsError);
    expect(() => decodeBinaryFrame(new Uint8Array([0xff, 0xff, 0x41]))).toThrow(EdgeWsError);
  });

  test("文本帧：头以空行结束，body 原样（CJK 按 UTF-8 计长，不受字符数影响）", () => {
    const frame = encodeTextFrame({ Path: "ssml", "X-RequestId": "r1" }, "你好，世界");
    const decoded = decodeTextFrame(frame);
    expect(decoded.headers["Path"]).toBe("ssml");
    expect(new TextDecoder().decode(decoded.body)).toBe("你好，世界");
    expect(() => decodeTextFrame("没有空行")).toThrow(EdgeWsError);
  });

  test("出站 ssml 帧没有 2 字节长度前缀（文本帧，与二进制帧不同）", () => {
    expect(encodeTextFrame({ Path: "ssml" }, "<speak/>").startsWith("Path:ssml")).toBe(true);
  });

  test("令牌走 drm.py 移植版（16 hex + 64 hex），不是标准 SHA-256", () => {
    expect(secMsGecToken(1767225600)).toBe(generateSecMsGec(1767225600));
    expect(secMsGecToken(1767225600)).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
  });
});

describe("连接复用与并发上限", () => {
  test("同参数连续两次请求只建一条连接（复用）", async () => {
    const { connect, sockets } = factory({ script: oneShot() });
    const client = createEdgeWsClient({ connect, now: () => 1767225600, idleMs: 10_000 });
    expect(await collect(client.synthesizeStream("第一句", PARAMS))).toHaveLength(1);
    expect(await collect(client.synthesizeStream("第二句", PARAMS))).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(client.stats.connects).toBe(1);
    expect(client.stats.open).toBe(1);
    client.close();
  });

  test("不同参数各自一条连接（voice 变了就不能复用）", async () => {
    const { connect, sockets } = factory({ script: oneShot([1]) });
    const client = createEdgeWsClient({ connect, now: () => 1767225600, idleMs: 10_000 });
    await collect(client.synthesizeStream("a", PARAMS));
    await collect(client.synthesizeStream("b", { ...PARAMS, voice: "zh-CN-YunxiNeural" }));
    expect(sockets).toHaveLength(2);
    client.close();
  });

  test("并发上限 2：第 3 个排队，不会建第 3 条连接", async () => {
    const { connect, sockets } = factory(); // 脚本什么都不做 → 请求挂住，正好观察并发
    const client = createEdgeWsClient({
      connect,
      now: () => 1767225600,
      idleMs: 0,
      audioTimeoutMs: 5_000,
    });
    const first = client.synthesizeStream("1", PARAMS).next();
    const second = client.synthesizeStream("2", PARAMS).next();
    const third = client.synthesizeStream("3", PARAMS).next();
    await tick(5);
    expect(sockets).toHaveLength(2);
    expect(client.stats.active).toBe(2);
    expect(client.stats.queued).toBe(1);

    sockets[0]!.turnEnd(); // 放掉一个名额：排队的那个才拿到
    await tick(5);
    expect(sockets).toHaveLength(3);
    sockets[1]!.turnEnd();
    sockets[2]!.turnEnd();
    await Promise.all([first, second, third]);
    client.close();
  });

  test("空闲 15s（这里注入 5ms）后关连接，并留下弃连原因", async () => {
    const { connect } = factory({ script: oneShot([1]) });
    const client = createEdgeWsClient({ connect, now: () => 1767225600, idleMs: 5 });
    await collect(client.synthesizeStream("hi", PARAMS));
    expect(client.stats.open).toBe(1);
    await tick(20);
    expect(client.stats.open).toBe(0);
    expect(client.stats.lastDrop?.reason).toBe("idle");
    client.close();
  });
});

describe("失败分类（上层据此回退 CLI）", () => {
  test("6s（注入 20ms）没有任何音频 → timeout，且连接被丢弃", async () => {
    const { connect, sockets } = factory();
    const client = createEdgeWsClient({
      connect,
      now: () => 1767225600,
      audioTimeoutMs: 20,
      idleMs: 10_000,
    });
    let kind = "";
    try {
      await client.synthesizeStream("慢句子", PARAMS).next();
    } catch (error) {
      kind = error instanceof EdgeWsError ? error.kind : "other";
    }
    expect(kind).toBe("timeout");
    expect(sockets[0]!.closed).toBe(true);
    expect(client.stats.open).toBe(0);
    expect(client.stats.lastDrop?.reason).toBe("request-failed");
    client.close();
  });

  test("握手失败 → 取服务端 Date 校正一次后重试；重试令牌按校正后的时间算", async () => {
    const { connect, urls } = factory({ script: oneShot([7]), failAt: [0] });
    const client = createEdgeWsClient({
      connect,
      now: () => 1700000000,
      serverTime: async () => 1767225600,
      idleMs: 0,
    });
    expect(await collect(client.synthesizeStream("重试", PARAMS))).toHaveLength(1);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(`Sec-MS-GEC=${generateSecMsGec(1700000000)}`);
    expect(urls[1]).toContain(`Sec-MS-GEC=${generateSecMsGec(1767225600)}`);
    client.close();
  });

  test("握手失败且拿不到服务端时间 → auth（不是沉默失败）", async () => {
    const { connect } = factory({ failAt: [0] });
    const client = createEdgeWsClient({
      connect,
      now: () => 1767225600,
      serverTime: async () => null,
      idleMs: 0,
    });
    let kind = "";
    try {
      await client.synthesizeStream("x", PARAMS).next();
    } catch (error) {
      kind = error instanceof EdgeWsError ? error.kind : "other";
    }
    expect(kind).toBe("auth");
    client.close();
  });

  test("空文本直接拒（不发帧、不建连）", async () => {
    const { connect, sockets } = factory();
    const client = createEdgeWsClient({ connect, now: () => 1767225600 });
    let kind = "";
    try {
      await client.synthesizeStream("   ", PARAMS).next();
    } catch (error) {
      kind = error instanceof EdgeWsError ? error.kind : "other";
    }
    expect(kind).toBe("empty");
    expect(sockets).toHaveLength(0);
    client.close();
  });
});

describe("日志纪律：只有字节数/帧数/耗时，绝无文本", () => {
  test("成功日志里没有原文，但有 bytes/frames", async () => {
    const lines: string[] = [];
    const secret = "这是一句不该出现在日志里的台词";
    const { connect } = factory({ script: oneShot([1, 2, 3, 4]) });
    const client = createEdgeWsClient({
      connect,
      now: () => 1767225600,
      idleMs: 0,
      log: (line) => lines.push(line),
    });
    await collect(client.synthesizeStream(secret, PARAMS));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("台词");
    }
    expect(lines.join("\n")).toContain("bytes=4");
    expect(lines.join("\n")).toContain("frames=1");
    client.close();
  });

  test("音频分片是逐块吐出的（不是攒成整块）", async () => {
    const { connect } = factory({
      script: (ws) => {
        ws.audio(new Uint8Array([1]));
        ws.audio(new Uint8Array([2]));
        ws.audio(new Uint8Array([3]));
        ws.turnEnd();
      },
    });
    const client = createEdgeWsClient({ connect, now: () => 1767225600, idleMs: 0 });
    const chunks = await collect(client.synthesizeStream("逐块", PARAMS));
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([1, 1, 1]);
    client.close();
  });
});
