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
  createMachine,
  needsBargeIn,
  reduceBargeIn,
  reduceEvent,
  reduceRequestFailed,
  reduceRequestSent,
  reduceUserInput,
  tickScene,
  withStatus,
} from "./session";
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
  /** 因「已有一轮在进行」而被丢弃的提交数（并发闸门的可见证据） */
  droppedSubmits: number;
  turns: number;
  latency: TurnLatency | null;
  busy: boolean;
  canInterrupt: boolean;
  lastUserText: string | null;
  lastBargeIn: BargeInResult | null;
  ttsName: string;
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

  private view: SessionView;
  private readonly listeners = new Set<() => void>();

  constructor(deps: SessionStoreDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
    this.directorRequest = deps.directorRequest ?? readDirectorRequest();
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
      droppedSubmits: this.droppedSubmits,
      turns: this.turns,
      latency: this.latency,
      busy: this.machine.turnActive,
      canInterrupt: needsBargeIn(this.machine),
      lastUserText: this.lastUserText,
      lastBargeIn: this.lastBargeIn,
      ttsName: this.deps.tts.name,
    };
  }

  // ------------------------------------------------------------ 生命周期

  async init(): Promise<void> {
    this.connection = "connecting";
    this.emit();

    let health: HealthInfo;
    try {
      health = await this.deps.api.health();
    } catch (err) {
      this.connection = "offline";
      this.setBanner({
        text: `${describeApiError(err)}；服务不可用，页面仍可浏览角色，重试可恢复`,
        tone: "error",
        retryable: true,
        sticky: true,
      });
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
    } catch (err) {
      // 会话创建失败不等于不能对话：服务端可能是有状态的，用本地 sessionId 兜底
      this.sessionId = "local";
      this.connection = "online";
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
    this.inflight?.abort();
    this.inflight = null;
    this.deps.tts.cancel();
    this.listeners.clear();
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

    const { machine, outcome } = reduceEvent(this.machine, event, this.clock());
    if (outcome !== "applied") {
      this.droppedEvents += 1;
      this.emit();
      return;
    }
    this.machine = machine;

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

    this.emit();
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

  private setBanner(input: BannerInput): void {
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
