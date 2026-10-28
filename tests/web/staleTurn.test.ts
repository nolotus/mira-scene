/**
 * 问题 1：`turn.end` 之后 turnId 是否留存、迟到的同轮事件能否绕过双闸门。
 *
 * 第一个 test 是「复现/特征化」：断言**修复前**的真实行为（事件被 applied、
 * 状态被拉回 speaking），用来证明评审描述的事实成立，而不是凭代码阅读下结论。
 */
import { describe, expect, test } from "bun:test";
import {
  createMachine,
  reduceEvent,
  reduceRequestSent,
} from "../../src/web/state/session";

const delta = (epoch: number, text: string, turnId = "t1") =>
  ({ type: "text.delta", turnId, epoch, text }) as const;

/** 走到「角色正在说话」的一轮：requestSent → text.delta */
function speakingMachine() {
  const sent = reduceRequestSent(createMachine(0), "t1", 0);
  return reduceEvent(sent, delta(0, "雨停之前，"), 10).machine;
}

function endTurn(machine: ReturnType<typeof createMachine>, turnId = "t1", epoch = 0) {
  return reduceEvent(machine, { type: "turn.end", turnId, epoch, interrupted: false }, 900);
}

describe("turn.end 的收尾不变量", () => {
  test("同一场景修复后：迟到的 text.delta 被挡在门外，状态与字幕都不动", () => {
    const ended = endTurn(speakingMachine());
    expect(ended.outcome).toBe("applied");
    expect(ended.machine.turnActive).toBe(false);
    expect(ended.machine.epoch).toBe(0); // 正常收尾不换 epoch

    // 修复前这条断言是 "applied" + speaking + 字幕被追加（见报告里的原始输出）
    const late = reduceEvent(ended.machine, delta(0, "别急着走。"), 1_200);
    expect(late.outcome).toBe("stale-turn");
    expect(late.machine.scene.characterStatus).toBe("idle");
    expect(late.machine.scene.subtitle).toBe("雨停之前，");
    expect(late.machine.turnActive).toBe(false);
  });

  test("turn.end 之后 turnId 归 null，lastTurnId 仍保留", () => {
    const ended = endTurn(speakingMachine());

    expect(ended.machine.turnId).toBeNull();
    expect(ended.machine.lastTurnId).toBe("t1");
    expect(ended.machine.turnActive).toBe(false);
    expect(ended.machine.scene.characterStatus).toBe("idle");
    expect(ended.machine.scene.subtitle).toBe("雨停之前，");
  });

  test("收尾后再来同轮事件：一律 stale-turn，不改字幕、不回到 speaking", () => {
    const ended = endTurn(speakingMachine()).machine;

    const late = reduceEvent(ended, delta(0, "别急着走。"), 1_200);
    expect(late.outcome).toBe("stale-turn");
    expect(late.machine).toBe(ended); // 原引用返回：连新对象都不造
    expect(late.machine.scene.characterStatus).toBe("idle");
    expect(late.machine.scene.subtitle).toBe("雨停之前，");
    expect(late.machine.text).toBe("雨停之前，");

    const lateChunk = reduceEvent(
      ended,
      { type: "audio.chunk", turnId: "t1", epoch: 0, seq: 3, dataUrl: "AAAA", mime: "audio/mpeg" },
      1_300,
    );
    expect(lateChunk.outcome).toBe("stale-turn");
    expect(lateChunk.machine.scene.characterStatus).toBe("idle");

    const lateEnd = endTurn(ended);
    expect(lateEnd.outcome).toBe("stale-turn");
    expect(lateEnd.machine).toBe(ended);
  });

  test("不变量不挡新一轮：turn.end 之后的 turn.start 照常进入 thinking", () => {
    const ended = endTurn(speakingMachine()).machine;
    const next = reduceEvent(
      ended,
      { type: "turn.start", turnId: "t2", epoch: 0, at: 2_000 },
      2_000,
    );

    expect(next.outcome).toBe("applied");
    expect(next.machine.turnId).toBe("t2");
    expect(next.machine.turnActive).toBe(true);
    expect(next.machine.scene.characterStatus).toBe("thinking");
  });

  test("epoch 检查仍然排在最前：陈旧 epoch 的迟到事件报 stale-epoch 而不是 stale-turn", () => {
    const ended = endTurn(speakingMachine()).machine;
    const stale = reduceEvent(ended, delta(9, "更早一轮的残句"), 1_400);

    expect(stale.outcome).toBe("stale-epoch");
    expect(stale.machine).toBe(ended);
  });
});
