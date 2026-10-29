import { describe, expect, test } from "bun:test";
import type { SceneState } from "../../src/shared/protocol";
import { createInitialScene } from "../../src/web/state/session";
import type { CueKind } from "../../src/web/stage/cues.ts";
import {
  CUE_TEMPLATES,
  EMPTY_CUE_STATE,
  EXIT_FADE_MS,
  FADE_OUT_MS,
  MERGE_WINDOW_MS,
  composeCue,
  createCueScheduler,
  detectKind,
  isCueOver,
  nextBoundaryAt,
} from "../../src/web/stage/cues.ts";

// ---------------------------------------------------------------- fixtures

/** 雷雨：闪电 + 大雨 + 镜头抖 + 冷颤（mock 导演的 rain_lightning beat 的真实形态） */
const STORM: SceneState = createInitialScene({
  scene: "cafe_night",
  emotion: "anxious",
  camera: "shake",
  vfx: { lightning: 1, rain_heavy: 0.8 },
  pendingActions: ["shiver"],
  subtitle: "刚才那一下——",
  lastBeat: "t1#vfx:lightning",
});

/** 暖场：暖光 + 温柔 + 前倾 */
const WARM: SceneState = createInitialScene({
  emotion: "warm",
  pose: "lean_in",
  vfx: { warm_glow: 1 },
  subtitle: "真的？",
  lastBeat: "t1#vfx:warm_glow",
});

/** 时钟可注入的调度器 */
function schedulerAt(clock: { t: number }) {
  return createCueScheduler({ now: () => clock.t });
}

// ---------------------------------------------------------------- ① 确定性

describe("cue 编排：同一组合 → 同一条 cue", () => {  test("命中雷雨模板，且同 (state, now) 两次编排完全一致", () => {
    expect(detectKind(STORM)).toBe("storm");

    const a = composeCue(STORM, 1000);
    const b = composeCue(STORM, 1000);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a!.kind).toBe("storm");
    expect(a!.id).toBe(b!.id);
    expect(a!.startedAt).toBe(1000);
    expect(a!.durationMs).toBe(CUE_TEMPLATES.storm.durationMs);
    // 时间线字段齐备：时长、强度、各层时间
    expect(a!.intensity).toBeGreaterThan(0);
    expect(a!.intensity).toBeLessThanOrEqual(1);
    expect(a!.layers.length).toBe(CUE_TEMPLATES.storm.layers.length);
  });

  test("层数组是深拷贝：改 cue 不会污染模板；不同 now 只换 id", () => {
    const a = composeCue(STORM, 1000)!;
    a.layers[0]!.from = 999;
    expect(CUE_TEMPLATES.storm.layers[0]!.from).toBe(1);

    const b = composeCue(STORM, 1000)!;
    const c = composeCue(STORM, 2500)!;
    expect(b.layers).toEqual(c.layers);
    expect(b.kind).toBe(c.kind);
    expect(b.startedAt).not.toBe(c.startedAt);
    expect(b.id).not.toBe(c.id);
  });

  test("storm 时间线：闪电早于雨势、镜头抖动紧随闪电 120–260ms、角色动作在抖动尾段", () => {
    const cue = composeCue(STORM, 0)!;
    const at = (target: string) => cue.layers.find((l) => l.target === target)!;
    const lightning = at("lightning");
    const rain = at("rain");
    const camera = at("camera");
    const char = at("char");

    expect(lightning.atMs).toBeLessThan(rain.atMs);
    const camDelay = camera.atMs - lightning.atMs;
    expect(camDelay).toBeGreaterThanOrEqual(120);
    expect(camDelay).toBeLessThanOrEqual(260);

    const camEnd = camera.atMs + camera.durationMs;
    const camTail = camEnd - camera.durationMs * 0.3;
    expect(char.atMs).toBeGreaterThanOrEqual(camTail);
    expect(char.atMs).toBeLessThanOrEqual(camEnd);

    // 每一层都必须落在 cue 的时长之内
    for (const layer of cue.layers) {
      expect(layer.atMs).toBeGreaterThanOrEqual(0);
      expect(layer.atMs + layer.durationMs).toBeLessThanOrEqual(cue.durationMs);
    }
  });

  test("四套模板各自可命中：storm / window_call / warm_beat / close_down", () => {
    expect(detectKind(STORM)).toBe("storm");
    expect(detectKind(WARM)).toBe("warm_beat");
    expect(detectKind(createInitialScene({ pose: "glance_window" }))).toBe("window_call");
    expect(detectKind(createInitialScene({ scene: "cafe_closing" }))).toBe("close_down");
    expect(
      detectKind(createInitialScene({ vfx: { lights_dim: 0.6 } })),
    ).toBe("close_down");

    for (const kind of ["storm", "window_call", "warm_beat", "close_down"] as const) {
      const template = CUE_TEMPLATES[kind];
      expect(template.durationMs).toBeGreaterThan(1000);
      expect(template.layers.length).toBeGreaterThanOrEqual(3);
      // 时间线升序：编排就是「先后」
      const sorted = [...template.layers].sort((x, y) => x.atMs - y.atMs);
      expect(template.layers.map((l) => l.atMs)).toEqual(sorted.map((l) => l.atMs));
    }
  });
});

