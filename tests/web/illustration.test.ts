/**
 * 客户端插图逻辑：缓存命中不请求、?gen=0 关闭、epoch 打断后不复活、未配置不写失败记录。
 *
 * 全部无 DOM：控制器依赖可注入（transport / cache / schedule / now），
 * 所以「迟到的 resolve」「4s 后淡出」「grace 超时」都是可控的、可重复的。
 */
import { describe, expect, test } from "bun:test";
import { buildPromptWithVariant, type IllustrateResponse } from "../../src/shared/illustrate.ts";
import {
  ILLUSTRATION_CACHE_PREFIX,
  createIllustrationCache,
  type IllustrationStorage,
} from "../../src/web/stage/illustration/illustrationCache.ts";
import {
  HOLD_MS,
  createIllustrationController,
  type IllustrationTransport,
  type IllustrationTransportInput,
} from "../../src/web/stage/illustration/illustrationController.ts";
import { illustrationVisible } from "../../src/web/stage/illustration/illustrationState.ts";
import { parseIllustrationFlag } from "../../src/web/stage/illustration/illustrationRuntime.ts";

const DATA_URL = "data:image/jpeg;base64,ZmFrZS1pbWFnZS1ieXRlcw==";
const STORM_PROMPT = buildPromptWithVariant("cafe_night", "storm", null);

// ---------------------------------------------------------------- 测试替身

interface MemoryStorage extends IllustrationStorage {
  dump: Map<string, string>;
}

function memoryStorage(): MemoryStorage {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (key) => dump.get(key) ?? null,
    setItem: (key, value) => {
      dump.set(key, value);
    },
    removeItem: (key) => {
      dump.delete(key);
    },
  };
}

/** 可控定时器：schedule 只登记，advance 才真正跑（含新登记的任务） */
function fakeTimers() {
  let seq = 0;
  let now = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  return {
    schedule: (fn: () => void, delay: number) => {
      seq += 1;
      const key = seq;
      tasks.set(key, { at: now + delay, fn });
      return () => {
        tasks.delete(key);
      };
    },
    advance(ms: number) {
      now += ms;
      for (let guard = 0; guard < 32; guard += 1) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= now)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        for (const [key, task] of due) {
          tasks.delete(key);
          task.fn();
        }
      }
    },
    get pending() {
      return tasks.size;
    },
  };
}

async function tick(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  controller: ReturnType<typeof createIllustrationController>;
  calls: IllustrationTransportInput[];
  timers: ReturnType<typeof fakeTimers>;
  cache: ReturnType<typeof createIllustrationCache>;
  transport: IllustrationTransport;
}

function harness(options: {
  enabled?: boolean;
  storage?: IllustrationStorage;
  respond?: (input: IllustrationTransportInput, call: number) => Promise<IllustrateResponse>;
} = {}): Harness {
  const timers = fakeTimers();
  const cache = createIllustrationCache({
    storage: options.storage ?? memoryStorage(),
    now: () => 0,
  });
  const calls: IllustrationTransportInput[] = [];
  const transport: IllustrationTransport = async (input) => {
    calls.push(input);
    if (options.respond) return options.respond(input, calls.length);
    return { ok: true, dataUrl: DATA_URL, cached: false, ms: 12 };
  };
  const controller = createIllustrationController({
    transport,
    cache,
    enabled: options.enabled !== false,
    schedule: timers.schedule,
    now: () => 0,
  });
  return { controller, calls, timers, cache, transport };
}

/** arm（storm 命中）+ 片段让出画面 */
function armAndRelease(h: Harness): void {
  h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
  h.controller.release("ended");
}

// ---------------------------------------------------------------- 开关

describe("?gen=… 开关", () => {
  test("默认开；?gen=0 / off / false / no 关闭", () => {
    expect(parseIllustrationFlag("")).toBe(true);
    expect(parseIllustrationFlag("?gen=1")).toBe(true);
    expect(parseIllustrationFlag("?gen=on")).toBe(true);
    expect(parseIllustrationFlag("?gen=0")).toBe(false);
    expect(parseIllustrationFlag("?gen=off")).toBe(false);
    expect(parseIllustrationFlag("?gen=false")).toBe(false);
    expect(parseIllustrationFlag("?gen=no")).toBe(false);
  });

  test("?gen=0：不发请求、不写记录、整层不渲染", async () => {
    const h = harness({ enabled: false });
    armAndRelease(h);
    await tick();
    expect(h.calls.length).toBe(0);
    expect(h.controller.records.length).toBe(0);
    expect(h.controller.state.phase).toBe("disabled");
    expect(illustrationVisible(h.controller.state)).toBe(false);
  });
});

