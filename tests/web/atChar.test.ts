/**
 * ④「说到哪、画面变到哪」：客户端按台词字符水位给 directive 排队。
 *
 * 两个层次都测：
 *   · 纯函数层（reduceEvent / isCueDue / cueAtChar）：闸门的判据可被逐条钉住；
 *   · store 层（走真实的 SSE 事件入口）：队列的入队、放行、收尾 flush、打断作废。
 *
 * 观察顺序的技巧：`vfx` 的键是**插入序**，所以 `Object.keys(scene.vfx)` 就是
 * 「这几条 vfx 指令实际被应用的顺序」—— 不需要靠 lastBeat（它只留最后一条）。
 */
import { describe, expect, test } from "bun:test";
import type { Directive, SessionEvent, SessionInfo, TurnRequest } from "../../src/shared/protocol";
import type { HealthInfo, SessionApi, StreamOptions, TurnStreamHandlers } from "../../src/web/state/api";
import { ApiError } from "../../src/web/state/api";
import { SessionStore } from "../../src/web/state/store";
import {
  createMachine,
  cueAtChar,
  isCueDue,
  reduceEvent,
  reduceRequestSent,
} from "../../src/web/state/session";
import { charCount } from "../../src/server/director/cues.ts";
import type { AudioChunk, TTSProvider } from "../../src/web/voice/tts";

// ---------------------------------------------------------------- harness

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
    /* stream 模式下才用到，这里不需要 */
  }
}

class FakeApi implements SessionApi {
  requests: TurnRequest[] = [];
  handlers: TurnStreamHandlers | null = null;

