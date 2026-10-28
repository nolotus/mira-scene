import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ECHO_GUARD,
  evaluateSpeechBargeIn,
  performBargeIn,
  speechReasonIsGuarded,
  type BargeInPorts,
} from "../../src/web/state/bargeIn";
import {
  SpeechTriggerGate,
  readSpeechGuardStats,
  resetSpeechGuardStats,
} from "../../src/web/voice/vad";

describe("回声自打断守卫（纯函数）", () => {
  test("角色没在说话时一律放行：普通输入不受守卫影响", () => {
    const decision = evaluateSpeechBargeIn({ speaking: false, sustainedMs: 0, sinceSpeechStartMs: null });
    expect(decision.accept).toBe(true);
    expect(decision.reject).toBeNull();
  });

  test("speaking 中短促声（< 阈值）不打断", () => {
    const decision = evaluateSpeechBargeIn({ speaking: true, sustainedMs: 180, sinceSpeechStartMs: 1_200 });
    expect(decision.accept).toBe(false);
    expect(decision.reject).toBe("too-short");
  });

  test("speaking 中长声（>= 阈值）打断", () => {
    const decision = evaluateSpeechBargeIn({ speaking: true, sustainedMs: 600, sinceSpeechStartMs: 1_200 });
    expect(decision.accept).toBe(true);
  });

  test("刚开口的 400ms 内即使声音够长也丢弃（回声爬升期）", () => {
    const decision = evaluateSpeechBargeIn({ speaking: true, sustainedMs: 600, sinceSpeechStartMs: 200 });
    expect(decision.accept).toBe(false);
    expect(decision.reject).toBe("echo-ramp-up");
  });

  test("阈值常量落在建议区间（350–500ms）且爬升期为 400ms", () => {
    expect(DEFAULT_ECHO_GUARD.minSustainedMs).toBeGreaterThanOrEqual(350);
    expect(DEFAULT_ECHO_GUARD.minSustainedMs).toBeLessThanOrEqual(500);
    expect(DEFAULT_ECHO_GUARD.rampUpMs).toBe(400);
  });

  test("只有 speech 原因经过守卫：按钮 / Esc / 打字永远不受约束", () => {
    expect(speechReasonIsGuarded("speech")).toBe(true);
    for (const reason of ["button", "key", "input", "retry", "branch"] as const) {
      expect(speechReasonIsGuarded(reason)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- 闸门（按帧推进）

type Probe = () => { speaking: boolean; sinceSpeechStartMs: number | null };

function makeGate(probe: Probe) {
  return new SpeechTriggerGate({
    threshold: 0.05,
    holdMs: 120,
    cooldownMs: 900,
    speakingProbe: probe,
  });
}

/** 以 16ms 一帧喂同一电平，返回每次 fire 的时刻 */
function run(gate: SpeechTriggerGate, level: number, fromMs: number, toMs: number): number[] {
  const fires: number[] = [];
  for (let t = fromMs; t <= toMs; t += 16) {
    if (gate.push(level, t).kind === "fire") fires.push(t);
  }
  return fires;
}

describe("回声守卫（接在 VAD 触发的路径上）", () => {
  test("speaking 中短促声（回声/咔哒，300ms）不打断", () => {
    resetSpeechGuardStats();
    // 角色早已在说话（已过爬升期），但这段声音只持续 300ms
    const gate = makeGate(() => ({ speaking: true, sinceSpeechStartMs: 2_000 }));
    const fires = run(gate, 0.2, 0, 300);
    expect(fires).toEqual([]);
    expect(gate.guardStats.rejected).toBe(1); // 同一段语音只记一次丢弃
    expect(readSpeechGuardStats().rejected).toBe(1);
  });

  test("speaking 中长声（> 阈值）在越过阈值后打断", () => {
    resetSpeechGuardStats();
    const gate = makeGate(() => ({ speaking: true, sinceSpeechStartMs: 2_000 }));
    const fires = run(gate, 0.2, 0, 700);
    expect(fires.length).toBe(1);
    expect(fires[0]).toBeGreaterThanOrEqual(DEFAULT_ECHO_GUARD.minSustainedMs);
    expect(readSpeechGuardStats().accepted).toBe(1);
  });

  test("角色刚开口的爬升期内，再长的声音也丢弃；出声结束后恢复正常", () => {
    resetSpeechGuardStats();
    let speaking = true;
    const gate = makeGate(() => ({ speaking, sinceSpeechStartMs: speaking ? 120 : null }));
    expect(run(gate, 0.2, 0, 700)).toEqual([]); // 一直在爬升期窗口内
    expect(gate.guardStats.lastReject).toBe("echo-ramp-up");

    speaking = false; // 角色说完了 → 守卫退出
    gate.reset();
    const fires = run(gate, 0.2, 0, 200);
    expect(fires.length).toBe(1); // 普通开口照旧触发（holdMs 之后）
  });

  test("冷却期内不连发（相邻两次触发间隔 >= cooldown）", () => {
    const gate = makeGate(() => ({ speaking: false, sinceSpeechStartMs: null }));
    const fires = run(gate, 0.2, 0, 3_000);
    expect(fires.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < fires.length; i += 1) {
      expect(fires[i]! - fires[i - 1]!).toBeGreaterThanOrEqual(900);
    }
  });
});

describe("人工打断不经过守卫", () => {
  test("同样的回声条件下，语音会被丢，按钮打断照样走完链路", () => {
    const echoCondition = { speaking: true, sustainedMs: 100, sinceSpeechStartMs: 100 };
    expect(evaluateSpeechBargeIn(echoCondition).accept).toBe(false);

    const steps: string[] = [];
    const ports: BargeInPorts = {
      epoch: () => 3,
      bumpEpoch: () => {
        steps.push("epoch");
        return 4;
      },
      cancelAudio: () => steps.push("audio"),
      notifyCancel: () => steps.push("cancel"),
      markListening: () => steps.push("listening"),
    };

    const result = performBargeIn(ports, { reason: "button", turnId: "t_1" });
    expect(result.steps).toEqual(["epoch", "audio", "cancel", "listening"]);
    expect(steps).toEqual(["epoch", "audio", "cancel", "listening"]);
  });
});
