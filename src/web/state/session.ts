/**
 * 会话状态机 —— 纯函数、零 DOM、零网络、零计时器。
 *
 * 两条不可让步的规则：
 *  1. `epoch` 只增不减；每次打断 +1。请求里带上当时的 epoch。
 *  2. 任何 `event.epoch !== machine.epoch` 的事件，在进入 reducer 之前就被丢弃。
 *     这是「上一轮迟到的网络响应不会覆盖当前状态、也不会重新开始播放」的唯一防线。
 *
 * 网络、语音、定时器都在上层（store.ts / bargeIn.ts / voice/*），
 * 所以这里的每条规则都能被 bun test 直接覆盖。
 */

import type {
  Action,
  CharacterStatus,
  Directive,
  SceneState,
  SessionEvent,
  Vfx,
} from "../../shared/protocol";

// ---------------------------------------------------------------- 视觉状态的初始值

/** 每种 vfx 的强度衰减速度（每秒）。一次性特效衰减快，持续氛围衰减慢。 */
export const VFX_DECAY_PER_SEC: Record<Vfx, number> = {
  lightning: 1.6, // ≈0.6s 内熄灭
  rain_heavy: 0.02,
  rain_light: 0.03,
  warm_glow: 0.045,
  lights_dim: 0.02,
  steam_wisp: 0.3,
};

/** 低于此强度直接移除，避免拖动一串 0.001 的空转重渲染 */
const VFX_FLOOR = 0.02;

/** 瞬时动作队列上限：模型刷屏时也不能把渲染层压垮 */
const MAX_PENDING_ACTIONS = 8;

/** 分支选项上限 */
const MAX_BRANCHES = 4;

export function createInitialScene(patch: Partial<SceneState> = {}): SceneState {
  return {
    scene: "cafe_night",
    emotion: "neutral",
    pose: "stand",
    camera: null,
    vfx: {},
    characterStatus: "idle",
    pendingActions: [],
    subtitle: "",
    branches: [],
    lastBeat: null,
    ...patch,
  };
}

export function withStatus(scene: SceneState, status: CharacterStatus): SceneState {
  return scene.characterStatus === status ? scene : { ...scene, characterStatus: status };
}

/**
 * 显著视觉事件 id（题目要求：画面事件要由对话触发，不能只依赖定时器）。
 * 带上 turnId，保证同一个 directive 在两轮里产生不同的 id，渲染层能重新触发动画。
 */
export function beatId(directive: Directive, turnId: string | null = null): string {
  const key =
    directive.kind === "emotion"
      ? `emotion:${directive.emotion}`
      : directive.kind === "pose"
        ? `pose:${directive.pose}`
        : directive.kind === "scene"
          ? `scene:${directive.scene}`
          : directive.kind === "camera"
            ? `camera:${directive.move}`
            : directive.kind === "vfx"
              ? `vfx:${directive.vfx}`
              : directive.kind === "action"
                ? `action:${directive.action}`
                : `branch:${directive.options.map((o) => o.id).join("|")}`;
  return turnId ? `${turnId}#${key}` : key;
}

/**
 * Directive → SceneState（纯函数，渲染层唯一的状态来源）。
 * - `pendingActions` 追加（渲染层消费后自行清空，见 `drainActions`）
 * - `vfx` 置满强度 1，由 `tickScene` 逐帧衰减
 */
export function applyDirective(
  scene: SceneState,
  directive: Directive,
  turnId: string | null = null,
): SceneState {
  const lastBeat = beatId(directive, turnId);
  switch (directive.kind) {
    case "emotion":
      return { ...scene, emotion: directive.emotion, lastBeat };
    case "pose":
      return { ...scene, pose: directive.pose, lastBeat };
    case "scene":
      return { ...scene, scene: directive.scene, lastBeat };
    case "camera":
      return { ...scene, camera: directive.move, lastBeat };
    case "vfx":
      return { ...scene, vfx: { ...scene.vfx, [directive.vfx]: 1 }, lastBeat };
    case "action":
      return {
        ...scene,
        pendingActions: [...scene.pendingActions, directive.action].slice(-MAX_PENDING_ACTIONS),
        lastBeat,
      };
    case "branch":
      return { ...scene, branches: directive.options.slice(0, MAX_BRANCHES), lastBeat };
  }
}

