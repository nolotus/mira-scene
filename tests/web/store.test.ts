import { createFillerPlayer } from "../../src/web/voice/filler";
import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionInfo, TurnRequest } from "../../src/shared/protocol";
import type { HealthInfo, SessionApi, StreamOptions, TurnStreamHandlers } from "../../src/web/state/api";
import { ApiError } from "../../src/web/state/api";
import { SessionStore } from "../../src/web/state/store";
import type { AudioChunk, TTSProvider } from "../../src/web/voice/tts";

class FakeTts implements TTSProvider {
  readonly name = "fake-tts";
  spoken: string[] = [];
  chunks: AudioChunk[] = [];
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
  pushChunk(chunk: AudioChunk): void {
    this.chunks.push(chunk);
  }
}

class FakeApi implements SessionApi {
  requests: TurnRequest[] = [];
  cancelled: Array<{ turnId: string; epoch: number }> = [];
  handlers: TurnStreamHandlers | null = null;

  async health(): Promise<HealthInfo> {
    return { ok: true, mode: "mock" };
  }
  async createSession(): Promise<SessionInfo> {
    return { sessionId: "session-1", mode: "mock", directorName: "mock", keyless: true };
  }
  streamTurn(
    req: TurnRequest,
    handlers: TurnStreamHandlers,
    opts?: StreamOptions,
  ): Promise<void> {
    this.requests.push(req);
    this.handlers = handlers;
    return new Promise<void>((_resolve, reject) => {
      opts?.signal?.addEventListener(
        "abort",
        () => reject(new ApiError("aborted", "请求已取消")),
        { once: true },
      );
    });
  }
  async cancelTurn(turnId: string, epoch: number) {
    this.cancelled.push({ turnId, epoch });
    return { cancelled: true, epoch };
  }

  emit(event: SessionEvent): void {
    this.handlers?.onEvent(event);
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("store：打断判据要看「音频是否真的在响」", () => {
  test("turn.end 之后状态已 idle、但音频还在播：按住说话仍必须打断并 cancel", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    let audioPlaying = true;
    const store = new SessionStore({
      api,
      tts,
      audioMode: "stream",
      audioPlaying: () => audioPlaying,
    });
    await store.init();

    void store.submit("今晚还开门吗？");
    await flush();
    const request = api.requests[0]!;
    api.emit({ type: "turn.start", turnId: request.turnId, epoch: request.epoch, at: 0 });
    api.emit({ type: "text.delta", turnId: request.turnId, epoch: request.epoch, text: "开着。" });
    api.emit({ type: "turn.end", turnId: request.turnId, epoch: request.epoch, interrupted: false });
    await flush();

    const cancelsBefore = tts.cancels;
    // 状态机此刻可能已是 idle（turn.end），但音频仍在缓冲播放
    store.onUserSpeech("button");
    await flush();

    expect(tts.cancels).toBeGreaterThan(cancelsBefore);
    expect(store.getSnapshot().scene.characterStatus).toBe("listening");
  });

  test("既不在说、也没音频：不打断，只切倾听（不误伤）", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const store = new SessionStore({
      api,
      tts,
      audioMode: "stream",
      audioPlaying: () => false,
    });
    await store.init();
    const cancelsBefore = tts.cancels;
    store.onUserSpeech("button");
    await flush();
    expect(tts.cancels).toBe(cancelsBefore);
    expect(store.getSnapshot().scene.characterStatus).toBe("listening");
  });
});

describe("store：canInterrupt 必须包含「音频还在响」这条腿", () => {
  test("turn.end 之后 idle + 音频仍在播 → view.canInterrupt 仍为 true", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    let audioPlaying = true;
    const store = new SessionStore({
      api,
      tts,
      audioMode: "stream",
      audioPlaying: () => audioPlaying,
    });
    await store.init();

    void store.submit("今晚还开门吗？");
    await flush();
    const request = api.requests[0]!;
    api.emit({ type: "turn.start", turnId: request.turnId, epoch: request.epoch, at: 0 });
    api.emit({ type: "text.delta", turnId: request.turnId, epoch: request.epoch, text: "开着。" });
    api.emit({ type: "turn.end", turnId: request.turnId, epoch: request.epoch, interrupted: false });
    await flush();

    const view = store.getSnapshot();
    // 前提：状态机确实已经判不出可打断（否则这条测试测不到「第二条腿」）
    expect(view.scene.characterStatus).not.toBe("speaking");
    expect(view.canInterrupt).toBe(true);

    audioPlaying = false;
    // canInterrupt 是 emit 时的快照：音频结束本身不触发 emit（已知限制，见审查意见），
    // 这里用一次麦克风状态切换逼出 emit，验证快照会跟着 audioPlaying 回落
    store.setMic("listening");
    store.setMic("idle");
    await flush();
    expect(store.getSnapshot().canInterrupt).toBe(false);
  });
});

