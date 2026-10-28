/**
 * 会话 store —— 把状态机、SSE、TTS、打断串起来的地方。
 *
 * 设计原则：
 *  - 状态机（session.ts）保持纯函数；这里只做「何时调用」与「调用失败怎么办」。
 *  - 依赖（api / tts）全部注入，所以 store 本身可被 bun test 直接驱动，不需要 DOM。
 *  - 所有 UI 可见的变化都经过 `emit()`；`getSnapshot()` 返回稳定引用，配合
 *    React 的 useSyncExternalStore 不会抖动。
 */

import type {
  SceneSnapshot,
  SessionEvent,
  SessionInfo,
  TurnRequest,
} from "../../shared/protocol";
import { describeDirectorFallback, parseDirectorRequest, type DirectorRequest } from "../../shared/director";
import type { HealthInfo, SessionApi } from "./api";
import { ApiError, describeApiError, isAbort } from "./api";
import type { BargeInReason, BargeInResult } from "./bargeIn";
import { performBargeIn } from "./bargeIn";
import type { SessionMachine } from "./session";
import {
  ACTION_QUEUE_LIMIT,
  createMachine,
  cueAtChar,
  enqueueAction,
  isBackgroundAction,
  isCueDue,
  needsBargeIn,
  reduceBargeIn,
  reduceEvent,
  reduceRequestFailed,
  reduceRequestSent,
  reduceUserInput,
  tickScene,
  withStatus,
} from "./session";
// 服务端的纯函数层（无 Node 依赖，见 cues.ts 文件头）。客户端只借用它的「字数尺子」，
// 保证「已播字数」与「atChar」按同一个口径数码点 —— 自己再写一份 Array.from().length
// 迟早会跟服务端差一格（尤其是在 emoji / 组合字符上）。
import { charCount } from "../../server/director/cues.ts";
import type { AudioChunkSink, AudioMode, TTSProvider } from "../voice/tts";
import { hasAudioChunkSink } from "../voice/tts";
import type { SttLang } from "../voice/stt";

// ---------------------------------------------------------------- 视图类型

export type ConnectionState = "connecting" | "online" | "offline";
export type MicState = "idle" | "requesting" | "listening" | "denied" | "unsupported";
export type BannerTone = "info" | "warn" | "error";

export interface StatusBanner {
  id: number;
  text: string;
  tone: BannerTone;
  /** 是否给「重试」入口 */
  retryable: boolean;
  /** 常驻（如断线），不自动消失 */
  sticky: boolean;
  createdAt: number;
  ttlMs: number;
}

export interface TurnLatency {
  firstEventMs: number | null;
  totalMs: number | null;
}

// ---------------------------------------------------------------- 断线自动重连（策略）

/**
 * 退避策略。
 *
 * 参数的理由（不是随手取的数）：
 *  - baseMs 1000 起步：本地服务重启（`bun run dev` 重编译）通常 1~2s 就好。
 *    更短（如 200ms）在「服务真的没起」时只是白烧请求，对首屏没帮助。
 *  - factor 2、上限 8s：1 → 2 → 4 → 8（第 4 次起封顶 8s）。
 *    上限 8s 与 `FIRST_EVENT_TIMEOUT_MS` 同量级 —— 再长就不像「自动恢复」而像「卡住了」，
 *    用户会开始自己点重试，自动重连反而成了障碍。
 *  - maxAttempts 5：5 次大约覆盖 0~23s（1+2+4+8+8 的等待 + 每次健康检查耗时），
 *    足够熬过一次开发环境重启；超过 5 次基本可以判断是服务真没起来（或端口被占），
 *    继续重试只会每 8s 烧一次请求，所以停在「可手动重试」。
 */
export interface ReconnectPolicy {
  baseMs: number;
  factor: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseMs: 1_000,
  factor: 2,
  maxDelayMs: 8_000,
  maxAttempts: 5,
};

/**
 * 第 `attempt` 次重试前要等多久（`attempt` 从 1 起）。
 * 导出成纯函数：退避序列（1/2/4/8/8）是要被单测钉住的行为，不能被藏在闭包里。
 */
export function reconnectDelay(
  attempt: number,
  policy: ReconnectPolicy = DEFAULT_RECONNECT_POLICY,
): number {
  if (attempt < 1) return 0;
  return Math.min(policy.baseMs * policy.factor ** (attempt - 1), policy.maxDelayMs);
}

/** 定时器注入点：让退避在 bun test 里能被确定性地推进，不依赖 jest 假时钟 */
export interface ReconnectTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const realReconnectTimers: ReconnectTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
};

/** 联网状态注入点：`navigator.onLine` 与 `online` 事件都不可注入，测试需要替身 */
export interface Connectivity {
  isOnline(): boolean;
  /** 监听「恢复联网」，返回取消订阅函数 */
  onOnline(listener: () => void): () => void;
}

export const browserConnectivity: Connectivity = {
  // 没有 navigator（SSR / 测试）时按「在线」处理：没有证据就不要假装断网
  isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  onOnline: (listener) => {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("online", listener);
    return () => window.removeEventListener("online", listener);
  },
};