/** 渲染层消费瞬时动作：一次性清空（题目：pendingActions 消费即清空） */
export function drainActions(scene: SceneState): { scene: SceneState; actions: Action[] } {
  if (scene.pendingActions.length === 0) return { scene, actions: [] };
  return { scene: { ...scene, pendingActions: [] }, actions: [...scene.pendingActions] };
}

/** 逐帧衰减 vfx 强度；无变化时返回同一个引用，避免无意义重渲染。 */
export function tickScene(scene: SceneState, dtMs: number): SceneState {
  if (!(dtMs > 0)) return scene;
  const keys = Object.keys(scene.vfx) as Vfx[];
  if (keys.length === 0) return scene;

  const dt = Math.min(dtMs, 250) / 1000; // 标签页休眠回来后不要一次性掉光
  let changed = false;
  const next: Partial<Record<Vfx, number>> = {};

  for (const key of keys) {
    const current = scene.vfx[key];
    if (current === undefined) continue;
    const value = current - (VFX_DECAY_PER_SEC[key] ?? 0.05) * dt;
    if (value > VFX_FLOOR) {
      next[key] = value;
      if (Math.abs(value - current) > 0.003) changed = true;
    } else {
      changed = true; // 强度归零 → 移除
    }
  }

  return changed ? { ...scene, vfx: next } : scene;
}

// ---------------------------------------------------------------- 会话机

/**
 * 会话机状态。`epoch` 与 `turnId` 一起构成「谁有权改这段状态」的凭证。
 */
export interface SessionMachine {
  /** 单调递增；打断 +1 */
  epoch: number;
  /** 当前轮的 id；没有进行中的轮次时为 null */
  turnId: string | null;
  scene: SceneState;
  /** 当前轮的完整文本（subtitle 是它的镜像） */
  text: string;
  turnActive: boolean;
  /** 最近一次真正开始的轮次，便于观测与重试 */
  lastTurnId: string | null;
  error: string | null;
  turnStartedAt: number | null;
  firstEventAt: number | null;
}

export function createMachine(epoch = 0, scene: SceneState = createInitialScene()): SessionMachine {
  return {
    epoch,
    turnId: null,
    scene,
    text: "",
    turnActive: false,
    lastTurnId: null,
    error: null,
    turnStartedAt: null,
    firstEventAt: null,
  };
}

/** 用户开始输入/说话：idle → listening。角色正在说话时必须先走 barge-in。 */
export function reduceUserInput(machine: SessionMachine): SessionMachine {
  if (machine.scene.characterStatus === "speaking") return machine;
  if (machine.scene.characterStatus === "listening") return machine;
  return { ...machine, error: null, scene: withStatus(machine.scene, "listening") };
}

/** 请求已发出、首 token 之前：thinking。新的一轮从空白字幕开始。 */
export function reduceRequestSent(
  machine: SessionMachine,
  turnId: string,
  now: number,
): SessionMachine {
  return {
    ...machine,
    turnId,
    turnActive: true,
    error: null,
    text: "",
    turnStartedAt: now,
    firstEventAt: null,
    scene: {
      ...withStatus(machine.scene, "thinking"),
      subtitle: "",
      pendingActions: [],
      branches: [],
    },
  };
}

export function reduceRequestFailed(machine: SessionMachine, message: string): SessionMachine {
  return {
    ...machine,
    turnActive: false,
    error: message,
    scene: withStatus(machine.scene, "idle"),
  };
}

/**
 * 打断：epoch+1，本轮一切「未落地」的产出作废。
 * 保留 emotion / pose / scene / vfx —— 角色不该在被打断的瞬间跳回初始姿势。
 */
