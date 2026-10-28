/**
 * 打断（barge-in）—— 全应用唯一允许跨 epoch 的入口。
 *
 * 执行顺序是被题目逐条约束的，且顺序本身就是正确性的一部分：
 *
 *   ① epoch + 1（同步，第一件事）
 *        → 从这一刻起，正在飞回来的旧响应带的还是老 epoch，进 reducer 就被丢弃。
 *          放在最前面，是因为 JS 是单线程 + 同步执行：这一行执行完，
 *          任何排队中的 onmessage/reader 回调都只能看到新 epoch。
 *   ② TTS cancel（同步）
 *        → speechSynthesis.cancel() / sourceNode.stop() + 清队列；
 *          角色声音立刻停，且旧 utterance 的 onend 因 generation 不符而不会推进队列。
 *   ③ POST /api/turn/:turnId/cancel（不 await，失败不影响本地）
 *        → 让服务端停止产出、省 token；即使它不理会，本地也已经安全。
 *   ④ 状态切 listening
 *        → 页面进入倾听态，可以接住用户接下来的输入。
 *
 * ⑤ 旧 in-flight 请求本地 abort：只影响 socket，不影响上面任何一步的语义。
 */

export type BargeInReason = "speech" | "key" | "button" | "input" | "retry" | "branch";

/**
 * 会经过「回声守卫」的原因只有 `speech`（VAD 自动触发）。
 * 按钮 / Esc / 打字是人工意图，永远不受守卫约束 —— 见 speechReasonIsGuarded()。
 */
export function speechReasonIsGuarded(reason: BargeInReason): boolean {
  return reason === "speech";
}

/** 步骤名，按实际执行顺序记录，测试用它断言顺序 */
export type BargeInStep = "epoch" | "audio" | "abort" | "cancel" | "listening";

export interface BargeInPorts {
  /** 当前（打断前）epoch */
  epoch(): number;
  /** epoch + 1，并清空本轮的「未完成产出」；同步返回新 epoch */
  bumpEpoch(): number;
  /** 立即静音 */
  cancelAudio(): void;
  /** 本地 abort in-flight fetch（可选） */
  abortInflight?(): void;
  /** 通知服务端取消（fire-and-forget） */
  notifyCancel(turnId: string, epoch: number): void;
  /** 状态切 listening */
  markListening(): void;
  /** 单步失败不阻塞其余步骤，但要能被观测到 */
  onError?(step: BargeInStep, error: unknown): void;
}

export interface BargeInResult {
  reason: BargeInReason;
  fromEpoch: number;
  toEpoch: number;
  /** 被打断的 turn（可能为 null：说话中但没有 turnId） */
  turnId: string | null;
  cancelledTurn: boolean;
  steps: BargeInStep[];
  failed: Array<{ step: BargeInStep; error: unknown }>;
}

/**
 * 同步执行整条打断链路。任何一步抛错都要继续走完后面的步骤
 * —— 静音和切状态比「报告错误」重要得多。
 */
export function performBargeIn(
  ports: BargeInPorts,
  options: { reason: BargeInReason; turnId?: string | null },
): BargeInResult {
  const fromEpoch = ports.epoch();
  const turnId = options.turnId ?? null;
  const steps: BargeInStep[] = [];
  const failed: Array<{ step: BargeInStep; error: unknown }> = [];

  const run = (step: BargeInStep, fn: () => void) => {
    steps.push(step);
    try {
      fn();
    } catch (error) {
      failed.push({ step, error });
      ports.onError?.(step, error);
    }
  };

  // ① epoch 必须先动，且必须同步完成
  let toEpoch = fromEpoch;
  run("epoch", () => {
    toEpoch = ports.bumpEpoch();
  });

  // ② 立即静音
  run("audio", () => ports.cancelAudio());

  // ③ 断开本地流（不改变语义，只是尽快释放连接）
  if (ports.abortInflight) run("abort", () => ports.abortInflight?.());

  // ④ 通知服务端（fire-and-forget；具体实现在 store 里 catch 掉）
  if (turnId) run("cancel", () => ports.notifyCancel(turnId, toEpoch));

  // ⑤ 进入倾听态
  run("listening", () => ports.markListening());

  return {
    reason: options.reason,
    fromEpoch,
    toEpoch,
    turnId,
    cancelledTurn: turnId !== null,
    steps,
    failed,
  };
}

