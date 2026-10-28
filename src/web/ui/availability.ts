/**
 * 「为什么用不了麦克风」与「刚才那个未捕获错误」——两类故障的文案决策。
 *
 * 关键设计：文案选择是**纯函数**，输入只有几个布尔/枚举事实，
 * 所以「权限拒绝 / 不支持 Web Speech / 非安全上下文」三条分支可以被单测直接钉住，
 * 不需要真的去点拒绝按钮或架一个公网 HTTP 环境。
 *
 * 每条分支都必须给出**可继续使用的替代入口**（文字输入 / 按住说话），
 * 不允许只说一句「不可用」就把用户堵在那里。
 */

import type { MicState } from "../state/store";

// ---------------------------------------------------------------- 麦克风

export type MicBlocker = "insecure" | "unsupported" | "stt" | "denied";

export interface MicNotice {
  kind: MicBlocker;
  /** 发生了什么 */
  title: string;
  /** 为什么（一句，能让人看到根因） */
  reason: string;
  /** 你可以做什么（第一条永远是「换成能用的入口」而不是「再试一次」） */
  actions: readonly string[];
  /** 主行动按钮的文案（点击后聚焦文字输入框） */
  primaryAction: string;
}

export interface MicAvailabilityInput {
  mic: MicState;
  /** Web Speech（SpeechRecognition）是否可用 */
  speechSupported: boolean;
  /** navigator.mediaDevices.getUserMedia 是否存在（非安全上下文下不存在） */
  hasMicCapture: boolean;
  /** window.isSecureContext；未知（SSR）时传 undefined */
  secureContext: boolean | undefined;
  /** 麦克风通了、但浏览器的语音识别服务不可用（无网络 / 内核缺服务） */
  sttBlocked?: boolean;
}

/**
 * 判定顺序即优先级：非安全上下文是**根因**，它同时会让 Web Speech 与 getUserMedia 失效，
 * 所以哪怕此时 store 里的 mic 状态是 denied，也应该先说「地址不对」而不是「你拒绝了权限」。
 */
export function describeMicAvailability(input: MicAvailabilityInput): MicNotice | null {
  if (input.secureContext === false) {
    return {
      kind: "insecure",
      title: "麦克风被浏览器禁用：当前不是安全上下文",
      reason: "浏览器只在 https 或 localhost 下开放麦克风与语音识别，公网 http 打开时必然失败。",
      actions: [
        "用 http://localhost:5173 打开（本机评审最省事）",
        "或在文字输入框里直接打字，对话与画面全部可用",
        "底栏此时只留打字与这句说明；打断用 Esc 或「打断」按钮",
      ],
      primaryAction: "去打字",
    };
  }

  if (!input.speechSupported || !input.hasMicCapture) {
    return {
      kind: "unsupported",
      title: "这个浏览器不支持语音识别",
      reason: input.hasMicCapture
        ? "缺少 Web Speech API（SpeechRecognition），常见于 Safari / Firefox 或精简版内核。"
        : "缺少麦克风采集能力（getUserMedia），无法开启持续倾听。",
      actions: [
        "用文字输入框打字：整条对话、打断、字幕、画面指令都不受影响",
        "这里已收起语音入口（没有识别就没有「倾听」的产出）；打断用 Esc 或「打断」按钮",
        "想演示语音时换 Chrome / Edge 打开同一地址",
      ],
      primaryAction: "去打字",
    };
  }

  // 麦克风是通的（getUserMedia 成功）却拿不到转写结果：不是权限问题，是语音识别服务不可用。
  // 不能把它说成「权限被拒绝」——评审刚在地址栏点了允许，谎报会被当场抓包。
  if (input.sttBlocked) {
    return {
      kind: "stt",
      title: "语音识别服务不可用",
      reason: "权限没问题，但浏览器的语音识别服务没有返回结果（无网络，或内核没提供该服务）。",
      actions: [
        "用文字输入框打字：对话、打断、字幕、画面指令都不受影响",
        "这里已收起语音入口（拿不到转写就没有「倾听」的产出）；打断用 Esc 或「打断」按钮",
        "联网后换 Chrome / Edge 打开可恢复语音转写",
      ],
      primaryAction: "去打字",
    };
  }

  if (input.mic === "denied") {
    return {
      kind: "denied",
      title: "麦克风权限被拒绝",
      reason: "浏览器记住了这次拒绝，页面内无法再弹授权框；必须从地址栏的权限图标里改。",
      actions: [
        "点地址栏左侧的麦克风图标 → 允许 → 刷新页面",
        "在此之前可直接用文字输入框打字",
        "「按住说话」仍可用：按下即打断，松开结束（不依赖麦克风权限）",
      ],
      primaryAction: "去打字",
    };
  }

  return null;
}

// ---------------------------------------------------------------- 输入主入口

/**
 * 「这台设备该用哪个入口」的判定 —— 纯函数，输入只有两个环境事实。
 *
 * 背景：iOS Safari 没有 Web Speech STT（`webkitSpeechRecognition` 在 iOS 上不可用/不稳定），
 * 评审在 iPhone 上打开时，语音按钮注定失败。这时**不能只甩一句「不支持」就完了**，
 * 必须把文字输入直接变成主入口：聚焦 + 改 placeholder + 一句短提示说清「只能打字」。
 */
export interface InputModeInput {
  /** Web Speech（SpeechRecognition）是否可用 */
  speechSupported: boolean;
  /** navigator.userAgent（未知时传 undefined，只影响文案细节） */
  userAgent?: string | undefined;
}

