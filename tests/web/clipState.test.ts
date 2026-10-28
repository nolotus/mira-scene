/**
 * 片段四态状态机 + ?demo=media 解析。
 *
 * 这一组测试对应题目第 ⑤ 条的四个必答题：加载、播放结束、中途打断、失败。
 * 全部打在纯函数上，不需要真的起浏览器、也不需要等 1 秒。
 */
import { describe, expect, test } from "bun:test";
import {
  CLIP_DURATION_MS,
  CLIP_FRAMES,
  CLIP_ID,
  CLIP_MISSING_SRC,
  CLIP_SRC,
  IDLE_CLIP,
  clipPhaseLabel,
  clipReducer,
  clipSrcFor,
  clipVisible,
  createPlayedClips,
  frameAt,
  isStormShot,
} from "../../src/web/stage/clip/clipState";
import { DEMO_BADGE, parseDemoFlag } from "../../src/web/ui/demo";

const loading = () => clipReducer(IDLE_CLIP, { type: "load", clip: CLIP_ID }).state;
const playing = () => clipReducer(loading(), { type: "loaded" }).state;

describe("clipState：加载 → 播放 → 结束 是单向的", () => {
  test("idle → loading → playing → ended，每一步都有可见的相位变化", () => {
    expect(IDLE_CLIP.phase).toBe("idle");
    expect(clipVisible(IDLE_CLIP)).toBe(false);

    const a = clipReducer(IDLE_CLIP, { type: "load", clip: CLIP_ID });
    expect(a.state.phase).toBe("loading");
    expect(a.state.clip).toBe(CLIP_ID);
    expect(clipVisible(a.state)).toBe(true);

    const b = clipReducer(a.state, { type: "loaded" });
    expect(b.state.phase).toBe("playing");
    expect(clipVisible(b.state)).toBe(true);

    const c = clipReducer(b.state, { type: "ended" });
    expect(c.state.phase).toBe("ended");
    expect(c.effect.ended).toBe(true);
    expect(c.state.reports.ended).toBe(1);
    // 播完必须回落角色画面
    expect(clipVisible(c.state)).toBe(false);
    expect(clipPhaseLabel(c.state.phase)).toContain("已放完");
  });

  test("没进 playing 之前 ended 无效（不能跳过加载）", () => {
    const state = loading();
    const early = clipReducer(state, { type: "ended" });
    expect(early.state).toBe(state);
    expect(early.effect.ended).toBe(false);
    expect(early.state.phase).toBe("loading");
  });

  test("ended 之后 loaded / abort 都不会把画面拉回来", () => {
    const ended = clipReducer(playing(), { type: "ended" }).state;
    for (const event of [
      { type: "loaded" as const },
      { type: "abort" as const, reason: "epoch" as const },
      { type: "error" as const, message: "迟到的错误" },
    ]) {
      const t = clipReducer(ended, event);
      expect(t.state).toBe(ended);
      expect(t.effect).toEqual({ ended: false, failed: false, interrupted: false });
      expect(clipVisible(t.state)).toBe(false);
    }
  });
});

describe("clipState：播放中被打断", () => {
  test("playing 中 abort → interrupted，并保住打断原因", () => {
    const aborted = clipReducer(playing(), { type: "abort", reason: "epoch" });
    expect(aborted.state.phase).toBe("interrupted");
    expect(aborted.state.abortReason).toBe("epoch");
    expect(aborted.effect.interrupted).toBe(true);
    // 打断 = 立刻停帧并隐藏
    expect(clipVisible(aborted.state)).toBe(false);
  });

  test("interrupted 是终态：之后任何事件都不再改变状态", () => {
    const aborted = clipReducer(playing(), { type: "abort", reason: "interrupt" }).state;
    const late = [
      { type: "loaded" as const },
      { type: "ended" as const },
      { type: "error" as const, message: "迟到的解码失败" },
      { type: "abort" as const, reason: "user" as const },
    ];
    for (const event of late) {
      const t = clipReducer(aborted, event);
      expect(t.state).toBe(aborted);
      expect(t.effect).toEqual({ ended: false, failed: false, interrupted: false });
    }
    // 也就是说：没有任何回调能把已经隐藏的片段拉回画面
    expect(aborted.reports.ended).toBe(0);
    expect(aborted.reports.failed).toBe(0);
  });

  test("loading 中也能打断（还没画出画面时打断同样安全）", () => {
    const aborted = clipReducer(loading(), { type: "abort", reason: "turn" });
    expect(aborted.state.phase).toBe("interrupted");
    expect(aborted.effect.interrupted).toBe(true);
  });
});

