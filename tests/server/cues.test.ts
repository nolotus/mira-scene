/**
 * 时序指令（cue）的纯函数层：排序、夹紧、按已播字数取「该触发了的」。
 *
 * 这一层是「台词与画面同一条时间轴」的地基，出错的表现很隐蔽（重复触发、越界不漏放、
 * 同一 atChar 的两条指令顺序翻车），所以每条边界都单独钉住。
 */
import { describe, expect, test } from "bun:test";
import {
  CueScanner,
  CueScheduler,
  charCount,
  clampAtChar,
  clampCues,
  cueFromDirective,
  cuesUpTo,
  readRawCue,
  sortCues,
} from "../../src/server/director/cues.ts";
import type { AnchoredCue, SpokenPlan } from "../../src/shared/protocol.ts";

const cue = (atChar: number, directive: AnchoredCue["directive"]): AnchoredCue => ({ atChar, directive });

function plan(say: string, cues: AnchoredCue[]): SpokenPlan {
  return { say, cues };
}

describe("charCount", () => {
  test("按码点计数：代理对（emoji/生僻字）算 1 个字符", () => {
    expect(charCount("雨")).toBe(1);
    expect(charCount("刚才那一下——")).toBe(7);
    expect(charCount("🙂")).toBe(1);
    expect(charCount("")).toBe(0);
  });
});

