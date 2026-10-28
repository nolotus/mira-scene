/**
 * 瞬时动作优先级队列。
 *
 * 语义变化只发生在排序：交付给渲染层的仍然是 `pendingActions`，
 * 渲染层照旧取 `[0]` —— 只是 `[0]` 现在保证是「当前最该演的那个」。
 */
import { describe, expect, test } from "bun:test";
import type { Action, SessionEvent, TurnRequest } from "../../src/shared/protocol";
import type { SessionApi, TurnStreamHandlers } from "../../src/web/state/api";
import {
  ACTION_PRIORITY,
  ACTION_QUEUE_LIMIT,
  MAX_BLINK_BACKLOG,
  applyDirective,
  createInitialScene,
  createMachine,
  drainActions,
  enqueueAction,
  isBackgroundAction,
  reduceRequestSent,
  reduceEvent,
} from "../../src/web/state/session";
import { SessionStore } from "../../src/web/state/store";
import type { TTSProvider } from "../../src/web/voice/tts";

const push = (queue: Action[], action: Action): Action[] => enqueueAction(queue, action).queue;
const foreground = (queue: Action[]): Action[] => queue.filter((a) => !isBackgroundAction(a));

describe("优先级表", () => {
  test("startle > shiver > hair_tuck > look_back > sigh > nod > blink（严格递减）", () => {
    const order: Action[] = ["startle", "shiver", "hair_tuck", "look_back", "sigh", "nod", "blink"];
    for (let i = 0; i < order.length - 1; i += 1) {
      const higher = ACTION_PRIORITY[order[i] as Action];
      const lower = ACTION_PRIORITY[order[i + 1] as Action];
      expect(higher).toBeGreaterThan(lower);
    }
  });

  test("眨眼是背景动作，其余都是前景动作", () => {
    expect(isBackgroundAction("blink")).toBe(true);
    for (const action of ["startle", "shiver", "hair_tuck", "look_back", "sigh", "nod"] as Action[]) {
      expect(isBackgroundAction(action)).toBe(false);
    }
  });
});

describe("抢占", () => {
  test("高优先级插到队首：渲染层取 [0] 会立刻改演新的那个", () => {
    const queue = push(push([], "nod"), "startle");
    expect(queue).toEqual(["startle", "nod"]);

    // 渲染层契约：仍然只取 [0]
    const scene = applyDirective(
      applyDirective(createInitialScene(), { kind: "action", action: "nod" }),
      { kind: "action", action: "startle" },
    );
    expect(scene.pendingActions[0]).toBe("startle");
  });

  test("低优先级不抢队首（hair_tuck 在播时来了 nod，队首仍是 hair_tuck）", () => {
    const queue = push(push([], "hair_tuck"), "nod");
    expect(queue).toEqual(["hair_tuck", "nod"]);
  });
});

describe("同优先级 FIFO", () => {
  test("同级保持到达顺序", () => {
    const queue = push(push(push([], "sigh"), "sigh"), "sigh");
    expect(queue).toEqual(["sigh", "sigh", "sigh"]);
  });

  test("同级不被后到的高优先级拆散内部顺序", () => {
    const queue = push(push(push([], "look_back"), "look_back"), "startle");
    expect(queue).toEqual(["startle", "look_back", "look_back"]);
  });
});

describe("上限 3：超出丢最旧的低优先级", () => {
  test("队列已满时来一个中高优先级：丢掉最旧的低优先级（nod），不是丢新来的", () => {
    expect(ACTION_QUEUE_LIMIT).toBe(3);
    const full = push(push(push([], "nod"), "sigh"), "hair_tuck");
    expect(full).toEqual(["hair_tuck", "sigh", "nod"]);

    const result = enqueueAction(full, "look_back");
    // look_back(3) 排到 hair_tuck(4) 之后 —— 抢占只按优先级，不是「新来的就靠前」
    expect(result.queue).toEqual(["hair_tuck", "look_back", "sigh"]);
    expect(result.dropped).toBe("nod"); // 最旧 + 最低
  });

  test("队列满了而来的是最低优先级：丢的是它自己（细微动作可丢）", () => {
    const full = push(push(push([], "startle"), "shiver"), "hair_tuck");
    const result = enqueueAction(full, "nod");
    expect(result.dropped).toBe("nod");
    expect(result.queue).toEqual(["startle", "shiver", "hair_tuck"]);
    expect(foreground(result.queue)).toHaveLength(3);
  });

  test("同级里丢更晚到达的那条（先到的已经在播了，换掉它更跳）", () => {
    const full = push(push(push([], "sigh"), "sigh"), "sigh"); // 三条同优先级
    const result = enqueueAction(full, "startle");
    // startle 抢占队首，超出上限 → 同级最旧的那条被丢（队列里第一个 sigh）
    expect(result.dropped).toBe("sigh");
    expect(result.queue).toEqual(["startle", "sigh", "sigh"]);
  });
});

