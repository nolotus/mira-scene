/**
 * 「用户开口就能打断角色」——触发闸门的状态机层测试。
 *
 * 覆盖的三类断言：
 *   ① 正常路径：speaking 时 speech_started → interim 确认 → 打断；idle 时只是开始识别
 *   ② 三道守卫：250ms 爬升期 / 400ms 防抖 / 200ms 内无 interim（短促噪声）
 *   ③ 前提与开关：AEC 实测不可用不自动触发；`?bargeIn=off` 全关；
 *      人工打断（按钮/Esc/打字）完全不经闸门，永远生效
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BARGE_IN_GATE,
  SpeechBargeInGate,
  type BargeInGateSnapshot,
} from "../../src/web/voice/bargeInGate";
import { parseBargeInFlag } from "../../src/web/voice/bargeInFlag";
import {
  aecStateOf,
  bargeInAudioConstraints,
  describeAppliedMicSettings,
  readAppliedMicSettings,
  reportAppliedMicSettings,
  readAecState,
  resetMicDiagnostics,
} from "../../src/web/voice/micConstraints";
import {
  formatBargeInTimeline,
  markTrace,
  resetTrace,
  setTraceEnabled,
  summarizeBargeInTimeline,
} from "../../src/web/voice/bargeInTrace";
import { performBargeIn } from "../../src/web/state/bargeIn";

const TTS_START = 10_000;

/** 一座「角色正在说话」的现场 */
function snap(overrides: Partial<BargeInGateSnapshot> = {}): BargeInGateSnapshot {
  return {
    nowMs: TTS_START + 1_000,
    enabled: true,
    aec: "on",
    speaking: true,
    ttsStartedAtMs: TTS_START,
    ...overrides,
  };
}

describe("speech_started 触发打断", () => {
  test("角色说话中：speech_started 进入待确认，interim 到达后立即打断", () => {
    const gate = new SpeechBargeInGate();
    const started = gate.onSpeechStarted(snap());
    expect(started.action).toBe("armed");
    expect(gate.armed).toBe(true);

    // 上游 interim 在 120ms 后到达 → 确认这是连续语音，不是噪声
    const fired = gate.onInterim(snap({ nowMs: TTS_START + 1_120 }));
    expect(fired).toEqual({ action: "fire", via: "interim", atMs: TTS_START + 1_120 });
    expect(gate.armed).toBe(false);
    expect(gate.stats().fired).toBe(1);
    expect(gate.stats().viaInterim).toBe(1);
  });

  test("角色没在说话：speech_started 只是「开始识别」，绝不打断", () => {
    const gate = new SpeechBargeInGate();
    const decision = gate.onSpeechStarted(snap({ speaking: false }));
    expect(decision).toEqual({
      action: "ignore",
      reject: "not-speaking",
      atMs: TTS_START + 1_000,
    });
    expect(gate.armed).toBe(false);
    // 之后就算来了 interim 也不会补触发（没有待确认）
    expect(gate.onInterim(snap({ speaking: false, nowMs: TTS_START + 1_100 })).action).toBe(
      "ignore",
    );
    expect(gate.stats().fired).toBe(0);
  });

  test("TTS 刚开口 250ms 内忽略（回声爬升 + AEC 收敛期）", () => {
    const gate = new SpeechBargeInGate();
    const early = gate.onSpeechStarted(snap({ ttsStartedAtMs: TTS_START + 800 }));
    expect(early.action).toBe("ignore");
    expect((early as { reject: string }).reject).toBe("echo-ramp-up");

    // 恰好 250ms 是边界：不算禁声期（守卫用 < 判断）
    const atEdge = gate.onSpeechStarted(snap({ ttsStartedAtMs: TTS_START + 750 }));
    expect(atEdge.action).toBe("armed");
  });

  test("爬升期之后才放行：同一段语音在 250ms 后仍会被确认", () => {
    const gate = new SpeechBargeInGate();
    expect(gate.onSpeechStarted(snap({ ttsStartedAtMs: TTS_START + 900 })).action).toBe("ignore");
    expect(gate.onSpeechStarted(snap({ nowMs: TTS_START + 1_100 })).action).toBe("armed");
    expect(gate.onInterim(snap({ nowMs: TTS_START + 1_200 })).action).toBe("fire");
  });

  test("打断后 400ms 内不再接受第二次触发（防抖）", () => {
    const gate = new SpeechBargeInGate();
    gate.onSpeechStarted(snap());
    gate.onInterim(snap({ nowMs: TTS_START + 1_100 }));
    expect(gate.stats().fired).toBe(1);

    const again = gate.onSpeechStarted(snap({ nowMs: TTS_START + 1_300 }));
    expect(again).toEqual({ action: "ignore", reject: "debounce", atMs: TTS_START + 1_300 });

    // 过了不应期就可以再打断一次
    const later = gate.onSpeechStarted(snap({ nowMs: TTS_START + 1_100 + 400 }));
    expect(later.action).toBe("armed");
  });

  test("短促噪声：speech_started 之后 200ms 内没有 interim → 不触发", () => {
    const gate = new SpeechBargeInGate();
    expect(gate.onSpeechStarted(snap()).action).toBe("armed");
    expect(gate.config.confirmMs).toBe(200);

    // 噪声结束、上游不产出任何 interim：tick 结算成「未确认」
    const settled = gate.tick(TTS_START + 1_000 + DEFAULT_BARGE_IN_GATE.confirmMs + 1);
    expect(settled).toBeNull(); // 还在迟到宽限内，先不判死
    const expired = gate.tick(
      TTS_START + 1_000 + DEFAULT_BARGE_IN_GATE.confirmMs + DEFAULT_BARGE_IN_GATE.lateConfirmMs + 1,
    );
    expect(expired).toEqual({
      action: "ignore",
      reject: "unconfirmed",
      atMs:
        TTS_START + 1_000 + DEFAULT_BARGE_IN_GATE.confirmMs + DEFAULT_BARGE_IN_GATE.lateConfirmMs + 1,
    });
    expect(gate.stats().fired).toBe(0);
  });

  test("interim 迟到（>200ms 但在宽限内）仍然触发，并单独计数", () => {
    const gate = new SpeechBargeInGate();
    gate.onSpeechStarted(snap());
    const fired = gate.onInterim(snap({ nowMs: TTS_START + 1_000 + 450 }));
    expect(fired.action).toBe("fire");
    expect((fired as { via: string }).via).toBe("interim-late");
    expect(gate.stats().viaInterimLate).toBe(1);
  });

  test("interim 在待确认之后才到（已过期）→ 不触发", () => {
    const gate = new SpeechBargeInGate();
    gate.onSpeechStarted(snap());
    const decision = gate.onInterim(snap({ nowMs: TTS_START + 1_000 + 900 }));
    expect(decision).toEqual({
      action: "ignore",
      reject: "unconfirmed",
      atMs: TTS_START + 1_900,
    });
    expect(gate.stats().fired).toBe(0);
  });

  test("final（有归属的原文）直接放行，人工节奏不被 interim 延迟拖住", () => {
    const gate = new SpeechBargeInGate();
    // 连 speech_started 都没有也允许：final 本身已经证明用户说了话
    const fired = gate.onFinal(snap());
    expect(fired).toEqual({ action: "fire", via: "final", atMs: TTS_START + 1_000 });
    expect(gate.stats().viaFinal).toBe(1);
  });
});

