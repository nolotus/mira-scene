/**
 * 断线自动重连。
 *
 * 全部用**注入的假定时器 + 假 API + 假联网状态**驱动，所以退避节奏（1/2/4/8/8）、
 * 上限、用户抢先、状态保留都能确定性断言，不依赖 jest 假时钟，也不需要真实等待。
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionInfo, TurnRequest } from "../../src/shared/protocol";
import type {
  HealthInfo,
  SessionApi,
  StreamOptions,
  TurnStreamHandlers,
} from "../../src/web/state/api";
import { ApiError } from "../../src/web/state/api";
import {
  DEFAULT_RECONNECT_POLICY,
  reconnectDelay,
  SessionStore,
  type Connectivity,
  type ReconnectTimers,
} from "../../src/web/state/store";
import type { AudioChunk, TTSProvider } from "../../src/web/voice/tts";

// ---------------------------------------------------------------- 替身

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

/** 假定时器：手动 advance，回调里新排的定时器也会被跑到 */
class FakeTimers implements ReconnectTimers {
  now = 0;
  private seq = 0;
  private readonly scheduled = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.scheduled.set(this.seq, { at: this.now + ms, fn });
    return this.seq;
  }

  clearTimeout(id: unknown): void {
    this.scheduled.delete(id as number);
  }

  get pending(): number {
    return this.scheduled.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.scheduled.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, entry] = due;
      this.scheduled.delete(id);
      this.now = entry.at;
      entry.fn();
    }
    this.now = target;
  }
}

class FakeConnectivity implements Connectivity {
  online = true;
  private listeners: Array<() => void> = [];

  isOnline(): boolean {
    return this.online;
  }

  onOnline(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  goOnline(): void {
    this.online = true;
    for (const listener of [...this.listeners]) listener();
  }

  goOffline(): void {
    this.online = false;
  }
}

/** 可编程 API：健康检查可抛错、turn 可失败、turn 正常时回一段带指令的剧本 */
class ScriptedApi implements SessionApi {
  healthCalls = 0;
  createSessionCalls = 0;
  healthThrows = false;
  requests: TurnRequest[] = [];
  turnFail: ApiError | null = null;

  async health(): Promise<HealthInfo> {
    this.healthCalls += 1;
    if (this.healthThrows) throw new ApiError("network", "断网");
    return { ok: true, mode: "mock" };
  }

  async createSession(): Promise<SessionInfo> {
    this.createSessionCalls += 1;
    return {
      sessionId: `session-${this.createSessionCalls}`,
      mode: "mock",
      directorName: "mock",
      keyless: true,
    };
  }

  async streamTurn(
    req: TurnRequest,
    handlers: TurnStreamHandlers,
    _opts?: StreamOptions,
  ): Promise<void> {
    this.requests.push(req);
    if (this.turnFail) throw this.turnFail;
    const base = { turnId: req.turnId, epoch: req.epoch };
    const events: SessionEvent[] = [
      { ...base, type: "turn.start", at: 0 },
      { ...base, type: "text.delta", text: "雨停了。" },
      { ...base, type: "directive", directive: { kind: "emotion", emotion: "warm" } },
      { ...base, type: "directive", directive: { kind: "action", action: "hair_tuck" } },
      { ...base, type: "turn.end", interrupted: false },
    ];
    for (const event of events) handlers.onEvent(event);
  }