describe("blink 不占队列", () => {
  test("眨眼叠加在队尾，hair_tuck 仍在队首", () => {
    const queue = push(push([], "hair_tuck"), "blink");
    expect(queue).toEqual(["hair_tuck", "blink"]);
    expect(queue[0]).toBe("hair_tuck"); // 眨眼顶不掉它
    expect(foreground(queue)).toEqual(["hair_tuck"]);
  });

  test("前景队列满 3 格时来眨眼：一个前景动作都不丢", () => {
    let queue = push(push(push([], "startle"), "shiver"), "hair_tuck");
    queue = push(queue, "blink");
    expect(foreground(queue)).toEqual(["startle", "shiver", "hair_tuck"]);
    expect(queue).toEqual(["startle", "shiver", "hair_tuck", "blink"]);
    expect(enqueueAction(queue, "blink").dropped).toBeNull();
  });

  test("眨眼自身有上限，超过就丢（再多也没有视觉意义）", () => {
    let queue: Action[] = [];
    for (let i = 0; i < MAX_BLINK_BACKLOG; i += 1) queue = push(queue, "blink");
    expect(queue).toHaveLength(MAX_BLINK_BACKLOG);
    expect(push(queue, "blink")).toHaveLength(MAX_BLINK_BACKLOG);
  });
});

describe("空队列", () => {
  test("空队列入队：就是它自己，没有丢弃", () => {
    const result = enqueueAction([], "nod");
    expect(result.queue).toEqual(["nod"]);
    expect(result.dropped).toBeNull();
  });

  test("空队列消费：drainActions 返回原引用与空数组（不造无意义的新对象）", () => {
    const scene = createInitialScene();
    const drained = drainActions(scene);
    expect(drained.actions).toEqual([]);
    expect(drained.scene).toBe(scene);
  });

  test("drainActions 清空整条优先级队列（含尾部眨眼）", () => {
    const scene = applyDirective(
      applyDirective(createInitialScene(), { kind: "action", action: "hair_tuck" }),
      { kind: "action", action: "blink" },
    );
    expect(scene.pendingActions).toEqual(["hair_tuck", "blink"]);
    const drained = drainActions(scene);
    expect(drained.actions).toEqual(["hair_tuck", "blink"]);
    expect(drained.scene.pendingActions).toEqual([]);
  });
});

describe("队列在状态机里的入口", () => {
  test("新一轮清空队列；本轮指令按优先级进入 pendingActions", () => {
    const withQueue = createMachine(0, createInitialScene({ pendingActions: ["nod"] }));
    const sent = reduceRequestSent(withQueue, "t1", 0);
    expect(sent.scene.pendingActions).toEqual([]); // 新一轮清场

    const directive = (action: Action): SessionEvent => ({
      type: "directive",
      turnId: "t1",
      epoch: 0,
      directive: { kind: "action", action },
    });

    const first = reduceEvent(sent, directive("hair_tuck"), 1);
    expect(first.outcome).toBe("applied");
    const second = reduceEvent(first.machine, directive("startle"), 2);
    expect(second.machine.scene.pendingActions).toEqual(["startle", "hair_tuck"]);
  });
});

describe("诊断计数（store）", () => {
  test("超出上限被丢弃的低优先级动作会进诊断", async () => {
    const tts = {
      name: "fake",
      speak() {},
      flush() {},
      cancel() {},
      dispose() {},
      isSpeaking: false,
    } as unknown as TTSProvider;

    const api = {
      health: async () => ({ ok: true }),
      createSession: async () => ({
        sessionId: "s1",
        mode: "mock",
        directorName: "mock",
        keyless: true,
      }),
      streamTurn: async (req: TurnRequest, handlers: TurnStreamHandlers) => {
        const base = { turnId: req.turnId, epoch: req.epoch };
        for (const action of ["startle", "shiver", "hair_tuck", "nod"] as Action[]) {
          handlers.onEvent({ ...base, type: "directive", directive: { kind: "action", action } });
        }
        handlers.onEvent({ ...base, type: "turn.end", interrupted: false });
      },
      cancelTurn: async (_turnId: string, epoch: number) => ({ cancelled: true, epoch }),
    } as unknown as SessionApi;

    const store = new SessionStore({ api, tts, audioMode: "stream" });
    await store.init();
    await store.submit("测试一句话");

    const view = store.getSnapshot();
    // nod 是最低优先级：队列已满 → 丢它
    expect(view.scene.pendingActions).toEqual(["startle", "shiver", "hair_tuck"]);
    expect(view.actionQueue.foreground).toBe(3);
    expect(view.actionQueue.background).toBe(0);
    expect(view.actionQueue.limit).toBe(ACTION_QUEUE_LIMIT);
    expect(view.actionQueue.droppedByPriority).toBe(1);
    store.dispose();
  });
});
