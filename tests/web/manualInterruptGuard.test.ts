/**
 * 人工打断（按钮 / Esc / 打字）后的回声守卫解除。
 *
 * 现场：Chrome 里 `speechSynthesis.cancel()` 之后 `speechSynthesis.speaking` 还会保持 true
 * 100–300ms。这段时间如果用户立刻接话，守卫会把「角色还在说话」当真，
 * 用户这句短促的开头就被当成回声丢掉（爬升期 400ms / 最短 420ms 两道闸）。
 *
 * 这里钉住的是**期望语义**：
 *   · 我们自己在人工打断那一刻就知道角色已经闭麦（BrowserTTS / bargeIn 都会 cancel），
 *     所以守卫必须**立刻**解除，不等浏览器标志回落；
 *   · 短促语音（用户「停一下」这类一口气说完的话）在打断后 50ms 内开口必须能触发出打断；
 *   · 解除是有边界的：等浏览器标志真的回落到 false、角色下一次真的开口时，守卫必须恢复。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  SpeechTriggerGate,
  createSpeechPhaseTracker,
  installSpeechSynthesisCancelWatch,
  noteManualSpeechInterrupt,
  resetSpeechPhase,
} from "../../src/web/voice/vad";

// ---------------------------------------------------------------- 造一个会「滞后松开」的 browser TTS

interface FakeSynth {
  speaking: boolean;
  pending: boolean;
  cancel(): void;
}

/**
 * 复刻 Chrome 的实测行为：cancel() 之后标志不会立刻变 false，
 * 而是滞后 100–300ms 才回落。测试里由用例自己决定何时回落（`synth.speaking = false`）。
 */
function installFakeSpeechSynthesis(initialSpeaking: boolean): FakeSynth {
  const synth: FakeSynth = {
    speaking: initialSpeaking,
    pending: false,
    cancel: () => {
      // 刻意不动 speaking：这就是那 100–300ms 的滞后
    },
  };
  (globalThis as unknown as { window: unknown }).window = { speechSynthesis: synth };
  return synth;
}

/** cancel 钩子是引用计数的，测试里必须逐个摘下，否则后面的用例会打到上一个 fake synth */
const detachers: Array<() => void> = [];
function watchCancel(): () => void {
  const detach = installSpeechSynthesisCancelWatch();
  detachers.push(detach);
  return detach;
}

afterEach(() => {
  while (detachers.length > 0) detachers.pop()!();
  delete (globalThis as unknown as { window?: unknown }).window;
  resetSpeechPhase();
});

const LEVEL = 0.2;

/** 以 16ms 一帧喂同一电平（模拟连续说话），返回每次 fire 的时刻 */
function run(gate: SpeechTriggerGate, fromMs: number, toMs: number, level = LEVEL): number[] {
  const fires: number[] = [];
  for (let t = fromMs; t <= toMs; t += 16) {
    if (gate.push(level, t).kind === "fire") fires.push(t);
  }
  return fires;
}

function makeGate() {
  return new SpeechTriggerGate({ threshold: 0.05, holdMs: 120, cooldownMs: 900 });
}

/** 角色正在朗读且处于爬升期：喂 0..200ms 让守卫真的拦一次（作为「守卫本来在工作」的证据） */
function runRampUpRejection(gate: SpeechTriggerGate): void {
  expect(run(gate, 0, 200)).toEqual([]);
  expect(gate.guardStats.lastReject).toBe("echo-ramp-up");
}

// ---------------------------------------------------------------- 复现 + 验收

describe("复现：浏览器标志滞后期间，守卫吞掉打断后第一句", () => {
  test("（机制）speaking 滞后期 + 爬升期内开口 → 短促语音 0 次 fire", () => {
    // 这条钉住「bug 的机制」本身：只靠浏览器标志时，lag 窗口内的开口会被守卫丢弃。
    // 它是守卫存在的理由（不是要删掉爬升期），修复必须发生在「相位来自哪里」这一层。
    resetSpeechPhase();
    const synth = installFakeSpeechSynthesis(true);
    const gate = makeGate();

    runRampUpRejection(gate); // 角色朗读中，爬升期里的开口被拦掉

    synth.cancel(); // 用户按 Esc 打断；浏览器标志仍为 true（滞后 100–300ms）

    // 用户 16ms 后开口，一句短促的「停」，250ms 就说完
    const after = run(gate, 216, 350);
    expect(after).toEqual([]); // 现状：整句被吞掉
  });
});

