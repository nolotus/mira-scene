/**
 * 「按住说话」的全局热键判定。
 *
 * 为什么单独抽成纯函数：按键的边界条件比看起来多 —— 输入框里空格是打字、组合键
 * 不能被抢、长按会连发 repeat、按住期间焦点可能移走。把这些条件写在 App 的 effect 里
 * 只能靠手点页面验，抽出来就能一条条钉住。
 *
 * 语义：
 *   · 按下（且此刻不在打字）→ 开始说话；
 *   · 抬起 → **一定**结束（不看 target）：焦点丢了也必须收尾，否则录音永远停不下来。
 */

/** 热键：空格（`code` 而不是 `key`：中文输入法/不同布局下 key 会变，code 稳定） */
export const PTT_HOTKEY_CODE = "Space";
/**
 * 备用热键：反引号。
 * 空格在输入框聚焦时属于「打字」，必须让位 —— 那时用户按空格没反应是完全正确的行为，
 * 但体感上就是「热键坏了」。给一个任何位置都生效的备用键，就不必先点空白处。
 */
export const PTT_ALT_HOTKEY_CODE = "Backquote";
/** 给用户看的键名 */
export const PTT_HOTKEY_LABEL = "空格";

/**
 * 这些元素里按空格是「用户在本来的输入位置打字」，绝不能抢：
 * 输入框、文本域、下拉、按钮/链接（空格会激活它们）、任何可编辑区域。
 */
const TYPING_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "[contenteditable='true']",
  // <summary> 用空格展开/收起（Dock 的「为什么、怎么恢复」就是 details/summary）：
  // 抢掉空格会让折叠块打不开。同理，任何「空格/回车会激活」的控件都不接管。
  "summary",
  "[role='button']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='tab']",
  "[role='switch']",
  "[role='menuitem']",
  // 显式可聚焦的自定义控件
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export interface PttKeyEvent {
  code: string;
  key?: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** 输入法组合态：这时的空格是在选候选词，不是说话 */
  isComposing?: boolean;
  target?: EventTarget | null;
}

/** 焦点是否在一个「用户正在输入」的地方 */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const el = target as
    | { isContentEditable?: boolean; closest?: (selector: string) => unknown }
    | null
    | undefined;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (typeof el.closest !== "function") return false;
  return el.closest(TYPING_SELECTOR) !== null;
}

/** 按下：是否该开始说话 */
export function isPttStart(event: PttKeyEvent): boolean {
  const isAlt = event.code === PTT_ALT_HOTKEY_CODE;
  if (event.code !== PTT_HOTKEY_CODE && !isAlt) return false;
  // 输入法组合态：空格在选候选词，抢了就等于让人打不出中文
  if (event.isComposing) return false;
  // 长按的连发事件不再重复触发（否则每 30ms 重启一次识别）
  if (event.repeat) return false;
  // ⌘/Ctrl/Alt 组合键不抢（⌘Space 是系统级快捷键）；Shift+Space 是标准翻页
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  // 空格在输入框/按钮里让位给原本的用途；反引号不受此限（它不是打字键）
  if (!isAlt && isTypingTarget(event.target)) return false;
  return true;
}

/**
 * 抬起：是否该结束说话。
 *
 * 这里**不看 target**：按住期间用户可能点到别处、焦点落到输入框，
 * 抬起那一刻仍必须把录音停下来。
 */
export function isPttEnd(event: PttKeyEvent): boolean {
  return (
    event.code === PTT_HOTKEY_CODE ||
    event.code === PTT_ALT_HOTKEY_CODE ||
    event.key === " "
  );
}

/**
 * 「这次按空格被输入框让位掉了」——UI 用它给一句提示。
 * 只用于提示，不参与是否接管热键的判定。
 */
export function isPttStartBlockedByTyping(event: PttKeyEvent): boolean {
  return event.code === PTT_HOTKEY_CODE && !event.repeat && isTypingTarget(event.target);
}
