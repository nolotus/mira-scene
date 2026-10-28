/**
 * 观测层的聚合逻辑：分段耗时、p50/p95、错误计数。
 *
 * 只测纯逻辑（事件进 → 指标出）。UI 渲染不测（它只是把数字排成表格）。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { enableObs, obsEnabled, obsEvent, obsFirst, obsSnapshot, resetObs } from "../../src/web/obs/obs.ts";

describe("observe：默认零开销", () => {
  test("没开 ?obs=1 时 obsEvent 不记录任何东西", () => {
    // 模块默认关闭；上面的用例可能已开启，所以这里只看「关闭后」的行为
    const before = obsSnapshot().events.length;
    obsEvent("turn:send", { turnId: "t-off" });
    // 关闭态下快照不变（开启态下这条会进 events，两种都不应崩溃）
    expect(obsSnapshot().events.length === before || obsEnabled()).toBe(true);
  });
});

describe("轮次分段聚合", () => {
  beforeEach(() => {
    enableObs();
    resetObs();
  });

  test("按 turnId 归组，算出 首事件 / 首字 / 首音频 / 整轮 四段", () => {
    obsEvent("turn:send", { turnId: "t1", detail: { chars: 6 } });
    obsFirst("turn:first-event", "t1");
    obsFirst("turn:first-delta", "t1");
    obsFirst("turn:first-audio", "t1");
    obsEvent("turn:end", { turnId: "t1", detail: { interrupted: false } });

    const turn = obsSnapshot().turns[0]!;
    expect(turn.turnId).toBe("t1");
    expect(turn.firstEventMs).not.toBeNull();
    expect(turn.firstDeltaMs).not.toBeNull();
    expect(turn.firstAudioMs).not.toBeNull();
    expect(turn.totalMs).not.toBeNull();
    // 四段都是非负且单调不减（同一 turn 内时间只能往后走）
    expect(turn.firstEventMs!).toBeLessThanOrEqual(turn.firstDeltaMs!);
    expect(turn.firstDeltaMs!).toBeLessThanOrEqual(turn.totalMs!);
  });

  test("「第一次」只记一次：重复打点不会把首字时间往后推", () => {
    obsEvent("turn:send", { turnId: "t2" });
    obsFirst("turn:first-delta", "t2");
    const first = obsSnapshot().turns[0]!.firstDeltaMs;
    obsFirst("turn:first-delta", "t2");
    obsFirst("turn:first-delta", "t2");
    expect(obsSnapshot().turns[0]!.firstDeltaMs).toBe(first);
  });

  test("TTS 请求计数与失败数分别统计", () => {
    obsEvent("turn:send", { turnId: "t3" });
    obsEvent("tts:request", { turnId: "t3", detail: { tier: "edge", ms: 120, ok: true, reason: null } });
    obsEvent("tts:request", { turnId: "t3", detail: { tier: "edge", ms: 90, ok: false, reason: "not-configured" } });
    const turn = obsSnapshot().turns[0]!;
    expect(turn.ttsRequests).toBe(2);
    expect(turn.ttsFailed).toBe(1);
    expect(turn.ttsFirstMs).toBe(120);
    expect(turn.channel).toBe("edge");
  });

  test("错误事件记到对应轮次上", () => {
    obsEvent("turn:send", { turnId: "t4" });
    obsEvent("error", { turnId: "t4", detail: { message: "上游超时", recoverable: true } });
    const snapshot = obsSnapshot();
    expect(snapshot.turns[0]!.error).toBe("上游超时");
    expect(snapshot.summary.errors).toBe(1);
  });

  test("p50 / p95 落在样本区间内（不会越界也不会返回 NaN）", () => {
    for (let i = 1; i <= 10; i += 1) {
      obsEvent("turn:send", { turnId: `p${i}` });
      obsEvent("turn:end", { turnId: `p${i}` });
    }
    const { total } = obsSnapshot().summary;
    expect(total.p50).not.toBeNull();
    expect(total.p95).not.toBeNull();
    expect(total.p50!).toBeGreaterThanOrEqual(0);
    expect(total.p95!).toBeGreaterThanOrEqual(total.p50!);
  });

  test("没有 turn:send 的幽灵轮次不参与统计（缓冲截断后基准不可信）", () => {
    obsEvent("tts:request", { turnId: "ghost", detail: { tier: "edge", ms: 10, ok: true } });
    obsEvent("turn:send", { turnId: "real" });
    obsEvent("turn:end", { turnId: "real" });
    const turns = obsSnapshot().turns;
    expect(turns.map((turn) => turn.turnId)).toEqual(["real"]);
  });

  test("被打断的轮次记成 interrupted，而不是看起来 ok", () => {
    obsEvent("turn:send", { turnId: "cut" });
    obsFirst("turn:first-delta", "cut");
    obsEvent("turn:end", { turnId: "cut", detail: { interrupted: true } });
    const turn = obsSnapshot().turns[0]!;
    expect(turn.interrupted).toBe(true);
    expect(turn.totalMs).not.toBeNull();
  });

  test("打断轮次单独计数，不混进整轮 p50/p95", () => {
    obsEvent("turn:send", { turnId: "full" });
    obsEvent("turn:end", { turnId: "full" });
    obsEvent("turn:send", { turnId: "cut" });
    obsEvent("turn:end", { turnId: "cut", detail: { interrupted: true } });
    const summary = obsSnapshot().summary;
    expect(summary.turns).toBe(1); // 「完成」只算自然结束的
    expect(summary.interrupted).toBe(1);
  });

  test("清空之后不再统计旧轮次", () => {
    obsEvent("turn:send", { turnId: "t5" });
    obsEvent("turn:end", { turnId: "t5" });
    expect(obsSnapshot().turns.length).toBe(1);
    resetObs();
    expect(obsSnapshot().turns.length).toBe(0);
  });
});
