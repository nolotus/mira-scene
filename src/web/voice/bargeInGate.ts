/**
 * 「用户一开口就打断角色」的触发闸门（纯状态机，不碰 DOM、不建定时器）。
 *
 * 为什么不再用能量 VAD 当触发源：能量阈值分不清「用户说话」和「外放的 TTS 回声」，
 * 所以旧实现只能默认关掉。现在改用 Deepgram 的 `speech_started`（服务端 VAD 判的
 * 语音起点）作为触发源 —— 它至少是「上游自己判定的语音」，不是我们自己拍的阈值。
 *
 * 但 `speech_started` 依旧会被回声点亮（AEC 收敛不够快时角色自己的声音也是「语音」），
 * 所以这里叠了三道守卫，每道挡一类具体的误触发：
 *
 *   ① 爬升期禁声（`rampUpMs` = 250ms）
 *        TTS 刚开始出声的那 250ms，麦克风收到的是「从零陡升到满响度」的外放声音，
 *        这是 AEC 最难收敛、能量最像人开口的时段 → 一律忽略。
 *   ② 打断后不应期（`debounceMs` = 400ms）
 *        一次打断会让 TTS 停、播放队列清空、状态切 listening，这段时间里
 *        上游可能连发 `speech_started`（同一段语音被切分）→ 只认第一次，防抖。
 *   ③ 短促噪声过滤（`confirmMs` = 200ms + interim 确认）
 *        咳嗽、键盘、椅子响都会给一个 `speech_started`，但它们 <200ms 就结束，
 *        上游不会为它产出 interim。所以 `speech_started` **本身不触发打断**：
 *        它只把「待确认」写进状态，真正的触发点是 200ms 内到达的第一条 interim。
 *        拿不到语音时长的情况下，这是最便宜的时长替代判据。
 *
 * 第四道是前置条件而不是守卫：**AEC 实测不可用**（`getSettings().echoCancellation === false`）
 * 时不自动打断 —— 没有回声消除就没有任何依据区分用户与回声，宁可退回手动打断。
 *
 * 按钮 / Esc / 打字打断**不经过这里**：人工意图永远要灵，见 state/bargeIn.ts 的
 * speechReasonIsGuarded()。
 */

/** AEC 实测状态（`getSettings()` 的三个可能结果，unknown = 浏览器不报这个字段） */
export type AecState = "on" | "off" | "unknown";

export interface BargeInGateConfig {
  /** ① TTS 刚开口的禁声期（回声爬升 + AEC 收敛窗口） */
  rampUpMs: number;
  /** ② 打断之后的不应期 */
  debounceMs: number;
  /** ③ speech_started 之后等 interim 确认的窗口 */
  confirmMs: number;
  /**
   * ③b 迟到的 interim 仍算确认的宽限。
   * 为什么需要它：上游 interim 的延迟不固定（实测 200–600ms 都有）。
   * 只认 `confirmMs` 会让「真的在说话、但 interim 慢」的整句丢掉打断，
   * 而用户对「我说话了它没停」的容忍度远低于「多打断一次」。
   * 放行的会单独计数（`via: "interim-late"`），诊断区能看出它被用了几次。
   */
  lateConfirmMs: number;
  /** AEC 读不到（浏览器不报 getSettings().echoCancellation）时是否仍然自动打断 */
  allowWhenAecUnknown: boolean;
}

export const DEFAULT_BARGE_IN_GATE: BargeInGateConfig = {
  rampUpMs: 250,
  debounceMs: 400,
  confirmMs: 200,
  lateConfirmMs: 600,
  /**
   * 闸门层的默认值保持 true（历史契约，纯状态机单测依赖它）；
   * **生产里不用这个默认值**：`bargeInSource.resolveBargeInSource` 已经把
   * `aec !== "on"` 挡在闸门之前（source = none），并且 App 侧显式传
   * `allowWhenAecUnknown: false`（见 PRODUCTION_BARGE_IN_GATE）。
   * 两道一起保证「不知道有没有回声消除 → 不自动打断」。
   */
  allowWhenAecUnknown: true,
};

/**
 * 生产用的闸门配置：AEC 读不到（`unknown`）时也不自动打断。
 * 与 `resolveBargeInSource` 的 AEC 门槛重复，是刻意的 —— 触发源解析被绕过时闸门仍是第二道锁。
 */
export const PRODUCTION_BARGE_IN_GATE: BargeInGateConfig = {
  ...DEFAULT_BARGE_IN_GATE,
  allowWhenAecUnknown: false,
};

