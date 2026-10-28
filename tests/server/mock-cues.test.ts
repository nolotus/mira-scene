/**
 * Mock 导演的时序指令：两个示范 beat（暴雨 / 担心）走 cuid 写法，
 * 也就是「台词说到第 N 个字符时才变画面」——不是整轮一次性把视觉放完。
 *
 * 顺带钉住兼容性：老写法的 beat 仍然发「没有 atChar」的 directive（= 立即执行）。
 */
import { describe, expect, test } from "bun:test";
import { charCount } from "../../src/server/director/cues.ts";
import { MockDirector } from "../../src/server/director/mock.ts";
import type { DirectorInput, SessionEvent } from "../../src/shared/protocol.ts";

function makeInput(overrides: Partial<DirectorInput> = {}): DirectorInput {
  return {
    userText: "你好",
    scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
    history: [],
    turnId: "turn-1",
    epoch: 1,
    ...overrides,
  };
}

async function run(input: DirectorInput): Promise<SessionEvent[]> {
  const director = new MockDirector({ delayScale: 0 });
  const events: SessionEvent[] = [];
  for await (const event of director.stream(input, new AbortController().signal)) events.push(event);
  return events;
}

type DirectiveEvent = Extract<SessionEvent, { type: "directive" }>;

function cuesOf(events: SessionEvent[]): DirectiveEvent[] {
  return events.filter((event): event is DirectiveEvent => event.type === "directive");
}

/** 某个指令触发时，已经播了多少字 */
function spokenAt(events: SessionEvent[], index: number): number {
  let spoken = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const event = events[cursor];
    if (event?.type === "text.delta") spoken += charCount(event.text);
  }
  return spoken;
}

function textOf(events: SessionEvent[]): string {
  return events.flatMap((event) => (event.type === "text.delta" ? [event.text] : [])).join("");
}

describe("Mock · 暴雨 beat（cues 写法）", () => {
  const input = makeInput({ userText: "外面雨好大" });

  test("开口前先发抖（atChar=0），闪电等到「刚才那一下——」之后", async () => {
    const events = await run(input);
    const cues = cuesOf(events);

    // 每条都带 atChar：这一 beat 走的是时序写法
    for (const cue of cues) expect(typeof cue.atChar).toBe("number");

    const shiver = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "action" && event.directive.action === "shiver",
    );
    expect(shiver).toBeGreaterThanOrEqual(0);
    expect(spokenAt(events, shiver)).toBe(0);

    const lightning = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "vfx" && event.directive.vfx === "lightning",
    );
    // 「刚才那一下——」= 7 个字符：闪电不许抢在这句话之前
    expect(spokenAt(events, lightning)).toBe(7);
    expect(cues.find((cue) => cue.directive.kind === "vfx" && cue.directive.vfx === "lightning")?.atChar).toBe(7);
  });

  test("雨势与镜头抖动在「雨又大了。」之后（atChar=18），不是一开头全放", async () => {
    const events = await run(input);
    const rain = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "vfx" && event.directive.vfx === "rain_heavy",
    );
    const shake = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "camera" && event.directive.move === "shake",
    );
    expect(spokenAt(events, rain)).toBe(18);
    expect(spokenAt(events, shake)).toBe(18);
    // 关键：确实是在台词中途，而不是台词说完之后补发
    const lastText = events.map((event) => event.type).lastIndexOf("text.delta");
    expect(rain).toBeGreaterThan(0);
    expect(rain).toBeLessThan(lastText);
  });

  test("atChar 递增有序；台词完整且顺序不变", async () => {
    const events = await run(input);
    const anchors = cuesOf(events).map((cue) => cue.atChar ?? 0);
    expect(anchors).toEqual([...anchors].sort((a, b) => a - b));
    expect(textOf(events)).toContain("刚才那一下——你看见了吗。");
    expect(textOf(events)).toContain("雨又大了。");
    // 视觉指令的顺序保持 beat 的意图：闪电 → 雨势 → 望窗
    expect(cuesOf(events).map((cue) => (cue.directive.kind === "vfx" ? cue.directive.vfx : cue.directive.kind))).toEqual([
      "action",
      "lightning",
      "rain_heavy",
      "camera",
      "pose",
    ]);
  });
});

describe("Mock · 担心 beat（第二个 cues 示范）", () => {
  test("惊跳在开口之前，情绪在「别这么说。」之后，侧身在「我知道这样不正常。」之后", async () => {
    const events = await run(
      makeInput({
        userText: "他会不会出事了",
        history: [
          { role: "user", text: "你好" },
          { role: "user", text: "嗯" },
        ],
      }),
    );

    const startle = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "action" && event.directive.action === "startle",
    );
    const anxious = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "emotion" && event.directive.emotion === "anxious",
    );
    const turnAway = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "pose" && event.directive.pose === "turn_away",
    );

    expect(spokenAt(events, startle)).toBe(0);
    expect(spokenAt(events, anxious)).toBe(7);
    expect(spokenAt(events, turnAway)).toBe(16);
    expect(new Set(cuesOf(events).map((cue) => cue.atChar)).size).toBeGreaterThanOrEqual(3);
  });
});

describe("Mock · 旧写法仍然兼容（无 atChar = 立即执行）", () => {
  test("「等谁」beat 的指令不带 atChar", async () => {
    const events = await run(makeInput({ userText: "你在等谁啊？" }));
    const cues = cuesOf(events);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.some((cue) => cue.atChar === undefined)).toBe(true);
    // 这条路径下指令仍然立刻生效（旧客户端行为不变）
    expect(cues.find((cue) => cue.directive.kind === "pose")?.directive).toEqual({
      kind: "pose",
      pose: "turn_away",
    });
  });
});
