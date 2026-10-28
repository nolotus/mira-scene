/**
 * 插图的六态状态机 —— 纯函数，零 DOM、零定时器、零 fetch、零存储。
 *
 *   idle ──arm──▶ waiting ──release──▶ requesting ──resolved──▶ showing ──hold──▶ done
 *                    │                     │                        │
 *                    └──skip──▶ skipped ◀──┘                        │
 *   任意态 ──abort(epoch/turn/…)──▶ interrupted ◀──────────────────┘
 *
 * 三条硬性质（测试逐条钉住）：
 *   ① 片段优先：waiting 期间不请求、不占屏 —— 片段还在播时插图绝不会抢画面。
 *   ② 打断即终态：interrupted 之后**任何**事件（resolved / fade / arm）都不再改变状态，
 *      于是「epoch 变了还有回调把插图拉回来」在状态层就不可能发生。
 *   ③ 一会话一次：`requested` 是闩，一旦发过请求，再 arm 也只落到 skipped。
 *
 * 与片段状态机的区别：插图没有「加载可失败」这一层资源语义（它是一段 base64 data URL），
 * 它的失败全部是**远端能力**问题（未配置 / 超配额 / 上游失败），所以一律静默 skip，
 * 只留一行诊断，不做失败样式。
 */

export type IllustrationPhase =
  | "idle"
  /** 已命中（storm 类 beat），但正在等片段让出画面 */
  | "waiting"
  /** 正在生成：只显示一行轻提示，角色与对话照常 */
  | "requesting"
  /** 呈现中（CSS 负责入场淡入 + 4s 末淡出） */
  | "showing"
  /** 已淡出，回落角色 */
  | "done"
  /** 被 epoch / 打断 / 卸载中止：终态，不再接受任何事件 */
  | "interrupted"
  /** 静默跳过（未配置 / 配额 / 上游失败 / 已请求过） */
  | "skipped"
  /** ?gen=0：功能整体关闭 */
  | "disabled";

export type IllustrationAbortReason = "epoch" | "turn" | "interrupt" | "user" | "unmount";

export type IllustrationSkipReason =
  | "not-configured"
  | "session-limit"
  | "daily-limit"
  | "upstream"
  | "no-session"
  | "bad-request"
  | "already-requested"
  | "disabled";

export interface IllustrationState {
  phase: IllustrationPhase;
  /** 当前这一张的 prompt（= 客户端缓存键 = 服务端 sha256 的原文） */
  prompt: string | null;
  sessionId: string | null;
  beatId: string | null;
  dataUrl: string | null;
  /** 这张是本地缓存里拿的（没有发请求） */
  cached: boolean;
  /** 进入当前相位的序号：渲染层用它当动画 key，避免同一相位重渲染时重播动画 */
  seq: number;
  /** 本会话是否已经发过请求（「同一会话最多 1 次」的闩） */
  requested: boolean;
  abortReason: IllustrationAbortReason | null;
  skipReason: IllustrationSkipReason | null;
}

export type IllustrationEvent =
  | { type: "arm"; prompt: string; sessionId: string | null; beatId: string; requested: boolean }
  | { type: "request" }
  | { type: "resolved"; dataUrl: string; cached: boolean }
  | { type: "skip"; reason: IllustrationSkipReason }
  | { type: "hold" }
  | { type: "abort"; reason: IllustrationAbortReason }
  | { type: "reset" };

export const IDLE_ILLUSTRATION: IllustrationState = {
  phase: "idle",
  prompt: null,
  sessionId: null,
  beatId: null,
  dataUrl: null,
  cached: false,
  seq: 0,
  requested: false,
  abortReason: null,
  skipReason: null,
};

const TERMINAL = new Set<IllustrationPhase>(["interrupted", "skipped", "done", "disabled"]);

export function isTerminal(phase: IllustrationPhase): boolean {
  return TERMINAL.has(phase);
}

/** 只把「真的换了态」的迁移推给订阅者（同引用 = 没变化） */
function move(state: IllustrationState, patch: Partial<IllustrationState>): IllustrationState {
  return { ...state, ...patch, seq: state.seq + 1 };
}

/**
 * 状态迁移。
 * 无效事件返回**同一个 state 引用**：调用方据此跳过重渲染，测试也能断言「迟到事件没改动状态」。
 */
export function illustrationReducer(
  state: IllustrationState,
  event: IllustrationEvent,
): IllustrationState {
  if (event.type === "reset") {
    if (state.phase === "idle" && state.requested === false) return state;
    return IDLE_ILLUSTRATION;
  }

  // 关闭态与所有终态：除 reset 之外一律无效（这就是「打断后不会被拉回来」的落点）
  if (state.phase === "disabled") return state;
  if (state.phase === "interrupted") return state;

  switch (event.type) {
    case "arm": {
      if (state.phase !== "idle") return state;
      // 本会话已经请求过一次：不再发，也不占屏
      if (state.requested || event.requested) {
        return move(state, {
          phase: "skipped",
          skipReason: "already-requested",
          beatId: event.beatId,
          sessionId: event.sessionId,
          prompt: event.prompt,
        });
      }
      return move(state, {
        phase: "waiting",
        prompt: event.prompt,
        sessionId: event.sessionId,
        beatId: event.beatId,
        requested: false,
      });
    }

    case "request": {
      if (state.phase !== "waiting") return state;
      return move(state, { phase: "requesting", requested: true });
    }

    case "resolved": {
      if (state.phase !== "requesting") return state;
      return move(state, { phase: "showing", dataUrl: event.dataUrl, cached: event.cached });
    }

    case "skip": {
      if (state.phase !== "waiting" && state.phase !== "requesting") return state;
      return move(state, { phase: "skipped", skipReason: event.reason });
    }

    case "hold": {
      if (state.phase !== "showing") return state;
      return move(state, { phase: "done" });
    }

    case "abort": {
      if (isTerminal(state.phase)) return state;
      return move(state, { phase: "interrupted", abortReason: event.reason, dataUrl: null });
    }
  }
}

/** 只有 showing 占屏（requesting 是轻提示，不是画面） */
export function illustrationVisible(state: IllustrationState): boolean {
  return state.phase === "showing" && state.dataUrl !== null;
}

/** 生成期间的轻提示：不遮角色、不拦输入 */
export function illustrationHintVisible(state: IllustrationState): boolean {
  return state.phase === "requesting";
}

export function illustrationPhaseLabel(phase: IllustrationPhase): string {
  switch (phase) {
    case "idle":
      return "未触发";
    case "waiting":
      return "等片段让出画面";
    case "requesting":
      return "生成中";
    case "showing":
      return "呈现中";
    case "done":
      return "已淡出";
    case "interrupted":
      return "已打断";
    case "skipped":
      return "已跳过（静默回落）";
    case "disabled":
      return "关闭（?gen=0）";
  }
}

export function abortReasonLabel(reason: IllustrationAbortReason): string {
  switch (reason) {
    case "epoch":
      return "epoch 变化（用户打断/换轮）";
    case "turn":
      return "新一轮开始";
    case "interrupt":
      return "用户打断";
    case "user":
      return "手动中止";
    case "unmount":
      return "组件卸载";
  }
}