export type BargeInTriggerReject =
  /** `?bargeIn=off`：全关 */
  | "disabled"
  /** AEC 实测不可用（或读不到且不允许兜底） */
  | "aec-unavailable"
  /** 角色没在说话：speech_started 只是「开始识别」，不是打断 */
  | "not-speaking"
  /** ① 爬升期 */
  | "echo-ramp-up"
  /** ② 打断后不应期 */
  | "debounce"
  /** ③ speech_started 之后没有任何 interim（短促噪声） */
  | "unconfirmed"
  /** 没有任何待确认的 speech_started（interim 先到 / 已结算完） */
  | "not-armed"
  /**
   * ①arm 时她在说话，fire 时已经停了。
   * 真机反例：3226ms status:idle → 3492ms speech_started（arm）→ 3692ms interim 打断了新请求。
   * arm 时的「在说话」是**那一刻**成立的事实，200ms 后的 interim 必须重新问一遍。
   */
  | "not-speaking-at-fire"
  /**
   * ②arm 时源是 deepgram，fire 时变了（AEC 实测翻转 → source 变 none/energy）。
   * 源一变就没有「谁有权打断」了，不能再拿 arm 时的结论放行。
   */
  | "source-changed-at-fire";

/**
 * fire 时的**实时**读取：闸门在 arm 时只记下「是什么源、谁在说话」，
 * 真正放行前必须再问一遍这些 getter（不是复用 arm 时的快照）。
 *
 * 为什么是 getter 而不是传给构造函数的快照值：快照只能描述注入那一瞬；
 * 这里要的是「fire 那一刻的事实」，只能每次调用现读。
 */
export interface BargeInGateLive {
  /** 角色此刻是否仍在出声 */
  speaking(): boolean;
  /** 当前触发源；中途 AEC 状态变化会把它变成 "none" */
  source?(): string;
  /** 当前轮次标识（诊断：arm 与 fire 是否同一轮） */
  turnId?(): string | null;
  /** 当前 epoch（诊断：arm 与 fire 之间有没有换过轮） */
  epoch?(): number;
}

/** 触发/判定时的一次现场快照（时间由调用方注入，测试才能控制时间轴） */
export interface BargeInGateSnapshot {
  nowMs: number;
  /** `?bargeIn=off` → false */
  enabled: boolean;
  /** 麦克风轨道实际生效的 AEC 状态 */
  aec: AecState;
  /** 角色是否正在出声（characterStatus === "speaking" 或 TTS 正在播） */
  speaking: boolean;
  /** 本轮 TTS 第一次开口的时刻；null = 这一轮还没出声 */
  ttsStartedAtMs: number | null;
}

export type BargeInTriggerDecision =
  | { action: "fire"; via: "interim" | "interim-late" | "final"; atMs: number }
  | { action: "armed"; atMs: number; deadlineMs: number }
  | { action: "ignore"; reject: BargeInTriggerReject; atMs: number };

export interface BargeInGateStats {  /** 真正执行了打断的次数 */
  fired: number;
  /** 由 interim 确认触发 / 迟到 interim 兜底 / final 兜底 */
  viaInterim: number;
  viaInterimLate: number;
  viaFinal: number;
  /** 被守卫丢弃的次数 */
  rejected: number;
  /** 最近一次丢弃原因 */
  lastReject: BargeInTriggerReject | null;
  lastFireAtMs: number | null;
}

function emptyStats(): BargeInGateStats {
  return {
    fired: 0,
    viaInterim: 0,
    viaInterimLate: 0,
    viaFinal: 0,
    rejected: 0,
    lastReject: null,
    lastFireAtMs: null,
  };
}

/** fire 那一刻复验到的现场（诊断用：arm 与 fire 之间上下文有没有过期） */
export interface BargeInFireContext {
  speaking: boolean;
  source: string;
  /** null = 调用方没提供 turnId()，无从比较 */
  sameTurn: boolean | null;
  /** null = 调用方没提供 epoch()，无从比较 */
  sameEpoch: boolean | null;
}

export class SpeechBargeInGate {
  readonly config: BargeInGateConfig;
  /** speech_started 到达但还没被 interim 确认的时刻 */
  private pendingSinceMs: number | null = null;
  /** arm 那一刻的触发源（fire 时要跟实时源比对，变了就不许放行） */
  private armedSource: string | null = null;
  private armedTurnId: string | null = null;
  private armedEpoch: number | null = null;
  private lastFireContext: BargeInFireContext | null = null;
  /**
   * fire 时的实时读取。没注入时退回快照字段（纯状态机单测的老契约不变），
   * 生产由 bargeInWiring 在构造时注入（它知道「现在」的源与说话状态）。
   */
  private live: BargeInGateLive | null = null;
  private statsValue: BargeInGateStats = emptyStats();

