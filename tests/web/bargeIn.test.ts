import { describe, expect, test } from "bun:test";
import type { BargeInPorts, BargeInStep } from "../../src/web/state/bargeIn";
import { performBargeIn } from "../../src/web/state/bargeIn";

interface Harness {
  ports: BargeInPorts;
  trace: string[];
  errors: Array<{ step: BargeInStep; error: unknown }>;
  epoch: { value: number };
  cancelCalls: Array<{ turnId: string; epoch: number }>;
}

function harness(overrides: Partial<BargeInPorts> = {}): Harness {
  const trace: string[] = [];
  const errors: Array<{ step: BargeInStep; error: unknown }> = [];
  const epoch = { value: 4 };
  const cancelCalls: Array<{ turnId: string; epoch: number }> = [];

  const ports: BargeInPorts = {
    epoch: () => epoch.value,
    bumpEpoch: () => {
      trace.push(`epoch:${epoch.value}->${epoch.value + 1}`);
      epoch.value += 1;
      return epoch.value;
    },
    cancelAudio: () => {
      trace.push("audio:cancel");
    },
    abortInflight: () => {
      trace.push("abort:inflight");
    },
    notifyCancel: (turnId, nextEpoch) => {
      trace.push(`cancel:${turnId}@${nextEpoch}`);
      cancelCalls.push({ turnId, epoch: nextEpoch });
    },
    markListening: () => {
      trace.push("state:listening");
    },
    onError: (step, error) => errors.push({ step, error }),
    ...overrides,
  };

  return { ports, trace, errors, epoch, cancelCalls };
}

describe("barge-in 执行顺序", () => {
  test("epoch 先动，再静音，再通知服务端，最后切 listening", () => {
    const h = harness();
    const result = performBargeIn(h.ports, { reason: "key", turnId: "t9" });

    expect(result.fromEpoch).toBe(4);
    expect(result.toEpoch).toBe(5);
    expect(result.cancelledTurn).toBe(true);
    expect(result.steps).toEqual(["epoch", "audio", "abort", "cancel", "listening"]);
    expect(h.trace).toEqual([
      "epoch:4->5",
      "audio:cancel",
      "abort:inflight",
      "cancel:t9@5",
      "state:listening",
    ]);
    // 服务端收到的是**新** epoch：旧 epoch 的产出立即作废
    expect(h.cancelCalls).toEqual([{ turnId: "t9", epoch: 5 }]);
  });

  test("静音抛错不阻断后续步骤（静音与切状态优先于错误上报）", () => {
    const h = harness({
      cancelAudio: () => {
        throw new Error("speechSynthesis 不可用");
      },
    });

    const result = performBargeIn(h.ports, { reason: "speech", turnId: "t2" });

    expect(result.failed.map((f) => f.step)).toEqual(["audio"]);
    expect(result.steps).toEqual(["epoch", "audio", "abort", "cancel", "listening"]);
    expect(h.trace).toContain("state:listening");
    expect(h.errors).toHaveLength(1);
  });

  test("没有 turnId 时不发 cancel，但依然 epoch+1 并静音", () => {
    const h = harness();
    const result = performBargeIn(h.ports, { reason: "button", turnId: null });

    expect(result.cancelledTurn).toBe(false);
    expect(h.trace).not.toContain("cancel");
    expect(h.epoch.value).toBe(5);
    expect(h.trace).toContain("audio:cancel");
  });
});
