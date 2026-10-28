/**
 * 播放槽 + 触发闸门（纯逻辑层复现「打断一次 → 永久播不出来」）。
 *
 * 组件里的入口判断是 `if (stopRef.current !== null) return;`：打断把播放收尾了，
 * 但槽没有释放，于是之后无论会话怎么换、已播集合怎么清，都再也进不了 loading。
 * 这里用一台和组件同源的通道（clipReducer + 播放槽 + 已播集合）把这件事钉住：
 *
 *   · 打断必须释放槽（否则就是那把永不释放的锁）；
 *   · 「被打断算已播」是**明确语义**：本会话内不再重播，但不许因此变成永久锁；
 *   · 新会话（已播集合清空）后收到 storm，必须能重新进入 loading。
 */

import { describe, expect, test } from "bun:test";
import {
  CLIP_ID,
  IDLE_CLIP,
  IDLE_SLOT,
  RUNNING_SLOT,
  clipReducer,
  createPlayedClips,
  decideClipStart,
  settleClipSlot,
  type AbortReason,
  type ClipPhase,
  type ClipSlotState,
} from "../../src/web/stage/clip/clipState";

/** 与 ClipPlayer 同构的最小通道：相位机 + 播放槽 + 本会话已播集合 */
function makePlayer() {
  let clip = IDLE_CLIP;
  let slot: ClipSlotState = IDLE_SLOT;
  const played = createPlayedClips();

  const settle = (outcome: "ended" | "failed" | "aborted") => {
    const next = settleClipSlot(slot, outcome);
    slot = next.slot;
    if (next.played) played.add(CLIP_ID);
  };

  return {
    get phase(): ClipPhase {
      return clip.phase;
    },
    get occupied(): boolean {
      return slot.occupied;
    },
    get playedCount(): number {
      return played.size;
    },
    /** 收到一帧 storm：只有闸门说 start 才会真的进 loading */
    tick(storm: boolean): "start" | "hold" | "skip" {
      const decision = decideClipStart({
        storm,
        occupied: slot.occupied,
        played: played.has(CLIP_ID),
      });
      if (decision !== "start") return decision;
      slot = RUNNING_SLOT;
      clip = clipReducer(clip, { type: "load", clip: CLIP_ID }).state;
      return "start";
    },
    loaded(): void {
      clip = clipReducer(clip, { type: "loaded" }).state;
    },
    /** 会话换 epoch / 用户打断 / 新一轮开始 → 立刻收尾 */
    abort(reason: AbortReason = "user"): void {
      clip = clipReducer(clip, { type: "abort", reason }).state;
      settle("aborted");
    },
    /** 自然播完 */
    end(): void {
      clip = clipReducer(clip, { type: "ended" }).state;
      settle("ended");
    },
    /** 加载/解码失败 → 静默降级 */
    fail(): void {
      clip = clipReducer(clip, { type: "error", message: "HTTP 404" }).state;
      settle("failed");
    },
    /** 新会话：本轮已播记录清空（对应 resetPlayedClips()） */
    newSession(): void {
      played.clear();
    },
  };
}

describe("播放槽：打断必须收尾干净", () => {
  test("loading 中被打断 → 槽必须释放（否则它就是那把永不释放的锁）", () => {
    const player = makePlayer();
    expect(player.tick(true)).toBe("start");
    expect(player.occupied).toBe(true);

    player.abort("interrupt");

    expect(player.phase).toBe("interrupted");
    expect(player.occupied).toBe(false); // ← 现状缺这一步
  });

  test("playing 中被打断 → 槽同样释放", () => {
    const player = makePlayer();
    player.tick(true);
    player.loaded();
    expect(player.phase).toBe("playing");

    player.abort("epoch");

    expect(player.occupied).toBe(false);
  });

  test("自然播完 / 失败降级同样释放槽（三条收尾路径一致）", () => {
    const a = makePlayer();
    a.tick(true);
    a.loaded();
    a.end();
    expect(a.phase).toBe("ended");
    expect(a.occupied).toBe(false);

    const b = makePlayer();
    b.tick(true);
    b.fail();
    expect(b.phase).toBe("failed");
    expect(b.occupied).toBe(false);
  });
});

describe("打断算已播（明确语义，不是含糊处理）", () => {
  test("打断算已播：本会话内再命中 storm 不重播（避免每次暴雨都被同一条片段打断）", () => {
    const player = makePlayer();
    player.tick(true);
    player.loaded();
    player.abort("interrupt");

    expect(player.playedCount).toBe(1);
    expect(player.tick(true)).toBe("skip");
    expect(player.phase).toBe("interrupted");
  });

  test("打断算已播：失败降级 / 自然播完也记已播（三条收尾路径同一语义）", () => {
    const ended = makePlayer();
    ended.tick(true);
    ended.loaded();
    ended.end();
    expect(ended.playedCount).toBe(1);

    const failed = makePlayer();
    failed.tick(true);
    failed.fail();
    expect(failed.playedCount).toBe(1);
  });
});

describe("打断之后不许留下永久锁（新会话必须能重新播）", () => {
  test("新会话（已播记录清空）收到 storm → 能重新进入 loading", () => {
    const player = makePlayer();
    player.tick(true);
    player.loaded();
    player.abort("epoch");

    player.newSession(); // 会话换了，本会话记录清空

    expect(player.tick(true)).toBe("start"); // ← 现状：skip（槽没释放，永久拦截）
    expect(player.phase).toBe("loading");
  });

  test("新会话的第二次打断之后仍然可以再进（锁不会越积越多）", () => {
    const player = makePlayer();
    for (let round = 0; round < 3; round += 1) {
      expect(player.tick(true)).toBe("start");
      player.loaded();
      player.abort("interrupt");
      expect(player.occupied).toBe(false);
      player.newSession();
    }
    expect(player.tick(true)).toBe("start");
    expect(player.phase).toBe("loading");
  });
});

describe("相位机本身不是锁：interrupted 之后 load 依然有效", () => {
  test("clipReducer：loading / playing 时 abort → 再 load 回到 loading", () => {
    const loading = clipReducer(IDLE_CLIP, { type: "load", clip: CLIP_ID }).state;
    const aborted = clipReducer(loading, { type: "abort", reason: "interrupt" }).state;
    expect(aborted.phase).toBe("interrupted");

    const again = clipReducer(aborted, { type: "load", clip: CLIP_ID }).state;
    expect(again.phase).toBe("loading");
  });

  test("clipReducer：playing 时 abort → 再 load 回到 loading", () => {
    const playing = clipReducer(
      clipReducer(IDLE_CLIP, { type: "load", clip: CLIP_ID }).state,
      { type: "loaded" },
    ).state;
    const aborted = clipReducer(playing, { type: "abort", reason: "epoch" }).state;
    const again = clipReducer(aborted, { type: "load", clip: CLIP_ID }).state;
    expect(again.phase).toBe("loading");
  });
});

describe("触发闸门只看三件事", () => {
  test("storm 未命中 / 槽被占 / 已播过 三种情况分别 hold、hold、skip", () => {
    expect(decideClipStart({ storm: false, occupied: false, played: false })).toBe("hold");
    expect(decideClipStart({ storm: true, occupied: true, played: false })).toBe("hold");
    expect(decideClipStart({ storm: true, occupied: false, played: true })).toBe("skip");
    expect(decideClipStart({ storm: true, occupied: false, played: false })).toBe("start");
  });
});