describe("store：垫音（filler）的让位时机", () => {
  function spyFiller() {
    const calls = { play: 0, stop: 0 };
    return {
      calls,
      filler: {
        get playing() {
          return calls.play > calls.stop;
        },
        play() {
          calls.play += 1;
        },
        stop() {
          calls.stop += 1;
        },
      },
    };
  }

  test("发送即播一次；首个 text.delta 立刻停（不与真实语音叠音）", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const { calls, filler } = spyFiller();
    const store = new SessionStore({ api, tts, audioMode: "stream", filler });
    await store.init();

    void store.submit("今晚还开门吗？");
    await flush();
    expect(calls.play).toBe(1);

    const request = api.requests[0]!;
    api.emit({ type: "turn.start", turnId: request.turnId, epoch: request.epoch, at: 0 });
    expect(calls.stop).toBe(0);

    api.emit({ type: "text.delta", turnId: request.turnId, epoch: request.epoch, text: "雨这么大，" });
    await flush();
    expect(calls.stop).toBeGreaterThanOrEqual(1);
    expect(tts.spoken).toEqual(["雨这么大，"]);
  });

  test("没等到任何文本就出错：垫音也要停（不留一声孤零零的嗯）", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const { calls, filler } = spyFiller();
    const store = new SessionStore({ api, tts, audioMode: "stream", filler });
    await store.init();

    void store.submit("在吗？");
    await flush();
    const request = api.requests[0]!;
    api.emit({ type: "turn.start", turnId: request.turnId, epoch: request.epoch, at: 0 });
    api.emit({
      type: "error",
      turnId: request.turnId,
      epoch: request.epoch,
      message: "上游挂了",
      recoverable: true,
    });
    await flush();
    expect(calls.stop).toBeGreaterThanOrEqual(1);
  });

  test("不传 filler 时一切照旧（可选依赖，不给就不响）", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "stream" });
    await store.init();
    void store.submit("在吗？");
    await flush();
    expect(api.requests).toHaveLength(1);
  });
});

describe("store：垫音在打断路径上的复位", () => {
  function realFiller() {
    const log = { play: 0, pause: 0 };
    const node = {
      currentTime: 0,
      play() {
        log.play += 1;
        return Promise.resolve();
      },
      pause() {
        log.pause += 1;
      },
    };
    return { log, filler: createFillerPlayer({ createAudio: () => node }) };
  }

  test("垫音还在播时打断：stop 必须真的执行（旧轮 turn.end 已被 epoch 闸门丢弃）", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const { log, filler } = realFiller();
    const store = new SessionStore({ api, tts, audioMode: "stream", filler });
    await store.init();

    void store.submit("今晚还开门吗？");
    await flush();
    expect(filler.playing).toBe(true);

    store.interrupt("button");
    expect(filler.playing).toBe(false);
    expect(log.pause).toBe(1);

    // 打断后再说一句：必须重新响，不能被上一轮卡住的 playing 早退吃掉
    void store.submit("那明天呢？");
    await flush();
    expect(log.play).toBe(2);
    expect(filler.playing).toBe(true);
  });
});

