/**
 * 「语音打断只有一个触发源」的端到端（模块级）验证。
 *
 * 这组测试**不**测 mock 出来的逻辑：它用真的 `createDeepgramStt` + 真的 `VoiceBargeInWiring`
 * + 真的时间线，只把「上游 WS / 麦克风 / MediaRecorder」换成脚本化替身（voice/fakeStt.ts）。
 * 所以它证明的是「上游发出 speech_started 之后，客户端能不能观察到并走完五步打断」，
 * 而不是「测试替身能不能调一个函数」。
 *
 * 断言对应验收项：
 *   ① speaking 中：speech_started → 200ms 内 interim 确认 → 打断；`speechStartedAtMs` 非空、
 *      `audioLatencyMs` 有值
 *   ② idle 中：speech_started 只是开始识别，不打断
 *   ③ 同一场景里能量 VAD 即使报「有人开口」也不得再触发一次（单一触发源）
 *   ④ AEC 门槛：`aec=off` → energy / `aec=unknown` → none，且 speech_started 都不许打断
 *   ⑤ pre-roll：握手窗口的音频不许丢（补发计数 + 溢出计数）
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_BARGE_IN_GATE, SpeechBargeInGate } from "../../src/web/voice/bargeInGate";
import { VoiceBargeInWiring } from "../../src/web/voice/bargeInWiring";
import { resolveBargeInSource } from "../../src/web/voice/bargeInSource";
import {
  formatBargeInTimeline,
  markTrace,
  readTrace,
  readTraceSource,
  resetTrace,
  setTraceEnabled,
  summarizeBargeInTimeline,
} from "../../src/web/voice/bargeInTrace";
import { createFakeStt } from "../../src/web/voice/fakeStt";
import { PRE_ROLL_MAX_CHUNKS } from "../../src/web/voice/deepgramStt";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 等到条件成立再断言，**不要**用 `sleep(固定值)` 等脚本化事件。
 * 这组用例的「+300ms speech_started / +500ms interim」都是真挂钟定时器：
 * 并行跑测试时事件循环会被抢占，固定 900ms 的等待会假红
 * （实测约一半概率，被误当成改动引起的回归查了很久）。
 */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待超时：事件没有发生");
    await sleep(10);
  }
}

/**
 * 打断必须是「in­terim 确认」这一路触发的，且只触发一次。
 *
 * 为什么不断言 `toEqual(["interim"])`：gate 会根据 interim 相对 speech_started 的
 * 时间差把它分类成 `interim` 或 `interim-late`，而脚本化的 200ms 间隔**正好压在
 * 那条阈值上** —— 并行跑测试时事件循环抖一下就会落到另一边，表现为约 1/8 概率的
 * 假红（实测「第 8 次失败，收到 interim-late」）。两种分类都走 onInterim，
 * 「单一触发源」这个不变量不受影响。
 */
function expectSingleInterimInterrupt(interrupts: string[]): void {
  expect(interrupts).toHaveLength(1);
  expect(["interim", "interim-late"]).toContain(interrupts[0]!);
}

/** 一套「现场」：角色在/不在说话 + 打断计数 + 时间线开关 */
function scene(options: { speaking: boolean; aec?: "on" | "off" | "unknown" }) {
  setTraceEnabled(true);
  resetTrace();
  const interrupts: string[] = [];
  const ttsStart = Date.now() - 1_000; // 已经跨过 250ms 爬升期
  const aec = options.aec ?? "on";
  const wiring = new VoiceBargeInWiring({
    // 生产配置（AEC 读不到不放行）：这里用同一份
    gate: new SpeechBargeInGate({ ...DEFAULT_BARGE_IN_GATE, allowWhenAecUnknown: false }),
    now: () => Date.now(),
    aec: () => aec,
    speaking: () => options.speaking,
    ttsStartedAtMs: () => ttsStart,
    interrupt: (via) => {
      interrupts.push(via);
      // 生产里这两条标记来自 tracedTts 的 cancel() 与 store 的状态 effect；
      // 这里由替身补上，位置与生产一致（interrupt 之内、同步）
      markTrace("audio:stopped");
      markTrace("status:listening");
      return { fromEpoch: 1, toEpoch: 2 };
    },
  });
  return { wiring, interrupts, ttsStart };
}