  async cancelTurn(_turnId: string, epoch: number) {
    return { cancelled: true, epoch };
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness() {
  const api = new ScriptedApi();
  const timers = new FakeTimers();
  const connectivity = new FakeConnectivity();
  const store = new SessionStore({
    api,
    tts: new FakeTts(),
    audioMode: "stream",
    clock: () => timers.now,
    timers,
    connectivity,
  });
  return { api, timers, connectivity, store };
}

// ---------------------------------------------------------------- 退避参数

describe("退避序列（纯函数）", () => {
  test("1s → 2s → 4s → 8s → 8s（上限 8s 封顶）", () => {
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) => reconnectDelay(attempt));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  test("默认策略：上限 8s、最多 5 次", () => {
    expect(DEFAULT_RECONNECT_POLICY.maxDelayMs).toBe(8000);
    expect(DEFAULT_RECONNECT_POLICY.maxAttempts).toBe(5);
  });
});

// ---------------------------------------------------------------- 自动重连

describe("断线自动重连", () => {
  test("健康检查失败 → 按 1/2/4/8/8 退避，诊断文案带次数与倒计时", async () => {
    const { api, timers, store } = harness();
    api.healthThrows = true;

    await store.init();
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const view = store.getSnapshot();
      expect(view.reconnect.active).toBe(true);
      expect(view.reconnect.attempt).toBe(attempt);
      expect(view.reconnect.maxAttempts).toBe(5);
      expect(view.banner?.text).toContain(`重连 ${attempt}/5，下次`);
      delays.push(view.reconnect.nextInMs ?? -1);

      timers.advance(view.reconnect.nextInMs ?? 0);
      await flush();
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
    store.dispose();
  });

  test("倒计时真的走字：tick 之后文案从 4.0s 变成 3.9s", async () => {
    const { api, timers, store } = harness();
    api.healthThrows = true;

    await store.init(); // 第 1 次：1s
    timers.advance(1000);
    await flush(); // 第 2 次：2s
    expect(store.getSnapshot().banner?.text).toBe("重连 2/5，下次 2.0s");

    timers.advance(4000); // 第 3 次：4s
    await flush();
    expect(store.getSnapshot().banner?.text).toBe("重连 3/5，下次 4.0s");

    timers.advance(100); // 走过 0.1s
    store.tick(16);
    expect(store.getSnapshot().banner?.text).toBe("重连 3/5，下次 3.9s");
    store.dispose();
  });

  test("5 次都失败 → 停止自动重连，停在可手动重试（不再是 sticky 重连文案、不再排定时器）", async () => {
    const { api, timers, store } = harness();
    api.healthThrows = true;

    await store.init();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      timers.advance(store.getSnapshot().reconnect.nextInMs ?? 0);
      await flush();
    }

    const view = store.getSnapshot();
    expect(view.reconnect.exhausted).toBe(true);
    expect(view.reconnect.active).toBe(false);
    expect(view.reconnect.nextInMs).toBeNull();
    expect(timers.pending).toBe(0); // 没有偷偷再排一次
    expect(view.connection).toBe("offline");
    expect(view.banner?.retryable).toBe(true);
    expect(view.banner?.text).toContain("自动重连已停止");
    expect(api.healthCalls).toBe(6); // 首连 + 5 次重试，一次不多

    // 再推进很久也不会自发发请求（不会无限重试烧请求）
    timers.advance(120_000);
    await flush();
    expect(api.healthCalls).toBe(6);
    store.dispose();
  });

  test("用户发送 → 立刻取消退避并马上试一次（不等定时器）", async () => {
    const { api, timers, store } = harness();
    api.healthThrows = true;

    await store.init();
    expect(timers.pending).toBe(1);
    const healthBefore = api.healthCalls;

    // 服务回来了，但退避还在等 1s
    api.healthThrows = false;
    const sent = store.submit("你还在吗？");
    await sent;

    expect(timers.pending).toBe(0); // 退避定时器被取消，不是「等它到点」
    expect(api.healthCalls).toBe(healthBefore + 1); // 立刻试了一次
    expect(store.getSnapshot().connection).toBe("online");
    expect(store.getSnapshot().reconnect.attempt).toBe(0); // 计数归零
    expect(api.requests).toHaveLength(1);
    store.dispose();
  });

  test("用户打断 → 同步取消退避并立刻试一次", async () => {
    const { api, timers, store } = harness();
    api.healthThrows = true;

    await store.init();
    const healthBefore = api.healthCalls;
    api.healthThrows = false;

    store.interrupt("button"); // 同步 API：不能要求调用方 await

    expect(timers.pending).toBe(0);
    expect(api.healthCalls).toBe(healthBefore + 1); // 已经在试（同步进入 health）
    await flush();
    expect(store.getSnapshot().connection).toBe("online");
    store.dispose();
  });

  test("手动重试：立刻试一次且重置退避计数", async () => {
    const { api, timers, store } = harness();
    api.healthThrows = true;

    await store.init();
    timers.advance(1000);
    await flush(); // 已经排到第 2 次
    expect(store.getSnapshot().reconnect.attempt).toBe(2);

    api.healthThrows = true; // 手动重试仍然失败 → 从第 1 次重新数
    await store.retry();
    expect(store.getSnapshot().reconnect.attempt).toBe(1);
    expect(store.getSnapshot().reconnect.nextInMs).toBe(1000);
    store.dispose();
  });

  test("自动重连成功：init 被再次调用，但角色状态 / 画面 / 历史都不清空", async () => {
    const { api, timers, store } = harness();

    await store.init();
    await store.submit("今晚还开门吗？");

    const warmed = store.getSnapshot();
    expect(warmed.machine.scene.emotion).toBe("warm");
    expect(warmed.machine.scene.pendingActions).toContain("hair_tuck");
    const createCallsBefore = api.createSessionCalls;

    // 中途断线（SSE 断）
    api.turnFail = new ApiError("network", "断线");
    await store.submit("你还在吗？");
    expect(store.getSnapshot().connection).toBe("offline");
    expect(store.getSnapshot().reconnect.attempt).toBe(1);

    const broken = store.getSnapshot();
    const turnsBefore = broken.turns;

    // 服务回来了：到点自动重连
    api.healthThrows = false;
    api.turnFail = null;
    timers.advance(broken.reconnect.nextInMs ?? 0);
    await flush();

    const recovered = store.getSnapshot();
    expect(recovered.connection).toBe("online");
    expect(api.createSessionCalls).toBe(createCallsBefore + 1); // init 真的又跑了一次
    expect(recovered.session?.sessionId).toBe(`session-${api.createSessionCalls}`);
    // 画面与角色状态原样保留（重连不清场）
    expect(recovered.machine.scene.emotion).toBe("warm");
    expect(recovered.machine.scene.scene).toBe("cafe_night");
    expect(recovered.machine.epoch).toBe(broken.machine.epoch);
    expect(recovered.turns).toBe(turnsBefore);
    expect(recovered.reconnect.recovered).toBe(1);

    // 历史也没丢：下一次请求仍带着上一轮的对话
    await store.submit("接着说");
    const lastRequest = api.requests.at(-1);
    expect(lastRequest?.history?.some((item) => item.role === "character")).toBe(true);
    expect(lastRequest?.history?.some((item) => item.text.includes("雨停了"))).toBe(true);
    store.dispose();
  });

  test("navigator.onLine === false → 暂停退避、不排定时器；online 事件后立刻试一次", async () => {
    const { api, timers, connectivity, store } = harness();
    api.healthThrows = true;
    connectivity.goOffline();

    await store.init();
    const paused = store.getSnapshot();
    expect(paused.reconnect.paused).toBe(true);
    expect(paused.reconnect.nextInMs).toBeNull();
    expect(timers.pending).toBe(0);
    expect(paused.banner?.text).toContain("网络已断开");

    // 断网期间时间怎么走都不发请求
    timers.advance(60_000);
    await flush();
    const callsWhilePaused = api.healthCalls;
    expect(callsWhilePaused).toBe(1);

    // 恢复联网：立刻试一次（不等任何定时器）
    api.healthThrows = false;
    connectivity.goOnline();
    await flush();

    expect(api.healthCalls).toBe(callsWhilePaused + 1);
    const resumed = store.getSnapshot();
    expect(resumed.connection).toBe("online");
    expect(resumed.reconnect.paused).toBe(false);
    store.dispose();
  });

  test("dispose 之后不再重连（页面卸载不能留下定时器与请求）", async () => {
    const { api, timers, store } = harness();
    api.healthThrows = true;

    await store.init();
    const calls = api.healthCalls;
    store.dispose();
    expect(timers.pending).toBe(0);

    timers.advance(60_000);
    await flush();
    expect(api.healthCalls).toBe(calls);
  });
});