export function reduceBargeIn(machine: SessionMachine): SessionMachine {
  return {
    ...machine,
    epoch: machine.epoch + 1,
    turnId: null,
    turnActive: false,
    text: "",
    lastTurnId: machine.turnId ?? machine.lastTurnId,
    error: null,
    turnStartedAt: null,
    firstEventAt: null,
    scene: {
      ...machine.scene,
      characterStatus: "listening",
      subtitle: "",
      pendingActions: [],
      branches: [],
      camera: null,
      lastBeat: null,
    },
  };
}

export type ApplyOutcome = "applied" | "stale-epoch" | "stale-turn";

export interface ApplyResult {
  machine: SessionMachine;
  outcome: ApplyOutcome;
}

/**
 * 事件入口 —— 这里是「迟到响应」唯一的关卡。
 * 顺序很关键：先比 epoch，再比 turnId，最后才碰 scene。
 */
export function reduceEvent(
  machine: SessionMachine,
  event: SessionEvent,
  now = 0,
): ApplyResult {
  if (event.epoch !== machine.epoch) {
    return { machine, outcome: "stale-epoch" };
  }
  // 不变量：没有进行中的轮次时，唯一允许进入的是 turn.start。
  // 拦的是「turn.end 已收尾、同一轮的事件还在路上」这一情形 —— 在此之前
  // turnId 会留在机器上，于是 epoch 相等 + turnId 相等，两道闸门都放行，
  // 一条迟到 text.delta 能把角色从 idle 拉回 speaking 并往字幕上追加内容。
  if (!machine.turnActive && event.type !== "turn.start") {
    return { machine, outcome: "stale-turn" };
  }
  if (machine.turnId !== null && event.turnId !== machine.turnId) {
    return { machine, outcome: "stale-turn" };
  }

  switch (event.type) {
    case "turn.start":
      return {
        machine: {
          ...machine,
          turnId: event.turnId,
          turnActive: true,
          error: null,
          scene: withStatus(machine.scene, "thinking"),
        },
        outcome: "applied",
      };

    case "text.delta": {
      const text = machine.text + event.text;
      return {
        machine: {
          ...machine,
          text,
          turnActive: true,
          firstEventAt: machine.firstEventAt ?? (now || null),
          scene: { ...withStatus(machine.scene, "speaking"), subtitle: text },
        },
        outcome: "applied",
      };
    }

    case "directive":
      return {
        machine: {
          ...machine,
          scene: applyDirective(machine.scene, event.directive, event.turnId),
        },
        outcome: "applied",
      };

    case "audio.chunk":
      // 音频路径同样从「首事件」起算 speaking 状态；音频真正播放由 StreamTTS 负责
      return {
        machine: {
          ...machine,
          turnActive: true,
          firstEventAt: machine.firstEventAt ?? (now || null),
          scene: withStatus(machine.scene, "speaking"),
        },
        outcome: "applied",
      };

    case "audio.end":
      return { machine, outcome: "applied" };

    case "turn.end":
      return {
        machine: {
          ...machine,
          turnActive: false,
          // 轮次收尾必须释放 turnId：留着它等于给「同一轮的迟到事件」留一把钥匙
          // （epoch 正常收尾不变，turnId 若还在，双闸门同时失效）
          turnId: null,
          lastTurnId: event.turnId,
          scene: withStatus(machine.scene, "idle"),
        },
        outcome: "applied",
      };

    case "error": {
      const next: SessionMachine = {
        ...machine,
        error: event.message,
        scene: event.recoverable
          ? machine.scene
          : withStatus(machine.scene, "idle"),
      };
      if (!event.recoverable) {
        next.turnActive = false;
        next.lastTurnId = event.turnId;
      }
      return { machine: next, outcome: "applied" };
    }
  }
}

/** 供 UI 显示的「谁在说话 / 谁在听」 */
export function isSpeaking(machine: SessionMachine): boolean {
  return machine.scene.characterStatus === "speaking";
}

/** 打断判据：角色正在说话，或本轮请求还没收尾 */
export function needsBargeIn(machine: SessionMachine): boolean {
  return machine.scene.characterStatus === "speaking" || machine.turnActive;
}
