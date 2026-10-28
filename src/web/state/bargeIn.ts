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