// ---------------------------------------------------------------- ② 合并

describe("合并：同一 kind 400ms 内重复触发不叠加", () => {
  test("同状态的重复触发返回同一份状态、同一条 cue、version 不变", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);

    const first = s.update(STORM);
    expect(first.active).not.toBeNull();
    const id = first.active!.id;
    expect(first.version).toBe(1);

    clock.t = 200;
    const second = s.update(STORM);
    expect(second).toBe(first); // 同一引用 = 渲染层零成本跳过
    expect(second.active!.id).toBe(id);
    expect(second.active!.startedAt).toBe(0);
    expect(second.version).toBe(1);
    expect(second.fadeOut).toBeNull();
  });

  test("内容变了但同 kind 且 400ms 内：仍然合并，不产生第二条 cue", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);
    const first = s.update(STORM);

    clock.t = MERGE_WINDOW_MS - 1;
    const evolved: SceneState = { ...STORM, lastBeat: "t1#vfx:rain_heavy", vfx: { rain_heavy: 0.95 } };
    const second = s.update(evolved);

    expect(second).toBe(first);
    expect(second.active!.id).toBe(first.active!.id);
    expect(second.fadeOut).toBeNull();
    expect(second.version).toBe(1);
  });

  test("超过 400ms 才重新编排（换 beat = 新的一次演出）", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);
    const first = s.update(STORM);

    clock.t = MERGE_WINDOW_MS + 1;
    const next = s.update({ ...STORM, lastBeat: "t1#vfx:lightning#again" });

    expect(next).not.toBe(first);
    expect(next.version).toBe(2);
    expect(next.active!.id).not.toBe(first.active!.id);
    expect(next.fadeOut!.cue.id).toBe(first.active!.id);
  });
});

// ---------------------------------------------------------------- ③ 打断

describe("打断：旧 cue 淡出、新 cue 接管、旧的不再产出新帧", () => {
  test("换 kind → 旧 cue 进入 fadeOut（80–160ms）而不是硬切", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);
    const first = s.update(STORM);
    const stormId = first.active!.id;

    clock.t = 600; // 已超过合并窗口
    const second = s.update(WARM);

    expect(second.active!.kind).toBe("warm_beat");
    expect(second.active!.id).not.toBe(stormId);
    expect(second.fadeOut).not.toBeNull();
    expect(second.fadeOut!.cue.id).toBe(stormId);
    expect(second.fadeOut!.reason).toBe("interrupt");
    expect(second.fadeOut!.durationMs).toBe(FADE_OUT_MS);
    expect(second.fadeOut!.durationMs).toBeGreaterThanOrEqual(80);
    expect(second.fadeOut!.durationMs).toBeLessThanOrEqual(160);
    expect(second.fadeOut!.startedAt).toBe(600); // 从打断那一刻开始淡出
    expect(second.version).toBe(first.version + 1);
  });

  test("打断之后旧 cue 不再产出新帧：状态引用不变、淡出时间不再被推后", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);
    s.update(STORM);

    clock.t = 600;
    const interrupted = s.update(WARM);
    const fadeStart = interrupted.fadeOut!.startedAt;

    clock.t = 650;
    const again = s.update(WARM);
    expect(again).toBe(interrupted); // 同一引用：没有新帧
    expect(again.fadeOut!.startedAt).toBe(fadeStart);
    expect(again.version).toBe(interrupted.version);
    // 旧 cue 自身的时间线也没有被续命
    expect(again.fadeOut!.cue.startedAt).toBe(0);
    expect(again.fadeOut!.cue.durationMs).toBe(CUE_TEMPLATES.storm.durationMs);
  });

  test("淡出到点后摘掉旧 cue，只剩新的那条", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);
    s.update(STORM);

    clock.t = 600;
    const interrupted = s.update(WARM);
    expect(interrupted.fadeOut).not.toBeNull();

    clock.t = 600 + FADE_OUT_MS;
    const after = s.update(WARM);
    expect(after.fadeOut).toBeNull();
    expect(after.active!.kind).toBe("warm_beat");
    expect(after.version).toBe(interrupted.version + 1);
  });
});

