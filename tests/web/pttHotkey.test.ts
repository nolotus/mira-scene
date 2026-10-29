/**
 * 「按住空格说话」的按键判定。
 *
 * 钉住的是边界而不是风格：输入框里空格必须还是打字、组合键不许抢、
 * 长按连发不许重复启动、抬起必须收尾（哪怕焦点已经移走）。
 */
import { describe, expect, test } from "bun:test";
import {
  isPttEnd,
  isPttStart,
  isPttStartBlockedByTyping,
  isTypingTarget,
  PTT_ALT_HOTKEY_CODE,
  PTT_HOTKEY_CODE,
} from "../../src/web/ui/pttHotkey.ts";

/**
 * 伪造一个带 closest 的元素（模拟 DOM 节点）。
 * 注意要按**选择器列表包含**来判断：真实的选择器是逗号分隔的一串，
 * 用等号匹配的假实现会让「输入框里不打」这条永远假绿。
 */
function fakeElement(tag: string, contentEditable = false): EventTarget {
  return {
    isContentEditable: contentEditable,
    closest(selector: string) {
      return selector.includes(tag) ? {} : null;
    },
  } as unknown as EventTarget;
}

describe("按住说话：按下判定", () => {
  test("空白处按空格 → 开始", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: null })).toBe(true);
  });

  test("输入框里按空格 → 不打，留给打字", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("input") })).toBe(false);
  });

  test("按钮/链接上按空格 → 不打（空格要能激活它们）", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("button") })).toBe(false);
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("a[href]") })).toBe(false);
  });

  test("可编辑区域（contenteditable）→ 不打", () => {
    expect(isTypingTarget(fakeElement("div", true))).toBe(true);
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("div", true) })).toBe(false);
  });

  test("组合键不抢（⌘Space 是系统快捷键）", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, metaKey: true, target: null })).toBe(false);
    expect(isPttStart({ code: PTT_HOTKEY_CODE, ctrlKey: true, target: null })).toBe(false);
    expect(isPttStart({ code: PTT_HOTKEY_CODE, altKey: true, target: null })).toBe(false);
  });

  test("长按连发（repeat）不重复启动识别", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, repeat: true, target: null })).toBe(false);
  });

  test("别的键不算", () => {
    expect(isPttStart({ code: "KeyV", target: null })).toBe(false);
    expect(isPttStart({ code: "Enter", target: null })).toBe(false);
  });
});

describe("按住说话：抬起判定", () => {
  test("空格抬起 → 结束", () => {
    expect(isPttEnd({ code: PTT_HOTKEY_CODE })).toBe(true);
    expect(isPttEnd({ code: "", key: " " })).toBe(true);
  });

  test("抬起不看 target：按住期间焦点移到输入框也必须收尾", () => {
    // 否则会留下「一直在录」的会话 —— 这类收尾必须与「按下」的严格判定不对称
    expect(isPttEnd({ code: PTT_HOTKEY_CODE, key: " ", target: fakeElement("input") })).toBe(true);
  });

  test("别的键抬起 → 不结束（避免误停）", () => {
    expect(isPttEnd({ code: "KeyV", key: "v" })).toBe(false);
  });
});

describe("按住说话：不许抢的场合", () => {
  test("输入法组合态（isComposing）→ 不打（空格在选候选词）", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, isComposing: true, target: null })).toBe(false);
  });

  test("Shift+Space（标准翻页）→ 不打", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, shiftKey: true, target: null })).toBe(false);
  });

  test("<summary>（空格本该展开折叠块）→ 不打", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("summary") })).toBe(false);
  });

  test("自定义可聚焦控件（role=button / tabindex）→ 不打", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("[role='button']") })).toBe(false);
    expect(
      isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("[tabindex]:not([tabindex='-1'])") }),
    ).toBe(false);
  });
});

describe("备用热键：反引号（输入框里也能用）", () => {
  test("反引号在普通位置 → 开始", () => {
    expect(isPttStart({ code: PTT_ALT_HOTKEY_CODE, target: null })).toBe(true);
  });

  test("反引号在输入框里 → 依然开始（它不是打字键，不用让位）", () => {
    expect(isPttStart({ code: PTT_ALT_HOTKEY_CODE, target: fakeElement("input") })).toBe(true);
  });

  test("空格在输入框里仍然不打（这条不能被破坏）", () => {
    expect(isPttStart({ code: PTT_HOTKEY_CODE, target: fakeElement("input") })).toBe(false);
  });

  test("反引号抬起 → 结束", () => {
    expect(isPttEnd({ code: PTT_ALT_HOTKEY_CODE })).toBe(true);
  });

  test("被输入框让位时可被识别出来（用于给用户提示，而不是静默无反应）", () => {
    expect(isPttStartBlockedByTyping({ code: PTT_HOTKEY_CODE, target: fakeElement("input") })).toBe(true);
    expect(isPttStartBlockedByTyping({ code: PTT_ALT_HOTKEY_CODE, target: fakeElement("input") })).toBe(false);
    expect(isPttStartBlockedByTyping({ code: PTT_HOTKEY_CODE, target: null })).toBe(false);
  });
});
