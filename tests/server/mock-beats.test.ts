import { describe, expect, test } from "bun:test";
import { MOCK_BEATS, selectMockBeat } from "../../src/server/director/mock.ts";

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

  test("用户点地点 → 命中对应场景 beat（场景由对话内容驱动，不是定时轮播）", () => {
    const fired = new Set(["opening"]);
    // 海边没有渲染器 → 不该命中任何场景 beat（不能只断言某个已不存在的 id）
    const sceneBeatIds = MOCK_BEATS.filter((beat) => beat.id.startsWith("scene_")).map((beat) => beat.id);
    expect(sceneBeatIds.length).toBeGreaterThan(0);
    expect(sceneBeatIds).not.toContain(selectMockBeat("我们去看海吧", 2, fired).id);
    expect(selectMockBeat("是不是该打烊了", 2, fired).id).toBe("scene_closing");
    expect(selectMockBeat("我看看窗外", 2, fired).id).toBe("scene_window");
    expect(selectMockBeat("还是回店里坐吧", 2, fired).id).toBe("scene_back_inside");
  });

  test("场景 beat 各只演一次（同一地点不会被反复切）", () => {
    expect(selectMockBeat("是不是该打烊了", 3, new Set(["opening", "scene_closing"])).id).not.toBe("scene_closing");
  });

  test("没点地点时不会自己切场景", () => {
    const fired = new Set(["opening"]);
    for (const text of ["你今天怎么样", "嗯……", "那你呢"]) {
      const id = selectMockBeat(text, 3, fired).id;
      expect(["scene_closing", "scene_window", "scene_back_inside"]).not.toContain(id);
    }
  });
});

describe("Mock 的场景指令必须过服务端白名单", () => {
  test("所有 beat 里的 scene 指令都能被 validateDirective 接受（防白名单漏配）", async () => {
    const { MOCK_BEATS } = await import("../../src/server/director/mock.ts");
    const { validateDirective } = await import("../../src/server/scene/validate.ts");
    const scenes = MOCK_BEATS.flatMap((beat) => [
      ...(beat.cues ?? []).map((cue) => cue.directive),
      ...beat.steps.filter((step) => step.kind === "directive").map((step) => step.directive),
    ]).filter((d) => d.kind === "scene");
    expect(scenes.length).toBeGreaterThan(0);
    // 海边没有渲染器（场景数据存在但 UI 不暴露），必须被白名单拒绝：
    // 否则 mock/模型会以为切了场景，画面却还是原来那间咖啡店
    expect(validateDirective({ kind: "scene", scene: "seaside_dawn" as never })).toBeNull();
    for (const directive of scenes) {
      expect(validateDirective(directive)).not.toBeNull();
    }
  });
});