describe("AEC 前置条件", () => {
  test("AEC 实测被忽略（echoCancellation === false）→ 不自动触发", () => {
    const gate = new SpeechBargeInGate();
    const decision = gate.onSpeechStarted(snap({ aec: "off" }));
    expect(decision).toEqual({ action: "ignore", reject: "aec-unavailable", atMs: 11_000 });
    // 连 interim 也不会把它救回来
    expect(gate.onInterim(snap({ aec: "off", nowMs: 11_100 })).action).toBe("ignore");
    expect(gate.stats().fired).toBe(0);
  });

  test("读不到 AEC 时默认仍放行，但可显式关掉兜底", () => {
    const permissive = new SpeechBargeInGate();
    expect(permissive.onSpeechStarted(snap({ aec: "unknown" })).action).toBe("armed");

    const strict = new SpeechBargeInGate({ allowWhenAecUnknown: false });
    expect(
      (strict.onSpeechStarted(snap({ aec: "unknown" })) as { reject: string }).reject,
    ).toBe("aec-unavailable");
  });

  test("getSettings 实测：true → on，false → off，缺字段 → unknown", () => {
    const stream = (settings: Record<string, unknown> | undefined) => ({
      getAudioTracks: () => (settings === undefined ? [] : [{ getSettings: () => settings }]),
    });

    const on = readAppliedMicSettings(stream({ echoCancellation: true, sampleRate: 48_000 }));
    expect(aecStateOf(on)).toBe("on");
    expect(on.sampleRate).toBe(48_000);
    expect(on.readable).toBe(true);

    const off = readAppliedMicSettings(stream({ echoCancellation: false }));
    expect(aecStateOf(off)).toBe("off");

    expect(aecStateOf(readAppliedMicSettings(stream({})))).toBe("unknown");
    expect(aecStateOf(readAppliedMicSettings(stream(undefined)))).toBe("unknown");
    // 采集已经在跑，读不到也绝不能抛
    expect(() => readAppliedMicSettings(null)).not.toThrow();
  });

  test("采集约束就是三件套（AEC / 降噪 / 自动增益）", () => {
    expect(bargeInAudioConstraints()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  test("诊断文案能说清「生效 / 被忽略 / 读不到」", () => {
    expect(
      describeAppliedMicSettings({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48_000,
        channelCount: 1,
        readable: true,
      }),
    ).toContain("回声消除开");
    expect(
      describeAppliedMicSettings({
        echoCancellation: false,
        noiseSuppression: null,
        autoGainControl: null,
        sampleRate: null,
        channelCount: null,
        readable: true,
      }),
    ).toContain("回声消除被忽略");
    expect(
      describeAppliedMicSettings({
        echoCancellation: null,
        noiseSuppression: null,
        autoGainControl: null,
        sampleRate: null,
        channelCount: null,
        readable: false,
      }),
    ).toContain("读不到");
  });

  test("设置上报后闸门读到的是实测值", () => {
    resetMicDiagnostics();
    expect(readAecState()).toBe("unknown");
    reportAppliedMicSettings({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 44_100,
      channelCount: 1,
      readable: true,
    });
    expect(readAecState()).toBe("off");
    expect(new SpeechBargeInGate().onSpeechStarted(snap({ aec: readAecState() })).action).toBe(
      "ignore",
    );
    resetMicDiagnostics();
    expect(readAecState()).toBe("unknown");
  });
});

describe("?bargeIn= 开关", () => {
  test("默认开；voice/on/1 视为开；off/0/false 关", () => {
    expect(parseBargeInFlag("")).toBe("on");
    expect(parseBargeInFlag("?bargeIn=voice")).toBe("on");
    expect(parseBargeInFlag("?bargeIn=on")).toBe("on");
    expect(parseBargeInFlag("?bargeIn=1")).toBe("on");
    expect(parseBargeInFlag("?bargeIn=off")).toBe("off");
    expect(parseBargeInFlag("?bargeIn=0")).toBe("off");
    expect(parseBargeInFlag("?bargeIn=false")).toBe("off");
    expect(parseBargeInFlag("?bargeIn=OFF")).toBe("off");
    // 未知值不猜：按默认开；显式关必须写 off
    expect(parseBargeInFlag("?bargeIn=maybe")).toBe("on");
    expect(parseBargeInFlag("?other=1&bargeIn=off")).toBe("off");
  });

  test("?bargeIn=off：闸门对所有来源都拒绝", () => {
    const gate = new SpeechBargeInGate();
    const off = snap({ enabled: false });
    expect(gate.onSpeechStarted(off)).toMatchObject({ action: "ignore", reject: "disabled" });
    expect(gate.onInterim(off)).toMatchObject({ action: "ignore", reject: "disabled" });
    expect(gate.onFinal(off)).toMatchObject({ action: "ignore", reject: "disabled" });
    expect(gate.stats().fired).toBe(0);
  });
});

describe("人工打断不受闸门影响", () => {
  test("闸门全关时，按钮/Esc 的打断链路一步不少", () => {
    const gate = new SpeechBargeInGate();
    // 语音侧全被拒
    expect(gate.onSpeechStarted(snap({ enabled: false })).action).toBe("ignore");
    expect(gate.onSpeechStarted(snap({ aec: "off" })).action).toBe("ignore");
    expect(gate.onSpeechStarted(snap({ speaking: false })).action).toBe("ignore");

    // 人工打断照旧：epoch → audio → abort → cancel → listening
    const trace: string[] = [];
    let epoch = 7;
    const result = performBargeIn(
      {
        epoch: () => epoch,
        bumpEpoch: () => {
          epoch += 1;
          trace.push("epoch");
          return epoch;
        },
        cancelAudio: () => trace.push("audio"),
        abortInflight: () => trace.push("abort"),
        notifyCancel: () => trace.push("cancel"),
        markListening: () => trace.push("listening"),
      },
      { reason: "key", turnId: "t1" },
    );
    expect(trace).toEqual(["epoch", "audio", "abort", "cancel", "listening"]);
    expect(result.toEpoch).toBe(8);
    expect(result.reason).toBe("key");
  });
});

describe("时间线（?trace=1 的判据）", () => {
  test("speech_started → 音频停止 的延迟可算、可读", () => {
    setTraceEnabled(true);
    resetTrace();
    markTrace("speech-started", "aec=on");
    markTrace("gate:armed");
    markTrace("gate:fire:interim");
    markTrace("interrupt:begin", "via=interim");
    markTrace("audio:cancel");
    markTrace("audio:stopped");
    markTrace("interrupt:done", "epoch 3→4");
    markTrace("status:listening");

    const timeline = summarizeBargeInTimeline(
      // 用固定的相对时间重造一份，避免依赖真实时钟精度
      [
        { atMs: 100, label: "speech-started" },
        { atMs: 118, label: "gate:fire:interim" },
        { atMs: 121, label: "interrupt:begin" },
        { atMs: 174, label: "audio:stopped" },
        { atMs: 176, label: "status:listening" },
      ],
    );
    expect(timeline.audioLatencyMs).toBe(74);
    expect(timeline.stateLatencyMs).toBe(76);

    const text = formatBargeInTimeline([
      { atMs: 100, label: "speech-started" },
      { atMs: 174, label: "audio:stopped" },
    ]);
    expect(text).toContain("speech_started → 音频停止：74ms");
    setTraceEnabled(false);
    resetTrace();
  });
});