  constructor(config: Partial<BargeInGateConfig> = {}) {
    this.config = { ...DEFAULT_BARGE_IN_GATE, ...config };
  }

  /** 注入 fire 时的实时读取（必须在第一次 arm 前设置；之后可随时替换） */
  setLive(live: BargeInGateLive | null): void {
    this.live = live;
  }

  /** 换一轮 / 换语言 / 关麦时清零（不影响统计，统计是给诊断看的累计值） */
  reset(): void {
    this.pendingSinceMs = null;
    this.armedSource = null;
    this.armedTurnId = null;
    this.armedEpoch = null;
    this.lastFireContext = null;
  }

  get armed(): boolean {
    return this.pendingSinceMs !== null;
  }

  /** 待确认的起点（诊断/测试用） */
  get pendingSince(): number | null {
    return this.pendingSinceMs;
  }

  stats(): BargeInGateStats {
    return { ...this.statsValue };
  }

  /** 通用守卫：返回 null = 放行，否则是丢弃原因 */
  guard(snapshot: BargeInGateSnapshot): BargeInTriggerReject | null {
    if (!snapshot.enabled) return "disabled";

    const { aec } = snapshot;
    if (aec === "off") return "aec-unavailable";
    if (aec === "unknown" && !this.config.allowWhenAecUnknown) return "aec-unavailable";

    // 角色没出声：这只是「开始识别」，用户正常说话不需要打断任何东西
    if (!snapshot.speaking) return "not-speaking";

    // ① 爬升期：现在离 TTS 开口不到 rampUpMs
    const started = snapshot.ttsStartedAtMs;
    if (this.config.rampUpMs > 0 && started !== null) {
      const sinceStart = snapshot.nowMs - started;
      // sinceStart < 0 说明时钟不一致，按「刚开口」处理（保守）
      if (sinceStart < this.config.rampUpMs) return "echo-ramp-up";
    }

    // ② 打断后不应期
    const last = this.statsValue.lastFireAtMs;
    if (this.config.debounceMs > 0 && last !== null) {
      if (snapshot.nowMs - last < this.config.debounceMs) return "debounce";
    }

    return null;
  }

  /** 上游判定「有人说话了」。注意：**这里不触发打断**，只进入待确认。 */
  onSpeechStarted(snapshot: BargeInGateSnapshot): BargeInTriggerDecision {
    const reject = this.guard(snapshot);
    if (reject) return this.reject(reject, snapshot.nowMs);

    if (this.pendingSinceMs !== null) {
      // 同一段语音被上游切成多段：保持最初的起点，不重置窗口
      return {
        action: "armed",
        atMs: this.pendingSinceMs,
        deadlineMs: this.pendingSinceMs + this.config.confirmMs,
      };
    }

    this.pendingSinceMs = snapshot.nowMs;
    // arm 时的源只是「记录」，不是结论：fire 时会再问一次 live.source()
    this.armedSource = this.readSource(snapshot);
    this.armedTurnId = this.live?.turnId?.() ?? null;
    this.armedEpoch = this.live?.epoch?.() ?? null;
    return {
      action: "armed",
      atMs: snapshot.nowMs,
      deadlineMs: snapshot.nowMs + this.config.confirmMs,
    };
  }

  /**
   * fire 前的实时复验：arm 时成立的「她在说话 / 源是 deepgram」在 fire 那一刻未必成立。
   * 真机反例就是这里缺一道：arm 记下 speaking=1，200ms 后 interim 到达时她已经回 idle，
   * 闸门照旧放行 → 无效打断（epoch+1、发一次 cancel、可能打断新请求）。
   *
   * 数据来源：注入的 getter（`setLive`）**每次现读**；没有注入时才退回快照字段。
   */
  private verifyAtFire(snapshot: BargeInGateSnapshot): BargeInTriggerReject | null {
    const speakingNow = this.live ? this.live.speaking() : snapshot.speaking;
    if (!speakingNow) return "not-speaking-at-fire";

    const sourceNow = this.readSource(snapshot);
    const armed = this.armedSource;
    // 源变了（含 deepgram → none / energy）或当前已经无源：arm 的依据作废
    if (sourceNow === "none") return "source-changed-at-fire";
    if (armed !== null && armed !== sourceNow) return "source-changed-at-fire";

    // 换轮/换 epoch 不算「不许打断」，但记进诊断（真机 trace 里能看出 arm 的上下文是否已经过期）
    this.lastFireContext = {
      speaking: true,
      source: sourceNow,
      sameTurn: this.sameTurnAsArm(),
      sameEpoch: this.sameEpochAsArm(),
    };
    return null;
  }