describe("store：打断与迟到响应（端到端，纯逻辑）", () => {
  test("打断后旧轮的 text.delta / audio.chunk 既不改字幕也不重新出声", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "stream" });
    await store.init();

    void store.submit("今晚还开门吗？");
    await flush();
    expect(api.requests).toHaveLength(1);

    const request = api.requests[0]!;
    api.emit({ type: "turn.start", turnId: request.turnId, epoch: request.epoch, at: 0 });
    api.emit({
      type: "text.delta",
      turnId: request.turnId,
      epoch: request.epoch,
      text: "雨这么大，",
    });
    await flush();

    expect(store.getSnapshot().scene.subtitle).toBe("雨这么大，");
    expect(store.getSnapshot().scene.characterStatus).toBe("speaking");
    expect(tts.spoken).toEqual(["雨这么大，"]);
    const speaksBeforeInterrupt = tts.spoken.length;
    const chunksBeforeInterrupt = tts.chunks.length;

    // 用户按下打断键
    const result = store.interrupt("key");
    expect(result.toEpoch).toBe(request.epoch + 1);

    const after = store.getSnapshot();
    expect(after.machine.epoch).toBe(request.epoch + 1);
    expect(after.scene.characterStatus).toBe("listening");
    expect(after.scene.subtitle).toBe("");
    expect(tts.cancels).toBeGreaterThanOrEqual(1);
    expect(api.cancelled).toEqual([{ turnId: request.turnId, epoch: request.epoch + 1 }]);

    // 旧轮「迟到」的事件：网络还在路上，epoch 已经不对了
    api.emit({
      type: "text.delta",
      turnId: request.turnId,
      epoch: request.epoch,
      text: "你还是早点回去吧。",
    });
    api.emit({
      type: "audio.chunk",
      turnId: request.turnId,
      epoch: request.epoch,
      seq: 0,
      dataUrl: "AAAA",
      mime: "audio/mpeg",
    });
    api.emit({
      type: "turn.end",
      turnId: request.turnId,
      epoch: request.epoch,
      interrupted: false,
    });
    await flush();

    const late = store.getSnapshot();
    expect(late.scene.subtitle).toBe("");
    expect(late.scene.characterStatus).toBe("listening");
    expect(late.droppedEvents).toBeGreaterThanOrEqual(3);
    expect(tts.spoken).toHaveLength(speaksBeforeInterrupt);
    expect(tts.chunks).toHaveLength(chunksBeforeInterrupt);
  });

  test("正常一轮：thinking → speaking → turn.end 回 idle，并 flush 掉残句", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "browser" });
    await store.init();

    void store.submit("来杯热的。");
    await flush();
    const request = api.requests[0]!;
    expect(store.getSnapshot().scene.characterStatus).toBe("thinking");

    api.emit({ type: "text.delta", turnId: request.turnId, epoch: request.epoch, text: "好，稍等。" });
    expect(store.getSnapshot().scene.characterStatus).toBe("speaking");

    api.emit({
      type: "directive",
      turnId: request.turnId,
      epoch: request.epoch,
      directive: { kind: "emotion", emotion: "warm" },
    });
    expect(store.getSnapshot().scene.emotion).toBe("warm");

    api.emit({ type: "turn.end", turnId: request.turnId, epoch: request.epoch, interrupted: false });
    await flush();

    const done = store.getSnapshot();
    expect(done.scene.characterStatus).toBe("idle");
    expect(done.busy).toBe(false);
    expect(done.turns).toBe(1);
    expect(tts.flushes).toBe(1);
  });
});

describe("store：健康与降级", () => {
  test("首事件超时 → 可见错误条 + 重试入口，状态回到 idle 而不是卡在 thinking", async () => {
    const api = new FakeApi();
    api.streamTurn = () => Promise.reject(new ApiError("timeout", "模型 8s 内没有响应（首事件超时）"));
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "browser" });
    await store.init();

    await store.submit("在吗？");

    const view = store.getSnapshot();
    expect(view.scene.characterStatus).toBe("idle");
    expect(view.busy).toBe(false);
    expect(view.banner?.tone).toBe("warn");
    expect(view.banner?.retryable).toBe(true);
    expect(view.banner?.text).toContain("重试");
    expect(view.connection).toBe("online");
  });

  test("健康检查失败 → offline 常驻提示，不抛异常", async () => {
    const api = new FakeApi();
    api.health = () => Promise.reject(new ApiError("network", "网络请求失败"));
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "browser" });

    await store.init();

    const view = store.getSnapshot();
    expect(view.connection).toBe("offline");
    expect(view.banner?.tone).toBe("error");
    expect(view.banner?.sticky).toBe(true);
    expect(view.banner?.retryable).toBe(true);
  });

  test("SSE 中途 error 事件 → 状态条可见，随后 turn.end 恢复 idle", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const store = new SessionStore({ api, tts, audioMode: "browser" });
    await store.init();

    void store.submit("讲个故事");
    await flush();
    const request = api.requests[0]!;

    api.emit({
      type: "error",
      turnId: request.turnId,
      epoch: request.epoch,
      message: "上游模型限流",
      recoverable: true,
    });
    expect(store.getSnapshot().banner?.text).toContain("上游模型限流");

    api.emit({ type: "turn.end", turnId: request.turnId, epoch: request.epoch, interrupted: false });
    expect(store.getSnapshot().scene.characterStatus).toBe("idle");
  });
});
