/**
 * 「用不了麦克风」的三分支文案 + 未捕获错误的兜底文案。
 *
 * 这三个分支在真实浏览器里最难复现（点拒绝、换内核、架一个公网 http 域名），
 * 所以选择逻辑做成纯函数，直接在这里钉住：每个分支都要有「发生了什么 + 根因 + 可用的替代入口」，
 * 且优先级固定（非安全上下文是根因，优先于 denied/unsupported）。
 */
import { describe, expect, test } from "bun:test";
import {
  attachRuntimeErrorWatcher,
  describeMicAvailability,
  describeRuntimeError,
  hasMicCapture,
  readSecureContext,
  summarizeError,
  type MicAvailabilityInput,
} from "../../src/web/ui/availability";

const HEALTHY: MicAvailabilityInput = {
  mic: "idle",
  speechSupported: true,
  hasMicCapture: true,
  secureContext: true,
};

describe("describeMicAvailability", () => {
  test("一切正常时不出提示（不打扰主界面）", () => {
    expect(describeMicAvailability(HEALTHY)).toBeNull();
    expect(describeMicAvailability({ ...HEALTHY, mic: "listening" })).toBeNull();
  });

  test("非安全上下文：说清是 http 的锅，并指向 localhost / 文字输入 / 按住说话", () => {
    const notice = describeMicAvailability({ ...HEALTHY, secureContext: false });
    expect(notice?.kind).toBe("insecure");
    expect(notice?.title).toContain("安全上下文");
    expect(notice?.reason).toContain("https");
    expect(notice?.actions.join(" ")).toContain("localhost");
    expect(notice?.actions.join(" ")).toContain("打字");
    expect(notice?.actions.join(" ")).toContain("按住说话");
  });

  test("非安全上下文优先于 denied（根因先讲，否则用户会去改一个没用的权限设置）", () => {
    const notice = describeMicAvailability({
      ...HEALTHY,
      secureContext: false,
      mic: "denied",
      speechSupported: false,
    });
    expect(notice?.kind).toBe("insecure");
  });

  test("浏览器不支持 Web Speech：文案与「权限被拒」完全不同", () => {
    const notice = describeMicAvailability({ ...HEALTHY, speechSupported: false });
    expect(notice?.kind).toBe("unsupported");
    expect(notice?.title).toContain("不支持语音识别");
    expect(notice?.actions.join(" ")).toContain("按住说话");
    expect(notice?.primaryAction).toBe("去打字");
  });

  test("有 Web Speech 但没有 getUserMedia 也算不支持（并说明缺的是采集能力）", () => {
    const notice = describeMicAvailability({ ...HEALTHY, hasMicCapture: false });
    expect(notice?.kind).toBe("unsupported");
    expect(notice?.reason).toContain("getUserMedia");
  });

  test("权限被拒绝：给出「从地址栏改权限」这条唯一可行路径 + 两个替代入口", () => {
    const notice = describeMicAvailability({ ...HEALTHY, mic: "denied" });
    expect(notice?.kind).toBe("denied");
    expect(notice?.reason).toContain("拒绝");
    expect(notice?.actions[0]).toContain("地址栏");
    expect(notice?.actions.join(" ")).toContain("文字输入框");
    expect(notice?.actions.join(" ")).toContain("按住说话");
  });

  test("麦克风通了但语音识别服务不可用：不能说成「权限被拒绝」", () => {
    const notice = describeMicAvailability({ ...HEALTHY, mic: "unsupported", sttBlocked: true });
    expect(notice?.kind).toBe("stt");
    expect(notice?.reason).toContain("权限没问题");
    expect(notice?.actions.join(" ")).toContain("打字");
    expect(describeMicAvailability({ ...HEALTHY, mic: "denied" })?.kind).toBe("denied");
  });

  test("三分支文案互不相同（避免三种故障显示同一句话）", () => {
    const insecure = describeMicAvailability({ ...HEALTHY, secureContext: false });
    const unsupported = describeMicAvailability({ ...HEALTHY, speechSupported: false });
    const denied = describeMicAvailability({ ...HEALTHY, mic: "denied" });
    const titles = [insecure?.title, unsupported?.title, denied?.title];
    expect(new Set(titles).size).toBe(3);
  });
});