  /** arm 时的源：注入了 live 就用它的现读值，否则按快照的 enabled 归一成 on/none */
  private readSource(snapshot: BargeInGateSnapshot): string {
    if (this.live?.source) return this.live.source();
    return snapshot.enabled ? "on" : "none";
  }

  /** fire 那一刻的现场（诊断用；不影响放行判定） */
  get fireContext(): BargeInFireContext | null {
    return this.lastFireContext;
  }

  private sameTurnAsArm(): boolean | null {
    if (!this.live?.turnId) return null;
    const now = this.live.turnId();
    const armed = this.armedTurnId;
    return armed === null ? true : now === armed;
  }

  private sameEpochAsArm(): boolean | null {
    if (!this.live?.epoch) return null;
    const now = this.live.epoch();
    const armed = this.armedEpoch;
    return armed === null ? true : now === armed;
  }

  /** 收到 interim：这才是「真的有人连续说话」的证据 → 触发打断 */
  onInterim(snapshot: BargeInGateSnapshot): BargeInTriggerDecision {
    const reject = this.guard(snapshot);
    if (reject) {
      // 状态已经变了（角色停下了 / 开关关了）：待确认作废
      this.pendingSinceMs = null;
      return this.reject(reject, snapshot.nowMs);
    }

    if (this.pendingSinceMs === null) return this.reject("not-armed", snapshot.nowMs);

    // ★ fire 前的实时复验：speaking / source 必须「此刻」仍成立（不能用 arm 时的快照）
    const stale = this.verifyAtFire(snapshot);
    if (stale) {
      this.pendingSinceMs = null;
      this.armedSource = null;
      return this.reject(stale, snapshot.nowMs);
    }

    const since = snapshot.nowMs - this.pendingSinceMs;
    const late = this.config.confirmMs + this.config.lateConfirmMs;
    if (since > late) {
      this.pendingSinceMs = null;
      return this.reject("unconfirmed", snapshot.nowMs);
    }

    this.pendingSinceMs = null;
    this.armedSource = null;
    return this.fire(since <= this.config.confirmMs ? "interim" : "interim-late", snapshot.nowMs);
  }

  /**
   * 收到 final：这已经是「用户说了什么」的原文，属于**有归属的**证据，直接放行。
   * 仍然记一次统计，方便诊断区分「interim 抢先打断」和「等到 final 才打断」。
   */
  onFinal(snapshot: BargeInGateSnapshot): BargeInTriggerDecision {
    const reject = this.guard(snapshot);
    if (reject) return this.reject(reject, snapshot.nowMs);
    // final 同样要复验：它能凭借「有归属的原文」绕过待确认，但不能绕过「此刻还在说话」
    const stale = this.verifyAtFire(snapshot);
    if (stale) {
      this.pendingSinceMs = null;
      this.armedSource = null;
      return this.reject(stale, snapshot.nowMs);
    }
    this.pendingSinceMs = null;
    this.armedSource = null;
    return this.fire("final", snapshot.nowMs);
  }

  /**
   * 结算过期的待确认（可选：调用方按需定期调，用于把「短促噪声」写进状态/诊断）。
   * 不调用也不会漏判 —— onInterim 自己会算超时。
   */
  tick(nowMs: number): BargeInTriggerDecision | null {
    const since = this.pendingSinceMs;
    if (since === null) return null;
    const late = this.config.confirmMs + this.config.lateConfirmMs;
    if (nowMs - since <= late) return null;
    this.pendingSinceMs = null;
    return this.reject("unconfirmed", nowMs);
  }

  private fire(
    via: "interim" | "interim-late" | "final",
    atMs: number,
  ): BargeInTriggerDecision {
    const stats = this.statsValue;
    stats.fired += 1;
    stats.lastFireAtMs = atMs;
    if (via === "interim") stats.viaInterim += 1;
    else if (via === "interim-late") stats.viaInterimLate += 1;
    else stats.viaFinal += 1;
    return { action: "fire", via, atMs };
  }

  private reject(reject: BargeInTriggerReject, atMs: number): BargeInTriggerDecision {
    this.statsValue.rejected += 1;
    this.statsValue.lastReject = reject;
    return { action: "ignore", reject, atMs };
  }
}
