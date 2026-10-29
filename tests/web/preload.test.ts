/**
 * 预取：清单 / 省流跳过 / 时序 / 失败留痕 / 一行人话。
 *
 * 这里不碰真实网络：`loader` 与 `idle` 都是注入的，所以「300ms 之后才发起」
 * 「一次只发一个」「失败不影响后续」都能在毫秒级断言，而不是等浏览器。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  CLIP_ASSET,
  PREFETCH_DELAY_MS,
  prefetchAssets,
  prefetchLine,
  prefetchSnapshot,
  resetPrefetch,
  scheduleAt,
  shouldSkipPrefetch,
  startPrefetch,
  subscribePrefetch,
} from "../../src/web/stage/preload";

beforeEach(() => {
  resetPrefetch();
});

describe("清单", () => {
  test("清单只剩片段：照片素材已下线，不能再出现 /char/ 项", () => {
    const assets = prefetchAssets();
    expect(assets).toEqual([{ name: "clip", url: CLIP_ASSET }]);
    expect(assets.some((a) => a.url.startsWith("/char/"))).toBe(false);
  });
});

describe("省流模式", () => {
  test("saveData / 2g 跳过，普通网络不跳过", () => {
    expect(shouldSkipPrefetch(null)).toBeNull();
    expect(shouldSkipPrefetch({})).toBeNull();
    expect(shouldSkipPrefetch({ saveData: true })).toContain("省流");
    expect(shouldSkipPrefetch({ effectiveType: "2g" })).toContain("2g");
    expect(shouldSkipPrefetch({ effectiveType: "4g" })).toBeNull();
  });

  test("跳过时整轮不发起任何加载，但诊断仍能读到原因", () => {
    let loads = 0;
    startPrefetch({
      connection: { saveData: true },
      loader: async () => {
        loads += 1;
      },
      idle: (cb) => cb(),
    });
    expect(loads).toBe(0);
    const snap = prefetchSnapshot();
    expect(snap.skipped).toBe(true);
    expect(prefetchLine(snap)).toContain("跳过");
    expect(prefetchLine(snap)).toContain("省流");
  });
});

describe("时序与串行", () => {
  test("调度时刻 = load + 300ms，且它自己再等 idle 才发起", async () => {
    expect(scheduleAt(0)).toBe(PREFETCH_DELAY_MS);
    expect(PREFETCH_DELAY_MS).toBeGreaterThanOrEqual(300);

    let clock = 1000;
    let idleCb: (() => void) | null = null;
    const started: number[] = [];
    startPrefetch({
      now: () => clock,
      connection: {},
      idle: (cb) => {
        idleCb = cb;
      },
      loader: async () => {
        started.push(clock);
      },
    });
    // idle 还没跑：一个请求都不该发
    expect(started).toEqual([]);
    expect(prefetchSnapshot().scheduledAt).toBeNull();
    clock = 1300;
    idleCb!();
    await Bun.sleep(1);
    expect(started[0]).toBe(1300);
    expect(prefetchSnapshot().scheduledAt).toBe(1300);
  });

  test("一次只发一个：前一个完成前不发下一个", async () => {
    const total = prefetchAssets().length;
    const pending: Array<() => void> = [];
    const inFlight: string[] = [];
    startPrefetch({
      connection: {},
      now: () => 0,
      idle: (cb) => cb(),
      loader: (url) =>
        new Promise<void>((resolve) => {
          inFlight.push(url);
          pending.push(() => resolve());
        }),
    });
    await Bun.sleep(1);
    expect(inFlight).toHaveLength(1);
    while (pending.length > 0) {
      const next = pending.shift()!;
      next();
      await Bun.sleep(1);
      // 每完成一个才会多一个（直到清单跑完）
      expect(inFlight.length).toBeLessThanOrEqual(total);
      expect(pending.length).toBeLessThanOrEqual(1);
    }
    await Bun.sleep(2);
    expect(prefetchSnapshot().entries.filter((e) => e.state === "ok")).toHaveLength(total);
  });
});

describe("失败即降级", () => {
  test("单张失败只记原因，后续继续跑，渲染路径不被抛错打断", async () => {
    startPrefetch({
      connection: {},
      now: () => 0,
      idle: (cb) => cb(),
      // 真实清单只有片段 1 项；这里注入两项，才测得出「一张失败不影响其余」的串行语义
      assets: [
        { name: "portrait", url: "/char/portrait.png" },
        { name: "clip", url: CLIP_ASSET },
      ],
      loader: async (url) => {
        if (url.includes("portrait.png")) throw new Error("HTTP 404");
      },
    });
    await Bun.sleep(20);
    const snap = prefetchSnapshot();
    const portrait = snap.entries.find((e) => e.name === "portrait")!;
    expect(portrait.state).toBe("fail");
    expect(portrait.reason).toBe("HTTP 404");
    expect(snap.entries.filter((e) => e.state === "ok").length).toBeGreaterThan(0);
    const line = prefetchLine(snap);
    expect(line).toContain("portrait ✗（HTTP 404）");
    expect(line).toContain("clip ✓");
  });

  test("订阅者能收到每一次状态变化（诊断面板据此刷新）", async () => {
    let calls = 0;
    const off = subscribePrefetch(() => {
      calls += 1;
    });
    startPrefetch({ connection: {}, now: () => 0, idle: (cb) => cb(), loader: async () => {} });
    await Bun.sleep(20);
    off();
    expect(calls).toBeGreaterThan(2);
  });
});

describe("纯函数", () => {
  test("prefetchLine 三种形态", () => {
    expect(prefetchLine({ skipped: false, skipReason: null, scheduledAt: null, startedVia: null, entries: [] })).toBe(
      "预取：未开始",
    );
    const line = prefetchLine({
      skipped: false,
      skipReason: null,
      scheduledAt: 300,
      startedVia: "requestIdleCallback",
      entries: [
        { name: "portrait", url: "/char/portrait.png", state: "ok", startedAt: 300, doneAt: 320, reason: null },
        { name: "clip", url: CLIP_ASSET, state: "fail", startedAt: 320, doneAt: 330, reason: "HTTP 404" },
      ],
    });
    expect(line).toBe("预取：portrait ✓ / clip ✗（HTTP 404）〔1/2，requestIdleCallback〕");
  });
});