/** 自动重连的可见状态（诊断面板 / headless 都读这一份） */
export interface ReconnectView {
  /** 正在自动重连（含正在等退避） */
  active: boolean;
  /** 已经排到第几次（1 起；0 = 还没排过） */
  attempt: number;
  maxAttempts: number;
  /** 下次尝试的倒计时（ms）；没排程时为 null */
  nextInMs: number | null;
  /** 因为 `navigator.onLine === false` 暂停了退避，等 online 事件 */
  paused: boolean;
  /** 次数用尽，已停止自动重连，只等手动重试 */
  exhausted: boolean;
  /** 自动重连成功的累计次数 */
  recovered: number;
}

export interface SessionView {
  machine: SessionMachine;
  scene: SessionMachine["scene"];
  session: SessionInfo | null;
  connection: ConnectionState;
  banner: StatusBanner | null;
  audioMode: AudioMode;
  mic: MicState;
  sttLang: SttLang;
  draft: string;
  /** 被 epoch 护栏丢掉的迟到事件数（打断链路的可见证据） */
  droppedEvents: number;
  /**
   * 被场景适配闸门丢掉的指令数：指令枚举本身合法，只是当前场景的 spec.actions
   * 里没有这个词（例如海边场景收到 hold_cup）。与 droppedEvents 分开计数 ——
   * 两者的成因和修法完全不同（一个是时序，一个是场景数据）。
   */
  droppedActions: number;
  /**
   * 排队后才触发的指令数（「说到哪、画面变到哪」的可见证据）。
   * > 0 说明水位闸门真的拦下过指令；恒为 0 时闸门等于不存在。
   */
  lateCues: number;
  /** 当前还在等水位的指令数（收尾后应回到 0） */
  queuedCues: number;
  /** 本轮已播字数水位（按 Unicode 码点，与 charCount 同一把尺子） */
  cueWatermark: number;
  /** 因「已有一轮在进行」而被丢弃的提交数（并发闸门的可见证据） */
  droppedSubmits: number;
  turns: number;
  latency: TurnLatency | null;
  busy: boolean;
  canInterrupt: boolean;
  lastUserText: string | null;
  lastBargeIn: BargeInResult | null;
  ttsName: string;
  /** 断线自动重连的当前状态（诊断显示「重连 2/5，下次 3.9s」就是读这里 / banner 文案） */
  reconnect: ReconnectView;
  /** 瞬时动作队列的可观测形态（排队语义见 session.ts 的 enqueueAction） */
  actionQueue: {
    /** 前景动作数（占队列格子的） */
    foreground: number;
    /** 背景动作数（眨眼，不占格子） */
    background: number;
    /** 前景队列上限 */
    limit: number;
    /** 因「超出上限」被丢掉的低优先级动作数（不静默） */
    droppedByPriority: number;
  };
}

export interface SessionStoreDeps {
  api: SessionApi;
  tts: TTSProvider & Partial<AudioChunkSink>;
  audioMode: AudioMode;
  /** 这个会话请求的导演档位（来自 `?director=`）；不传则从 location.search 读 */
  directorRequest?: DirectorRequest;
  clock?: () => number;
  /** 首事件超时（默认 8000ms，题目要求 8s） */
  firstEventTimeoutMs?: number;
  /** 退避策略（默认见 DEFAULT_RECONNECT_POLICY；测试里可缩小成毫秒级） */
  reconnect?: Partial<ReconnectPolicy>;
  /** 定时器替身（默认用真实 setTimeout） */
  timers?: ReconnectTimers;
  /** 联网状态替身（默认 navigator.onLine + online 事件） */
  connectivity?: Connectivity;
}

export type BannerInput = {
  text: string;
  tone?: BannerTone;
  retryable?: boolean;
  sticky?: boolean;
  ttlMs?: number;
};

const DEFAULT_BANNER_TTL_MS = 5_000;
const HISTORY_LIMIT = 12;

// ---------------------------------------------------------------- 工具

function newTurnId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `t_${Date.now().toString(36)}_${rand}`;
}

/**
 * 从 URL 读「这个会话请求哪档导演」（`?director=live`）。
 *
 * 写法对齐 ui/demo.ts 的 parseDemoFlag：search 直接来自 location.search，纯函数可测。
 * 不认得的取值一律当「没指定」（交给服务端默认档位）——手打 `?director=1`
 * 既不会静默变成 live，也不会报错。
 */
export function readDirectorRequest(search?: string): DirectorRequest {
  const raw = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return parseDirectorRequest(new URLSearchParams(raw).get("director"));
}

function snapshotScene(machine: SessionMachine): SceneSnapshot {
  return {
    scene: machine.scene.scene,
    emotion: machine.scene.emotion,
    pose: machine.scene.pose,
    playedBeats: machine.scene.lastBeat ? [machine.scene.lastBeat] : [],
  };
}

// ---------------------------------------------------------------- 诊断（模块级）

/**
 * 时序指令的模块级诊断 —— 沿用 clipBus / bargeInTrace 那套「模块级可变快照 + 只读 getter
 * + window 镜像」的既有模式，所以**不需要改 ui/Diagnostics.tsx**：
 *   · 会话内：`store.getSnapshot().lateCues / queuedCues / cueWatermark`（走既有视图通道）
 *   · 会话外 / headless：`window.__miraCueDiag`（CDP 里直接读，与 `__miraBargeInTrace` 同形）
 * 要把它变成诊断面板上的一行，只需在 Diagnostics.tsx 的 rows 里加一行 view.lateCues —— 本次不改那个文件。
 */
export interface CueDiagSnapshot {
  /** 已播字数水位 */
  watermark: number;
  /** 当前队列长度 */
  queued: number;
  /** 排队后才触发 */
  lateCues: number;
  /** 收尾时被强制放出（水位未到） */
  forcedCues: number;
  /** 被打断 / 换轮 / 过期丢弃 */
  droppedCues: number;
}

