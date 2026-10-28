/**
 * 真模型输出的解析层：结构化 JSON + 增量取 say 字段。
 * 这部分最容易出隐蔽 bug（半截转义、半截 token、模型加围栏），所以单独测。
 */
import { describe, expect, test } from "bun:test";
import { SayExtractor, parseDirectorPayload, splitReady } from "../../src/server/director/live.ts";

describe("parseDirectorPayload", () => {
  test("标准形状：say + directives", () => {
    const payload = parseDirectorPayload(
      '{"say":"…一个不太守时的人。","directives":[{"kind":"pose","pose":"turn_away"},{"kind":"vfx","vfx":"rain_heavy"}]}',
    );
    expect(payload?.say).toBe("…一个不太守时的人。");
    expect(payload?.directives).toEqual([
      { kind: "pose", pose: "turn_away" },
      { kind: "vfx", vfx: "rain_heavy" },
    ]);
  });

  test("非法的指令取值被丢弃，台词保留", () => {
    const payload = parseDirectorPayload(
      '{"say":"雨又大了。","directives":[{"kind":"emotion","emotion":"furious"},{"kind":"emotion","emotion":"anxious"},{"kind":"teleport"}]}',
    );
    expect(payload?.say).toBe("雨又大了。");
    expect(payload?.directives).toEqual([{ kind: "emotion", emotion: "anxious" }]);
  });

  test("容忍代码围栏与前后多余文字", () => {
    const payload = parseDirectorPayload('好的，这是 JSON：\n```json\n{"say":"嗯。","directives":[]}\n```');
    expect(payload?.say).toBe("嗯。");
    expect(payload?.directives).toEqual([]);
  });

  test("缺 directives 字段也接受；text 作为 say 的别名", () => {
    expect(parseDirectorPayload('{"say":"嗯。"}')?.directives).toEqual([]);
    expect(parseDirectorPayload('{"text":"嗯。"}')?.say).toBe("嗯。");
  });

  test("branch 指令解析成选项", () => {
    const payload = parseDirectorPayload(
      '{"say":"真的？","directives":[{"kind":"branch","options":[{"id":"stay","label":"陪你一起等"},{"id":"call","label":"我帮你打个电话"}]}]}',
    );
    expect(payload?.directives).toEqual([
      {
        kind: "branch",
        options: [
          { id: "stay", label: "陪你一起等" },
          { id: "call", label: "我帮你打个电话" },
        ],
      },
    ]);
  });

  test("不是 JSON / 空对象 → null 或空台词", () => {
    expect(parseDirectorPayload("抱歉，我无法回答")).toBeNull();
    expect(parseDirectorPayload("")).toBeNull();
    expect(parseDirectorPayload("{}")?.say).toBe("");
  });
});

describe("SayExtractor（边收 JSON 边取台词）", () => {
  test("跨多个 chunk 增量取出，直到遇到收尾引号为止", () => {
    const extractor = new SayExtractor();
    const chunks = ['{ "say"', ': "', "你好", "呀，", "外面雨好大", "。", '", "directives"', ": [] }"];
    let text = "";
    for (const chunk of chunks) text += extractor.push(chunk);

    expect(text).toBe("你好呀，外面雨好大。");
    expect(extractor.done).toBe(true);
    // 收尾引号之后的内容不再当台词
    expect(extractor.push('"directives":[]}')).toBe("");
  });

  test("处理转义：\\\" \\n \\u4f60 以及半截转义", () => {
    const extractor = new SayExtractor();
    let text = "";
    text += extractor.push('{"say":"他说：\\"等我');
    text += extractor.push('\\"\\n然后\\u4f60'); // 半截 \u4f60 需要下一片补齐
    text += extractor.push("\\u597d。\"}");
    expect(text).toBe('他说："等我"\n然后你好。');
  });

  test("say 之前有别的字段也认得；没有 say 什么都不吐", () => {
    const extractor = new SayExtractor();
    expect(extractor.push('{"directives":[],"say":"嗯')).toBe("嗯");
    expect(new SayExtractor().push('{"directives":[]}')).toBe("");
  });
});

describe("splitReady", () => {
  test("尾部 1 字先压住，等下一片拼，保证每片 2–6 字", () => {
    const first = splitReady("你好呀");
    for (const piece of first.pieces) {
      const length = Array.from(piece).length;
      expect(length).toBeGreaterThanOrEqual(2);
      expect(length).toBeLessThanOrEqual(6);
    }
    expect(Array.from(first.rest).length).toBeLessThan(2);
  });

  test("短文本（1 字）不产出碎屑", () => {
    const result = splitReady("嗯");
    expect(result.pieces).toEqual([]);
    expect(result.rest).toBe("嗯");
  });
});