// ---------------------------------------------------------------- 缓存

describe("本地缓存（1 天）", () => {
  test("命中缓存不发请求，直接呈现且 cached=true", async () => {
    const storage = memoryStorage();
    const seed = createIllustrationCache({ storage, now: () => 0 });
    seed.set(STORM_PROMPT, DATA_URL);
    // 确认键就是 prompt 原文
    expect(storage.dump.has(ILLUSTRATION_CACHE_PREFIX + STORM_PROMPT)).toBe(true);

    const h = harness({ storage });
    armAndRelease(h);
    await tick();

    expect(h.calls.length).toBe(0);
    expect(h.controller.state.phase).toBe("showing");
    expect(h.controller.state.cached).toBe(true);
    expect(h.controller.state.dataUrl).toBe(DATA_URL);
  });

  test("过期（>1 天）不再命中，会真的发一次请求", async () => {
    const storage = memoryStorage();
    const seed = createIllustrationCache({ storage, now: () => 0 });
    seed.set(STORM_PROMPT, DATA_URL);
    // 2 天后再读
    const expired = createIllustrationCache({ storage, now: () => 2 * 24 * 60 * 60 * 1000 });
    expect(expired.get(STORM_PROMPT)).toBeNull();
  });

  test("请求成功后写回缓存，同 prompt 的下一张不再请求", async () => {
    const storage = memoryStorage();
    const first = harness({ storage });
    armAndRelease(first);
    await tick();
    expect(first.calls.length).toBe(1);
    expect(createIllustrationCache({ storage, now: () => 0 }).get(STORM_PROMPT)).toBe(DATA_URL);
  });
});

// ---------------------------------------------------------------- 请求与配额

