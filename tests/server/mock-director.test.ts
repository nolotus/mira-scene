/**
 * MockDirector 的四条硬指标：
 * ① abort 后立即停止产出  ② 事件 epoch 原样回显
 * ③ 视觉事件由对话内容触发（不是定时器）  ④ 分片节奏与多幕弧线覆盖度
 */
import { describe, expect, test } from "bun:test";
import { MockDirector } from "../../src/server/director/mock.ts";
import type { Directive, DirectorInput, SessionEvent } from "../../src/shared/protocol.ts";

const baseScene: DirectorInput["scene"] = {
  scene: "cafe_night",
  emotion: "neutral",
  pose: "hold_cup",
  playedBeats: [],
};

function makeInput(overrides: Partial<DirectorInput> = {}): DirectorInput {
  return {
    userText: "你好",
    scene: { ...baseScene },
    history: [],
    turnId: "turn-1",
    epoch: 1,
    ...overrides,
  };
}

async function run(input: DirectorInput, options: { delayScale?: number } = {}): Promise<SessionEvent[]> {
  const director = new MockDirector({ delayScale: options.delayScale ?? 0 });
  const events: SessionEvent[] = [];
  for await (const event of director.stream(input, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

function directivesOf(events: SessionEvent[]): Directive[] {
  return events.flatMap((event) => (event.type === "directive" ? [event.directive] : []));
}

function textOf(events: SessionEvent[]): string {
  return events
    .flatMap((event) => (event.type === "text.delta" ? [event.text] : []))
    .join("");
}

describe("MockDirector · abort", () => {
  test("abort 后立即停止产出，不再有时间片", async () => {
    // 用真实节奏（delayScale=1），确保 abort 落在片间等待中间
    const director = new MockDirector({ delayScale: 1 });
    const controller = new AbortController();
    const events: SessionEvent[] = [];
    let abortedAt = 0;

    for await (const event of director.stream(makeInput({ userText: "外面雨好大" }), controller.signal)) {
      events.push(event);
      if (events.length === 4) {
        abortedAt = performance.now();
        controller.abort(new Error("test interrupt"));
      }
    }
    const finishedAt = performance.now();

    // 第 4 条之后不会再产出任何事件
    expect(events.length).toBe(4);
    // 而且立刻返回，不会把剩余台词/指令继续跑完（真实节奏下剩余部分需要数百毫秒）
    expect(finishedAt - abortedAt).toBeLessThan(100);
  });

  test("一开始就 aborted 的 signal 一条事件都不产出", async () => {
    const director = new MockDirector({ delayScale: 1 });
    const controller = new AbortController();
    controller.abort();
    const events: SessionEvent[] = [];
    for await (const event of director.stream(makeInput(), controller.signal)) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });
});

describe("MockDirector · epoch", () => {
  test("每条事件都原样回显输入的 epoch 与 turnId", async () => {
    const events = await run(makeInput({ userText: "外面雨好大", epoch: 42, turnId: "turn-xyz" }));
    expect(events.length).toBeGreaterThan(4);
    for (const event of events) {
      expect(event.epoch).toBe(42);
      expect(event.turnId).toBe("turn-xyz");
    }
  });
});

describe("MockDirector · 由对话内容驱动", () => {
  test("提到「雨」→ 闪电 + 发抖 + 雨势加大", async () => {
    const events = await run(makeInput({ userText: "外面雨下得好大" }));
    const directives = directivesOf(events);

    expect(directives).toContainEqual({ kind: "vfx", vfx: "lightning" });
    expect(directives).toContainEqual({ kind: "action", action: "shiver" });
    expect(directives).toContainEqual({ kind: "vfx", vfx: "rain_heavy" });
  });

  test("问「等谁」→ 侧身避开视线 + 望向窗外", async () => {
    const events = await run(makeInput({ userText: "你在等谁啊？" }));
    const directives = directivesOf(events);

    expect(directives).toContainEqual({ kind: "pose", pose: "turn_away" });
    expect(directives).toContainEqual({ kind: "pose", pose: "glance_window" });
  });

  test("提到打烊 → 场景切到 cafe_closing + 灯光变暗", async () => {
    const events = await run(makeInput({ userText: "是不是快打烊了" }));
    const directives = directivesOf(events);

    expect(directives).toContainEqual({ kind: "scene", scene: "cafe_closing" });
    expect(directives).toContainEqual({ kind: "vfx", vfx: "lights_dim" });
  });

  test("同样的输入得到同样的演出（没有定时器、没有随机）", async () => {
    const input = makeInput({ userText: "你为什么一直看窗外" });
    const first = await run(input);
    const second = await run(input);
    expect(first).toEqual(second);
    expect(textOf(first).length).toBeGreaterThan(0);
  });

  test("不同输入走不同 beat（不是永远同一段）", async () => {
    const rain = textOf(await run(makeInput({ userText: "外面雨好大" })));
    const photo = textOf(await run(makeInput({ userText: "你是摄影师吗，拍什么的" })));
    expect(rain).not.toBe(photo);
  });

  test("空输入也能接住，不会产出空 turn", async () => {
    const events = await run(makeInput({ userText: "   " }));
    expect(textOf(events).length).toBeGreaterThan(0);
  });
});

describe("MockDirector · 分片与弧线", () => {
  test("台词按 2–6 字分片，拼起来与整句一致", async () => {
    const events = await run(makeInput({ userText: "外面雨好大" }));
    const pieces = events.flatMap((event) => (event.type === "text.delta" ? [event.text] : []));
    expect(pieces.length).toBeGreaterThan(3);
    for (const piece of pieces) {
      const length = Array.from(piece).length;
      expect(length).toBeGreaterThanOrEqual(2);
      expect(length).toBeLessThanOrEqual(6);
    }
    expect(textOf(events)).toBe(pieces.join(""));
  });

  test("多轮弧线覆盖 ≥3 种情绪、≥2 种姿势、1 次场景变化、1 次对话触发的显著视效", async () => {
    const script = ["你好", "外面雨下得好大", "你在等谁啊", "你为什么不问原因", "是不是快打烊了", "嗯"];
    const director = new MockDirector({ delayScale: 0 });
    const history: Array<{ role: "user" | "character"; text: string }> = [];
    const emotions = new Set<string>();
    const poses = new Set<string>();
    const scenes = new Set<string>();
    const vfxEvents = new Set<string>();

    for (const [index, userText] of script.entries()) {
      const events: SessionEvent[] = [];
      const input = makeInput({ userText, history: [...history], turnId: `turn-${index}`, epoch: index });
      for await (const event of director.stream(input, new AbortController().signal)) {
        events.push(event);
      }
      const spoken = textOf(events);
      expect(spoken.length).toBeGreaterThan(0);

      for (const directive of directivesOf(events)) {
        if (directive.kind === "emotion") emotions.add(directive.emotion);
        if (directive.kind === "pose") poses.add(directive.pose);
        if (directive.kind === "scene") scenes.add(directive.scene);
        if (directive.kind === "vfx") vfxEvents.add(directive.vfx);
      }

      history.push({ role: "user", text: userText });
      history.push({ role: "character", text: spoken });
    }

    expect(emotions.size).toBeGreaterThanOrEqual(3);
    expect(poses.size).toBeGreaterThanOrEqual(2);
    expect(scenes.size).toBeGreaterThanOrEqual(1);
    expect(vfxEvents.has("lightning")).toBe(true);
  });

  test("同一次会话里显著视效只放一次（playedBeats 生效）", async () => {
    const director = new MockDirector({ delayScale: 0 });
    const first: SessionEvent[] = [];
    for await (const event of director.stream(makeInput({ userText: "外面雨好大" }), new AbortController().signal)) {
      first.push(event);
    }
    expect(directivesOf(first)).toContainEqual({ kind: "vfx", vfx: "lightning" });

    // 第二轮明明又提到雨，但闪电不该再放
    const second: SessionEvent[] = [];
    const input = makeInput({
      userText: "雨还是好大",
      history: [{ role: "user", text: "外面雨好大" }],
      scene: { ...baseScene, playedBeats: ["rain_lightning"] },
    });
    for await (const event of director.stream(input, new AbortController().signal)) {
      second.push(event);
    }
    expect(directivesOf(second)).not.toContainEqual({ kind: "vfx", vfx: "lightning" });
  });
});
