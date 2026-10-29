import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionInfo, TurnRequest } from "../../src/shared/protocol";
import type { HealthInfo, SessionApi, StreamOptions, TurnStreamHandlers } from "../../src/web/state/api";
import { ApiError } from "../../src/web/state/api";
import {
  createMachine,
  reduceBargeIn,
  reduceEvent,
  reduceRequestFailed,
  reduceRequestSent,
} from "../../src/web/state/session";
import { SessionStore } from "../../src/web/state/store";
import type { AudioChunk, TTSProvider } from "../../src/web/voice/tts";

class FakeTts implements TTSProvider {
  readonly name = "fake-tts";
  cancels = 0;
  get isSpeaking(): boolean {
    return false;
  }
  speak(): void {}
  flush(): void {}
  cancel(): void {
    this.cancels += 1;
  }
  dispose(): void {}
  pushChunk(_chunk: AudioChunk): void {}
}

class FakeApi implements SessionApi {
  requests: TurnRequest[] = [];
  cancelled: Array<{ turnId: string; epoch: number }> = [];
  handlers: TurnStreamHandlers | null = null;

  async health(): Promise<HealthInfo> {
    return { ok: true, mode: "mock" };
  }
  async createSession(): Promise<SessionInfo> {
    return { sessionId: "session-cue-1", mode: "mock", directorName: "mock", keyless: true };
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

describe("思考态（thinking cue）状态机纯函数测试", () => {
  test("1. 提交后立即进入思考态", () => {
    const machine = createMachine(1);
    expect(machine.scene.characterStatus).toBe("idle");

    const sent = reduceRequestSent(machine, "turn-1", 100);
    expect(sent.scene.characterStatus).toBe("thinking");
    expect(sent.turnActive).toBe(true);
    expect(sent.scene.subtitle).toBe("");
  });

  test("2. 首个 text.delta 到达后退出思考态进入 speaking", () => {
    const sent = reduceRequestSent(createMachine(1), "turn-1", 100);
    expect(sent.scene.characterStatus).toBe("thinking");

    const result = reduceEvent(sent, {
      type: "text.delta",
      turnId: "turn-1",
      epoch: 1,
      text: "今晚有雨。",
    });
    expect(result.outcome).toBe("applied");
    expect(result.machine.scene.characterStatus).toBe("speaking");
    expect(result.machine.scene.subtitle).toBe("今晚有雨。");
  });

  test("3. 首个 audio.chunk 到达后退出思考态进入 speaking", () => {
    const sent = reduceRequestSent(createMachine(1), "turn-1", 100);
    expect(sent.scene.characterStatus).toBe("thinking");

    const result = reduceEvent(sent, {
      type: "audio.chunk",
      turnId: "turn-1",
      epoch: 1,
      seq: 0,
      dataUrl: "AAAA",
      mime: "audio/mpeg",
    });
    expect(result.outcome).toBe("applied");
    expect(result.machine.scene.characterStatus).toBe("speaking");
  });

  test("4. 打断后立即退出思考态进入 listening", () => {
    const sent = reduceRequestSent(createMachine(1), "turn-1", 100);
    expect(sent.scene.characterStatus).toBe("thinking");

    const interrupted = reduceBargeIn(sent);
    expect(interrupted.scene.characterStatus).toBe("listening");
    expect(interrupted.turnActive).toBe(false);
  });

  test("5. 出错 / 失败后立即退出思考态回到 idle", () => {
    const sent = reduceRequestSent(createMachine(1), "turn-1", 100);
    expect(sent.scene.characterStatus).toBe("thinking");

    const failed = reduceRequestFailed(sent, "网络连接断开");
    expect(failed.scene.characterStatus).toBe("idle");
    expect(failed.turnActive).toBe(false);
  });
});

describe("思考态（thinking cue）Store 集成测试", () => {
  test("完整生命周期：提交(thinking) → text.delta(speaking) → 打断(listening)", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const store = new SessionStore({
      api,
      tts,
      audioMode: "stream",
    });
    await store.init();

    expect(store.getSnapshot().scene.characterStatus).toBe("idle");

    // 提交后进入 thinking
    void store.submit("你好");
    await flush();
    expect(store.getSnapshot().scene.characterStatus).toBe("thinking");

    const req = api.requests[0]!;
    api.emit({ type: "turn.start", turnId: req.turnId, epoch: req.epoch, at: 0 });
    // turn.start 保持 thinking
    expect(store.getSnapshot().scene.characterStatus).toBe("thinking");

    // 首个 text.delta 退出 thinking 进入 speaking
    api.emit({ type: "text.delta", turnId: req.turnId, epoch: req.epoch, text: "你好呀！" });
    expect(store.getSnapshot().scene.characterStatus).toBe("speaking");

    // 打断后立即退出
    store.interrupt();
    await flush();
    expect(store.getSnapshot().scene.characterStatus).toBe("listening");
  });

  test("思考态被打断：提交(thinking) → interrupt 立即退出到 listening", async () => {
    const api = new FakeApi();
    const tts = new FakeTts();
    const store = new SessionStore({
      api,
      tts,
      audioMode: "stream",
    });
    await store.init();

    void store.submit("你好");
    await flush();
    expect(store.getSnapshot().scene.characterStatus).toBe("thinking");

    store.interrupt();
    await flush();
    expect(store.getSnapshot().scene.characterStatus).toBe("listening");
  });
});