describe("修复后：人工打断立刻解除守卫，短促语音不得被吞", () => {
  test("cancel() 之后 50ms 内开口的短促语音必须触发一次打断", () => {
    resetSpeechPhase();
    const synth = installFakeSpeechSynthesis(true);
    watchCancel();
    const gate = makeGate();

    runRampUpRejection(gate);
    const rejectedBefore = gate.guardStats.rejected;

    synth.cancel(); // ← 人工打断（按钮 / Esc / 打字 / VAD 打断都会走到这里）

    // 浏览器标志仍旧滞后为 true，用户 16ms 后说一句 130ms 的短促话
    expect(synth.speaking).toBe(true);
    const fires = run(gate, 216, 350);

    expect(fires.length).toBe(1);
    expect(gate.guardStats.rejected).toBe(rejectedBefore); // 没有新的丢弃计数
  });

  test("显式 API noteManualSpeechInterrupt() 同样立刻解除守卫（供按钮/Esc/打字接线）", () => {
    resetSpeechPhase();
    installFakeSpeechSynthesis(true);
    const gate = makeGate();

    runRampUpRejection(gate);
    noteManualSpeechInterrupt();

    const fires = run(gate, 216, 350);
    expect(fires.length).toBe(1);
  });

  test("解除有边界：标志回落后角色真的再开口，守卫照样恢复（爬升期重新生效）", () => {
    resetSpeechPhase();
    const synth = installFakeSpeechSynthesis(true);
    watchCancel();
    const gate = makeGate();

    runRampUpRejection(gate);
    synth.cancel();
    const afterInterrupt = run(gate, 216, 350);
    expect(afterInterrupt.length).toBe(1);
    expect(synth.speaking).toBe(true); // 还在滞后期

    // 这段语音结束、浏览器标志真正回落（Chrome 释放完成）
    gate.push(0, 360);
    synth.speaking = false;
    gate.push(0, 376);

    // 角色开始下一句：这是一个真实的新朗读相位，守卫必须重新生效
    synth.speaking = true;
    const guarded = run(gate, 400, 640);
    expect(guarded).toEqual([]);
    expect(gate.guardStats.lastReject).toBe("echo-ramp-up");
  });

  test("没有人工打断时守卫不受影响：角色说话中的短促声照旧丢弃", () => {
    resetSpeechPhase();
    installFakeSpeechSynthesis(true);
    const gate = makeGate();
    expect(run(gate, 0, 200)).toEqual([]); // 越过噪声门限，但仍在爬升期
    expect(gate.guardStats.rejected).toBe(1);
    expect(gate.guardStats.lastReject).toBe("echo-ramp-up");
  });
});

describe("朗读相位跟踪器（我们自己的状态，不是浏览器标志）", () => {
  test("未打断时：标志的上升沿开启相位，计时从我们观察到的起点算", () => {
    let browserSpeaking = true;
    const tracker = createSpeechPhaseTracker({ readBrowserSpeaking: () => browserSpeaking });

    expect(tracker.observe(1_000)).toEqual({ speaking: true, sinceSpeechStartMs: 0 });
    expect(tracker.observe(1_250)).toEqual({ speaking: true, sinceSpeechStartMs: 250 });

    browserSpeaking = false;
    expect(tracker.observe(1_400)).toEqual({ speaking: false, sinceSpeechStartMs: null });
  });

  test("markSilent 之后：滞后的 true 不再算朗读相位；标志回落后再上升才算", () => {
    let browserSpeaking = true;
    const tracker = createSpeechPhaseTracker({ readBrowserSpeaking: () => browserSpeaking });

    tracker.observe(0);
    tracker.markSilent();

    // 滞后窗口：浏览器仍说 true，但我们已经知道角色闭麦了
    expect(tracker.observe(50)).toEqual({ speaking: false, sinceSpeechStartMs: null });
    expect(tracker.speaking).toBe(false);

    // 标志回落 → 之后的新上升沿是真实的新一句，计时从头开始
    browserSpeaking = false;
    tracker.observe(200);
    browserSpeaking = true;
    expect(tracker.observe(400)).toEqual({ speaking: true, sinceSpeechStartMs: 0 });
    expect(tracker.observe(500)).toEqual({ speaking: true, sinceSpeechStartMs: 100 });
  });

  test("浏览器标志一直不回落时保持解除（宁可少拦回声，也不吞用户的话）", () => {
    const tracker = createSpeechPhaseTracker({ readBrowserSpeaking: () => true });
    tracker.observe(0);
    tracker.markSilent();
    expect(tracker.observe(10_000)).toEqual({ speaking: false, sinceSpeechStartMs: null });
  });
});
