/**
 * 底栏层级规则的纯函数测试。
 *
 * 为什么值得单测：这轮改动的核心不是样式，而是「什么状态显示什么控件」的判定。
 * 打断常驻占位、语音不可用时还摆一个按不动的麦克风、状态条又长回 7 个 chip ——
 * 这三类回归肉眼很难在演示里立刻发现，但都是纯函数输入输出的错误。
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dockChipList, PushToTalkButton, splitDockChips, visibleDockControls } from "../../src/web/ui/Dock";
import type { MicNotice } from "../../src/web/ui/availability";

const noticeOf = (kind: MicNotice["kind"]): MicNotice => ({
  kind,
  title: "标题",
  reason: "原因",
  actions: [],
  primaryAction: "去打字",
});

const base = {
  characterStatus: "idle" as const,
  micNotice: null,
  speechSupported: true,
  hasError: false,
};

describe("visibleDockControls · 打断只在说话时出现", () => {
  test("idle / listening / thinking 都不出现（不占位）", () => {
    for (const characterStatus of ["idle", "listening", "thinking"] as const) {
      expect(visibleDockControls({ ...base, characterStatus }).interrupt).toBe(false);
    }
  });

  test("canInterrupt 为真时，即便状态已回 idle 也出现（缓冲音频仍在播的窗口）", () => {
    expect(visibleDockControls({ ...base, characterStatus: "idle", canInterrupt: true }).interrupt).toBe(true);
  });

  test("canInterrupt 为假时，即便状态是 speaking 也不出现（判据唯一来源）", () => {
    expect(visibleDockControls({ ...base, characterStatus: "speaking", canInterrupt: false }).interrupt).toBe(false);
  });

  test("speaking 才出现", () => {
    expect(visibleDockControls({ ...base, characterStatus: "speaking" }).interrupt).toBe(true);
  });

  test("说话 + 有错误：打断与红点互不影响", () => {
    const c = visibleDockControls({ ...base, characterStatus: "speaking", hasError: true });
    expect(c.interrupt).toBe(true);
    expect(c.retry).toBe(true);
    expect(c.moreDot).toBe(true);
  });
});

describe("visibleDockControls · 语音路径退化时换内容而不是留死按钮", () => {
  test("一切正常：麦克风 + 按住说话 + 语言都在，没有提示块", () => {
    const c = visibleDockControls(base);
    expect(c.mic).toBe(true);
    expect(c.ptt).toBe(true);
    expect(c.lang).toBe(true);
    expect(c.voiceHint).toBe(false);
  });

  test("非安全上下文 / 不支持 Web Speech / STT 服务不可用：换成「打字优先」提示", () => {
    for (const kind of ["insecure", "unsupported", "stt"] as const) {
      const c = visibleDockControls({ ...base, micNotice: noticeOf(kind) });
      expect(c.voiceHint).toBe(true);
      expect(c.mic).toBe(false);
      // 倾听没有产出时，按住说话也一起收起（打断仍由 Esc / 打断按钮负责）
      expect(c.ptt).toBe(false);
      expect(c.lang).toBe(false);
    }
  });

  test("权限被拒：麦克风与按住说话保留（改完权限刷新即恢复）", () => {
    const c = visibleDockControls({ ...base, micNotice: noticeOf("denied") });
    expect(c.voiceHint).toBe(false);
    expect(c.mic).toBe(true);
    expect(c.ptt).toBe(true);
    expect(c.lang).toBe(true);
  });

  test("设备没有 Web Speech（无 notice）：语言选择收起，麦克风仍可当 VAD 入口", () => {
    const c = visibleDockControls({ ...base, speechSupported: false });
    expect(c.lang).toBe(false);
    expect(c.mic).toBe(true);
  });
});

describe("visibleDockControls · 重试与红点只跟错误走", () => {
  test("无错误：抽屉里没有重试，⋯ 不带红点", () => {
    const c = visibleDockControls(base);
    expect(c.retry).toBe(false);
    expect(c.moreDot).toBe(false);
  });

  test("有错误：重试进抽屉并带红点", () => {
    const c = visibleDockControls({ ...base, hasError: true });
    expect(c.retry).toBe(true);
    expect(c.moreDot).toBe(true);
  });
});

describe("状态条最多常显 2 个", () => {
  const full = dockChipList({
    characterStatus: "speaking",
    sessionMode: "mock",
    fallbackReason: "forced-mock",
    audioMode: "browser",
    keyless: true,
    droppedEvents: 3,
    droppedActions: 1,
  });

  test("候选列表覆盖全部旧 chip（不是丢弃，是换位置）", () => {
    expect(full.map((c) => c.key)).toEqual([
      "status",
      "director",
      "fallback",
      "audio",
      "keyless",
      "droppedEvents",
      "droppedActions",
    ]);
  });

  test("前两个常显：角色状态 + 导演模式", () => {
    const { visible } = splitDockChips(full);
    expect(visible.map((c) => c.key)).toEqual(["status", "director"]);
    expect(visible[0]?.label).toBe("说话");
    expect(visible[1]?.label).toBe("Mock 导演");
  });

  test("其余全部进溢出（一个都不丢）", () => {
    const { visible, overflow } = splitDockChips(full);
    expect(visible.length).toBeLessThanOrEqual(2);
    expect(visible.length + overflow.length).toBe(full.length);
    expect(overflow.length).toBe(5);
  });

  test("即使候选很多，常显也不超过上限；空列表也不炸", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: `l${i}` }));
    expect(splitDockChips(many).visible.length).toBe(2);
    expect(splitDockChips(many, 0)).toEqual({ visible: [], overflow: many });
    expect(splitDockChips([])).toEqual({ visible: [], overflow: [] });
  });

  test("未连接时导演位显示「未连接」，但仍占第二个常显位", () => {
    const list = dockChipList({
      characterStatus: "idle",
      sessionMode: null,
      fallbackReason: null,
      audioMode: "browser",
      keyless: true,
      droppedEvents: 0,
      droppedActions: 0,
    });
    expect(list[1]?.label).toBe("未连接");
    expect(splitDockChips(list).visible.length).toBe(2);
  });
});

describe("PushToTalkButton · 单一状态源与可见反馈", () => {
  test("未按住状态：data-holding 为 false，主文案为按住说话", () => {
    const html = renderToStaticMarkup(
      React.createElement(PushToTalkButton, {
        holding: false,
        onStart: () => {},
        onEnd: () => {},
      })
    );
    expect(html).toContain('data-holding="false"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">按住说话 <kbd>Space</kbd></button>");
  });

  test("键盘/鼠标按住状态（单一状态源）：data-holding 为 true，主文案切换为松开结束", () => {
    const html = renderToStaticMarkup(
      React.createElement(PushToTalkButton, {
        holding: true,
        onStart: () => {},
        onEnd: () => {},
      })
    );
    expect(html).toContain('data-holding="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">松开结束 <kbd>Space</kbd></button>");
  });
});