  async health(): Promise<HealthInfo> {
    return { ok: true, mode: "mock" };
  }
  async createSession(): Promise<SessionInfo> {
    return { sessionId: "session-1", mode: "mock", directorName: "mock", keyless: true };
  }
  streamTurn(req: TurnRequest, handlers: TurnStreamHandlers, opts?: StreamOptions): Promise<void> {
    this.requests.push(req);
    this.handlers = handlers;
    return new Promise<void>((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new ApiError("aborted", "请求已取消")), {
        once: true,
      });
    });
  }
  async cancelTurn(_turnId: string, epoch: number) {
    return { cancelled: true, epoch };
  }

  emit(event: SessionEvent): void {
    this.handlers?.onEvent(event);
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 起一个已经进入 turn 的 store：返回 (api, tts, store, 当前轮次凭证) */
async function startedTurn() {
  const api = new FakeApi();
  const tts = new FakeTts();
  const store = new SessionStore({ api, tts, audioMode: "browser" });
  await store.init();
  void store.submit("今晚还开门吗？");
  await flush();
  const request = api.requests[0]!;
  api.emit({ type: "turn.start", turnId: request.turnId, epoch: request.epoch, at: 0 });
  const say = (text: string) =>
    api.emit({ type: "text.delta", turnId: request.turnId, epoch: request.epoch, text });
  const cue = (atChar: number | undefined, directive: Directive) =>
    api.emit({
      type: "directive",
      turnId: request.turnId,
      epoch: request.epoch,
      directive,
      ...(atChar === undefined ? {} : { atChar }),
    });
  return { api, tts, store, request, say, cue };
}

// ---------------------------------------------------------------- 纯函数层

describe("水位闸门（纯函数）", () => {
  test("atChar 缺省 / 非有限数 → 没有锚，判据恒放行；负数归 0、小数取整", () => {
    expect(cueAtChar({})).toBeNull();
    expect(cueAtChar({ atChar: Number.NaN })).toBeNull();
    expect(cueAtChar({ atChar: Number.POSITIVE_INFINITY })).toBeNull();
    expect(cueAtChar({ atChar: -3 })).toBe(0);
    expect(cueAtChar({ atChar: 7.9 })).toBe(7);

    expect(isCueDue(null, 0)).toBe(true);
    expect(isCueDue(0, 0)).toBe(true);
    expect(isCueDue(5, 4)).toBe(false);
    expect(isCueDue(5, 5)).toBe(true);
  });

  test("reduceEvent：不带水位 = 旧行为（永远立即执行）；带水位则锚在未来返回 queued", () => {
    let machine = createMachine();
    machine = reduceRequestSent(machine, "t1", 0);

    const event: SessionEvent = {
      type: "directive",
      turnId: "t1",
      epoch: machine.epoch,
      directive: { kind: "emotion", emotion: "warm" },
      atChar: 9,
    };

    // 不传水位：与改动前完全一致 —— 立即应用
    const legacy = reduceEvent(machine, event, 0);
    expect(legacy.outcome).toBe("applied");
    expect(legacy.machine.scene.emotion).toBe("warm");

    // 水位 3 < atChar 9：排队，机器不动（连 lastBeat 都不动）
    const gated = reduceEvent(machine, event, 0, 3);
    expect(gated.outcome).toBe("queued");
    expect(gated.machine).toBe(machine);

    // 水位推到 9：放行
    const due = reduceEvent(machine, event, 0, 9);
    expect(due.outcome).toBe("applied");
    expect(due.machine.scene.emotion).toBe("warm");
  });

  test("epoch 不对的指令连「排队」都不配：闸门在 epoch/turnId 之后", () => {
    let machine = createMachine();
    machine = reduceRequestSent(machine, "t1", 0);
    const stale: SessionEvent = {
      type: "directive",
      turnId: "t1",
      epoch: machine.epoch + 1,
      directive: { kind: "emotion", emotion: "sad" },
      atChar: 99,
    };
    expect(reduceEvent(machine, stale, 0, 0).outcome).toBe("stale-epoch");
  });
});

// ---------------------------------------------------------------- store 层

describe("store：atChar 排队与放行", () => {
  test("① atChar 缺失 → 立即应用（回归：与改动前的「收到即播」逐字一致）", async () => {
    const { store, cue, say } = await startedTurn();
    say("欢迎光临。");
    // 水位 = 5，但这条指令根本没有锚
    cue(undefined, { kind: "emotion", emotion: "warm" });

    const view = store.getSnapshot();
    expect(view.scene.emotion).toBe("warm");
    expect(view.scene.lastBeat).toContain("emotion:warm");
    expect(view.lateCues).toBe(0);
    expect(view.queuedCues).toBe(0);
  });

  test("① atChar = 0 → 也是立即应用（锚在第 0 字 = 开口之前就变）", async () => {
    const { store, cue } = await startedTurn();
    cue(0, { kind: "pose", pose: "lean_in" });
    expect(store.getSnapshot().scene.pose).toBe("lean_in");
    expect(store.getSnapshot().queuedCues).toBe(0);
  });

  test("② atChar 大于水位 → 排队，水位未到时画面不动", async () => {
    const { store, cue, say, request } = await startedTurn();
    say("吓我一跳。"); // 水位 5
    expect(store.getSnapshot().cueWatermark).toBe(charCount("吓我一跳。"));

    cue(12, { kind: "vfx", vfx: "lightning" });

    const view = store.getSnapshot();
    expect(view.scene.vfx.lightning).toBeUndefined();
    expect(view.queuedCues).toBe(1);
    expect(view.lateCues).toBe(0);
    // 排队不产生任何「显著视觉事件」：lastBeat 也不该动
    expect(view.scene.lastBeat).toBeNull();

    // 水位继续推进但还没到：仍然不动
    say("你别站在");
    expect(store.getSnapshot().cueWatermark).toBe(charCount("吓我一跳。你别站在"));
    expect(store.getSnapshot().scene.vfx.lightning).toBeUndefined();
    expect(store.getSnapshot().queuedCues).toBe(1);

    // 到位才变
    say("那儿——");
    expect(store.getSnapshot().cueWatermark).toBe(charCount("吓我一跳。你别站在那儿——"));
    expect(store.getSnapshot().scene.vfx.lightning).toBe(1);
    expect(store.getSnapshot().queuedCues).toBe(0);
    expect(store.getSnapshot().lateCues).toBe(1);
    expect(store.getSnapshot().scene.lastBeat).toBe(`${request.turnId}#vfx:lightning`);
  });

  test("③ 水位推进后按 atChar 升序触发；同一 atChar 保持到达顺序", async () => {
    const { store, cue, say } = await startedTurn();

    // 故意乱序到达，且两条都锚在 5
    cue(8, { kind: "vfx", vfx: "rain_heavy" });
    cue(3, { kind: "vfx", vfx: "rain_light" });
    cue(5, { kind: "vfx", vfx: "steam_wisp" }); // 先到
    cue(5, { kind: "vfx", vfx: "warm_glow" }); // 后到
    expect(store.getSnapshot().queuedCues).toBe(4);

    // 1..3：只有 atChar=3 那条够水位
    say("一二三");
    expect(Object.keys(store.getSnapshot().scene.vfx)).toEqual(["rain_light"]);
    expect(store.getSnapshot().queuedCues).toBe(3);

    // 4..5：atChar=5 的两条按到达顺序（steam_wisp 先、warm_glow 后）
    say("四五");
    expect(Object.keys(store.getSnapshot().scene.vfx)).toEqual([
      "rain_light",
      "steam_wisp",
      "warm_glow",
    ]);
    expect(store.getSnapshot().queuedCues).toBe(1);

    // 6..8：最后一条
    say("六七八");
    expect(Object.keys(store.getSnapshot().scene.vfx)).toEqual([
      "rain_light",
      "steam_wisp",
      "warm_glow",
      "rain_heavy",
    ]);
    expect(store.getSnapshot().queuedCues).toBe(0);
    expect(store.getSnapshot().lateCues).toBe(4);

    // 不会重复触发：再补几句台词，vfx 键序与计数都不变
    const before = store.getSnapshot().scene.vfx;
    say("九十");
    expect(store.getSnapshot().scene.vfx).toBe(before);
    expect(store.getSnapshot().lateCues).toBe(4);
  });

  test("④ 打断（epoch 变化）→ 队列清空，且旧轮残留不应用", async () => {
    const { store, cue, say, api, request } = await startedTurn();
    say("我…");
    cue(30, { kind: "emotion", emotion: "anxious" });
    cue(31, { kind: "branch", options: [{ id: "a", label: "追问" }] });
    expect(store.getSnapshot().queuedCues).toBe(2);

    store.interrupt("key");
    expect(store.getSnapshot().queuedCues).toBe(0);
    expect(store.getSnapshot().machine.epoch).toBe(request.epoch + 1);

    // 旧轮迟到的台词：epoch 不对，进不了 reducer
    api.emit({
      type: "text.delta",
      turnId: request.turnId,
      epoch: request.epoch,
      text: "我先走了。",
    });

    const late = store.getSnapshot();
    expect(late.scene.emotion).toBe("neutral");
    expect(late.scene.branches).toEqual([]);
    expect(late.scene.subtitle).toBe("");
    expect(late.lateCues).toBe(0);
    expect(late.queuedCues).toBe(0);
    expect(late.droppedEvents).toBeGreaterThanOrEqual(1);

    // 旧轮 turn.end 也不能把队列里的东西捞回来
    api.emit({
      type: "turn.end",
      turnId: request.turnId,
      epoch: request.epoch,
      interrupted: true,
    });
    expect(store.getSnapshot().scene.branches).toEqual([]);
    expect(store.getSnapshot().scene.emotion).toBe("neutral");
  });

  test("⑤ turn.end → 末尾 branch 被 flush（水位远远没到也不丢）", async () => {
    const { store, cue, say, api, request } = await startedTurn();
    say("你要走吗？");
    cue(999, { kind: "branch", options: [{ id: "stay", label: "留下" }, { id: "go", label: "走吧" }] });
    cue(999, { kind: "emotion", emotion: "sad" });
    expect(store.getSnapshot().queuedCues).toBe(2);

    api.emit({ type: "turn.end", turnId: request.turnId, epoch: request.epoch, interrupted: false });

    const done = store.getSnapshot();
    expect(done.queuedCues).toBe(0);
    expect(done.scene.branches.map((option) => option.id)).toEqual(["stay", "go"]);
    expect(done.scene.emotion).toBe("sad");
    expect(done.lateCues).toBe(2);
    expect(done.busy).toBe(false);
    expect(done.scene.characterStatus).toBe("idle");
  });

  test("⑤ 被打断的 turn.end → 队列作废而不是 flush（画面不该为被打断的话继续变）", async () => {
    const { store, cue, say, api, request } = await startedTurn();
    say("等一下。");
    cue(999, { kind: "branch", options: [{ id: "x", label: "X" }] });

    api.emit({ type: "turn.end", turnId: request.turnId, epoch: request.epoch, interrupted: true });

    const done = store.getSnapshot();
    expect(done.scene.branches).toEqual([]);
    expect(done.queuedCues).toBe(0);
    expect(done.lateCues).toBe(0);
  });

  test("⑥ 码点计数：emoji / 组合字符的水位与 charCount 一致（不是 text.length）", async () => {
    const { store, cue, say } = await startedTurn();

    // "雨🙂大"：UTF-16 length 4，码点 3
    say("雨🙂大");
    expect("雨🙂大".length).toBe(4);
    expect(store.getSnapshot().cueWatermark).toBe(3);
    expect(store.getSnapshot().cueWatermark).toBe(charCount("雨🙂大"));

    // 锚在第 3 个码点 → 已经够水位；锚在第 4 个 → 还得等
    cue(3, { kind: "vfx", vfx: "rain_light" });
    cue(4, { kind: "vfx", vfx: "warm_glow" });
    expect(store.getSnapshot().scene.vfx.rain_light).toBe(1);
    expect(store.getSnapshot().scene.vfx.warm_glow).toBeUndefined();
    expect(store.getSnapshot().queuedCues).toBe(1);

    // 组合字符 "e" + U+0301（一个码点算 1，两个码点算 2）
    say("e\u0301");
    expect(store.getSnapshot().cueWatermark).toBe(charCount("雨🙂大e\u0301"));
    expect(store.getSnapshot().cueWatermark).toBe(5);
    expect(store.getSnapshot().scene.vfx.warm_glow).toBe(1);

    // 再一个 emoji：一次推进 1 格而不是 2 格
    say("😀");
    expect(store.getSnapshot().cueWatermark).toBe(6);
  });

  test("换轮：新一轮的水位从 0 起，上一轮的队列不会被新轮捞出", async () => {
    const first = await startedTurn();
    first.say("第一轮。");
    first.cue(50, { kind: "emotion", emotion: "sad" });
    expect(first.store.getSnapshot().queuedCues).toBe(1);

    // 用户又说了一句：needsBargeIn 成立 → 先打断（epoch+1，队列作废）
    void first.store.submit("再来一杯。");
    await flush();

    const next = first.store.getSnapshot();
    expect(next.queuedCues).toBe(0);
    expect(next.scene.emotion).toBe("neutral");
    expect(next.cueWatermark).toBe(0);
  });
});
