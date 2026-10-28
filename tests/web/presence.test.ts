/**
 * 在场状态仲裁器（presence）的验收测试。
 *
 * 这一组测试对应「角色视觉跟真实声音对不上」的四个具体病灶：
 *   1. 文本到了、音频还没开始 → 必须是 thinking，且**口型必须关闭**（原来这里已经在动嘴）
 *   2. 音频开播 → speaking（口型开启，唯一允许动嘴的状态）
 *   3. turn.end 已到但音频还在播 → 仍 speaking（原来这里回了 idle）
 *   4. 音频播完（tts → idle）→ 才回 idle
 *   5. 麦克风真的在采集 → listening，口型关闭
 *   6. 120ms 内 thinking↔speaking 反复 → 只发生一次切换（最小停留）
 *   7. 失败路径 → idle，reason 可读
 *
 * 时间戳全部手写（仲裁器只接受调用方传入的 `now`），所以不需要 fake timer。
 */

import { describe, expect, test } from "bun:test";
import {
  PRESENCE_MIN_HOLD_MS,
  arbitrate,
  createPresenceArbiter,
  createPresenceState,
  createPresenceTrace,
  describePresence,
  micPhaseOf,
  parsePresenceTraceFlag,
  readTtsError,
  requestPhaseOf,
  stepPresence,
  summarizeTrace,
  ttsPhaseOf,
  type PresenceInputs,
  type PresenceState,
  type TraceSample,
} from "../../src/web/state/presence";

const base: PresenceInputs = {
  request: "streaming",
  tts: "idle",
  mic: "off",
  hasText: true,
  hasAudio: false,
};

const withBase = (patch: Partial<PresenceInputs>): PresenceInputs => ({ ...base, ...patch });

/** 把一串 (时刻, 输入) 依次喂进仲裁器，返回每一步之后的状态 */
function run(steps: Array<[number, Partial<PresenceInputs>]>): Array<{ at: number; state: PresenceState }> {
  const first = steps[0]?.[0] ?? 0;
  let state = createPresenceState(base, first);
  return steps.map(([at, patch]) => {
    state = stepPresence(state, withBase(patch), at);
    return { at, state };
  });
}

/** 统计状态切换次数（用于最小停留断言） */
function transitions(history: PresenceState[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1]?.presence.status;
    const next = history[i]?.presence.status;
    if (prev !== next) out.push(`${prev}→${next}`);
  }
  return out;
}

// ---------------------------------------------------------------- 1

describe("文本已到但音频未开始", () => {
  test("thinking，且口型必须关闭（不再提前动嘴）", () => {
    const p = arbitrate(withBase({ request: "streaming", hasText: true, hasAudio: false, tts: "synthesizing" }));
    expect(p.status).toBe("thinking");
    expect(p.mouth).toBe("closed");
    expect(p.mouthDrive).toBe(false);
    expect(p.reason).toBe("request:streaming(text-ready,audio-pending)");
  });

  test("刚提交（submitted）也是 thinking", () => {
    const p = arbitrate(withBase({ request: "submitted", hasText: false, tts: "synthesizing" }));
    expect(p.status).toBe("thinking");
    expect(p.mouthDrive).toBe(false);
    expect(p.reason).toBe("request:submitted");
  });

  test("整条「文本先到 → 音频未到」的链路上，没有任何一帧允许动嘴", () => {
    const history = run([
      [0, { request: "submitted", hasText: false, tts: "synthesizing" }],
      [400, { request: "streaming", hasText: true, tts: "synthesizing" }],
      [1800, { request: "streaming", hasText: true, hasAudio: false, tts: "synthesizing" }],
    ]).map((s) => s.state);
    expect(history.every((s) => s.presence.status === "thinking")).toBe(true);
    expect(history.every((s) => s.presence.mouthDrive === false)).toBe(true);
  });
});

// ---------------------------------------------------------------- 2