/** 建一条假上游，并把 STT 回调接到 wiring 上（与 App.tsx 的接法一致） */
function connect(wiring: VoiceBargeInWiring, opts: { aec?: "on" | "off" | "unknown" } = {}) {
  return createFakeStt({
    aecOverride: opts.aec ?? "on",
    onSpeechStarted: () => wiring.onSpeechStarted(),
    onTranscript: ({ final }) => {
      if (final) wiring.onFinal();
      else wiring.onInterim();
    },
  });
}

describe("① speaking 中：speech_started → interim 确认 → 五步打断", () => {
  test("timeline.speechStartedAtMs 与 audioLatencyMs 都能量出来", async () => {
    const s = scene({ speaking: true });
    s.wiring.update({ bargeInEnabled: true, sttChannel: "fake" });
    expect(s.wiring.source).toBe("deepgram");

    const harness = connect(s.wiring);
    harness.controller.prewarm();
    harness.controller.start();
    markTrace("status:speaking");

    // 脚本：+300ms speech_started、+500ms interim、+800ms final
    await until(() => s.interrupts.length > 0);

    expectSingleInterimInterrupt(s.interrupts); // 只打断一次，触发点是 interim
    const timeline = summarizeBargeInTimeline(readTrace());
    expect(timeline.speechStartedAtMs).not.toBeNull();
    expect(timeline.audioLatencyMs).not.toBeNull();
    // 「打断由 interim 触发」由上面的 interrupts 断言负责；这里只防「音频压根没停」。
    // 不写 400ms 这种紧上界：脚本事件走真挂钟，并行跑测试时会漂移（假红）。
    expect(timeline.audioLatencyMs!).toBeLessThan(1500);
    // 五个环节都在时间线上
    const labels = readTrace().map((mark) => mark.label);
    expect(labels).toContain("speech-started");
    expect(labels).toContain("gate:armed");
    // 同上：gate 会把它记成 gate:fire:interim 或 gate:fire:interim-late，
    // 两者都是「interim 确认这一路」，差别只是相对 speech_started 的时间分类。
    expect(labels.some((label) => label.startsWith("gate:fire:interim"))).toBe(true);
    expect(labels).toContain("interrupt:begin");
    expect(labels).toContain("audio:stopped");

    console.log(formatBargeInTimeline(readTrace()));
    harness.probe.dispose();
    harness.controller.abort();
  });
});

describe("② idle 中：speech_started 只开始识别，不打断", () => {
  test("不调 interrupt，闸门给出 not-speaking", async () => {
    const s = scene({ speaking: false });
    s.wiring.update({ bargeInEnabled: true, sttChannel: "fake" });
    const harness = connect(s.wiring);
    harness.controller.prewarm();
    harness.controller.start();
    markTrace("status:listening");

    await sleep(900);

    expect(s.interrupts).toEqual([]);
    const labels = readTrace().map((mark) => mark.label);
    // speech_started 到了（证明链路通），但被闸门挡在「不打断」这一侧
    expect(labels).toContain("speech-started");
    expect(labels).toContain("gate:ignore:not-speaking");
    expect(labels).not.toContain("interrupt:begin");
    expect(summarizeBargeInTimeline(readTrace()).interruptAtMs).toBeNull();

    console.log(formatBargeInTimeline(readTrace()));
    harness.probe.dispose();
    harness.controller.abort();
  });
});

describe("③ 单一触发源：能量 VAD 在 deepgram 源下不得再触发一次", () => {
  test("speech_started 打断后，能量 VAD 的开口只被记成 suppressed", async () => {
    const s = scene({ speaking: true });
    s.wiring.update({ bargeInEnabled: true, sttChannel: "fake" });
    const harness = connect(s.wiring);
    harness.controller.prewarm();
    harness.controller.start();

    await until(() => s.interrupts.length > 0);
    expectSingleInterimInterrupt(s.interrupts);

    // 同一场景里能量 VAD 报「有人开口」：不许产生第二次打断
    s.wiring.onEnergySpeech();
    s.wiring.onEnergySpeech();
    expectSingleInterimInterrupt(s.interrupts);
    expect(readTrace().filter((mark) => mark.label === "energy:suppressed")).toHaveLength(2);
    expect(s.wiring.stats().suppressedEnergy).toBe(2);
    expect(s.wiring.stats().gate.fired).toBe(1);

    harness.probe.dispose();
    harness.controller.abort();
  });
});