function emptyCueDiag(): CueDiagSnapshot {
  return { watermark: 0, queued: 0, lateCues: 0, forcedCues: 0, droppedCues: 0 };
}

let cueDiag: CueDiagSnapshot = emptyCueDiag();

export function getCueDiag(): CueDiagSnapshot {
  return { ...cueDiag };
}

/** 仅供测试 / 演示复位（与 resetTrace / clearClipDiagnostics 同性质） */
export function resetCueDiag(): void {
  cueDiag = emptyCueDiag();
  publishCueDiag();
}

function publishCueDiag(): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__miraCueDiag = { ...cueDiag };
}

/** 一条等水位的指令（event 原封不动留着：放出来时还要再过一遍 epoch / turnId / 场景适配） */
interface QueuedCue {
  atChar: number;
  seq: number;
  event: Extract<SessionEvent, { type: "directive" }>;
}

// ---------------------------------------------------------------- store

export class SessionStore {
  private readonly deps: SessionStoreDeps;
  private readonly clock: () => number;
  /** 建会话时送的档位（定下来就不再改：档位跟着会话走） */
  private readonly directorRequest: DirectorRequest;

  private machine: SessionMachine = createMachine();
  private session: SessionInfo | null = null;
  private sessionId: string | null = null;
  private connection: ConnectionState = "connecting";
  private banner: StatusBanner | null = null;
  private bannerSeq = 0;
  private mic: MicState = "idle";
  private sttLang: SttLang = "zh-CN";
  private draft = "";
  private droppedEvents = 0;
  /** 场景适配闸门丢掉的指令（见 SessionView.droppedActions） */
  private droppedActions = 0;
  /**
   * 本轮已播字数水位（按 Unicode 码点）。`directive.atChar <= cueWatermark` 才执行。
   * 只在被接受的 text.delta 上推进，新一轮 / 打断时归零。
   */
  private cueWatermark = 0;
  /** 锚在未来的指令，按 atChar 升序（同 atChar 保持到达顺序，见 enqueueCue） */
  private cueQueue: QueuedCue[] = [];
  /** 到达序号：同一 atChar 的多条靠它定序（稳定排序不依赖 Array.sort 的稳定性假设） */
  private cueSeq = 0;
  /** 排队后才触发的指令数 */
  private lateCues = 0;
  /** 收尾时水位还没到、被强制放出的条数（末尾 branch 不丢的证据） */
  private forcedCues = 0;
  /** 因打断 / 换轮 / 过期而丢弃的排队指令数（不应用，也不静默：计数可见） */
  private droppedCues = 0;
  private droppedSubmits = 0;
  /** 「准备期」占用标记：从 submit 入口到请求真正发出为止，同一时刻只允许一个提交 */
  private startingTurn = false;
  private turns = 0;
  private latency: TurnLatency | null = null;
  private lastUserText: string | null = null;
  private lastBargeIn: BargeInResult | null = null;
  private history: Array<{ role: "user" | "character"; text: string }> = [];
  private inflight: AbortController | null = null;
  private disposed = false;

  // ---- 断线自动重连
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly timers: ReconnectTimers;
  private readonly connectivity: Connectivity;
  /** 已经排到第几次尝试（1 起；0 = 还没排过） */
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  /** 下次尝试的时间点（用于 banner 倒计时）；没排程时 null */
  private reconnectDueAt: number | null = null;
  private reconnectActive = false;
  private reconnectPaused = false;
  private reconnectExhausted = false;
  private reconnectRecovered = 0;
  /** 当前 banner 是不是自动重连写的那条（倒计时刷新只碰自己那条） */
  private reconnectBanner = false;
  /** init 去重：自动退避与用户主动可能同时到达，同一时刻只允许建一次会话 */
  private initInFlight: Promise<void> | null = null;
  private readonly offOnline: () => void;

  // ---- 瞬时动作队列诊断
  /** 因「超出上限」被丢的低优先级动作数（见 SessionView.actionQueue） */
  private droppedActionsByPriority = 0;

  private view: SessionView;
  private readonly listeners = new Set<() => void>();