describe("音频开始播", () => {
  test("speaking，口型开启，reason 指向 tts:playing", () => {
    const p = arbitrate(withBase({ request: "streaming", hasAudio: true, tts: "playing" }));
    expect(p.status).toBe("speaking");
    expect(p.mouthDrive).toBe(true);
    expect(p.reason).toBe("tts:playing");
  });

  test("thinking → speaking 的切换发生在音频开播之后（不是文本到达之后）", () => {
    const history = run([
      [0, { request: "streaming", hasText: true, tts: "synthesizing" }],
      [1200, { request: "streaming", hasText: true, tts: "synthesizing" }],
      [1900, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
    ]).map((s) => s.state);
    expect(history[1]?.presence.status).toBe("thinking");
    expect(history[2]?.presence.status).toBe("speaking");
    expect(transitions(history)).toEqual(["thinking→speaking"]);
  });
});

// ---------------------------------------------------------------- 3

describe("turn.end 已到但音频还在播", () => {
  test("仍是 speaking，不许提前回 idle", () => {
    const p = arbitrate(
      withBase({ request: "ended", hasText: true, hasAudio: true, tts: "playing" }),
    );
    expect(p.status).toBe("speaking");
    expect(p.mouthDrive).toBe(true);
  });

  test("turn.end 之后音频进入句间空隙（synthesizing + 已有音频）：还是 speaking，但口型关掉", () => {
    const p = arbitrate(
      withBase({ request: "ended", hasText: true, hasAudio: true, tts: "synthesizing" }),
    );
    expect(p.status).toBe("speaking");
    expect(p.mouthDrive).toBe(false);
    expect(p.reason).toBe("tts:synthesizing(audio-in-flight)");
  });

  test("状态机层面：request 已经 ended，speaking 也不会因为「请求结束」而掉回 idle", () => {
    const steps = run([
      [0, { request: "streaming", hasText: true, tts: "synthesizing" }],
      [200, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [900, { request: "ended", hasText: true, hasAudio: true, tts: "playing" }],
      [1500, { request: "ended", hasText: true, hasAudio: true, tts: "playing" }],
    ]);
    const history = steps.map((s) => s.state);
    expect(history.slice(1).every((s) => s.presence.status === "speaking")).toBe(true);
    expect(transitions(history)).toEqual(["thinking→speaking"]);
  });

  test("守住 speaking：即使输入说没事了，只要 tts 还没 idle 就不降级", () => {
    const history = run([
      [0, { request: "streaming", hasText: true, tts: "synthesizing" }],
      [200, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      // 一个坏输入：请求已结束、tts 报 synthesizing（分片在飞）
      [600, { request: "ended", hasText: true, hasAudio: false, tts: "synthesizing" }],
    ]).map((s) => s.state);
    const last = history[history.length - 1];
    expect(last?.presence.status).toBe("speaking");
    expect(last?.presence.mouthDrive).toBe(false);
    expect(last?.presence.reason.startsWith("hold:speaking")).toBe(true);
  });
});

// ---------------------------------------------------------------- 4

describe("音频播完才回 idle", () => {
  test("tts → idle 且本轮结束 → idle", () => {
    const p = arbitrate(withBase({ request: "ended", hasText: true, hasAudio: true, tts: "idle" }));
    expect(p.status).toBe("idle");
    expect(p.mouthDrive).toBe(false);
    expect(p.reason).toBe("request:ended");
  });

  test("时序：speaking 的结束时刻不早于 tts 回 idle 的时刻", () => {
    const history = run([
      [0, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [1000, { request: "ended", hasText: true, hasAudio: true, tts: "playing" }],
      [2400, { request: "ended", hasText: true, hasAudio: true, tts: "idle" }],
      [2600, { request: "ended", hasText: true, hasAudio: true, tts: "idle" }],
    ]);
    const speakingAt = history.filter((h) => h.state.presence.status === "speaking").map((h) => h.at);
    const idleAt = history.find((h) => h.state.presence.status === "idle")?.at ?? null;
    // t=0 的那一次被最小停留压住（还没满 160ms），1000 时刻才真正开口；
    // tts 在 2400 变 idle，同一采样点才允许回待机 —— 不会更早。
    expect(speakingAt).toEqual([1000]);
    expect(idleAt).toBe(2400);
  });
});

// ---------------------------------------------------------------- 5

describe("麦克风真实采集", () => {
  test("capturing 且有用户语音 → listening，口型关闭", () => {
    const p = arbitrate(
      withBase({ request: "idle", hasText: false, mic: "capturing", userSpeaking: true, tts: "idle" }),
    );
    expect(p.status).toBe("listening");
    expect(p.mouth).toBe("closed");
    expect(p.mouthDrive).toBe(false);
    expect(p.reason).toBe("mic:capturing(speech)");
  });

  test("capturing 但没有语音活动信号时按「在听」处理", () => {
    expect(arbitrate(withBase({ request: "idle", hasText: false, mic: "capturing" })).status).toBe(
      "listening",
    );
  });

  test("请求在路上、麦克风也开着但她没开口 → thinking（不被一个常开的麦克风盖住）", () => {
    const p = arbitrate(withBase({ request: "submitted", mic: "capturing", hasText: false }));
    expect(p.status).toBe("thinking");
    expect(p.reason).toBe("request:submitted");
  });

  test("请求在路上但用户正在说话（插话）→ listening 优先", () => {
    const p = arbitrate(
      withBase({ request: "submitted", mic: "capturing", userSpeaking: true, hasText: false }),
    );
    expect(p.status).toBe("listening");
    expect(p.reason).toBe("mic:capturing(speech)");
  });

  test("音频在播时 speaking 优先于 listening（口型跟音频，不跟麦克风）", () => {
    const p = arbitrate(
      withBase({ hasAudio: true, tts: "playing", mic: "capturing", userSpeaking: true }),
    );
    expect(p.status).toBe("speaking");
    expect(p.mouthDrive).toBe(true);
  });

  test("mic 状态映射：只有 listening 才算真的在采集", () => {
    expect(micPhaseOf("listening")).toBe("capturing");
    expect(micPhaseOf("requesting")).toBe("requesting");
    expect(micPhaseOf("idle")).toBe("off");
    expect(micPhaseOf("denied")).toBe("off");
    expect(micPhaseOf("unsupported")).toBe("off");
  });
});

// ---------------------------------------------------------------- 6

describe("状态抖动与最小停留", () => {
  test("120ms 内 thinking↔speaking 反复 → 只发生一次切换", () => {
    const steps = run([
      [0, { request: "streaming", hasText: true, tts: "synthesizing" }],
      [20, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [40, { request: "streaming", hasText: true, hasAudio: true, tts: "synthesizing" }],
      [60, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [80, { request: "streaming", hasText: true, hasAudio: true, tts: "synthesizing" }],
      [110, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [140, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [170, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [200, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
    ]);
    const history = steps.map((s) => s.state);

    expect(transitions(history)).toEqual(["thinking→speaking"]);
    // 这次切换发生在最小停留满之后（120ms 内的反复一次都没提交）
    const speakingStep = steps.find((s) => s.state.presence.status === "speaking");
    expect(speakingStep?.at).toBeGreaterThanOrEqual(PRESENCE_MIN_HOLD_MS);
  });

  test("抖回原状态 → 一次切换都不发生", () => {
    const steps = run([
      [0, { request: "streaming", hasText: true, tts: "synthesizing" }],
      [30, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [90, { request: "streaming", hasText: true, hasAudio: true, tts: "synthesizing" }],
      [150, { request: "streaming", hasText: true, tts: "synthesizing" }],
    ]);
    const history = steps.map((s) => s.state);
    expect(transitions(history)).toEqual([]);
    expect(steps[steps.length - 1]?.state.presence.status).toBe("thinking");
  });

  test("最小停留时长可注入：60ms 的抖动在 40ms 阈值下不生效", () => {
    let state = createPresenceState(base, 0);
    state = stepPresence(
      state,
      withBase({ hasAudio: true, tts: "playing" }),
      40,
      40,
    );
    expect(state.presence.status).toBe("speaking");

    let slow = createPresenceState(base, 0);
    slow = stepPresence(slow, withBase({ hasAudio: true, tts: "playing" }), 40, 400);
    expect(slow.presence.status).toBe("thinking");
    expect(slow.pending?.presence.status).toBe("speaking");

    slow = stepPresence(slow, withBase({ hasAudio: true, tts: "playing" }), 420, 400);
    expect(slow.presence.status).toBe("speaking");
    expect(slow.pending).toBeNull();
  });

  test("同一个输入重复喂不会产生新对象（避免 React 无意义重渲染）", () => {
    const input = withBase({ hasAudio: true, tts: "playing" });
    const first = createPresenceState(input, 0);
    expect(stepPresence(first, input, 50)).toBe(first);
  });
});

// ---------------------------------------------------------------- 7

describe("失败路径", () => {
  test("tts failed + request failed → idle，reason 两条原因都写清", () => {
    const p = arbitrate(
      withBase({ request: "failed", tts: "failed", hasText: true, hasAudio: false }),
    );
    expect(p.status).toBe("idle");
    expect(p.mouthDrive).toBe(false);
    expect(p.reason).toBe("request:failed+tts:failed");
    expect(describePresence(p)).toBe("idle ← request:failed+tts:failed");
  });

  test("只有 tts 失败也回 idle（不许停在 thinking）", () => {
    const p = arbitrate(withBase({ request: "ended", tts: "failed", hasAudio: false }));
    expect(p.status).toBe("idle");
    expect(p.reason).toBe("tts:failed");
  });

  test("从 speaking 直接失败 → 允许降级（失败不该被 hold 卡住）", () => {
    const history = run([
      [0, { request: "streaming", hasText: true, hasAudio: true, tts: "playing" }],
      [900, { request: "failed", hasText: false, tts: "failed" }],
    ]).map((s) => s.state);
    const last = history[history.length - 1];
    expect(last?.presence.status).toBe("idle");
    expect(last?.presence.reason).toBe("request:failed+tts:failed");
  });
});

// ---------------------------------------------------------------- 信号推导

describe("信号推导（App 接线的那一半）", () => {
  test("requestPhaseOf：submitted / streaming / ended / failed / idle", () => {
    expect(
      requestPhaseOf({ turnActive: true, firstEventAt: null, error: null, lastTurnId: "t1" }),
    ).toBe("submitted");
    expect(
      requestPhaseOf({ turnActive: true, firstEventAt: 1, error: null, lastTurnId: "t1" }),
    ).toBe("streaming");
    expect(
      requestPhaseOf({ turnActive: false, firstEventAt: 1, error: null, lastTurnId: "t1" }),
    ).toBe("ended");
    expect(
      requestPhaseOf({ turnActive: false, firstEventAt: null, error: "boom", lastTurnId: "t1" }),
    ).toBe("failed");
    expect(
      requestPhaseOf({ turnActive: false, firstEventAt: null, error: null, lastTurnId: null }),
    ).toBe("idle");
  });

  test("ttsPhaseOf：isSpeaking 优先，其次是失败，其次才是「还在路上」", () => {
    expect(ttsPhaseOf({ playing: true, error: "x", request: "streaming" })).toBe("playing");
    expect(ttsPhaseOf({ playing: false, error: "x", request: "streaming" })).toBe("failed");
    expect(ttsPhaseOf({ playing: false, error: null, request: "streaming" })).toBe("synthesizing");
    expect(ttsPhaseOf({ playing: false, error: null, request: "submitted" })).toBe("synthesizing");
    expect(ttsPhaseOf({ playing: false, error: null, request: "ended" })).toBe("idle");
    expect(ttsPhaseOf({ playing: false, error: null, request: "failed" })).toBe("failed");
  });

  test("readTtsError：读不到就 null，绝不吃异常", () => {
    expect(readTtsError(null)).toBeNull();
    expect(readTtsError({})).toBeNull();
    expect(readTtsError({ error: "  " })).toBeNull();
    expect(readTtsError({ error: "解码失败" })).toBe("解码失败");
    expect(
      readTtsError({
        get error() {
          throw new Error("boom");
        },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------- 时间线自证

describe("时间线自证（?trace=1 的判据）", () => {
  const timeline: TraceSample[] = [
    { t: 0, status: "thinking", tts: "synthesizing", hasAudio: false, subtitleLen: 0 },
    { t: 50, status: "thinking", tts: "synthesizing", hasAudio: false, subtitleLen: 0 },
    { t: 700, status: "thinking", tts: "synthesizing", hasAudio: false, subtitleLen: 12 },
    { t: 1750, status: "thinking", tts: "synthesizing", hasAudio: true, subtitleLen: 24 },
    { t: 1800, status: "speaking", tts: "playing", hasAudio: true, subtitleLen: 24 },
    { t: 2400, status: "speaking", tts: "playing", hasAudio: true, subtitleLen: 27 },
    { t: 3000, status: "speaking", tts: "playing", hasAudio: true, subtitleLen: 30 },
    { t: 4200, status: "speaking", tts: "idle", hasAudio: true, subtitleLen: 30 },
    { t: 4400, status: "idle", tts: "idle", hasAudio: true, subtitleLen: 30 },
  ];

  test("健康的时序：三条断言全过", () => {
    const summary = summarizeTrace(timeline);
    expect(summary.thinkingGapMs).toBe(1100);
    expect(summary.startLagMs).toBe(0);
    expect(summary.endLagMs).toBeGreaterThanOrEqual(0);
    expect(summary.prematureDowngrade).toBe(false);
    expect(summary.ok).toBe(true);
  });

  test("旧的错位时序（文本一到就 speaking）会被抓出来", () => {
    const broken: TraceSample[] = timeline.map((s) =>
      s.t >= 700 && s.t < 1800 ? { ...s, status: "speaking" } : s,
    );
    const summary = summarizeTrace(broken);
    expect(summary.thinkingOk).toBe(false);
    expect(summary.ok).toBe(false);
  });

  test("句间掉回 idle（声音还在响）会被抓出来", () => {
    const broken: TraceSample[] = timeline.map((s) => (s.t === 2400 ? { ...s, status: "idle" } : s));
    const summary = summarizeTrace(broken);
    expect(summary.prematureDowngrade).toBe(true);
    expect(summary.endOk).toBe(false);
    expect(summary.ok).toBe(false);
  });

  test("提前整体回待机也会被抓出来", () => {
    const broken: TraceSample[] = timeline.map((s) =>
      s.t === 3000 || s.t === 4200 ? { ...s, status: "idle" } : s,
    );
    const summary = summarizeTrace(broken);
    expect(summary.speakingEndT).toBe(2400);
    expect(summary.endLagMs).toBeLessThan(0);
    expect(summary.endOk).toBe(false);
  });

  test("采样器：记录相对时间、可导出 JSON", () => {
    let now = 1000;
    const trace = createPresenceTrace(() => now);
    trace.push({ status: "thinking", tts: "synthesizing", hasAudio: false, subtitleLen: 0 });
    now = 1050;
    trace.push({ status: "speaking", tts: "playing", hasAudio: true, subtitleLen: 4 });
    expect(trace.records.map((r) => r.t)).toEqual([0, 50]);
    expect(JSON.parse(trace.json())).toHaveLength(2);
    expect(trace.records[1]?.status).toBe("speaking");
  });

  test("?trace=1 开关：显式才算开", () => {
    expect(parsePresenceTraceFlag("?trace=1")).toBe(true);
    expect(parsePresenceTraceFlag("?trace=on")).toBe(true);
    expect(parsePresenceTraceFlag("?trace=0")).toBe(false);
    expect(parsePresenceTraceFlag("")).toBe(false);
    expect(parsePresenceTraceFlag("?demo=fail")).toBe(false);
  });
});

// ---------------------------------------------------------------- 门面

describe("createPresenceArbiter 门面", () => {
  test("按注入的时钟推进，输出与 stepPresence 一致", () => {
    const arbiter = createPresenceArbiter({ clock: () => 0, minHoldMs: 160 });
    expect(arbiter.get().reason).toBe("boot");
    expect(arbiter.update(base, 0).status).toBe("thinking");
    expect(arbiter.update(withBase({ hasAudio: true, tts: "playing" }), 100).status).toBe("thinking");
    expect(arbiter.state().pending?.presence.status).toBe("speaking");
    expect(arbiter.update(withBase({ hasAudio: true, tts: "playing" }), 200).status).toBe("speaking");
    expect(arbiter.reset(base, 300).status).toBe("thinking");
  });
});
