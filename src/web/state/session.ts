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
import { isActionAllowed } from "../stage/scenes/spec";

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

// ---------------------------------------------------------------- 瞬时动作队列（优先级）

/**
 * 动作优先级（数值越大越优先）。
 *
 * 排序理由：**能打断观众的强烈动作优先，细微动作可丢**。
 * 一次眨眼被吞掉没人发现；一次惊跳被吞掉，这个 beat 的重音就整个没了。
 * 所以这张表同时是「排序键」和「丢弃键」—— 队列满时丢的就是表尾那些，
 * 不需要另一套优先级规则（两套规则迟早会打架）。
 *
 * 具体位置来自「动作幅度 / 信息量 / 与其他通道的重复度」三个维度：
 *  - startle 惊跳：幅度最大，且是 beat 的重音，唯一不可替代的；
 *  - shiver 发抖：躯干幅度大，观众一眼读出「冷 / 怕」；
 *  - hair_tuck 别头发：幅度不大，但带着明确指向（发夹高光、视线下移），信息量高；
 *  - look_back 回头：视线调度，中幅；错过一次还有下一句补上；
 *  - sigh 叹气：画面幅度小，主要靠声音传递 —— 视觉这一半丢了损失有限；
 *  - nod 点头：最容易被台词语气重复表达，所以排在可牺牲的一侧；
 *  - blink 眨眼：背景动作，不参与排队（见 isBackgroundAction）。
 */
export const ACTION_PRIORITY: Record<Action, number> = {
  startle: 6,
  shiver: 5,
  hair_tuck: 4,
  look_back: 3,
  sigh: 2,
  nod: 1,
  blink: 0,
};

/** 前景动作队列上限：超过就丢「最旧的低优先级」（见 evictLowestForeground） */
export const ACTION_QUEUE_LIMIT = 3;

/** 背景动作（眨眼）最多叠这么多次：再多视觉上也没有区别，只是白占内存 */
export const MAX_BLINK_BACKLOG = 2;

/**
 * 背景动作：`blink` 是「随时可叠加」的一类，**不占队列**。
 *
 * 为什么必须单独拎出来：眨眼是渲染层最频繁的底层动作，如果它和 `hair_tuck`
 * 抢同一条 3 格队列，几句台词里攒下的眨眼会把真正有戏的动作顶掉 ——
 * 观感上就是「角色一直在眨眼，但该做的动作没做」。
 */
export function isBackgroundAction(action: Action): boolean {
  return action === "blink";
}

export interface ActionEnqueueResult {
  queue: Action[];
  /**
   * 被这条新动作挤掉的旧动作（没有就是 null）。
   * 纯函数不记账 —— 计数留在 store（`droppedActionsByPriority`），
   * 这一层继续零副作用，才能被 bun test 直接钉住。
   */
  dropped: Action | null;
}

/**
 * 入队一条瞬时动作（纯函数，返回新数组）。
 *
 * 队列语义 = `pendingActions` 本身：前景动作按优先级降序、同优先级按到达顺序（FIFO），
 * 背景动作（眨眼）挂在尾部。渲染层照旧取 `[0]` —— 拿到的永远是当前最该演的那个。
 */
export function enqueueAction(queue: Action[], action: Action): ActionEnqueueResult {
  if (isBackgroundAction(action)) {
    // 追加到尾部：`[0]` 永远是前景动作，所以眨眼在任何情况下都顶不掉它；
    // 但它在队列里真实存在，渲染层可以随时叠加播放。
    if (queue.filter(isBackgroundAction).length >= MAX_BLINK_BACKLOG) {
      return { queue, dropped: null };
    }
    return { queue: [...queue, action], dropped: null };
  }

  const next = [...queue];
  // 插入点 = 第一个「优先级严格低于它」的位置：
  //  · 同优先级排在已有同级的后面 → FIFO（不引入序号就够，因为队列里同级本就是到达顺序）
  //  · 眨眼优先级最低，所以它天然落在所有前景动作之后 —— 不需要额外分支
  const index = next.findIndex((queued) => ACTION_PRIORITY[queued] < ACTION_PRIORITY[action]);
  if (index < 0) next.push(action);
  else next.splice(index, 0, action);

  let dropped: Action | null = null;
  if (next.filter((queued) => !isBackgroundAction(queued)).length > ACTION_QUEUE_LIMIT) {
    dropped = evictLowestForeground(next);
  }
  return { queue: next, dropped };
}

