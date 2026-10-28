import { describe, expect, test } from "bun:test";
import { selectMockBeat } from "../../src/server/director/mock.ts";

/**
 * 回归：真实冒烟测试发现的「答非所问」。
 * 症状：第 3 轮问「你是做什么的？」，她回的是开场白「……哦，你来了。」
 * 根因：opening beat 的 match 是通配正则且只演一次，未命中关键词时会在任意轮次抢到它。
 * 修法：给 opening 加 maxPhase: 0，并补齐 leaving / photo_talk 的关键词。
 */
describe("Mock 导演的 beat 选择", () => {
  test("开场白只在第 0 轮出现，第 2 轮的未命中输入不得回开场白", () => {
    expect(selectMockBeat("嗯嗯", 0, new Set()).id).toBe("opening");
    expect(selectMockBeat("嗯嗯", 2, new Set()).id).not.toBe("opening");
  });

  test("开场白演过之后，第 0 轮也不再重复", () => {
    expect(selectMockBeat("嗯嗯", 0, new Set(["opening"])).id).not.toBe("opening");
  });

  test("「你是做什么的」命中聊摄影，而不是掉进开场白", () => {
    expect(selectMockBeat("你是做什么的？", 2, new Set(["opening"])).id).toBe("photo_talk");
  });

  test("「谢谢，我该走了」命中离开，而不是只回一句谢谢", () => {
    const fired = new Set(["opening"]);
    expect(selectMockBeat("谢谢，我该走了。", 3, fired).id).toBe("leaving");
  });

  test("提到雨仍然优先命中暴雨 beat（对话内容驱动视觉事件）", () => {
    expect(selectMockBeat("外面还在下雨吗？", 1, new Set(["opening"])).id).toBe("rain_lightning");
  });
});