describe("请求行为", () => {
  test("正常路径：waiting → requesting → showing → 4s 后 done", async () => {
    const h = harness();
    h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
    // 片段还在播：不请求、不占屏
    expect(h.controller.state.phase).toBe("waiting");
    expect(h.calls.length).toBe(0);
    expect(illustrationVisible(h.controller.state)).toBe(false);

    h.controller.clipStarted();
    h.controller.release("ended");
    expect(h.controller.state.phase).toBe("requesting");
    await tick();
    expect(h.controller.state.phase).toBe("showing");

    h.timers.advance(HOLD_MS);
    expect(h.controller.state.phase).toBe("done");
    expect(illustrationVisible(h.controller.state)).toBe(false);
  });

  test("同一会话最多一次请求：showing/done 之后再 arm 不再发请求", async () => {
    const h = harness();
    armAndRelease(h);
    await tick();
    expect(h.calls.length).toBe(1);

    h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
    h.controller.release("ended");
    await tick();
    expect(h.calls.length).toBe(1);
    expect(h.controller.state.phase).toBe("showing");
  });

  test("片段一直没占屏：grace 到点后放行（不会把插图饿死）", async () => {
    const h = harness();
    h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
    expect(h.controller.state.phase).toBe("waiting");
    h.timers.advance(3_000);
    expect(h.controller.state.phase).toBe("requesting");
    await tick();
    expect(h.controller.state.phase).toBe("showing");
  });

  test("片段播完前不会被请求（不抢屏）", async () => {
    const h = harness();
    h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
    h.controller.clipStarted();
    expect(h.calls.length).toBe(0);
    // 片段自己结束 → 这时才请求
    h.controller.release("ended");
    expect(h.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------- 打断

describe("epoch 打断是终态", () => {
  test("请求中被 epoch 打断：立刻隐藏，迟到的 resolve 不许把画面拉回来", async () => {
    const pending = deferred<IllustrateResponse>();
    const h = harness({ respond: () => pending.promise });

    armAndRelease(h);
    await tick();
    expect(h.controller.state.phase).toBe("requesting");

    h.controller.abort("epoch");
    expect(h.controller.state.phase).toBe("interrupted");
    expect(illustrationVisible(h.controller.state)).toBe(false);

    // 迟到的结果
    pending.resolve({ ok: true, dataUrl: DATA_URL, cached: false, ms: 900 });
    await tick();

    expect(h.controller.state.phase).toBe("interrupted");
    expect(h.controller.state.dataUrl).toBeNull();
    expect(illustrationVisible(h.controller.state)).toBe(false);

    // 4s 的 hold 定时器也必须被取消（不会再产生 hold 迁移）
    h.timers.advance(HOLD_MS * 2);
    expect(h.controller.state.phase).toBe("interrupted");
  });

  test("呈现中被 epoch 打断：立即可见性为 false，不再回屏", async () => {
    const h = harness();
    armAndRelease(h);
    await tick();
    expect(illustrationVisible(h.controller.state)).toBe(true);

    h.controller.abort("epoch");
    expect(illustrationVisible(h.controller.state)).toBe(false);
    h.timers.advance(HOLD_MS * 2);
    expect(h.controller.state.phase).toBe("interrupted");
    expect(illustrationVisible(h.controller.state)).toBe(false);
  });

  test("打断之后再 arm 也不会重新开始（会话内一次性）", async () => {
    const h = harness();
    armAndRelease(h);
    await tick();
    h.controller.abort("epoch");
    h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
    h.controller.release("ended");
    await tick();
    expect(h.controller.state.phase).toBe("interrupted");
    expect(h.calls.length).toBe(1);
  });

  test("打断会留下一条 warn 记录（诊断区可查），不含任何失败样式要求的数据", async () => {
    const h = harness();
    h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
    h.controller.abort("epoch");
    const last = h.controller.records.at(-1);
    expect(last?.tone).toBe("warn");
    expect(last?.detail).toContain("epoch");
  });
});

// ---------------------------------------------------------------- 未配置 / 配额

describe("not-configured 是正常态", () => {
  test("未配置：静默跳过，只留一行 info 记录，绝不产生失败记录", async () => {
    const h = harness({
      respond: async () => ({ ok: false, reason: "not-configured" }),
    });
    armAndRelease(h);
    await tick();

    expect(h.controller.state.phase).toBe("skipped");
    expect(h.controller.state.skipReason).toBe("not-configured");
    expect(illustrationVisible(h.controller.state)).toBe(false);

    expect(h.controller.records.length).toBe(1);
    const record = h.controller.records[0]!;
    expect(record.tone).toBe("info");
    expect(record.detail).toBe("生成式插图：服务端未配置");
    expect(h.controller.records.filter((item) => item.tone === "error").length).toBe(0);
  });

  test("确认未配置后不再尝试（不会再刷记录、不会重复请求）", async () => {
    const h = harness({ respond: async () => ({ ok: false, reason: "not-configured" }) });
    armAndRelease(h);
    await tick();
    expect(h.controller.unavailable).toBe(true);

    h.controller.arm({ sessionId: "s1", beatId: "storm", scene: "cafe_night" });
    h.controller.release("ended");
    await tick();

    expect(h.calls.length).toBe(1);
    expect(h.controller.records.length).toBe(1);
  });

  test("配额用尽同样静默（session-limit 不当失败）", async () => {
    const h = harness({ respond: async () => ({ ok: false, reason: "session-limit" }) });
    armAndRelease(h);
    await tick();
    expect(h.controller.state.skipReason).toBe("session-limit");
    expect(h.controller.records.every((record) => record.tone !== "error")).toBe(true);
  });

  test("上游失败：静默回落，但记录为 error（诊断区唯一会红标的情况）", async () => {
    const h = harness({ respond: async () => ({ ok: false, reason: "upstream" }) });
    armAndRelease(h);
    await tick();
    expect(h.controller.state.phase).toBe("skipped");
    expect(h.controller.state.skipReason).toBe("upstream");
    expect(illustrationVisible(h.controller.state)).toBe(false);
    expect(h.controller.records.at(-1)?.tone).toBe("error");
  });

  test("会话未建立：不发请求，warn 记录", async () => {
    const h = harness();
    h.controller.arm({ sessionId: null, beatId: "storm", scene: "cafe_night" });
    h.controller.release("ended");
    await tick();
    expect(h.calls.length).toBe(0);
    expect(h.controller.state.skipReason).toBe("no-session");
  });
});