// ---------------------------------------------------------------- ④ 无命中

describe("内容没命中就不编排", () => {
  test("空 state → null，且调度器原地不动", () => {
    const empty = createInitialScene();
    expect(detectKind(empty)).toBeNull();
    expect(composeCue(empty, 0)).toBeNull();

    const clock = { t: 0 };
    const s = schedulerAt(clock);
    const state = s.update(empty);
    expect(state).toBe(EMPTY_CUE_STATE);
    expect(state.active).toBeNull();
    expect(state.fadeOut).toBeNull();
    expect(nextBoundaryAt(state)).toBeNull();
  });

  test("只有普通情绪/说话状态（没有 vfx/pose/场景命中）→ null", () => {
    const plain = createInitialScene({
      emotion: "curious",
      characterStatus: "speaking",
      subtitle: "嗯。",
      camera: "push_in",
      lastBeat: "t1#camera:push_in",
    });
    expect(composeCue(plain, 0)).toBeNull();
  });

  test("命中内容消失后不重排，但正在演的 cue 仍然演完自己的一段", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);
    const first = s.update(STORM);

    clock.t = 300;
    const idle = s.update(createInitialScene());
    expect(idle).toBe(first); // 无新内容 → 没有新帧
    expect(idle.active!.id).toBe(first.active!.id);
    expect(isCueOver(idle.active!, clock.t)).toBe(false);
  });
});

// ---------------------------------------------------------------- 收尾

describe("收尾：演满时长后淡出，不做硬切", () => {
  test("到期 → fadeOut(reason=end)，淡出结束 → 清空", () => {
    const clock = { t: 0 };
    const s = schedulerAt(clock);
    const first = s.update(WARM);
    const duration = first.active!.durationMs;
    expect(nextBoundaryAt(first)).toBe(duration);

    clock.t = duration;
    const ended = s.update(WARM);
    expect(ended.active).toBeNull();
    expect(ended.fadeOut!.reason).toBe("end");
    expect(ended.fadeOut!.durationMs).toBe(EXIT_FADE_MS);
    expect(ended.fadeOut!.startedAt).toBe(duration);

    clock.t = duration + EXIT_FADE_MS;
    const cleared = s.update(WARM);
    expect(cleared.active).toBeNull();
    expect(cleared.fadeOut).toBeNull();
    expect(nextBoundaryAt(cleared)).toBeNull();
  });
});

// ---------------------------------------------------------------- 内容区分