/**
 * 丢掉「最旧的低优先级」前景动作（原地改 next，返回被丢的那个）。
 * 严格小于才替换 → 同级里保留**更早到达**的那条：先到的已经可能在播了，后到的还没开始，
 * 丢后者对画面更平滑。
 */
function evictLowestForeground(queue: Action[]): Action | null {
  let victimIndex = -1;
  let victimPriority = Number.POSITIVE_INFINITY;
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (candidate === undefined || isBackgroundAction(candidate)) continue;
    const priority = ACTION_PRIORITY[candidate];
    if (priority < victimPriority) {
      victimPriority = priority;
      victimIndex = index;
    }
  }
  if (victimIndex < 0) return null;
  const [victim] = queue.splice(victimIndex, 1);
  return victim ?? null;
}

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
 * 场景适配闸门（客户端职责）。
 *
 * 与「服务端白名单」的分工，写清楚免得下次有人把两层合并：
 *  - 服务端 `src/server/scene/validate.ts`：管**枚举合法性** —— `blink` 是不是一个
 *    存在的 Action、`cafe_night` 是不是一个存在的场景。它不懂场景语义，也不该懂。
 *  - 这里：管**场景适配** —— 当前场景的 `spec.actions` 里有没有这个词。
 *    `hold_cup` 在协议里是 **Pose**，所以 `action` 与 `pose` 两条指令都要过闸门。
 * 被拦下的指令由 store 计入 `droppedActions`（诊断面板里看得见，不静默）。
 */
export function isDirectiveAllowed(scene: SceneState["scene"], directive: Directive): boolean {
  switch (directive.kind) {
    case "action":
      return isActionAllowed(scene, directive.action);
    case "pose":
      return isActionAllowed(scene, directive.pose);
    default:
      return true;
  }
}

/**
 * Directive → SceneState（纯函数，渲染层唯一的状态来源）。
 *
 * 为什么「水位置闸门」的**判断**在 session（reduceEvent 的 directive 分支）、
 * 而**队列**在 store：
 *  · 判断只依赖「这条指令 vs 当前水位」，没有任何跨事件状态 —— 它是纯的，放这里能被单测直接钉住；
 *    epoch / turnId / 场景适配三道判断也都在这里，闸门跟它们排在一起才不会漏掉先后次序。
 *  · 队列是跨事件、跨轮次的生命周期状态（要打断清空、要收尾 flush），
 *    而 SessionMachine 是「渲染层唯一输入」且会被 snapshot 给服务端参考；
 *    把一个只属于调度的队列塞进机器里，等于让渲染与协议都背上一次调度细节。
 *  · 结论：session 负责「该不该现在执行」，store 负责「现在不执行时把它放哪儿、什么时候再问一次」。
 *
 * 行为约定：
 * - 场景容不下的 `action` / `pose`：原样返回（连 `lastBeat` 都不动，
 *   画面不该为一件没发生的动作重播）
 * - `pendingActions` 按优先级入队（见 `enqueueAction`；渲染层消费后自行清空，见 `drainActions`）
 * - `vfx` 置满强度 1，由 `tickScene` 逐帧衰减
 */