describe("clipState：失败只回报一次", () => {
  test("loading 中 404 → failed，记录原因，并回落角色", () => {
    const failed = clipReducer(loading(), { type: "error", message: "HTTP 404" });
    expect(failed.state.phase).toBe("failed");
    expect(failed.state.error).toBe("HTTP 404");
    expect(failed.effect.failed).toBe(true);
    expect(failed.state.reports.failed).toBe(1);
    expect(clipVisible(failed.state)).toBe(false);
    expect(clipPhaseLabel(failed.state.phase)).toContain("已降级");
  });

  test("重复 error 不会二次上报，也不会覆盖第一条原因", () => {
    const first = clipReducer(loading(), { type: "error", message: "HTTP 404" }).state;
    const again = clipReducer(first, { type: "error", message: "HTTP 500" });
    expect(again.state).toBe(first);
    expect(again.effect.failed).toBe(false);
    expect(again.state.reports.failed).toBe(1);
    expect(again.state.error).toBe("HTTP 404");
  });

  test("失败后 abort / ended 不改变状态（不会二次上报）", () => {
    const failed = clipReducer(playing(), { type: "error", message: "解码失败" }).state;
    for (const event of [
      { type: "abort" as const, reason: "user" as const },
      { type: "ended" as const },
    ]) {
      const t = clipReducer(failed, event);
      expect(t.state).toBe(failed);
      expect(t.effect).toEqual({ ended: false, failed: false, interrupted: false });
    }
  });
});

describe("clipState：结束回调唯一性", () => {
  test("重复 ended 只算一次", () => {
    const first = clipReducer(playing(), { type: "ended" });
    const second = clipReducer(first.state, { type: "ended" });
    const third = clipReducer(second.state, { type: "ended" });
    expect(second.state).toBe(first.state);
    expect(third.state).toBe(first.state);
    expect(second.effect.ended).toBe(false);
    expect(first.state.reports.ended).toBe(1);
  });

  test("reset 后计数保留（同一会话的累计事实不被清掉）", () => {
    const ended = clipReducer(playing(), { type: "ended" }).state;
    const reset = clipReducer(ended, { type: "reset" }).state;
    expect(reset.phase).toBe("idle");
    expect(reset.clip).toBeNull();
    expect(reset.reports.ended).toBe(1);
  });
});

describe("clipState：触发条件与已播集合", () => {
  const scene = {
    vfx: {},
    camera: null,
    pendingActions: [],
  };

  test("vfx: lightning 命中即 storm；大雨 + 镜头抖 / 冷颤也算", () => {
    expect(isStormShot({ ...scene, vfx: { lightning: 0.2 } })).toBe(true);
    expect(isStormShot({ ...scene, vfx: { rain_heavy: 0.4 }, camera: "shake" })).toBe(true);
    expect(
      isStormShot({ ...scene, vfx: { rain_heavy: 0.4 }, pendingActions: ["shiver"] }),
    ).toBe(true);
    expect(isStormShot({ ...scene, vfx: { rain_heavy: 0.4 } })).toBe(false);
    expect(isStormShot({ ...scene, vfx: { warm_glow: 0.9 } })).toBe(false);
  });

  test("同一会话内同一片段只播一次", () => {
    const played = createPlayedClips();
    expect(played.has(CLIP_ID)).toBe(false);
    expect(played.add(CLIP_ID)).toBe(true);
    expect(played.add(CLIP_ID)).toBe(false);
    expect(played.has(CLIP_ID)).toBe(true);
    expect(played.size).toBe(1);
    played.clear();
    expect(played.has(CLIP_ID)).toBe(false);
  });

  test("帧号与时长：12 帧 @12fps，越界夹到末帧", () => {
    expect(CLIP_FRAMES).toBe(12);
    expect(CLIP_DURATION_MS).toBe(1000);
    expect(frameAt(-5)).toBe(0);
    expect(frameAt(0)).toBe(0);
    expect(frameAt(500)).toBe(6);
    expect(frameAt(999)).toBe(11);
    expect(frameAt(CLIP_DURATION_MS)).toBe(11);
    expect(frameAt(99_999)).toBe(11);
  });
});

describe("clipState：?demo=media", () => {
  test("解析出 media 故障，并带上演示模式标注", () => {
    const flags = parseDemoFlag("?demo=media");
    expect(flags.active).toBe(true);
    expect(flags.raw).toBe("media");
    expect(flags.faults).toEqual(["media"]);
    expect(flags.badge).toBe(DEMO_BADGE);
    expect(flags.summary).toContain("404");
  });

  test("media 故障 → 换成必定 404 的地址；正常时用真实资源", () => {
    expect(clipSrcFor(true)).toBe(CLIP_MISSING_SRC);
    expect(clipSrcFor(false)).toBe(CLIP_SRC);
    expect(CLIP_MISSING_SRC).not.toBe(CLIP_SRC);
    expect(CLIP_MISSING_SRC.endsWith(".png")).toBe(true);
    const flags = parseDemoFlag("?demo=media");
    expect(clipSrcFor(flags.faults.includes("media"))).toBe(CLIP_MISSING_SRC);
  });

  test("其它演示取值不受影响，未知取值仍按 fail 处理", () => {
    expect(parseDemoFlag("?demo=all").faults).toEqual(["turn", "timeout", "tts"]);
    expect(parseDemoFlag("?demo=media1").faults).toEqual(["turn"]);
    expect(parseDemoFlag("?demo=0").active).toBe(false);
  });
});