describe("④ AEC 门槛：off → energy / unknown → none，且都不自动打断", () => {
  for (const aec of ["off", "unknown"] as const) {
    test(`aec=${aec}：source 正确、speech_started 不触发打断`, async () => {
      const expected = aec === "off" ? "energy" : "none";
      const s = scene({ speaking: true, aec });
      const decision = s.wiring.update({ bargeInEnabled: true, sttChannel: "fake" });
      expect(decision.source).toBe(expected);
      expect(decision.detail).toContain(`barge-in source: ${expected}`);
      if (aec === "off") expect(decision.detail).toContain("(aec-off)");
      else expect(decision.detail).toContain("(aec-unknown)");

      // 假上游仍照脚本发 speech_started / interim：源不是它就不能打断
      const harness = connect(s.wiring, { aec });
      harness.controller.prewarm();
      harness.controller.start();
      await sleep(400);
      s.wiring.onSpeechStarted();
      s.wiring.onInterim();

      expect(s.interrupts).toEqual([]);
      expect(readTrace().some((mark) => mark.label === "gate:ignore:source-mismatch")).toBe(true);
      expect(readTraceSource().source).toBe(expected);

      harness.probe.dispose();
      harness.controller.abort();
    });
  }

  test("解析矩阵：只有 echoCancellation===true 才可能自动打断", () => {
    const cases = [
      { bargeInEnabled: true, sttChannel: "deepgram" as const, aec: "on" as const, source: "deepgram" },
      { bargeInEnabled: true, sttChannel: "fake" as const, aec: "on" as const, source: "deepgram" },
      { bargeInEnabled: true, sttChannel: "webspeech" as const, aec: "on" as const, source: "energy" },
      { bargeInEnabled: true, sttChannel: "none" as const, aec: "on" as const, source: "energy" },
      { bargeInEnabled: true, sttChannel: "deepgram" as const, aec: "off" as const, source: "energy" },
      { bargeInEnabled: true, sttChannel: "deepgram" as const, aec: "unknown" as const, source: "none" },
      { bargeInEnabled: true, sttChannel: "webspeech" as const, aec: "unknown" as const, source: "none" },
      { bargeInEnabled: false, sttChannel: "deepgram" as const, aec: "on" as const, source: "none" },
    ];
    for (const item of cases) {
      const decision = resolveBargeInSource(item);
      expect(decision.source).toBe(item.source as "deepgram" | "energy" | "none");
      expect(decision.detail.startsWith(`barge-in source: ${item.source} (`)).toBe(true);
    }
  });
});

describe("⑤ pre-roll：握手窗口的音频不丢", () => {
  test("WS 就绪前录到的帧在 open 后按序补发（prerollFlushed>0）", async () => {
    // 握手 300ms：MediaRecorder 100ms 一块 → 就绪前应有 2 帧左右进队列
    const harness = createFakeStt({ script: { openMs: 300 } });
    harness.controller.prewarm();
    harness.controller.start();
    await sleep(420);

    expect(harness.probe.ready()).toBe(true);
    expect(harness.controller.diagnostics.prerollFlushed).toBeGreaterThan(0);
    expect(harness.controller.diagnostics.prerollDropped).toBe(0);
    // 补发之后音频继续到达上游
    const before = harness.probe.audioFrames();
    await sleep(200);
    expect(harness.probe.audioFrames()).toBeGreaterThan(before);

    harness.probe.dispose();
    harness.controller.abort();
  });

  test("握手极慢时队列有上限，丢最旧并计数（prerollDropped>0）", async () => {
    const harness = createFakeStt({ script: { openMs: 1_900 } });
    harness.controller.prewarm();
    harness.controller.start();
    await sleep(2_050);

    expect(harness.controller.diagnostics.prerollDropped).toBeGreaterThan(0);
    expect(harness.controller.diagnostics.prerollFlushed).toBe(PRE_ROLL_MAX_CHUNKS);
    expect(PRE_ROLL_MAX_CHUNKS).toBe(15);

    harness.probe.dispose();
    harness.controller.abort();
  });
});