  constructor(deps: SessionStoreDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
    this.directorRequest = deps.directorRequest ?? readDirectorRequest();
    this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...deps.reconnect };
    this.timers = deps.timers ?? realReconnectTimers;
    this.connectivity = deps.connectivity ?? browserConnectivity;
    // 断网期间不排队（排队也只会失败），恢复联网后立刻试一次 —— 这就是 online 监听的全部职责
    this.offOnline = this.connectivity.onOnline(() => this.handleOnline());
    this.view = this.buildView();
  }

  // ------------------------------------------------------------ 订阅

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SessionView => this.view;

  private emit(): void {
    if (this.disposed) return;
    this.view = this.buildView();
    for (const listener of [...this.listeners]) listener();
  }

  private buildView(): SessionView {
    return {
      machine: this.machine,
      scene: this.machine.scene,
      session: this.session,
      connection: this.connection,
      banner: this.banner,
      audioMode: this.deps.audioMode,
      mic: this.mic,
      sttLang: this.sttLang,
      draft: this.draft,
      droppedEvents: this.droppedEvents,
      droppedActions: this.droppedActions,
      lateCues: this.lateCues,
      queuedCues: this.cueQueue.length,
      cueWatermark: this.cueWatermark,
      droppedSubmits: this.droppedSubmits,
      turns: this.turns,
      latency: this.latency,
      busy: this.machine.turnActive,
      canInterrupt: needsBargeIn(this.machine),
      lastUserText: this.lastUserText,
      lastBargeIn: this.lastBargeIn,
      ttsName: this.deps.tts.name,
      reconnect: this.reconnectView(),
      actionQueue: {
        foreground: this.machine.scene.pendingActions.filter((a) => !isBackgroundAction(a)).length,
        background: this.machine.scene.pendingActions.filter(isBackgroundAction).length,
        limit: ACTION_QUEUE_LIMIT,
        droppedByPriority: this.droppedActionsByPriority,
      },
    };
  }

  private reconnectView(): ReconnectView {
    return {
      active: this.reconnectActive,
      attempt: this.reconnectAttempt,
      maxAttempts: this.reconnectPolicy.maxAttempts,
      nextInMs: this.reconnectDueAt === null ? null : Math.max(0, this.reconnectDueAt - this.clock()),
      paused: this.reconnectPaused,
      exhausted: this.reconnectExhausted,
      recovered: this.reconnectRecovered,
    };
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 建会话（首次加载 / 手动重试 / 自动重连都走这里）。
   *
   * 去重的理由：退避定时器到点、用户又刚好按了发送，两条路会同时进来；
   * 并发建会话 = 两个 sessionId 互相覆盖，先建的那条流就成了孤儿（服务端还在给一个
   * 没人再认的 sessionId 干活）。
   */
  async init(): Promise<void> {
    if (this.initInFlight) return this.initInFlight;
    const run = this.runInit().finally(() => {
      this.initInFlight = null;
    });
    this.initInFlight = run;
    return run;
  }

  private async runInit(): Promise<void> {
    this.connection = "connecting";
    this.emit();

    let health: HealthInfo;
    try {
      health = await this.deps.api.health();
    } catch (err) {
      this.connection = "offline";
      this.reconnectActive = true;
      this.setBanner({
        text: `${describeApiError(err)}；服务不可用，页面仍可浏览角色，重试可恢复`,
        tone: "error",
        retryable: true,
        sticky: true,
      });
      // 失败即排退避：不排程 = 用户只能自己点「重试」，正是本次要替掉的手动路径
      this.scheduleReconnect();
      return;
    }

    if (!health.ok) {
      this.setBanner({
        text: "健康检查未通过（/api/health 返回 ok=false）",
        tone: "warn",
        retryable: true,
        ttlMs: 8_000,
      });
    }

    try {
      this.session = await this.deps.api.createSession(undefined, { director: this.directorRequest });
      this.sessionId = this.session.sessionId;
      this.connection = "online";
      // 请求了真模型却回落成 Mock 时说清楚，不许静默
      const fallback = describeDirectorFallback(this.session.fallbackReason);
      this.setBanner(
        fallback
          ? {
              text: `你请求了真模型，但已回落成 Mock 导演：${fallback}`,
              tone: "warn",
              ttlMs: 9_000,
            }
          : {
              text: this.session.keyless
                ? `已连接 · ${this.session.mode === "live" ? "真模型" : "Mock 导演"}（零密钥可跑）`
                : `已连接 · ${this.session.mode === "live" ? "真模型" : "Mock 导演"}`,
              tone: "info",
              ttlMs: 2_500,
            },
      );
      this.noteReconnectSuccess();
    } catch (err) {
      // 会话创建失败不等于不能对话：服务端可能是有状态的，用本地 sessionId 兜底
      this.sessionId = "local";
      this.connection = "online";
      // 会话创建失败但服务还可达：不算「恢复」，只把退避停掉（否则每 8s 再建一次）
      this.resetReconnectProgress();
      this.setBanner({
        text: `会话创建失败（${describeApiError(err)}），已用本地会话继续`,
        tone: "warn",
        retryable: true,
        ttlMs: 8_000,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.offOnline();
    this.inflight?.abort();
    this.inflight = null;
    this.deps.tts.cancel();
    this.listeners.clear();
  }

  // ------------------------------------------------------------ 内部：断线自动重连

  /**
   * 用户主动操作（发送 / 打断 / 手动重试）的入口：退避立刻作废，并马上试一次。
   * 返回 Promise 是为了让 submit 能等连接好了再发请求；连接本来是好的 → 返回 null。
   */
  private wakeFromBackoff(): Promise<void> | null {
    const waiting =
      this.reconnectTimer !== null ||
      this.reconnectPaused ||
      this.reconnectExhausted ||
      this.reconnectAttempt > 0;
    this.resetReconnectProgress();
    if (!waiting) return null;
    if (this.connection === "online") {
      this.emit();
      return null;
    }
    return this.reconnectNow("user");
  }

  /** 取消退避、计数归零、解除暂停 / 停止（不发起请求） */
  private resetReconnectProgress(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.reconnectActive = false;
    this.reconnectPaused = false;
    this.reconnectExhausted = false;
    this.reconnectBanner = false;
  }

  /** 连接成功：清掉重连状态；只有真的排过退避才提示「已恢复」，正常首连不打扰 */
  private noteReconnectSuccess(): void {
    const attempted = this.reconnectAttempt;
    const wasActive = this.reconnectActive;
    this.resetReconnectProgress();
    if (!wasActive && attempted === 0) return;
    this.reconnectRecovered += 1;
    this.setBanner({
      text: `连接已恢复（自动重连第 ${this.reconnectRecovered} 次成功）`,
      tone: "info",
      ttlMs: 3_000,
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectDueAt = null;
  }

  /** 排下一次退避（整个 store 里只有这一个地方挂重连定时器） */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectExhausted) return;
    this.clearReconnectTimer();

    if (!this.connectivity.isOnline()) {
      // 断网时排队没意义：到点也只会失败，还会把 1s/2s/4s 的额度白白用掉。
      // 改成暂停 + 等 online 事件，联网后从「立刻试一次」重新开始。
      this.reconnectActive = true;
      this.reconnectPaused = true;
      this.reconnectBanner = false;
      this.setBanner({
        text: "网络已断开（navigator.onLine=false）：恢复联网后会自动重连一次",
        // 断线是错误态，不是「提醒」—— 与 init 失败那条保持同一个严重度
        tone: "error",
        retryable: true,
        sticky: true,
      });
      return;
    }

    if (this.reconnectAttempt >= this.reconnectPolicy.maxAttempts) {
      // 次数用尽：停在「可手动重试」，不无限重试烧请求
      this.reconnectActive = false;
      this.reconnectPaused = false;
      this.reconnectExhausted = true;
      this.setBanner({
        text: `自动重连已停止（${this.reconnectPolicy.maxAttempts}/${this.reconnectPolicy.maxAttempts} 次仍失败）：可点「重试」立刻再试一次`,
        tone: "error",
        retryable: true,
        sticky: true,
      });
      return;
    }

    this.reconnectAttempt += 1;
    const delay = reconnectDelay(this.reconnectAttempt, this.reconnectPolicy);
    this.reconnectDueAt = this.clock() + delay;
    this.reconnectActive = true;
    this.reconnectPaused = false;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDueAt = null;
      void this.reconnectNow("timer");
    }, delay);
    this.setReconnectBanner(delay);
  }

  /** 试一次（定时器到点 / 用户主动 / 联网恢复三种触发） */
  private async reconnectNow(trigger: "timer" | "user" | "online"): Promise<void> {
    if (this.disposed) return;
    this.clearReconnectTimer();
    this.reconnectActive = true;
    this.reconnectPaused = false;
    // 手动 / 联网恢复触发的那次重新从第 1 次开始数；定时器触发接着往下数
    if (trigger !== "timer") this.reconnectAttempt = 0;
    await this.init();
  }

  private handleOnline(): void {
    if (this.disposed) return;
    // 连接本来好好的，online 事件不该凭空多建一个会话
    if (this.connection === "online" && !this.reconnectActive && !this.reconnectExhausted) return;
    // 能走到这里说明在等联网（或已经放弃）：立刻试一次，从第 1 次重新数
    this.reconnectPaused = false;
    this.reconnectExhausted = false;
    void this.reconnectNow("online");
  }

  /** 诊断文案：`重连 2/5，下次 3.9s` */
  private reconnectBannerText(remainingMs: number): string {
    return `重连 ${this.reconnectAttempt}/${this.reconnectPolicy.maxAttempts}，下次 ${(
      Math.max(0, remainingMs) / 1000
    ).toFixed(1)}s`;
  }

  private setReconnectBanner(remainingMs: number): void {
    this.setBanner({
      text: this.reconnectBannerText(remainingMs),
      // 还在重试 = 连接仍然是断的：tone 跟 init 失败那条一致（error），恢复后才换成 info
      tone: "error",
      retryable: true,
      sticky: true,
    });
    this.reconnectBanner = true;
  }

  /** 倒计时刷新：只改自己那条 banner 的文案，不新建 banner（id 不变 → UI 不重播入场动画） */
  private refreshReconnectCountdown(): boolean {
    if (!this.reconnectBanner || this.reconnectDueAt === null || !this.banner) return false;
    const text = this.reconnectBannerText(this.reconnectDueAt - this.clock());
    if (this.banner.text === text) return false;
    this.banner = { ...this.banner, text };
    return true;
  }

  // ------------------------------------------------------------ UI 输入

  setDraft(value: string): void {
    if (this.draft === value) return;
    this.draft = value;
    if (value.trim() !== "" && this.machine.scene.characterStatus === "idle") {
      this.machine = reduceUserInput(this.machine);
    }
    this.emit();
  }

  setSttLang(lang: SttLang): void {
    if (this.sttLang === lang) return;
    this.sttLang = lang;
    this.emit();
  }

  setMic(state: MicState): void {
    if (this.mic === state) return;
    this.mic = state;
    if (state === "denied" || state === "unsupported") {
      this.setBanner({
        text:
          state === "denied"
            ? "麦克风不可用：请用文字输入，或按住「按住说话」按钮手动打断"
            : "当前浏览器不支持语音识别：请用文字输入，或按住「按住说话」按钮手动打断",
        tone: "warn",
        ttlMs: 8_000,
      });
    }
    this.emit();
  }

  /** VAD / 麦克风检测到用户开口 */
  onUserSpeech(reason: BargeInReason = "speech"): void {
    if (needsBargeIn(this.machine)) {
      this.interrupt(reason);
      return;
    }
    this.machine = reduceUserInput(this.machine);
    this.emit();
  }

  // ------------------------------------------------------------ 核心动作

  /**
   * 打断。整条链路委托给 bargeIn.ts（顺序在那里被单测钉住），
   * 这里只负责把端口接上真实的 store / tts / api。
   */
  interrupt(reason: BargeInReason = "button", turnIdOverride?: string | null): BargeInResult {
    const turnId = turnIdOverride === undefined ? this.machine.turnId : turnIdOverride;
    const result = performBargeIn(
      {
        epoch: () => this.machine.epoch,
        bumpEpoch: () => {
          this.machine = reduceBargeIn(this.machine);
          return this.machine.epoch;
        },
        cancelAudio: () => this.deps.tts.cancel(),
        abortInflight: () => {
          this.inflight?.abort();
          this.inflight = null;
        },
        notifyCancel: (id, epoch) => {
          // 服务端取消是尽力而为：网络失败不能影响本地已经完成的静音与状态切换
          void this.deps.api.cancelTurn(id, epoch).catch((err: unknown) => {
            if (!isAbort(err)) console.warn("[barge-in] 服务端取消失败（不影响本地）", err);
          });
        },
        markListening: () => {
          // reduceBargeIn 已把状态切到 listening；这里保证「倾听态」是链路最后一步的可见结果
          this.machine = { ...this.machine, scene: withStatus(this.machine.scene, "listening") };
        },
        onError: (step, err) => console.warn(`[barge-in] 步骤 ${step} 失败`, err),
      },
      { reason, turnId },
    );

    // 打断后队列里剩下的是旧轮的账：不应用、不保留（画面不该为被打断的句子继续变）
    this.discardCues();
    // 打断也是「用户主动操作」：退避立刻作废，并马上试一次（不等定时器）
    void this.wakeFromBackoff();
    this.lastBargeIn = result;
    this.emit();
    return result;
  }

  /** 发送一轮输入（文字或 STT 转写）。角色正在说话时先打断。 */
  async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;

    // 并发闸门。为什么必须有：startTurn 在会话未就绪时要 await init()，
    // 这段时间 turnActive 还是 false、epoch 也没动，第二次提交会畅通无阻地
    // 发出去，两条 POST 共享同一个 epoch —— 等于同一轮跑两份，谁后到谁覆盖状态。
    // 这里把「准备期」也纳入 in-flight 判据：第二次提交**丢弃**而不是打断重发，
    // 因为连点两下是误触，不该付两次模型调用、也不该把已经排好的那轮腰斩。
    if (this.startingTurn) {
      this.droppedSubmits += 1;
      this.setBanner({
        text: "已有一轮在进行，这句话先不发送（等她说完，或按 Esc 打断）",
        tone: "warn",
        ttlMs: 2_500,
      });
      return;
    }

    this.startingTurn = true;
    try {
      this.draft = "";
      if (needsBargeIn(this.machine)) this.interrupt("input");
      this.lastUserText = text;
      // 用户主动操作：退避定时器不再有意义 —— 立刻试一次，不让人干等 8s
      await this.wakeFromBackoff();
      await this.startTurn(text);
    } finally {
      this.startingTurn = false;
    }
  }

  /** 失败后的重试入口：沿用上一句输入，重新开一轮（epoch 会再 +1，旧轮彻底作废） */
  async retry(): Promise<void> {
    if (this.startingTurn) {
      this.droppedSubmits += 1;
      return;
    }
    this.startingTurn = true;
    try {
      const text = this.lastUserText;
      this.clearBanner();
      if (needsBargeIn(this.machine)) this.interrupt("retry");
      if (this.connection !== "online" || !this.sessionId) {
        // 手动「重试」= 立刻试一次 + 计数归零（不沿用后台那条已经退到 8s 的节奏）
        this.resetReconnectProgress();
        await this.init();
      }
      if (!text) {
        this.emit();
        return;
      }
      await this.startTurn(text);
    } finally {
      this.startingTurn = false;
    }
  }

  pickBranch(id: string): void {
    const branch = this.machine.scene.branches.find((item) => item.id === id);
    if (!branch) return;
    this.machine = { ...this.machine, scene: { ...this.machine.scene, branches: [] } };
    void this.submit(branch.label);
  }

  clearBanner(): void {
    if (!this.banner) return;
    this.banner = null;
    this.reconnectBanner = false;
    this.emit();
  }

  /** 逐帧驱动（vfx 衰减 + 状态条过期）。由 App 的 rAF 调用。 */
  tick(dtMs: number): void {
    let changed = false;
    const scene = tickScene(this.machine.scene, dtMs);
    if (scene !== this.machine.scene) {
      this.machine = { ...this.machine, scene };
      changed = true;
    }
    if (
      this.banner &&
      !this.banner.sticky &&
      this.clock() - this.banner.createdAt >= this.banner.ttlMs
    ) {
      this.banner = null;
      changed = true;
    }
    // 重连倒计时（「下次 3.9s」）：tick 由 rAF 驱动，所以它能真的走字
    if (this.refreshReconnectCountdown()) changed = true;
    if (changed) this.emit();
  }

  // ------------------------------------------------------------ 内部：一轮对话

  private async startTurn(userText: string): Promise<void> {
    if (!this.sessionId) {
      await this.init();
      if (!this.sessionId) {
        this.setBanner({ text: "还没有可用的会话，请重试连接", tone: "error", retryable: true });
        return;
      }
    }

    const turnId = newTurnId();
    this.machine = reduceRequestSent(this.machine, turnId, this.clock());
    // 新一轮从零字数开始（reduceRequestSent 已把 text 清空），旧队列一并作废
    this.resetCues();
    this.emit();

    const epoch = this.machine.epoch;
    const request: TurnRequest = {
      sessionId: this.sessionId,
      turnId,
      epoch,
      userText,
      scene: snapshotScene(this.machine),
      history: this.history.slice(-HISTORY_LIMIT),
    };

    const controller = new AbortController();
    this.inflight?.abort();
    this.inflight = controller;
    // 请求已经发出去了，准备期到此结束 —— 解锁后「角色说话中插话」仍然走 barge-in
    // （epoch+1 + abort 旧流），同一时刻依然最多一个**有效** in-flight turn。
    this.startingTurn = false;

    const startedAt = this.clock();
    let firstEventAt: number | null = null;

    try {
      await this.deps.api.streamTurn(
        request,
        {
          onEvent: (event) => this.handleEvent(event),
          onFirstEvent: () => {
            if (firstEventAt === null) firstEventAt = this.clock();
          },
        },
        {
          signal: controller.signal,
          firstEventTimeoutMs: this.deps.firstEventTimeoutMs,
        },
      );

      if (epoch === this.machine.epoch) {
        this.latency = {
          firstEventMs: firstEventAt === null ? null : firstEventAt - startedAt,
          totalMs: this.clock() - startedAt,
        };
        this.connection = "online";
        this.emit();
      }
    } catch (err) {
      // 已经被打断（epoch 变了）→ 旧请求的失败与当前状态无关，静默丢弃
      if (epoch !== this.machine.epoch || isAbort(err)) {
        this.droppedEvents += 1;
        this.emit();
        return;
      }

      const message = describeApiError(err);
      this.machine = reduceRequestFailed(this.machine, message);
      this.deps.tts.cancel();

      const networkDown = err instanceof ApiError && err.kind === "network";
      if (networkDown) this.connection = "offline";

      const firstEventTimedOut = err instanceof ApiError && err.kind === "timeout" && firstEventAt === null;
      if (firstEventTimedOut) {
        this.setBanner({
          text: `${message}（可点重试，或直接重新说一句）`,
          tone: "warn",
          retryable: true,
          sticky: true,
        });
      } else if (networkDown) {
        this.setBanner({
          text: `${message}（本地服务未启动或已断开）`,
          tone: "error",
          retryable: true,
          sticky: true,
        });
      } else {
        this.setBanner({
          text: message,
          tone: "error",
          retryable: true,
          sticky: true,
        });
      }
      // SSE 中途断（或连不上）：同样进自动退避，不必等用户发现画面卡住了才点重试
      if (networkDown) this.scheduleReconnect();
      this.emit();
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }

  /**
   * 事件入口。epoch 检查放在最前面：晚到的旧事件连 reducer 都不进。
   * （reducer 里还有第二道 epoch 检查，双保险；这里提前返回是为了避免无谓的解码与朗读。）
   */
  private handleEvent(event: SessionEvent): void {
    if (event.epoch !== this.machine.epoch) {
      this.droppedEvents += 1;
      this.emit();
      return;
    }

    // 收尾 / 换轮 / 出错这三个生命周期点是队列的边界：
    //  · turn.end 正常收尾 → 把剩下的全部放掉：末尾那条 branch 不能因为「水位还没到」而丢；
    //  · turn.end 被打断、不可恢复的 error → 直接作废（用户已经开口，剩下的画面不该再演）；
    //  · turn.start → 新一轮，旧队列作废。
    if (event.type === "turn.end") {
      if (event.interrupted) this.discardCues();
      else this.flushCues({ all: true });
    } else if (event.type === "error" && !event.recoverable) {
      this.discardCues();
    } else if (event.type === "turn.start") {
      this.resetCues();
    }

    const queueBefore = this.machine.scene.pendingActions;
    const { machine, outcome } = reduceEvent(this.machine, event, this.clock(), this.cueWatermark);
    if (outcome === "queued") {
      // 锚在未来：按 atChar 入队，水位推上来之后再问一次 reduceEvent
      if (event.type === "directive") this.enqueueCue(event);
      this.syncCueDiag();
      this.emit();
      return;
    }
    if (outcome === "action-not-in-scene") {
      // 指令合法但与场景不符（场景适配层拦下的）：单独计数，不与迟到事件混在一起
      this.droppedActions += 1;
      this.emit();
      return;
    }
    if (outcome !== "applied") {
      this.droppedEvents += 1;
      this.emit();
      return;
    }
    this.machine = machine;
    this.countPriorityDrop(queueBefore, event);

    // 水位：直接从「本轮全文」重算，而不是把 event.text 的长度累加
    //  · 用字符数而不是 text.length：`🙂` 在 UTF-16 里是 2，在码点尺子上是 1，
    //    服务端的 atChar 也是按码点算的 —— 用 length 会整整差半格；
    //  · 重算而不是累加：文本一旦被重置（新一轮 / 打断），累加式水位会悄悄漂移。
    if (event.type === "text.delta") this.cueWatermark = charCount(machine.text);

    // 只有真正被接受的事件才驱动声音：迟到/串轮的音频分片连解码都不做
    if (event.type === "audio.chunk" && hasAudioChunkSink(this.deps.tts)) {
      this.deps.tts.pushChunk({ seq: event.seq, dataUrl: event.dataUrl, mime: event.mime });
    }
    if (event.type === "text.delta") {
      this.deps.tts.speak(event.text);
    }

    if (event.type === "turn.end") {
      if (event.interrupted) this.deps.tts.cancel();
      else this.deps.tts.flush();
      this.recordHistory();
      this.turns += 1;
    }

    if (event.type === "error") {
      this.setBanner({
        text: event.recoverable ? `出错了：${event.message}` : `本轮失败：${event.message}`,
        tone: event.recoverable ? "warn" : "error",
        retryable: true,
        ttlMs: 8_000,
      });
      return;
    }

    // 水位推进之后按 atChar 升序放队首（同一 atChar 保持到达顺序）
    if (event.type === "text.delta") this.flushCues({ all: false });
    this.syncCueDiag();

    this.emit();
  }

  /**
   * 队列满时被丢掉的低优先级动作 —— 计数留在 store，session.ts 保持零副作用。
   * 这里把同一个纯函数再算一次即可：入队规则只有一份，结果必然与 applyDirective 一致，
   * 不需要在纯层里塞一个回调或可变计数器。
   */
  private countPriorityDrop(
    before: SessionMachine["scene"]["pendingActions"],
    event: SessionEvent,
  ): void {
    if (event.type !== "directive" || event.directive.kind !== "action") return;
    if (enqueueAction(before, event.directive.action).dropped) this.droppedActionsByPriority += 1;
  }

  private recordHistory(): void {
    const userText = this.lastUserText;
    const reply = this.machine.text.trim();
    if (userText) this.history.push({ role: "user", text: userText });
    if (reply) this.history.push({ role: "character", text: reply });
    if (this.history.length > HISTORY_LIMIT * 2) {
      this.history = this.history.slice(-HISTORY_LIMIT);
    }
  }

  // ------------------------------------------------------------ 内部：水位闸门

  /** 新一轮 / 打断后归零：水位对齐当前全文（通常是空串），队列清空 */
  private resetCues(): void {
    this.cueQueue = [];
    this.cueWatermark = charCount(this.machine.text);
  }

  /**
   * 入队：按 atChar 升序插入，**同一 atChar 保持到达顺序**（先到的先执行，可回放）。
   * 不用 Array.prototype.sort：稳定排序是规范要求，但「同 atChar 用到达序号兜底」
   * 让它连实现差异都不依赖。
   */
  private enqueueCue(event: Extract<SessionEvent, { type: "directive" }>): void {
    const atChar = cueAtChar(event) ?? 0;
    this.cueSeq += 1;
    const item: QueuedCue = { atChar, seq: this.cueSeq, event };
    const index = this.cueQueue.findIndex((queued) => queued.atChar > atChar);
    if (index < 0) this.cueQueue.push(item);
    else this.cueQueue.splice(index, 0, item);
  }

  /**
   * 放队首。`all: true` 是收尾用的强制放行：水位可能永远到不了最后几条的 atChar
   * （台词被截断、文本没推全），但指令不能因此消失。
   */
  private flushCues(options: { all: boolean }): void {
    while (this.cueQueue.length > 0) {
      const head = this.cueQueue[0];
      if (!head) break;
      if (!options.all && !isCueDue(head.atChar, this.cueWatermark)) break;
      this.cueQueue.shift();
      this.fireCue(head, options.all);
    }
  }

  /**
   * 放出一条已排队的指令。
   *
   * 再过一遍 reduceEvent（watermark = Infinity = 不再排队），而不是直接调 applyDirective：
   * epoch / turnId / turnActive / 场景适配这四道判断必须对排队指令同样生效 ——
   * 排队期间可能已经换了一轮（epoch 变了），那种「旧账」只该被丢弃，不该落到画面上。
   */
  private fireCue(item: QueuedCue, forced: boolean): void {
    const { machine, outcome } = reduceEvent(
      this.machine,
      item.event,
      this.clock(),
      Number.POSITIVE_INFINITY,
    );
    if (outcome === "applied") {
      this.machine = machine;
      this.lateCues += 1;
      if (forced) this.forcedCues += 1;
      return;
    }
    if (outcome === "action-not-in-scene") {
      // 到了执行这一刻，场景已经不认这条指令了（场景可能被本轮更早的指令换掉）
      this.droppedActions += 1;
      return;
    }
    // stale-epoch / stale-turn：排队期间换了轮，或该轮已收尾 —— 旧账不落画面
    this.droppedCues += 1;
  }

  /** 作废队列（打断 / 换轮 / 不可恢复的失败）：不应用，只计数，不静默 */
  private discardCues(): void {
    if (this.cueQueue.length > 0) this.droppedCues += this.cueQueue.length;
    this.cueQueue = [];
    this.syncCueDiag();
  }

  private syncCueDiag(): void {
    cueDiag = {
      watermark: this.cueWatermark,
      queued: this.cueQueue.length,
      lateCues: this.lateCues,
      forcedCues: this.forcedCues,
      droppedCues: this.droppedCues,
    };
    publishCueDiag();
  }

  private setBanner(input: BannerInput): void {
    // 除 setReconnectBanner 自己以外，任何 banner 都意味着「重连那条已经被替换」
    this.reconnectBanner = false;
    this.bannerSeq += 1;
    this.banner = {
      id: this.bannerSeq,
      text: input.text,
      tone: input.tone ?? "info",
      retryable: input.retryable ?? false,
      sticky: input.sticky ?? false,
      createdAt: this.clock(),
      ttlMs: input.ttlMs ?? DEFAULT_BANNER_TTL_MS,
    };
    this.emit();
  }
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  return new SessionStore(deps);
}