describe("sortCues / clampCues", () => {
  test("乱序输入按 atChar 升序；同一 atChar 保持输入顺序", () => {
    const sorted = sortCues([
      cue(9, { kind: "vfx", vfx: "lightning" }),
      cue(0, { kind: "action", action: "shiver" }),
      cue(3, { kind: "pose", pose: "turn_away" }),
      cue(0, { kind: "emotion", emotion: "warm" }),
    ]);
    expect(sorted.map((item) => item.atChar)).toEqual([0, 0, 3, 9]);
    expect(sorted[0]?.directive).toEqual({ kind: "action", action: "shiver" });
    expect(sorted[1]?.directive).toEqual({ kind: "emotion", emotion: "warm" });
  });

  test("不修改入参（纯函数）", () => {
    const input = [cue(5, { kind: "vfx", vfx: "rain_heavy" }), cue(1, { kind: "action", action: "nod" })];
    const snapshot = [...input];
    sortCues(input);
    expect(input).toEqual(snapshot);
  });

  test("越界 atChar 夹到 [0, say.length]；负数与非有限数都落回 0", () => {
    expect(clampAtChar(99, 10)).toBe(10);
    expect(clampAtChar(-3, 10)).toBe(0);
    expect(clampAtChar(Number.NaN, 10)).toBe(0);
    expect(clampAtChar(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampAtChar(4.7, 10)).toBe(4);

    const clamped = clampCues([cue(99, { kind: "action", action: "nod" }), cue(-1, { kind: "vfx", vfx: "lightning" })], 10);
    expect(clamped.map((item) => item.atChar)).toEqual([10, 0]);
  });
});

describe("cuesUpTo", () => {
  test("空 plan → 空数组", () => {
    expect(cuesUpTo(plan("", []), 10)).toEqual([]);
    expect(cuesUpTo(plan("嗯。", []), 10)).toEqual([]);
  });

  test("atChar = 0 在开口之前就该触发", () => {
    const p = plan("雨又大了。", [cue(0, { kind: "vfx", vfx: "lightning" })]);
    expect(cuesUpTo(p, 0)).toEqual([cue(0, { kind: "vfx", vfx: "lightning" })]);
  });

  test("按已播字数放行，未到的不返回；乱序输入按 atChar 升序返回", () => {
    const p = plan("刚才那一下——你看见了吗。", [
      cue(7, { kind: "vfx", vfx: "lightning" }),
      cue(0, { kind: "action", action: "shiver" }),
      cue(13, { kind: "pose", pose: "glance_window" }),
    ]);
    expect(cuesUpTo(p, 0).map((item) => item.atChar)).toEqual([0]);
    expect(cuesUpTo(p, 7).map((item) => item.atChar)).toEqual([0, 7]);
    expect(cuesUpTo(p, 12).map((item) => item.atChar)).toEqual([0, 7]);
    expect(cuesUpTo(p, 13).map((item) => item.atChar)).toEqual([0, 7, 13]);
  });

  test("越界 atChar 被夹到 say.length：说到最后一定放，不会永久卡住", () => {
    const p = plan("雨又大了。", [cue(999, { kind: "vfx", vfx: "rain_heavy" })]);
    expect(cuesUpTo(p, 4)).toEqual([]);
    expect(cuesUpTo(p, 5)).toEqual([cue(5, { kind: "vfx", vfx: "rain_heavy" })]);
    // charsSpoken 越界也按 say.length 算，不会崩
    expect(cuesUpTo(p, 10_000)).toEqual([cue(5, { kind: "vfx", vfx: "rain_heavy" })]);
  });

  test("同一 atChar 多条保持稳定顺序", () => {
    const p = plan("别。", [
      cue(0, { kind: "action", action: "startle" }),
      cue(0, { kind: "camera", move: "shake" }),
      cue(1, { kind: "emotion", emotion: "anxious" }),
    ]);
    expect(cuesUpTo(p, 1).map((item) => item.directive)).toEqual([
      { kind: "action", action: "startle" },
      { kind: "camera", move: "shake" },
      { kind: "emotion", emotion: "anxious" },
    ]);
  });

  test("charsSpoken 回退不会重复返回已触发的（靠 firedCount 前缀）", () => {
    const p = plan("刚才那一下——你看见了吗。", [cue(0, { kind: "action", action: "shiver" }), cue(7, { kind: "vfx", vfx: "lightning" })]);
    const first = cuesUpTo(p, 8);
    expect(first).toHaveLength(2);
    // 客户端字幕回退/重放：已触发过 2 条，再算一次不该吐出来
    expect(cuesUpTo(p, 8, 2)).toEqual([]);
    expect(cuesUpTo(p, 3, 2)).toEqual([]);
  });
});

describe("CueScheduler", () => {
  test("水位只增不减：advance 回退不重复触发", () => {
    const scheduler = new CueScheduler([
      cue(0, { kind: "action", action: "shiver" }),
      cue(7, { kind: "vfx", vfx: "lightning" }),
      cue(13, { kind: "pose", pose: "glance_window" }),
    ]);
    expect(scheduler.advance(0).map((item) => item.atChar)).toEqual([0]);
    expect(scheduler.advance(7).map((item) => item.atChar)).toEqual([7]);
    expect(scheduler.advance(2)).toEqual([]);
    expect(scheduler.watermark).toBe(7);
    expect(scheduler.advance(13).map((item) => item.atChar)).toEqual([13]);
    expect(scheduler.firedCount).toBe(3);
    expect(scheduler.pendingCount).toBe(0);
  });

  test("迟到的 cue（atChar 已越过）在下一次 advance 立刻放出，不丢", () => {
    const scheduler = new CueScheduler([], { sayLength: 20 });
    scheduler.advance(10);
    scheduler.feed([cue(4, { kind: "vfx", vfx: "lightning" })]);
    expect(scheduler.advance(10).map((item) => item.atChar)).toEqual([4]);
  });

  test("feed 追加后仍按 atChar 升序、同值稳定", () => {
    const scheduler = new CueScheduler([cue(9, { kind: "pose", pose: "turn_away" })]);
    scheduler.feed([cue(0, { kind: "action", action: "nod" }), cue(9, { kind: "camera", move: "shake" })]);
    const all = scheduler.takeAll();
    expect(all.map((item) => item.atChar)).toEqual([0, 9, 9]);
    expect(all[1]?.directive).toEqual({ kind: "pose", pose: "turn_away" });
    expect(all[2]?.directive).toEqual({ kind: "camera", move: "shake" });
  });

  test("takeAll 把越界 atChar 也放出去（收尾不漏指令）", () => {
    const scheduler = new CueScheduler([cue(99, { kind: "vfx", vfx: "rain_heavy" })], { sayLength: 5 });
    expect(scheduler.advance(5)).toEqual([]);
    expect(scheduler.takeAll().map((item) => item.atChar)).toEqual([99]);
    expect(scheduler.takeAll()).toEqual([]);
  });
});

describe("readRawCue（模型给的单条 cue）", () => {
  test("短键 d → directive", () => {
    const read = readRawCue({ atChar: 7, d: { kind: "vfx", vfx: "lightning" } });
    expect(read.dropped).toBeNull();
    expect(read.cue).toEqual({ atChar: 7, directive: { kind: "vfx", vfx: "lightning" } });
  });

  test("长键 directive 与「摊平写法」也认", () => {
    expect(readRawCue({ atChar: 2, directive: { kind: "pose", pose: "turn_away" } }).cue?.directive).toEqual({
      kind: "pose",
      pose: "turn_away",
    });
    expect(readRawCue({ atChar: 3, kind: "action", action: "nod" }).cue?.directive).toEqual({
      kind: "action",
      action: "nod",
    });
  });

  test("atChar 不是有限数字 → 整条丢弃并标原因", () => {
    expect(readRawCue({ atChar: "7", d: { kind: "action", action: "nod" } })).toEqual({
      cue: null,
      dropped: "atChar",
    });
    expect(readRawCue({ d: { kind: "action", action: "nod" } }).dropped).toBe("atChar");
    expect(readRawCue({ atChar: Number.NaN, d: { kind: "action", action: "nod" } }).dropped).toBe("atChar");
  });

  test("指令不过白名单 → 只丢这一条，原因可计数", () => {
    expect(readRawCue({ atChar: 1, d: { kind: "vfx", vfx: "tornado" } })).toEqual({
      cue: null,
      dropped: "directive",
    });
    expect(readRawCue({ atChar: 1, d: { kind: "teleport" } }).dropped).toBe("directive");
    expect(readRawCue(null).dropped).toBe("directive");
  });

  test("cueFromDirective：旧格式 → atChar 0（= 立即执行）", () => {
    expect(cueFromDirective({ kind: "vfx", vfx: "lightning" })).toEqual({
      atChar: 0,
      directive: { kind: "vfx", vfx: "lightning" },
    });
  });
});

describe("CueScanner（边收 JSON 边扫 cues 数组）", () => {
  test("对象被切在半截也不炸，收全了才吐", () => {
    const scanner = new CueScanner();
    expect(scanner.push('{"cues":[{"atChar":0,"d":{"kind":"act')).toEqual([]);
    const fresh = scanner.push('ion","action":"shiver"}},{"atChar":7,"d":{"kind":"vfx","vfx":"lightning"}}');
    expect(fresh.map((item) => item.atChar)).toEqual([0, 7]);
    expect(scanner.closed).toBe(false);
    expect(scanner.push("],")).toEqual([]);
    expect(scanner.closed).toBe(true);
  });

  test("台词里出现 \"cues\" 字样不会被当成数组开头", () => {
    const scanner = new CueScanner();
    scanner.push('{"say":"他问我 cues 是什么","cues":[{"atChar":1,"d":{"kind":"action","action":"nod"}}]}');
    expect(scanner.cues).toEqual([]);
  });

  test("非法项计数，合法项照常吐", () => {
    const scanner = new CueScanner();
    const fresh = scanner.push(
      '{"cues":[{"atChar":"x","d":{"kind":"action","action":"nod"}},{"atChar":1,"d":{"kind":"vfx","vfx":"nope"}},{"atChar":2,"d":{"kind":"vfx","vfx":"lightning"}}],',
    );
    expect(fresh).toEqual([cue(2, { kind: "vfx", vfx: "lightning" })]);
    expect(scanner.stats).toEqual({ droppedAtChar: 1, droppedDirective: 1 });
  });
});
