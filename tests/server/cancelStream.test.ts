/**
 * 问题 3：服务端 cancel 之后是否还在往客户端推事件。
 *
 * 假导演**故意不理会** AbortSignal（真实导演如果忘了检查 signal 就是这个样子），
 * 于是这条测试能直接看到：cancel 之后 push 有没有被拦住、循环有没有停下来。
 */
import { describe, expect, test } from "bun:test";
import { createApp, type App } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import type { CancelResult, Director, DirectorInput, SessionEvent } from "../../src/shared/protocol.ts";

const testConfig = loadConfig({ NODE_ENV: "development" });

/** 完全无视 signal 的导演：每 5ms 吐一条，共 total 条 */
class StubbornDirector implements Director {
  readonly name = "stubborn";
  readonly total: number;
  yielded = 0;

  constructor(total = 40) {
    this.total = total;
  }

  async *stream(input: DirectorInput, _signal: AbortSignal): AsyncIterable<SessionEvent> {
    for (let i = 0; i < this.total; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      this.yielded += 1;
      yield { type: "text.delta", turnId: input.turnId, epoch: input.epoch, text: `第${i}段。` };
    }
  }
}

function turnBody(): Record<string, unknown> {
  return {
    sessionId: "sess-cancel",
    turnId: "turn-cancel-stream",
    epoch: 4,
    userText: "外面雨好大",
    scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
    history: [],
  };
}

interface Outcome {
  events: SessionEvent[];
  afterCancel: SessionEvent[];
  cancelledAt: number;
  director: StubbornDirector;
}

/** 读到第一条 text.delta 就 cancel，然后继续把流读完，记录 cancel 之后还收到哪些事件 */
async function cancelMidStream(app: App, director: StubbornDirector): Promise<Outcome> {
  const response = await app.fetch(
    new Request("http://localhost/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turnBody()),
    }),
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const events: SessionEvent[] = [];
  const afterCancel: SessionEvent[] = [];
  let cancelledAt = -1;
  let cancelResult: CancelResult | null = null;

  const decoder = new TextDecoder();
  let buffer = "";

  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      if (!frame.trim()) continue;
      const event = JSON.parse(frame.replace(/^data: /, "")) as SessionEvent;
      events.push(event);
      if (cancelledAt >= 0) afterCancel.push(event);

      if (cancelledAt < 0 && event.type === "text.delta") {
        const cancelResponse = await app.fetch(
          new Request("http://localhost/api/turn/turn-cancel-stream/cancel", { method: "POST" }),
        );
        cancelResult = (await cancelResponse.json()) as CancelResult;
        cancelledAt = events.length - 1;
      }
    }
  }

  expect(cancelResult?.cancelled).toBe(true);
  return { events, afterCancel, cancelledAt, director };
}

describe("cancel 之后服务端不再产出", () => {
  test("cancel 之前的台词正常送达（修复没有把整条流静音）", async () => {
    const director = new StubbornDirector(8);
    const app = createApp({ config: testConfig, director });
    const { events, cancelledAt } = await cancelMidStream(app, director);

    expect(events[0]?.type).toBe("turn.start");
    const beforeCancel = events.slice(0, cancelledAt + 1).filter((event) => event.type === "text.delta");
    expect(beforeCancel.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)?.type).toBe("turn.end");
  });

  test("修复后：cancel 之后不再推任何导演事件，循环就地 break", async () => {
    const director = new StubbornDirector();
    const app = createApp({ config: testConfig, director });
    const { afterCancel, director: used } = await cancelMidStream(app, director);

    // 只允许收尾的 turn.end（interrupted=true），不允许任何台词继续冒出来
    const deltasAfterCancel = afterCancel.filter((event) => event.type === "text.delta");
    expect(deltasAfterCancel).toHaveLength(0);
    expect(afterCancel.every((event) => event.type === "turn.end")).toBe(true);
    const end = afterCancel.find((event) => event.type === "turn.end");
    expect(end?.type === "turn.end" ? end.interrupted : false).toBe(true);

    // 导演没有被继续消费：明显早于 total 就停了
    expect(used.yielded).toBeLessThan(used.total);
    expect(used.yielded).toBeLessThanOrEqual(3);
  });
});