export function applyDirective(
  scene: SceneState,
  directive: Directive,
  turnId: string | null = null,
): SceneState {
  if (!isDirectiveAllowed(scene.scene, directive)) return scene;
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
        // 队列语义 = 按优先级排好序（高优先级抢占低优先级，眨眼不占队列）。
        // 交付给渲染层的仍是 pendingActions，渲染层照旧取 [0]。
        pendingActions: enqueueAction(scene.pendingActions, directive.action).queue,
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

export type ApplyOutcome =
  | "applied"
  | "stale-epoch"
  | "stale-turn"
  | "action-not-in-scene"
  /** 指令锚在未来某个字符位置（`atChar > watermark`）：现在不该执行，交给上层排队 */
  | "queued";

export interface ApplyResult {
  machine: SessionMachine;
  outcome: ApplyOutcome;
}

/**
 * 一条 directive 事件锚在哪个字符位置（`atChar` 的规范化，纯函数）。
 *
 *   · 缺省 / 非有限数 → `null`：**没有锚**，等价于旧协议「立即执行」
 *   · 负数 → 0（开口之前就变）
 *   · 其余取整（与 cues.ts 的 clampAtChar 同一套取整规则，但**不夹到台词长度**：
 *     客户端拿到的 atChar 经常比「目前已收到的台词」更靠后，那正是要排队的情形，
 *     夹到当前文本长度会把「说到一半才变」压成「立刻变」）
 *
 * 返回 null 而不是 0 是有意的：0 是「说到第 0 个字就变」（合法且有意义的锚），
 * 与「根本没有锚」是两件事，用同一个值表达会让「atChar 缺失时行为逐字不变」说不清。
 */
export function cueAtChar(event: { atChar?: number }): number | null {
  const raw = event.atChar;
  if (raw === undefined || !Number.isFinite(raw)) return null;
  return raw <= 0 ? 0 : Math.trunc(raw);
}

/**
 * 水位闸门的判据（纯函数）：这条指令现在该执行吗？
 *
 * watermark = 本轮已播字数（按 Unicode 码点，与 cues.ts 的 charCount 同一把尺子）。
 * `Number.POSITIVE_INFINITY` 表示**强制放行**（收尾时把队列里剩下的全部放掉），
 * 也是 `reduceEvent` 的默认值 —— 默认不带闸门，任何只关心「迟到」不关心「说到哪」的
 * 调用方（老测试、以后可能的回放器）拿到的行为与改动前完全一致。
 */
export function isCueDue(atChar: number | null, watermark: number): boolean {
  if (atChar === null) return true;
  if (!Number.isFinite(watermark)) return true; // 强制放行
  return atChar <= watermark;
}

/**
 * 事件入口 —— 这里是「迟到响应」唯一的关卡。
 * 顺序很关键：先比 epoch，再比 turnId，最后才碰 scene。
 */
export function reduceEvent(
  machine: SessionMachine,
  event: SessionEvent,
  now = 0,
  /**
   * 本轮已播字数水位（可选）。只有 `directive` 分支用它，而且只用来判断
   * 「该排队还是该执行」；**不传 = 不设闸门 = 旧行为**（见 isCueDue）。
   * 队列本身不在这里（reducer 是纯函数、无跨事件状态），由 store 持有。
   */
  watermark = Number.POSITIVE_INFINITY,
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

    case "directive": {
      // 水位闸门（「说到哪、画面变到哪」）。放在这里而不是 store 里，理由见 applyDirective 上方的注释；
      // 位置也有讲究 —— 在 epoch / turnId / turnActive 三道闸门**之后**、场景适配**之前**：
      //   · 之后：一条已经过期的指令不该有机会进队列等着被放出来（否则打断后队列里全是旧账）；
      //   · 之前：场景会被本轮更早的指令改掉，「这个场景容不容得下」只有在真要执行的那一刻才知道。
      const atChar = cueAtChar(event);
      if (!isCueDue(atChar, watermark)) return { machine, outcome: "queued" };

      // 场景适配：这个场景容不下的动作/姿势在这里就被丢掉，并让上层看得见（→ droppedActions）
      if (!isDirectiveAllowed(machine.scene.scene, event.directive)) {
        return { machine, outcome: "action-not-in-scene" };
      }
      return {
        machine: {
          ...machine,
          scene: applyDirective(machine.scene, event.directive, event.turnId),
        },
        outcome: "applied",
      };
    }

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