describe("不同内容 → 不同演出（闪电只属于 storm）", () => {
  /** 按 mock 导演 beat 表的真实形态构造状态：换一句话，状态不同，命中就该不同 */
  const cases: Array<[label: string, state: SceneState, expected: CueKind | null]> = [
    [
      "雨/雷（rain_lightning）",
      createInitialScene({
        camera: "shake",
        vfx: { lightning: 1, rain_heavy: 0.8 },
        pendingActions: ["shiver"],
        emotion: "anxious",
        lastBeat: "t#vfx:lightning",
      }),
      "storm",
    ],
    [
      "打烊/几点（closing_keyword）",
      createInitialScene({
        scene: "cafe_closing",
        vfx: { lights_dim: 1 },
        emotion: "sad",
        lastBeat: "t#scene:cafe_closing",
      }),
      "close_down",
    ],
    [
      "我得走/对不起（leaving）",
      createInitialScene({
        emotion: "sad",
        pose: "turn_away",
        camera: "pull_back",
        pendingActions: ["sigh"],
        lastBeat: "t#emotion:sad",
      }),
      "close_down",
    ],
    ["等谁/一个人（who_waiting）", createInitialScene({ pose: "glance_window" }), "window_call"],
    [
      "一起/陪你（invite）",
      createInitialScene({
        emotion: "warm",
        pose: "lean_in",
        camera: "push_in",
        vfx: { steam_wisp: 1 },
        lastBeat: "t#emotion:warm",
      }),
      "warm_beat",
    ],
    [
      "好看/星星/发夹（star_pin）",
      createInitialScene({ emotion: "warm", pose: "hold_cup", pendingActions: ["hair_tuck"] }),
      "warm_beat",
    ],
    [
      "报警/别等了（danger）",
      createInitialScene({
        emotion: "anxious",
        camera: "shake",
        pendingActions: ["startle"],
        lastBeat: "t#action:startle",
      }),
      null,
    ],
  ];

  test("每种输入命中各自那套，且不是「不管说什么都放闪电」", () => {
    const hits = cases.map(([label, state, expected]) => {
      const kind = detectKind(state);
      expect({ label, kind }).toEqual({ label, kind: expected });
      return kind;
    });
    // 同一套模板不会统治所有输入：4 种不同命中 + 1 种不编排
    expect(new Set(hits.filter((k) => k !== null)).size).toBe(4);
    expect(hits.filter((k) => k === null)).toHaveLength(1);
    expect(hits.filter((k) => k === "storm")).toHaveLength(1);
  });

  test("闪电层只存在于 storm 模板（结构上排除硬编码幻觉）", () => {
    for (const kind of ["storm", "window_call", "warm_beat", "close_down"] as const) {
      const hasLightning = CUE_TEMPLATES[kind].layers.some((l) => l.target === "lightning");
      expect({ kind, hasLightning }).toEqual({ kind, hasLightning: kind === "storm" });
    }
    // 非 storm 的命中也不会带闪电层
    const warmCue = composeCue(WARM, 0)!;
    expect(warmCue.layers.some((l) => l.target === "lightning")).toBe(false);
  });

  test("不同 kind 的 cue 层数与时长各不相同（换输入 = 换画面节奏）", () => {
    const shapes = ["storm", "window_call", "warm_beat", "close_down"].map((kind) => {
      const template = CUE_TEMPLATES[kind as "storm"];
      return `${template.durationMs}:${template.layers.map((l) => l.target).join("+")}`;
    });
    expect(new Set(shapes).size).toBe(4);
  });
});

describe("室内情绪演出不得铺全屏雨（owner 实测：语音回复时整屏斜线）", () => {
  // 背景：cue 的 rain 层是**铺满舞台**的独立层（.cue-rain，76°/84° 重复渐变），
  // 与场景层负责的窗外雨不是一回事。室内只要命中「电话/外面」「难过」就会
  // 触发 window_call / close_down，而它们原本各带一条 rain 层 → 整屏斜线。
  const indoor = ["cafe_night", "cafe_closing"] as const;

  for (const scene of indoor) {
    test(`${scene}：电话 / 难过 不得产生 rain 层`, () => {
      const cases = [
        { subtitle: "给你打个电话吧", emotion: "neutral" as const },
        { subtitle: "我在等一个人", emotion: "sad" as const },
        { subtitle: "外面雨好大", emotion: "neutral" as const },
      ];
      for (const item of cases) {
        const cue = composeCue(
          createInitialScene({ scene, emotion: item.emotion, subtitle: item.subtitle }),
          0,
        );
        const layers = cue?.layers ?? [];
        expect(layers.some((layer) => layer.target === "rain")).toBe(false);
      }
    });
  }
});
