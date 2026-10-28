/**
 * 打断链路的**唯一入口**：把「上游信号」翻译成「一次打断」，并保证只有一个源有权这么做。
 *
 * 从 App.tsx 里抽出来的理由：这层逻辑是这次事故的现场（两个源同时挂在 `store.onUserSpeech`
 * 上），而它以前只存在于一个 React effect 的闭包里 —— 无法单测，出问题只能靠真机 trace 猜。
 * 现在它是纯类：不碰 React、不建定时器，时间由调用方注入，deepgram / energy 两条路
 * 都从这里走，`tests/web/bargeInSingleSource.test.ts` 用假 STT 直接跑它。
 *
 * 三条不变式：
 *   1. `source !== "deepgram"` 时，`onSpeechStarted/onInterim/onFinal` 一律**不进入闸门**
 *      （打一条 `gate:ignore:source-mismatch` 说明为什么不认它）。
 *   2. `source !== "energy"` 时，`onEnergySpeech()` 只打 `energy:suppressed`，
 *      **绝不**触发打断 —— 这就是「不允许两个源同时调 store.onUserSpeech」的机械保证。
 *   3. 打断动作只在 `fire()` 一处发生，时间线标记也在那里，因此
 *      `speech-started → interrupt:begin → audio:stopped` 的顺序不可被绕过。
 */

import {
  SpeechBargeInGate,
  type AecState,
  type BargeInGateSnapshot,
  type BargeInGateStats,
  type BargeInTriggerDecision,
} from "./bargeInGate";
import {
  resolveBargeInSource,
  type BargeInSource,
  type BargeInSourceDecision,
} from "./bargeInSource";
import { markTrace, publishTrace, setTraceSource } from "./bargeInTrace";

export interface BargeInWiringOptions {
  gate: SpeechBargeInGate;
  /** 单调时钟（测试注入，生产用 performance.now） */
  now(): number;
  /** 麦克风实测 AEC（每次判定现查，不等 React 渲染） */
  aec(): AecState;
  /** 角色此刻是否在出声 */
  speaking(): boolean;
  /**
   * **fire 那一刻**她是否仍在出声（arm 与 fire 之间可能已经回 idle）。
   * 不给就退回 `speaking()`；生产用同一份实时信号的严格版本，理由见 App.tsx。
   */
  speakingAtFire?(): boolean;
  /** 本轮 TTS 第一次开口的时刻（爬升期基准） */
  ttsStartedAtMs(): number | null;
  /** 当前轮次标识（诊断：arm 与 fire 是否同一轮） */
  turnId?(): string | null;
  /** 当前 epoch（诊断：arm 与 fire 之间换没换过轮） */
  epoch?(): number;
  /** 真正执行打断（`store.interrupt("speech")`）；返回值只用于时间线 */
  interrupt(via: string): { fromEpoch: number; toEpoch: number } | void;
  /** 触发源变化时回调（App 写诊断/提示用） */
  onSourceChange?(decision: BargeInSourceDecision): void;
  /** 进入闸门但被守卫丢弃时回调（AEC / 关开关的一次性提示走这里） */
  onRejected?(decision: BargeInTriggerDecision, source: string): void;
}

/** 一次判定的来源（时间线里的 `source=` 字段） */
export type BargeInSignal = "speech_started" | "interim" | "final" | "energy";

export class VoiceBargeInWiring {
  private readonly options: BargeInWiringOptions;
  private current: BargeInSourceDecision = {
    source: "none",
    reason: "disabled",
    detail: "barge-in source: none（还没开麦）",
    energyForLevelOnly: true,
  };
  private suppressedEnergy = 0;
  private sourceMismatch = 0;
  /** 上次 `update()` 的输入：fire 时按同一份输入 + **实时** AEC 重新解析源 */
  private lastInput: { bargeInEnabled: boolean; sttChannel: "deepgram" | "fake" | "webspeech" | "none" } | null =
    null;

  constructor(options: BargeInWiringOptions) {
    this.options = options;
    // ★ 把「fire 时的实时读取」直接装进闸门：arm 时记下的话说状态会过期，
    //   真正放行前必须现读。源只有 wiring 知道，而且必须是**现解析**的
    //   （AEC 实测值可能从 on 翻成 off → resolveBargeInSource 得 none），
    //   所以闭包里重新跑一次解析，而不是把 update() 时的结论拷进去。
    options.gate.setLive({
      speaking: () =>
        options.speakingAtFire ? options.speakingAtFire() : options.speaking(),
      source: () => this.liveSource(),
      turnId: options.turnId ? () => options.turnId!() : undefined,
      epoch: options.epoch ? () => options.epoch!() : undefined,
    });
  }

  /**
   * 此刻的触发源：拿上次 `update()` 的输入 + **当场**读到的 AEC 重新解析。
   * 直接返回 `this.current.source` 是「上一次解析的结论」，AEC 翻转后它就已过期。
   */
  private liveSource(): BargeInSource {
    const input = this.lastInput;
    if (!input) return this.current.source;
    return resolveBargeInSource({ ...input, aec: this.options.aec() }).source;
  }

  get source(): BargeInSource {
    return this.current.source;
  }

  get decision(): BargeInSourceDecision {
    return this.current;
  }

  /** 只有一个源有权触发打断的机械统计（诊断/测试用） */
  stats(): { suppressedEnergy: number; sourceMismatch: number; gate: BargeInGateStats } {
    return {
      suppressedEnergy: this.suppressedEnergy,
      sourceMismatch: this.sourceMismatch,
      gate: this.options.gate.stats(),
    };
  }

