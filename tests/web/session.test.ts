import { describe, expect, test } from "bun:test";
import type { Directive } from "../../src/shared/protocol";
import {
  applyDirective,
  createInitialScene,
  createMachine,
  drainActions,
  reduceBargeIn,
  reduceEvent,
  reduceRequestSent,
  tickScene,
} from "../../src/web/state/session";

const delta = (epoch: number, text: string, turnId = "t1") =>
  ({ type: "text.delta", turnId, epoch, text }) as const;

describe("epoch 护栏：陈旧事件一律丢弃", () => {
  test("epoch 不匹配的 text.delta 不改变字幕、不改变状态，返回同一个 machine 引用", () => {
    const machine = reduceRequestSent(createMachine(3), "t1", 0);
    const result = reduceEvent(machine, delta(2, "上一轮迟到的后半句"));

    expect(result.outcome).toBe("stale-epoch");
    expect(result.machine).toBe(machine);
    expect(result.machine.scene.subtitle).toBe("");
    expect(result.machine.text).toBe("");
    expect(result.machine.scene.characterStatus).toBe("thinking");
  });

  test("陈旧 epoch 的 directive / turn.end / audio.chunk 同样被挡掉", () => {
    const machine = reduceRequestSent(createMachine(5), "t1", 0);

    const directive: Directive = { kind: "emotion", emotion: "sad" };
    const dirResult = reduceEvent(machine, {
      type: "directive",
      turnId: "t1",
      epoch: 4,
      directive,
    });
    expect(dirResult.outcome).toBe("stale-epoch");
    expect(dirResult.machine.scene.emotion).toBe("neutral");

    const endResult = reduceEvent(machine, {
      type: "turn.end",
      turnId: "t1",
      epoch: 4,
      interrupted: false,
    });
    expect(endResult.outcome).toBe("stale-epoch");
    expect(endResult.machine.turnActive).toBe(true);

    const chunkResult = reduceEvent(machine, {
      type: "audio.chunk",
      turnId: "t1",
      epoch: 4,
      seq: 0,
      dataUrl: "AAAA",
      mime: "audio/mpeg",
    });
    expect(chunkResult.outcome).toBe("stale-epoch");
    expect(chunkResult.machine.scene.characterStatus).toBe("thinking");
  });

  test("同 epoch 但 turnId 对不上的事件被当作串轮丢弃", () => {
    const machine = reduceRequestSent(createMachine(1), "t1", 0);
    const result = reduceEvent(machine, delta(1, "别的轮次", "t0"));
    expect(result.outcome).toBe("stale-turn");
    expect(result.machine.scene.subtitle).toBe("");
  });

  test("epoch 匹配的事件正常工作（护栏没有把正常路径也挡住）", () => {
    const machine = reduceRequestSent(createMachine(7), "t1", 0);
    const result = reduceEvent(machine, delta(7, "欢迎光临"));
    expect(result.outcome).toBe("applied");
    expect(result.machine.scene.subtitle).toBe("欢迎光临");
    expect(result.machine.scene.characterStatus).toBe("speaking");
  });
});

describe("打断：epoch +1，旧轮产出失效", () => {
  test("打断后 epoch +1、状态切 listening、字幕与未消费动作清空", () => {
    let machine = reduceRequestSent(createMachine(0), "t1", 0);
    machine = reduceEvent(machine, delta(0, "她说到一半"), 0).machine;
    machine = reduceEvent(
      machine,
      { type: "directive", turnId: "t1", epoch: 0, directive: { kind: "action", action: "sigh" } },
      0,
    ).machine;
    expect(machine.scene.characterStatus).toBe("speaking");
    expect(machine.scene.pendingActions).toEqual(["sigh"]);

    const interrupted = reduceBargeIn(machine);

    expect(interrupted.epoch).toBe(1);
    expect(interrupted.scene.characterStatus).toBe("listening");
    expect(interrupted.scene.subtitle).toBe("");
    expect(interrupted.scene.pendingActions).toEqual([]);
    expect(interrupted.scene.branches).toEqual([]);
    expect(interrupted.turnId).toBeNull();
    expect(interrupted.turnActive).toBe(false);
    expect(interrupted.lastTurnId).toBe("t1");
    // 视觉连续性：情绪/姿势/场景不因为打断而跳回初始值
    expect(interrupted.scene.scene).toBe(machine.scene.scene);
  });

  test("打断后旧 turn 的 text.delta 不改变字幕", () => {
    let machine = reduceRequestSent(createMachine(0), "t1", 0);
    machine = reduceEvent(machine, delta(0, "雨好像更大了。"), 0).machine;
    const interrupted = reduceBargeIn(machine);

    const late = reduceEvent(interrupted, delta(0, "——我还没说完呢。"), 0);

    expect(late.outcome).toBe("stale-epoch");
    expect(late.machine.scene.subtitle).toBe("");
    expect(late.machine.text).toBe("");
    expect(late.machine.epoch).toBe(1);
  });

  test("旧轮的 turn.end 不会把新一轮拉回 idle", () => {
    const interrupted = reduceBargeIn(
      reduceEvent(reduceRequestSent(createMachine(0), "t1", 0), delta(0, "前半句"), 0).machine,
    );
    const next = reduceRequestSent(interrupted, "t2", 100);
    const spoken = reduceEvent(next, delta(1, "新的一轮", "t2"), 100).machine;
    expect(spoken.scene.characterStatus).toBe("speaking");

    const lateEnd = reduceEvent(spoken, {
      type: "turn.end",
      turnId: "t1",
      epoch: 0,
      interrupted: true,
    });

    expect(lateEnd.outcome).toBe("stale-epoch");
    expect(lateEnd.machine.scene.characterStatus).toBe("speaking");
    expect(lateEnd.machine.turnActive).toBe(true);
  });
});

