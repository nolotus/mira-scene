/**
 * 闸门的「arm 时成立、fire 时不成立」反例（真机 trace 复现）：
 *
 *   3226.0ms status:idle          ← 她已经说完了
 *   3492.0ms stt:speech_started   ← 闸门 arm（那一刻确实在说话）
 *   3692.2ms interrupt:begin (via=interim)   ← 200ms 后她已经回 idle，却仍然打断了
 *
 * 这里用同一套 wiring + 假上游把「arm 与 fire 之间状态变了」逐条钉住：
 *   · speaking 在 fire 时现读（不是 arm 的快照）
 *   · source 同理（AEC 翻转 → 源变 none 也不许 fire）
 *   · 两次翻转只触发一次
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_BARGE_IN_GATE, SpeechBargeInGate, type AecState } from "../../src/web/voice/bargeInGate";
import { VoiceBargeInWiring } from "../../src/web/voice/bargeInWiring";
import { readTrace, resetTrace, setTraceEnabled } from "../../src/web/voice/bargeInTrace";

/** 现场：可手动推进的时钟 + 可手动翻转的 speaking / source */
function scene(options: {
  speaking: boolean;
  /** fire 时是否仍算「在说话」（模拟 App 里被收紧的那条实时信号） */
  speakingAtFire?: boolean;
  aec?: AecState;
}) {
  setTraceEnabled(true);
  resetTrace();
  let now = 1_000;
  let speaking = options.speaking;
  let speakingAtFire = options.speakingAtFire ?? options.speaking;
  let aec: AecState = options.aec ?? "on";
  const interrupts: string[] = [];
  const ttsStart = 0; // 早已跨过 250ms 爬升期

  const gate = new SpeechBargeInGate({
    ...DEFAULT_BARGE_IN_GATE,
    allowWhenAecUnknown: false,
  });
  const wiring = new VoiceBargeInWiring({
    gate,
    now: () => now,
    // 每次判定现读：AEC 中途翻转（on → off）时源应该当场变成 none
    aec: () => aec,
    speaking: () => speaking,
    speakingAtFire: () => speakingAtFire,
    turnId: () => "turn-1",
    epoch: () => 0,
    ttsStartedAtMs: () => ttsStart,
    interrupt: (via) => {
      interrupts.push(via);
      return { fromEpoch: 0, toEpoch: 1 };
    },
  });

  return {
    wiring,
    gate,
    interrupts,
    /** 推进时钟（毫秒） */
    advance(ms: number) {
      now += ms;
    },
    /** 此刻角色是否在出声（arm 信号） */
    setSpeaking(next: boolean) {
      speaking = next;
      speakingAtFire = next;
    },
    /** 只改「fire 时」的信号：模拟 speaking 信号在 arm 之后过期 */
    setSpeakingAtFire(next: boolean) {
      speakingAtFire = next;
    },
    /** AEC 实测翻转（arm 之后才发生）→ 现解析的源变成 none */
    setAec(next: AecState) {
      aec = next;
    },
    labels: () => readTrace().map((mark) => mark.label),
  };
}

describe("打断闸门：arm 与 fire 之间状态过期", () => {
  test("arm 时在说话、fire 前转 idle → 不触发，记 not-speaking-at-fire", () => {
    const s = scene({ speaking: true });
    s.wiring.update({ bargeInEnabled: true, sttChannel: "fake" });

    expect(s.wiring.onSpeechStarted()?.action).toBe("armed");
    s.advance(200);
    // 200ms 里她说完了：arm 时的 speaking=1 已经过期
    s.setSpeakingAtFire(false);

    const decision = s.wiring.onInterim();
    expect(decision?.action).toBe("ignore");
    expect(decision).toMatchObject({ action: "ignore", reject: "not-speaking-at-fire" });

    expect(s.interrupts).toHaveLength(0);
    expect(s.wiring.stats().gate.fired).toBe(0);
    expect(s.wiring.stats().gate.lastReject).toBe("not-speaking-at-fire");
    // 清闸：不能留着待确认等下一帧
    expect(s.gate.armed).toBe(false);
    expect(s.labels()).toContain("gate:ignore:not-speaking-at-fire");
    expect(s.labels()).not.toContain("interrupt:begin");
  });

  test("arm 时在说话、fire 时仍在说话 → 正常触发（回归）", () => {
    const s = scene({ speaking: true });
    s.wiring.update({ bargeInEnabled: true, sttChannel: "fake" });

    expect(s.wiring.onSpeechStarted()?.action).toBe("armed");
    s.advance(200);

    const decision = s.wiring.onInterim();
    expect(decision).toMatchObject({ action: "fire", via: "interim" });
    expect(s.interrupts).toEqual(["interim"]);
    expect(s.wiring.stats().gate.fired).toBe(1);
    expect(s.labels()).toContain("gate:fire:interim");
  });

  test("arm 后 source 从 deepgram 变 none → 不触发", () => {
    // 闸门单测：源在 arm 之后变 none（AEC 翻转 / 关开关导致的现解析结果），
    // 但 AEC 快照这一路仍认为可以判（守卫先过），真正拦住的是 fire 时的源复验。
    let source: "deepgram" | "none" = "deepgram";
    const gate = new SpeechBargeInGate({
      ...DEFAULT_BARGE_IN_GATE,
      allowWhenAecUnknown: false,
    });
    gate.setLive({ speaking: () => true, source: () => source });
    const snapshot = {
      nowMs: 1_000,
      enabled: true,
      aec: "on" as AecState,
      speaking: true,
      ttsStartedAtMs: 0,
    };

    expect(gate.onSpeechStarted(snapshot)).toMatchObject({ action: "armed" });
    source = "none"; // arm 之后 AEC 实测翻转 → 现解析的源没了

    const decision = gate.onInterim({ ...snapshot, nowMs: 1_200 });
    expect(decision).toMatchObject({ action: "ignore", reject: "source-changed-at-fire" });
    expect(gate.stats().fired).toBe(0);
    expect(gate.stats().lastReject).toBe("source-changed-at-fire");
    expect(gate.armed).toBe(false);
  });

  test("speaking→idle→speaking 两次翻转：只有第二次（fire 时仍在说）触发一次", () => {
    const s = scene({ speaking: true });
    s.wiring.update({ bargeInEnabled: true, sttChannel: "fake" });

    // 第一轮：arm 时在说 → 200ms 后已回 idle → interim 不许触发
    expect(s.wiring.onSpeechStarted()?.action).toBe("armed");
    s.advance(200);
    s.setSpeakingAtFire(false);
    expect(s.wiring.onInterim()).toMatchObject({ reject: "not-speaking-at-fire" });
    expect(s.interrupts).toHaveLength(0);

    // 第二轮：她真的又开口了，arm 与 fire 都在说话 → 触发一次
    s.setSpeaking(true);
    s.advance(500);
    expect(s.wiring.onSpeechStarted()?.action).toBe("armed");
    s.advance(200);
    expect(s.wiring.onInterim()).toMatchObject({ action: "fire", via: "interim" });

    expect(s.interrupts).toEqual(["interim"]);
    expect(s.wiring.stats().gate.fired).toBe(1);
  });
});
