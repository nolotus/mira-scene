/**
 * 白名单校验：非法指令必须被丢弃，合法指令必须原样重建。
 */
import { describe, expect, test } from "bun:test";
import { validateDirective, validateDirectives } from "../../src/server/scene/validate.ts";

describe("validateDirective", () => {
  test("合法指令全部通过", () => {
    expect(validateDirective({ kind: "emotion", emotion: "warm" })).toEqual({ kind: "emotion", emotion: "warm" });
    expect(validateDirective({ kind: "pose", pose: "glance_window" })).toEqual({ kind: "pose", pose: "glance_window" });
    expect(validateDirective({ kind: "action", action: "hair_tuck" })).toEqual({ kind: "action", action: "hair_tuck" });
    expect(validateDirective({ kind: "camera", move: "push_in" })).toEqual({ kind: "camera", move: "push_in" });
    expect(validateDirective({ kind: "vfx", vfx: "lightning" })).toEqual({ kind: "vfx", vfx: "lightning" });
    expect(validateDirective({ kind: "scene", scene: "cafe_closing" })).toEqual({
      kind: "scene",
      scene: "cafe_closing",
    });
  });

  test("枚举外的取值一律丢弃", () => {
    expect(validateDirective({ kind: "emotion", emotion: "angry" })).toBeNull();
    expect(validateDirective({ kind: "pose", pose: "fly" })).toBeNull();
    expect(validateDirective({ kind: "action", action: "explode" })).toBeNull();
    expect(validateDirective({ kind: "camera", move: "zoom" })).toBeNull();
    expect(validateDirective({ kind: "vfx", vfx: "snow" })).toBeNull();
    expect(validateDirective({ kind: "scene", scene: "beach" })).toBeNull();
    expect(validateDirective({ kind: "emotion" })).toBeNull();
    expect(validateDirective({ kind: "teleport", target: "moon" })).toBeNull();
  });

  test("非对象/空值不会抛出，直接丢弃", () => {
    expect(validateDirective(null)).toBeNull();
    expect(validateDirective(undefined)).toBeNull();
    expect(validateDirective("emotion:warm")).toBeNull();
    expect(validateDirective(42)).toBeNull();
    expect(validateDirective([])).toBeNull();
  });

  test("兼容模型把 kind 写成 type", () => {
    expect(validateDirective({ type: "pose", pose: "lean_in" })).toEqual({ kind: "pose", pose: "lean_in" });
  });

  test("返回的是重建后的干净对象，多余字段不会流到渲染层", () => {
    const result = validateDirective({ kind: "emotion", emotion: "sad", injection: "boom" });
    expect(result).toEqual({ kind: "emotion", emotion: "sad" });
    expect(result && "injection" in result).toBe(false);
  });

  test("branch：非法结构丢弃，id 去重，最多 4 个", () => {
    expect(validateDirective({ kind: "branch", options: [] })).toBeNull();
    expect(validateDirective({ kind: "branch", options: "stay" })).toBeNull();
    expect(validateDirective({ kind: "branch", options: [{ id: "", label: "空 id" }] })).toBeNull();
    expect(validateDirective({ kind: "branch", options: [{ id: "a", label: "" }] })).toBeNull();

    const deduped = validateDirective({
      kind: "branch",
      options: [
        { id: "stay", label: "陪你一起等" },
        { id: "stay", label: "重复 id" },
        { id: "call", label: "我帮你打个电话" },
      ],
    });
    expect(deduped).toEqual({
      kind: "branch",
      options: [
        { id: "stay", label: "陪你一起等" },
        { id: "call", label: "我帮你打个电话" },
      ],
    });

    const capped = validateDirective({
      kind: "branch",
      options: [1, 2, 3, 4, 5].map((index) => ({ id: `opt${index}`, label: `选项${index}` })),
    });
    expect(capped && capped.kind === "branch" ? capped.options.length : 0).toBe(4);
  });
});

describe("validateDirectives", () => {
  test("混合列表里只保留合法项", () => {
    const result = validateDirectives([
      { kind: "emotion", emotion: "anxious" },
      { kind: "emotion", emotion: "furious" },
      { kind: "vfx", vfx: "lights_dim" },
      { kind: "scene", scene: "nowhere" },
      null,
    ]);
    expect(result).toEqual([
      { kind: "emotion", emotion: "anxious" },
      { kind: "vfx", vfx: "lights_dim" },
    ]);
  });

  test("非数组输入返回空数组", () => {
    expect(validateDirectives(undefined)).toEqual([]);
    expect(validateDirectives({ kind: "emotion", emotion: "warm" })).toEqual([]);
  });
});