describe("Directive → SceneState", () => {
  test("各类指令落到正确字段，pendingActions 消费即清空", () => {
    let scene = createInitialScene();
    scene = applyDirective(scene, { kind: "emotion", emotion: "warm" }, "t1");
    scene = applyDirective(scene, { kind: "pose", pose: "lean_in" }, "t1");
    scene = applyDirective(scene, { kind: "scene", scene: "window_rain" }, "t1");
    scene = applyDirective(scene, { kind: "camera", move: "push_in" }, "t1");
    scene = applyDirective(scene, { kind: "vfx", vfx: "lightning" }, "t1");
    scene = applyDirective(scene, { kind: "action", action: "blink" }, "t1");
    scene = applyDirective(scene, { kind: "action", action: "sigh" }, "t1");
    scene = applyDirective(
      scene,
      { kind: "branch", options: [{ id: "stay", label: "再坐一会儿" }, { id: "go", label: "我该走了" }] },
      "t1",
    );

    expect(scene.emotion).toBe("warm");
    expect(scene.pose).toBe("lean_in");
    expect(scene.scene).toBe("window_rain");
    expect(scene.camera).toBe("push_in");
    expect(scene.vfx.lightning).toBe(1);
    expect(scene.pendingActions).toEqual(["blink", "sigh"]);
    expect(scene.branches.map((b) => b.id)).toEqual(["stay", "go"]);
    expect(scene.lastBeat).toBe("t1#branch:stay|go");

    const { scene: drained, actions } = drainActions(scene);
    expect(actions).toEqual(["blink", "sigh"]);
    expect(drained.pendingActions).toEqual([]);
    // 消费一次之后是空操作，不会重复触发动作
    expect(drainActions(drained).actions).toEqual([]);
  });

  test("vfx 强度随时间衰减，一次性特效最终移除，持续氛围衰减更慢", () => {
    let scene = applyDirective(createInitialScene(), { kind: "vfx", vfx: "lightning" }, "t1");
    scene = applyDirective(scene, { kind: "vfx", vfx: "rain_heavy" }, "t1");

    const once = tickScene(scene, 200);
    expect(once.vfx.lightning).toBeLessThan(1);
    expect(once.vfx.rain_heavy).toBeLessThan(1);

    let faded = scene;
    for (let i = 0; i < 10; i += 1) faded = tickScene(faded, 250);
    expect(faded.vfx.lightning).toBeUndefined();
    expect(faded.vfx.rain_heavy).toBeDefined();

    // 没有变化时返回同一引用，避免 60fps 无意义重渲染
    const empty = createInitialScene();
    expect(tickScene(empty, 16)).toBe(empty);
  });

  test("同一 directive 在不同轮次产生不同的 lastBeat", () => {
    const directive: Directive = { kind: "vfx", vfx: "lightning" };
    const a = applyDirective(createInitialScene(), directive, "t1");
    const b = applyDirective(createInitialScene(), directive, "t2");
    expect(a.lastBeat).not.toBe(b.lastBeat);
  });
});

describe("轮次收尾", () => {
  test("turn.end 后状态回 idle，字幕保留最后一句", () => {
    let machine = reduceRequestSent(createMachine(0), "t1", 0);
    machine = reduceEvent(machine, delta(0, "雨停之前，别急着走。"), 10).machine;
    expect(machine.scene.characterStatus).toBe("speaking");

    const result = reduceEvent(
      machine,
      { type: "turn.end", turnId: "t1", epoch: 0, interrupted: false },
      900,
    );

    expect(result.outcome).toBe("applied");
    expect(result.machine.scene.characterStatus).toBe("idle");
    expect(result.machine.turnActive).toBe(false);
    expect(result.machine.scene.subtitle).toBe("雨停之前，别急着走。");
    expect(result.machine.lastTurnId).toBe("t1");
  });

  test("状态链路 idle → listening → thinking → speaking → idle", () => {
    const idle = createMachine(0);
    expect(idle.scene.characterStatus).toBe("idle");

    const listening = reduceRequestSent(createMachine(0), "t0", 0); // 占位：思考中
    expect(listening.scene.characterStatus).toBe("thinking");

    const speaking = reduceEvent(listening, delta(0, "嗯？", "t0"), 0).machine;
    expect(speaking.scene.characterStatus).toBe("speaking");

    const done = reduceEvent(
      speaking,
      { type: "turn.end", turnId: "t0", epoch: 0, interrupted: false },
      1,
    ).machine;
    expect(done.scene.characterStatus).toBe("idle");
  });
});