describe("环境探测", () => {
  test("readSecureContext：未知窗口返回 undefined，布尔值原样返回", () => {
    expect(readSecureContext(undefined)).toBeUndefined();
    expect(readSecureContext({ isSecureContext: false } as Window)).toBe(false);
    expect(readSecureContext({ isSecureContext: true } as Window)).toBe(true);
    expect(readSecureContext({} as Window)).toBeUndefined();
  });

  test("hasMicCapture：没有 getUserMedia 就是 false", () => {
    expect(hasMicCapture(undefined)).toBe(false);
    expect(hasMicCapture({} as Navigator)).toBe(false);
    expect(hasMicCapture({ mediaDevices: {} } as Navigator)).toBe(false);
    expect(hasMicCapture({ mediaDevices: { getUserMedia: () => {} } } as unknown as Navigator)).toBe(
      true,
    );
  });
});

describe("describeRuntimeError", () => {
  test("文案包含「这会影响角色表演」，并保留错误原文摘要", () => {
    const notice = describeRuntimeError(new Error("audio decode failed"));
    expect(notice.text).toContain("audio decode failed");
    expect(notice.detail).toContain("这会影响角色表演");
    expect(notice.detail).toContain("文字对话仍可继续");
  });

  test("Promise 拒绝用不同前缀，说明是异步任务失败", () => {
    const notice = describeRuntimeError(new Error("TTS 抛错"), "rejection");
    expect(notice.text).toContain("异步任务");
    expect(notice.kind).toBe("rejection");
  });

  test("summarizeError 压成一行并截断，避免长堆栈把界面撑爆", () => {
    expect(summarizeError("  a\n\nb  ")).toBe("a b");
    expect(summarizeError(undefined)).toContain("未知错误");
    const long = summarizeError(new Error("x".repeat(400)));
    expect(long.length).toBeLessThanOrEqual(121);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("attachRuntimeErrorWatcher", () => {
  function target() {
    return new EventTarget();
  }

  function errorEvent(message: string): Event {
    const event = new Event("error");
    Object.defineProperty(event, "message", { value: message });
    return event;
  }

  function rejectionEvent(reason: unknown): Event {
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: reason });
    return event;
  }

  test("error 与 unhandledrejection 都会被上报", () => {
    const seen: string[] = [];
    const stop = attachRuntimeErrorWatcher(target(), (notice) => seen.push(notice.text));
    const node = target();
    stop();
    const other = target();
    const dispose = attachRuntimeErrorWatcher(other, (notice) => seen.push(notice.text));
    other.dispatchEvent(errorEvent("boom"));
    other.dispatchEvent(rejectionEvent(new Error("rejected")));
    dispose();
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain("boom");
    expect(seen[1]).toContain("rejected");
    expect(node).toBeDefined();
  });

  test("同一条消息 2s 内重复只报一次（避免同一错误刷满屏）", () => {
    const seen: string[] = [];
    let now = 0;
    const node = target();
    const dispose = attachRuntimeErrorWatcher(
      node,
      (notice) => seen.push(notice.text),
      { clock: () => now },
    );
    node.dispatchEvent(errorEvent("same"));
    now += 500;
    node.dispatchEvent(errorEvent("same"));
    expect(seen.length).toBe(1);
    now += 3_000;
    node.dispatchEvent(errorEvent("same"));
    expect(seen.length).toBe(2);
    dispose();
  });

  test("dispose 之后不再上报（组件卸载不留监听）", () => {
    const seen: string[] = [];
    const node = target();
    const dispose = attachRuntimeErrorWatcher(node, (notice) => seen.push(notice.text));
    dispose();
    node.dispatchEvent(errorEvent("late"));
    expect(seen.length).toBe(0);
  });
});