// ---------------------------------------------------------------- 回声自打断守卫

/**
 * 为什么需要这个守卫（这是被真实评审点名的 bug 面）：
 *
 * 麦克风开着 + 外放时，`speechSynthesis` 的声音会被麦克风收回去。`getUserMedia` 的
 * `echoCancellation` 只是「尽力」，对 TTS 这种持续、频谱稳定的声音常常收敛不够快，
 * 于是能量 VAD 会把角色自己说的话当成「用户开口」→ 角色自己打断自己（话说一半卡住）。
 *
 * 守卫只对 VAD 触发的打断生效，两条硬条件：
 *
 *   ① 角色刚开口的 `rampUpMs` 内一律丢弃 —— 那是回声爬升 + AEC 收敛期，误判率最高；
 *   ② `rampUpMs` 之后仍要求**连续**语音 ≥ `minSustainedMs` —— 回声在句间换气处会断，
 *      短促触发更可能是残余回声/环境噪音。
 *
 * 按钮 / Esc / 打字打断**不经过这里**（`speechReasonIsGuarded()` 会拒掉一切非 speech 原因）：
 * 人工打断永远要灵，宁可让守卫放过一次回声，也不能让人按了按钮没反应。
 *
 * 已知局限（不藏着）：能量 VAD 无法区分「用户的持续说话」与「持续的 TTS 回声」。
 * 所以守卫能挡掉短促回声与爬升期误触，挡不住「整句朗读期间的持续回声」；
 * 这也是为什么 README 把语音打断写成「实验特性」、把按钮/Esc 写成主路径。
 */
export interface EchoGuardConfig {
  /** 角色说话时，连续超过阈值至少这么久才算用户真的开口 */
  minSustainedMs: number;
  /** 角色开口后的这段「禁声期」内不接受任何 VAD 打断 */
  rampUpMs: number;
}

export const DEFAULT_ECHO_GUARD: EchoGuardConfig = {
  minSustainedMs: 420,
  rampUpMs: 400,
};

export type SpeechGuardReject = "echo-ramp-up" | "too-short";

export interface SpeechGuardInput {
  /** 角色是否正在出声（TTS 音频在播）；false 表示守卫不介入 */
  speaking: boolean;
  /** 本次连续超阈值语音已持续多久 */
  sustainedMs: number;
  /** 角色从「没说话」变成「说话」到现在多久；未知时传 null（按「刚开口」处理） */
  sinceSpeechStartMs: number | null;
  config?: EchoGuardConfig;
}

export interface SpeechGuardDecision {
  accept: boolean;
  reject: SpeechGuardReject | null;
}

/** 守卫放行/丢弃计数：诊断区用它自证「守卫真的在跑」 */
export interface SpeechGuardStats {
  /** 角色说话中，VAD 打断被放行 */
  accepted: number;
  /** 角色说话中，VAD 打断被丢弃（回声守卫命中） */
  rejected: number;
  lastReject: SpeechGuardReject | null;
}

/** 纯函数：给定「角色是否在说话 + 说了多久 + 用户已经连续说了多久」判定放行还是丢弃 */
export function evaluateSpeechBargeIn(input: SpeechGuardInput): SpeechGuardDecision {
  if (!input.speaking) return { accept: true, reject: null };

  const config = input.config ?? DEFAULT_ECHO_GUARD;

  if (config.rampUpMs > 0) {
    const sinceStart = input.sinceSpeechStartMs;
    if (sinceStart === null || sinceStart < config.rampUpMs) {
      return { accept: false, reject: "echo-ramp-up" };
    }
  }

  if (config.minSustainedMs > 0 && input.sustainedMs < config.minSustainedMs) {
    return { accept: false, reject: "too-short" };
  }

  return { accept: true, reject: null };
}
