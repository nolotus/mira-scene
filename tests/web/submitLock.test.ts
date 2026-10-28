/**
 * 问题 2：`submit` 的并发锁。
 *
 * 第一个 test 是「复现」：让 `init()`（createSession）挂住，同一时刻连点两次提交，
 * 断言**修复前**真的会发出两个共享同一 epoch 的 `/api/turn` 请求。
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionInfo, TurnRequest } from "../../src/shared/protocol";
import type { HealthInfo, SessionApi, StreamOptions, TurnStreamHandlers } from "../../src/web/state/api";
import { ApiError } from "../../src/web/state/api";
import { SessionStore } from "../../src/web/state/store";
import type { AudioChunk, TTSProvider } from "../../src/web/voice/tts";

class FakeTts implements TTSProvider {
  readonly name = "fake-tts";
  spoken: string[] = [];
  cancels = 0;
  flushes = 0;
  get isSpeaking(): boolean {
    return false;
  }
  speak(text: string): void {
    this.spoken.push(text);
  }
  flush(): void {
    this.flushes += 1;
  }
  cancel(): void {
    this.cancels += 1;
  }
  dispose(): void {
    /* noop */
  }
  pushChunk(_chunk: AudioChunk): void {
    /* noop */
  }
}

/** createSession 挂住，直到 `release()`：把「会话未就绪」这个窗口在测试里变成可控的 */
class SlowSessionApi implements SessionApi {
  requests: TurnRequest[] = [];
  cancelled: Array<{ turnId: string; epoch: number }> = [];
  healthCalls = 0;
  createSessionCalls = 0;
  liveStreams = 0;
  peakLiveStreams = 0;
  /** true = 建会话立刻返回（不需要 release()，用于「会话已就绪」的场景） */
  open = false;

  #release: Array<() => void> = [];

  async health(): Promise<HealthInfo> {
    this.healthCalls += 1;
    return { ok: true, mode: "mock" };
  }

  async createSession(): Promise<SessionInfo> {
    this.createSessionCalls += 1;
    const seq = this.createSessionCalls;
    if (!this.open) {
      await new Promise<void>((resolve) => {
        this.#release.push(resolve);
      });
    }
    return { sessionId: `session-${seq}`, mode: "mock", directorName: "mock", keyless: true };
  }

  streamTurn(
    req: TurnRequest,
    _handlers: TurnStreamHandlers,
    opts?: StreamOptions,
  ): Promise<void> {
    this.requests.push(req);
    this.liveStreams += 1;
    this.peakLiveStreams = Math.max(this.peakLiveStreams, this.liveStreams);
    return new Promise<void>((_resolve, reject) => {
      const settle = () => {
        this.liveStreams -= 1;
      };
      opts?.signal?.addEventListener(
        "abort",
        () => {
          settle();
          reject(new ApiError("aborted", "请求已取消"));
        },
        { once: true },
      );
    });
  }

  async cancelTurn(turnId: string, epoch: number) {
    this.cancelled.push({ turnId, epoch });
    return { cancelled: true, epoch };
  }

  release(): void {
    const pending = this.#release;
    this.#release = [];
    for (const resolve of pending) resolve();
  }

  emit(_event: SessionEvent): void {
    /* 本文件不需要下行事件 */
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("submit 并发锁：会话未就绪窗口里的第二次提交", () => {
  test("会话未就绪窗口连点两次：只发一条请求（修复前是两条共享同一 epoch 的请求）", async () => {
    const api = new SlowSessionApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "stream" });

    const first = store.submit("今晚还开门吗？");
    const second = store.submit("今晚还开门吗？");
    await flush();

    // 这一瞬间 turnActive 仍是 false（init 没回来）—— 闸门必须靠 startingTurn，不是靠 turnActive
    expect(store.getSnapshot().machine.turnActive).toBe(false);

    api.release();
    await flush();
    await flush();

    // 修复前这里会看到 2 条 /api/turn，且两条 epoch 相同
    expect(api.requests).toHaveLength(1);
    expect(api.createSessionCalls).toBe(1);

    store.dispose();
    void first;
    void second;
  });

  test("修复后：未就绪窗口内的第二次提交被丢弃，只产生一个请求、一次建会话", async () => {
    const api = new SlowSessionApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "stream" });

    const first = store.submit("今晚还开门吗？");
    const second = store.submit("今晚还开门吗？");
    await flush();

    expect(api.createSessionCalls).toBe(1);
    expect(store.getSnapshot().droppedSubmits).toBe(1);
    expect(store.getSnapshot().banner?.text).toContain("已有一轮在进行");

    api.release();
    await flush();
    await flush();

    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.userText).toBe("今晚还开门吗？");
    expect(store.getSnapshot().machine.turnActive).toBe(true);

    store.dispose();
    void first;
    void second;
  });

  test("修复后：同一时刻最多一个 in-flight turn（连点 5 次）", async () => {
    const api = new SlowSessionApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "stream" });

    const pending = [
      store.submit("第一句"),
      store.submit("第二句"),
      store.submit("第三句"),
      store.submit("第四句"),
      store.submit("第五句"),
    ];
    await flush();
    api.release();
    await flush();
    await flush();

    expect(api.requests).toHaveLength(1);
    expect(api.createSessionCalls).toBe(1);
    expect(api.peakLiveStreams).toBeLessThanOrEqual(1);
    expect(store.getSnapshot().droppedSubmits).toBe(4);

    store.dispose();
    void pending;
  });

  test("修复不误伤正常打断：一轮在跑时用户再说话，仍然是打断 + 新的一轮", async () => {
    const api = new SlowSessionApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "stream" });
    api.open = true; // 会话立刻可用：直接测「已就绪后的一轮在跑时插话」

    const first = store.submit("今晚还开门吗？");
    await flush();
    expect(api.requests).toHaveLength(1);
    const firstEpoch = api.requests[0]!.epoch;

    // 角色还在说，用户插话：这是设计内的 barge-in，不能被并发锁挡掉
    const second = store.submit("等等，你刚才说什么？");
    await flush();

    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]!.epoch).toBe(firstEpoch + 1); // 打断必然换 epoch
    expect(api.requests[1]!.userText).toBe("等等，你刚才说什么？");
    expect(api.cancelled).toHaveLength(1);
    expect(store.getSnapshot().droppedSubmits).toBe(0);

    void first;
    void second;
  });
});