  /**
   * 重新解析触发源（开麦 / 换语言 / STT 回退 / AEC 实测结果变化时都要调）。
   * 返回解析结果，调用方据此决定要不要启动能量 VAD。
   */
  update(input: { bargeInEnabled: boolean; sttChannel: "deepgram" | "fake" | "webspeech" | "none" }): BargeInSourceDecision {
    this.lastInput = input;
    const next = resolveBargeInSource({
      bargeInEnabled: input.bargeInEnabled,
      sttChannel: input.sttChannel,
      aec: this.options.aec(),
    });
    const changed = next.source !== this.current.source || next.reason !== this.current.reason;
    this.current = next;
    if (changed) {
      markTrace("barge-in:source", next.detail);
      setTraceSource(next.source, next.detail);
      publishTrace();
      this.options.onSourceChange?.(next);
    }
    return next;
  }

  /** 闸门用的现场快照 */
  snapshot(): BargeInGateSnapshot {
    return {
      nowMs: this.options.now(),
      enabled: this.current.source !== "none",
      aec: this.options.aec(),
      speaking: this.options.speaking(),
      ttsStartedAtMs: this.options.ttsStartedAtMs(),
    };
  }

  /** 上游判定「有人说话了」：**不直接打断**，只进闸门待确认 */
  onSpeechStarted(): BargeInTriggerDecision | null {
    if (!this.acceptSignal("speech_started")) return null;
    const snapshot = this.snapshot();
    // 这条标记是验收项：它出现 = speech_started 真的穿过了服务端 → 客户端 → App 三跳
    markTrace(
      "speech-started",
      `aec=${snapshot.aec} speaking=${snapshot.speaking ? 1 : 0} source=deepgram`,
    );
    const decision = this.options.gate.onSpeechStarted(snapshot);
    this.afterDecision(decision, "speech-started");
    return decision;
  }

  /** 第一条 interim = 「真的在连续说话」的证据 → 这里才打断 */
  onInterim(): BargeInTriggerDecision | null {
    if (!this.acceptSignal("interim")) return null;
    const decision = this.options.gate.onInterim(this.snapshot());
    this.afterDecision(decision, "interim");
    return decision;
  }

  /** final = 有归属的用户原文：不过待确认，直接放行 */
  onFinal(): BargeInTriggerDecision | null {
    if (!this.acceptSignal("final")) return null;
    const decision = this.options.gate.onFinal(this.snapshot());
    this.afterDecision(decision, "final");
    return decision;
  }

  /**
   * 能量 VAD 报「有人开口」。**只有** source === "energy" 时才可能真的打断；
   * Deepgram 在跑时它连闸门都不进 —— 这是单一触发源的硬保证。
   */
  onEnergySpeech(): BargeInTriggerDecision | null {
    if (this.current.source !== "energy") {
      this.suppressedEnergy += 1;
      markTrace("energy:suppressed", `source=${this.current.source}`);
      return null;
    }
    const snapshot = this.snapshot();
    const decision = this.options.gate.onSpeechStarted(snapshot);
    if (decision.action === "fire" || decision.action === "ignore") {
      // 能量 VAD 自己已经做过持续时长判定（holdMs）：等同于 interim 确认，直接结算
      const confirmed =
        decision.action === "fire" ? decision : this.options.gate.onFinal(snapshot);
      this.afterDecision(confirmed, "energy");
      return confirmed;
    }
    this.afterDecision(decision, "energy");
    return decision;
  }

  /** 换轮 / 关麦时清零待确认（统计是累计值，不清） */
  reset(): void {
    this.options.gate.reset();
  }

  /** 触发源不是它 → 打一条说明，不进闸门（绝不悄悄吞掉） */
  private acceptSignal(signal: BargeInSignal): boolean {
    if (this.current.source === "deepgram") return true;
    this.sourceMismatch += 1;
    markTrace(`gate:ignore:source-mismatch`, `${signal} source=${this.current.source}`);
    return false;
  }

  private afterDecision(decision: BargeInTriggerDecision, source: string): void {
    if (decision.action === "fire") {
      // 把 fire 那一刻复验到的现场写进时间线：日后真机 trace 能直接看出
      // 「arm 时的上下文到 fire 时是否已经过期」，不必再猜。
      markTrace(`gate:fire:${decision.via}`, this.fireDetail(source));
      this.fire(decision.via);
      return;
    }
    if (decision.action === "armed") {
      markTrace("gate:armed", source);
      return;
    }
    markTrace(`gate:ignore:${decision.reject}`, source);
    this.options.onRejected?.(decision, source);
  }

  /** fire 时的诊断字段（speaking 恒为 1，能放行就说明实时复验过了） */
  private fireDetail(source: string): string {
    const ctx = this.options.gate.fireContext;
    if (!ctx) return source;
    const parts = [source, `speaking=${ctx.speaking ? 1 : 0}`, `source=${ctx.source}`];
    if (ctx.sameTurn === false) parts.push("turn=changed");
    if (ctx.sameEpoch === false) parts.push("epoch=changed");
    return parts.join(" ");
  }

  private fire(via: string): void {
    markTrace("interrupt:begin", `via=${via}`);
    const result = this.options.interrupt(via);
    if (result) markTrace("interrupt:done", `epoch ${result.fromEpoch}→${result.toEpoch}`);
    else markTrace("interrupt:done", `via=${via}`);
  }
}