export interface InputMode {
  /** voice：语音是主入口；text：语音不可用，文字是唯一主入口 */
  primary: "voice" | "text";
  /** 一句短提示；null = 不需要多说 */
  hint: string | null;
  /** 输入框 placeholder（角色说话时会另用打断提示） */
  placeholder: string;
  /** 是否在挂载时把焦点放进输入框 */
  focusInput: boolean;
}

const VOICE_PLACEHOLDER = "和 Mira 说点什么…（回车发送）";
const TEXT_PLACEHOLDER = "在这台设备上打字，和 Mira 说话…（回车发送）";

export function describeInputMode(input: InputModeInput): InputMode {
  if (input.speechSupported) {
    return {
      primary: "voice",
      hint: null,
      placeholder: VOICE_PLACEHOLDER,
      focusInput: false,
    };
  }

  const ua = input.userAgent ?? "";
  const apple = /iPad|iPhone|iPod/.test(ua);
  return {
    primary: "text",
    hint: apple ? "这台设备只能打字：iOS 网页没有语音识别" : "这台设备只能打字：浏览器没有语音识别",
    placeholder: TEXT_PLACEHOLDER,
    focusInput: true,
  };
}

// ---------------------------------------------------------------- 未捕获错误

export type RuntimeErrorKind = "error" | "rejection";

export interface RuntimeErrorNotice {
  kind: RuntimeErrorKind;
  /** 一句话说清发生了什么（含错误原文摘要） */
  text: string;
  /** 影响范围 + 还能做什么 */
  detail: string;
  /** 原始错误摘要，供诊断面板查看 */
  raw: string;
}

const MAX_SUMMARY = 120;

/** 把任意错误值压成一行可读摘要（去掉堆栈与换行，避免把界面撑爆） */
export function summarizeError(value: unknown): string {
  let raw: string;
  if (value === null || value === undefined) {
    raw = "";
  } else if (value instanceof Error) {
    raw = value.message || value.name;
  } else if (typeof value === "string") {
    raw = value;
  } else if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    raw = typeof message === "string" ? message : safeStringify(value);
  } else {
    raw = String(value);
  }
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") return "未知错误（无错误信息）";
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY)}…` : flat;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 未捕获错误的提示文案。
 * 明确写出「这会影响角色表演」：因为角色/场景是程序化渲染，脚本一断，
 * 表演会停在半路或被跳过 —— 但文字对话不受影响，所以不是致命错误。
 */
export function describeRuntimeError(
  value: unknown,
  kind: RuntimeErrorKind = "error",
): RuntimeErrorNotice {
  const summary = summarizeError(value);
  const prefix = kind === "rejection" ? "有一条异步任务失败了" : "页面脚本报了个未捕获的错误";
  return {
    kind,
    text: `${prefix}：${summary}`,
    detail: "这会影响角色表演（动作、口型或声音可能停在半路），但文字对话仍可继续。",
    raw: summary,
  };
}

export interface RuntimeErrorWatcherOptions {
  /** 同一条消息在这段时间内重复出现只报一次（默认 2s） */
  dedupeMs?: number;
  /** 注入时钟，测试用 */
  clock?: () => number;
}

/**
 * 全局兜底：window 的 error 与 unhandledrejection 都收进来。
 *
 * 用 addEventListener 而不是覆写 window.onerror：覆写会顶掉别处（或将来）注册的处理函数，
 * 也无法同时听 unhandledrejection。默认行为（控制台打印）保持不动，这里只做「多一个可见出口」。
 */
export function attachRuntimeErrorWatcher(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  onError: (notice: RuntimeErrorNotice) => void,
  options: RuntimeErrorWatcherOptions = {},
): () => void {
  const dedupeMs = options.dedupeMs ?? 2_000;
  const clock = options.clock ?? (() => Date.now());
  let lastText = "";
  let lastAt = Number.NEGATIVE_INFINITY;

  const report = (notice: RuntimeErrorNotice): void => {
    const now = clock();
    if (notice.text === lastText && now - lastAt < dedupeMs) return;
    lastText = notice.text;
    lastAt = now;
    onError(notice);
  };

  const onWindowError = (event: Event): void => {
    const detail = event as ErrorEvent;
    // 资源加载失败（img/script）没有 error 对象，用 target 的 src 兜底，别丢掉这类报错
    if (detail.error !== undefined && detail.error !== null) {
      report(describeRuntimeError(detail.error, "error"));
      return;
    }
    const element = detail.target as { src?: string; tagName?: string } | null;
    if (element && typeof element.tagName === "string" && element.tagName) {
      report(describeRuntimeError(`${element.tagName} 资源加载失败 ${element.src ?? ""}`, "error"));
      return;
    }
    report(describeRuntimeError(detail.message || "未知脚本错误", "error"));
  };

  const onRejection = (event: Event): void => {
    const detail = event as PromiseRejectionEvent;
    report(describeRuntimeError(detail.reason, "rejection"));
  };

  target.addEventListener("error", onWindowError);
  target.addEventListener("unhandledrejection", onRejection);

  return () => {
    target.removeEventListener("error", onWindowError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

// ---------------------------------------------------------------- 环境探测

/** window.isSecureContext（localhost 也算安全上下文），SSR 下返回 undefined */
export function readSecureContext(win: Window | undefined): boolean | undefined {
  if (!win) return undefined;
  const value = (win as { isSecureContext?: boolean }).isSecureContext;
  return typeof value === "boolean" ? value : undefined;
}

/** navigator.mediaDevices.getUserMedia 是否可用 */
export function hasMicCapture(nav: Navigator | undefined): boolean {
  if (!nav) return false;
  const devices = (nav as { mediaDevices?: { getUserMedia?: unknown } }).mediaDevices;
  return typeof devices?.getUserMedia === "function";
}
