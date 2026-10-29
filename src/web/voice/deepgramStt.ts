/**
 * 语音输入（STT）—— Deepgram，经服务端 WS 代理。
 *
 * 为什么不是 Web Speech：Web Speech 在 Chrome 上依赖浏览器自家的识别服务（无网即废，
 * 且不同内核行为不一）；Deepgram 的中文 nova-2 是实测可用的（见下），并且能给出
 * `SpeechStarted` —— 这正是下一步「真实打断」需要的信号（能量 VAD 靠音量，会被音乐/噪声骗）。
 *
 * 实测链路（浏览器侧，已跑过真音频）：
 *   getUserMedia → MediaRecorder('audio/webm;codecs=opus', 100ms 切片) → WS /api/stt
 *   → 服务端按容器模式（不声明 encoding）转给 Deepgram → speech_started / interim×N / final。
 *   注意**不要**改成声明 linear16：webm 字节按 PCM 解释出来是错的。
 *
 * 预热：建连实测约 1 秒。用户开口才连 = 第一句必然丢半句，所以 `prewarm()` 在
 * 麦克风一开就建连并取流待命；`start()` 只负责 recorder.start()。
 *
 * 两种「停止」，语义不同，别混（真机踩过：混了就会吞掉最后一条 final）：
 *   · `stop()` = **这句说完了，还要说下一句**：停录音 → 等最后一个数据块到达 →
 *     发 `{"type":"finish_utterance"}` → 服务端冲尾段 final（≤1500ms）后为下一句补建上游。
 *     浏览器 WS 与麦克风全程保留。
 *   · `abort()` = **彻底断开**（页面卸载 / 切语言 / 回退到别的通道）：关 WS，服务端
 *     收到 close 后同样先 flush 尾段再收摊，但不会留着给下一句用。
 *
 * 回退链（每一跳都写进 diagnostics，界面可见，绝不静默）：
 *   status.stt=false / WS 失败 / 无 MediaRecorder → Web Speech → 都没有 → 纯文字（supported=false）。
 *
 * 本轮只**暴露** speech_started / final 给上层（onSpeechStarted / onSpeechFinal），
 * 不改 bargeIn 逻辑 —— 拿它替换能量 VAD 是下一步的事。
 */

import {
  createStt,
  isSpeechRecognitionSupported,
  type SttController,
  type SttErrorCode,
  type SttLang,
  type SttOptions,
} from "./stt.ts";
import type { AecState } from "./bargeInGate.ts";
import { markTrace } from "./bargeInTrace.ts";
import {
  aecStateOf,
  bargeInAudioConstraints,
  readAppliedMicSettings,
  reportAppliedMicSettings,
  type AppliedMicSettings,
} from "./micConstraints.ts";

/** MediaRecorder 的切片间隔：100ms 是实测的粒度（越小越碎、越大延迟越高） */
export const CHUNK_MS = 100;
export const RECORDER_MIME = "audio/webm;codecs=opus";

/**
 * 「这句说完了」的控制消息：告诉服务端把这条上游的尾段 final 冲出来，**浏览器 WS 不动**。
 * 服务端收到后会向 Deepgram 发 `{"type":"CloseStream"}` 并等 final（≤1500ms），
 * 然后为下一句补建新上游。详见 src/server/stt.ts「控制消息」段。
 */
export const FINISH_UTTERANCE = JSON.stringify({ type: "finish_utterance" });

/**
 * 静音自动收尾：转写**不再增长**多久后，主动替用户说「这句完了」。
 *
 * 为什么要有它：麦克风是开关式的，用户说完话不点「关闭麦克风」就永远不触发收尾，
 * 体感就是「我说完了她半天不理我」。这里只看 interim 是否还在长，不猜音量——
 * 语音能量判静音在有背景音的场景里不可靠，而「转写停住了」几乎是用户停嘴的强信号。
 *
 * 900ms 的取值：句内自然停顿实测多在 300~700ms，700ms 会把长句腰斩；
 * 900ms 仍比人手动点一下更早，且不会切碎正常长句。
 */
export const AUTO_FINISH_QUIET_MS = 900;

/** 预建连队列上限：1.5s。超出丢最旧帧并计入 `prerollDropped`（见 diagnostics） */
export const PRE_ROLL_MAX_CHUNKS = Math.ceil(1500 / CHUNK_MS);

export type SttChannelOf = "deepgram" | "webspeech" | "none";

export interface DeepgramSttDiagnostics {
  channel: SttChannelOf;
  /** 回退原因（diagnostics 区可见）；null = 没回退过 */
  reason: string | null;
  /** 预热状态：connecting 期间上层可以显示「语音通道连接中」 */
  prewarm: "idle" | "connecting" | "ready" | "failed";
  /**
   * 麦克风轨道**实际生效**的回声消除状态（`track.getSettings().echoCancellation`）。
   * 为什么单独一个字段：`getUserMedia` 的约束只是「请求」，浏览器可以静默忽略；
   * 自动打断的唯一硬前提就是它 —— 拿不到 true 就不能把麦克风里的声音当成用户。
   * 还没开始采集时是 `unknown`。
   */
  aec: AecState;
  /** 实际生效的采集设置（诊断区/报告用；null = 还没取流） */
  micSettings: AppliedMicSettings | null;
  /**
   * 握手窗口里攒下、并在 WS 就绪后**补发**的音频帧数。
   * 为什么必须有这个计数：`prewarm()` 建连实测约 1s，用户很可能在指纹里就开口了。
   * 旧实现把这段音频直接丢掉 → Deepgram 手里没有那段声音 → `speech_started` 永远不来，
   * 而 trace 上看起来只是「上游没发」，根本查不到是本地丢的（真机踩过一次）。
   */
  prerollFlushed: number;
  /** 预建连队列溢出被丢的最旧帧数（上限 ≈1.5s；>0 说明用户开口太早，需要说「再说一次」） */
  prerollDropped: number;
  /**
   * 服务端上报的「上游会不会发 `speech_started`」。
   *
   * 默认 true（Deepgram 会发）。阿里百炼 fun-asr 是整段识别，**不发**它 → 服务端
   * 在 WS 建连后的第一条消息里上报 `false`，客户端据此把自动打断切到 energy VAD。
   * 服务端**绝不伪造** speech_started（伪造比没有更糟：会在错误时机打断）。
   */
  supportsSpeechStarted: boolean;
  /** 服务端上报的 provider（`ali` / `deepgram`；null = 还没收到能力消息） */
  provider: string | null;
}

// ---------------------------------------------------------------- 浏览器最小接口

export interface VoiceSocketLike {
  send(data: string | Blob | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
}

export interface MediaStreamLike {
  getTracks(): Array<{ stop(): void }>;
  /** 读实际生效的采集设置（AEC 实测）用；测试替身可以不给 */
  getAudioTracks?(): Array<{ getSettings?(): unknown }>;
}

export interface RecorderLike {
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob | null }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  /**
   * 可选：真 MediaRecorder 的 `stop` 事件。**最后一块音频是在 stop() 之后异步到达的**
   * （dataavailable → stop），所以「这句说完了」必须等这个事件再发，否则服务端会把
   * CloseStream 提前发给上游，最后那块音频反被当成下一句排队，句尾必丢。
   */
  onstop?: (() => void) | null;
}

/** 测试注入点：全部可替换，默认走真实浏览器 API */
export interface DeepgramSttDeps {
  openSocket?(url: string): VoiceSocketLike;
  getMic?(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  createRecorder?(stream: MediaStreamLike): RecorderLike;
  createFallback?(options: SttOptions): SttController;
  sttUrl?(lang: SttLang): string;
}

export interface DeepgramSttOptions extends SttOptions {
  /** `/api/voice/status` 说 stt 是否可用；函数形式 = 状态可能在创建之后才到 */
  available?(): boolean;
  deps?: DeepgramSttDeps;
  /** 上游判定「用户开口了」——真实打断的触发点（本轮只暴露） */
  onSpeechStarted?(): void;
  /** 一句说完（final）——可以在这时提交，而不是等 Web Speech 的 result 事件 */
  onSpeechFinal?(text: string): void;
  onUtteranceEnd?(): void;
  onDiagnostic?(diagnostics: DeepgramSttDiagnostics): void;
  log?(line: string): void;
}

export interface DeepgramSttController extends SttController {
  readonly channel: SttChannelOf;
  readonly diagnostics: DeepgramSttDiagnostics;
  /** 麦克风开启时立刻调：建 WS（~1s 握手）+ 取流 + 备好 recorder，不等第一句 */
  prewarm(): void;
}

function defaultSttUrl(lang: SttLang): string {
  if (typeof location === "undefined") return `/api/stt?lang=${lang}`;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/api/stt?lang=${lang}`;
}

export function hasMicCapture(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

export function createDeepgramStt(options: DeepgramSttOptions = {}): DeepgramSttController {
  const deps = options.deps ?? {};
  const log = options.log ?? (() => {});
  const openSocket =
    deps.openSocket ??
    ((url: string) => new WebSocket(url) as unknown as VoiceSocketLike);
  const getMic =
    deps.getMic ??
    ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
  const makeRecorder =
    deps.createRecorder ??
    ((stream: MediaStreamLike) =>
      new MediaRecorder(stream as unknown as MediaStream, { mimeType: RECORDER_MIME }) as unknown as RecorderLike);
  const makeFallback = deps.createFallback ?? ((opts: SttOptions) => createStt(opts));
  const sttUrl = deps.sttUrl ?? defaultSttUrl;

  let lang: SttLang = options.lang ?? "zh-CN";
  let disposed = false;
  let listening = false;
  let wantListening = false;
  let socket: VoiceSocketLike | null = null;
  let socketReady = false;
  let stream: MediaStreamLike | null = null;
  let recorder: RecorderLike | null = null;
  let fallback: SttController | null = null;
  /** stop() 之后还欠一条「这句说完了」：等 recorder 的最后一个数据块送达再发 */
  let finishPending = false;
  /** 静音自动收尾计时器（见 AUTO_FINISH_QUIET_MS）；null = 没在等 */
  let autoFinishTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一次 interim 的原文：用来判断「转写还在长吗」 */
  let lastInterimText = "";
  /** recorder 是否**原生**带 stop 事件（必须在挂回调之前判断，否则自己的赋值会把它变成 true） */
  let recorderHasStopEvent = false;
  /**
   * 握手窗口的音频预滚队列（≈1.5s = 15 个 100ms 帧）。
   * 上限存在的理由：宁可丢最旧的帧（并在 `prerollDropped` 里计数），也不让内存无限涨；
   * 15 帧覆盖建连实测的 ~1s，再多就不是「握手慢」而是网络出问题了。
   */
  const preRoll: Array<string | Blob | ArrayBufferLike | ArrayBufferView> = [];
  let preRollFlushed = 0;
  let preRollDropped = 0;

  /** 告诉服务端「这句说完了」：冲 final，但**不关 WS**（连接还要给下一句用） */
  function sendFinishUtterance(): void {
    finishPending = false;
    if (!socket || !socketReady) return;
    try {
      socket.send(FINISH_UTTERANCE);
    } catch {
      switchToFallback("ws-send-failed");
    }
  }

  const webSpeechUsable = (): boolean => {
    if (deps.createFallback) return true;
    return isSpeechRecognitionSupported();
  };

  const deepgramUsable = (): boolean => {
    if (options.available && !options.available()) return false;
    const canSocket = deps.openSocket !== undefined || typeof WebSocket !== "undefined";
    const canMic = deps.getMic !== undefined || hasMicCapture();
    const canRecord = deps.createRecorder !== undefined || typeof MediaRecorder !== "undefined";
    return canSocket && canMic && canRecord;
  };

  let diagnostics: DeepgramSttDiagnostics = {
    channel: "none",
    reason: null,
    prewarm: "idle",
    aec: "unknown",
    micSettings: null,
    prerollFlushed: 0,
    prerollDropped: 0,
    // 能力默认「有 speech_started」：服务端的能力消息到了才会改（阿里是 false）
    supportsSpeechStarted: true,
    provider: null,
  };

  // 初始通道：Deepgram 能用就用它；否则**真的试一次** Web Speech（supported=false 的兜底
  // 不能算「有通道」，否则界面会显示 WebSpeech 而实际一句也转不出来）
  diagnostics = {
    ...diagnostics,
    channel: deepgramUsable() ? "deepgram" : ensureFallback() ? "webspeech" : "none",
  };

  function setDiag(patch: Partial<DeepgramSttDiagnostics>): void {
    diagnostics = { ...diagnostics, ...patch };
    options.onDiagnostic?.(diagnostics);
  }

  function ensureFallback(): SttController | null {
    if (fallback) return fallback;
    if (!webSpeechUsable()) return null;
    try {
      const created = makeFallback({
        lang,
        continuous: options.continuous ?? true,
        interim: options.interim ?? true,
        onTranscript: options.onTranscript,
        onError: options.onError,
        onStateChange: (value) => {
          listening = value;
          options.onStateChange?.(value);
        },
      });
      fallback = created.supported ? created : null;
      return fallback;
    } catch {
      fallback = null;
      return null;
    }
  }

  function stopRecorder(): void {
    const current = recorder;
    recorder = null;
    if (!current) return;
    try {
      current.stop();
    } catch {
      /* 已经停了 */
    }
  }

  function closeSocket(reason: string): void {
    const current = socket;
    socket = null;
    socketReady = false;
    // 旧连接的预滚帧不许灌进新连接（那是上一段的音频，灌进去会让上游判出幽灵语音）
    preRoll.length = 0;
    if (!current) return;
    // 先摘回调：主动关自己时不该再走一遍「上游断了」的分支
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close(1000, reason);
    } catch {
      /* 忽略 */
    }
  }

  function stopMic(): void {
    const current = stream;
    stream = null;
    if (!current) return;
    for (const track of current.getTracks()) {
      try {
        track.stop();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 从 Deepgram 侧整体退到 Web Speech（再不行退到纯文字）。每跳都留原因。 */
  function switchToFallback(reason: string): void {
    if (disposed || diagnostics.channel !== "deepgram") return;
    // 退通道前先撤掉自动收尾：新通道（Web Speech）自己会管收尾，旧定时器不能跨通道生效
    clearAutoFinish();
    lastInterimText = "";
    const resume = wantListening;
    stopRecorder();
    closeSocket(reason);
    stopMic();
    listening = false;
    const fb = ensureFallback();
    if (fb) {
      setDiag({ channel: "webspeech", reason, prewarm: "failed" });
      log(`[stt] fallback → webspeech reason=${reason}`);
      if (resume) fb.start();
      return;
    }
    setDiag({ channel: "none", reason, prewarm: "failed" });
    wantListening = false;
    options.onStateChange?.(false);
    options.onError?.(
      "这台设备只能打字：服务端语音识别不可用，浏览器也没有 Web Speech。对话、打断、字幕都还能用文字走完。",
      "unsupported" satisfies SttErrorCode,
    );
    log(`[stt] fallback → none reason=${reason}`);
  }

  /** 取消自动收尾（任何显式动作都要先取消，避免「用户已点停 + 计时器又停一次」） */
  function clearAutoFinish(): void {
    if (autoFinishTimer !== null) {
      clearTimeout(autoFinishTimer);
      autoFinishTimer = null;
    }
  }

  /**
   * 每收到一条 interim 就重新计时；转写停住 AUTO_FINISH_QUIET_MS 就替用户收尾。
   * 只在真正听着的时候计时，且只在文字**有变化**时重置（上游会重复上报同一条 interim）。
   */
  function armAutoFinish(text: string): void {
    if (!listening || disposed || diagnostics.channel !== "deepgram") return;
    if (text === lastInterimText) return;
    lastInterimText = text;
    clearAutoFinish();
    autoFinishTimer = setTimeout(() => {
      autoFinishTimer = null;
      // 守卫含 channel：回退到 Web Speech 之后，这个定时器绝不能再碰 deepgram 的 stop()，
      // 否则会把刚起来的 Web Speech 会话掐断（审查实测路径：ws-send-failed → switchToFallback）
      if (!listening || disposed || diagnostics.channel !== "deepgram") return;
      log(`[stt] auto-finish: 转写静止 ${AUTO_FINISH_QUIET_MS}ms，替用户收尾`);
      markTrace("stt:auto-finish", `quietMs=${AUTO_FINISH_QUIET_MS}`);
      controller.stop();
    }, AUTO_FINISH_QUIET_MS);
  }

  function handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const record = payload as Record<string, unknown>;
    const type = record.type;

    if (type === "interim" || type === "final") {
      const text = typeof record.text === "string" ? record.text : "";
      if (!text) return;
      options.onTranscript?.({ text, final: type === "final" });
      if (type === "final") {
        // 上游自己给了终稿：不需要再替用户收尾
        clearAutoFinish();
        // 必须清掉「上一条 interim 原文」：否则下一句说到一模一样的短句（「好的」）
        // 会因为 text === lastInterimText 而永不启动自动收尾（审查指出的静默失效）
        lastInterimText = "";
        options.onSpeechFinal?.(text);
      } else {
        armAutoFinish(text);
      }
      return;
    }
    if (type === "speech_started") {
      // 这条标记的作用：把「上游有没有发」和「App 有没有接」分开。
      // 下次真机 trace 里如果只有 speech-started 而没有 stt:speech_started，问题在上游；
      // 反过来则是 App 侧接线断了。
      markTrace("stt:speech_started", "upstream");
      // 上游刚报「开口了」→ 把静默时钟清掉：长句中途上游停顿 ≥阈值时，
      // 不能因为「转写暂时没长」就把还在说话的用户收尾（审查指出的丢音频路径）
      clearAutoFinish();
      lastInterimText = "";
      options.onSpeechStarted?.();
      return;
    }
    if (type === "utterance_end") {
      options.onUtteranceEnd?.();
      return;
    }
    if (type === "capabilities") {
      // 服务端能力上报（WS 的第一条消息）：
      // `supportsSpeechStarted:false` = 这条通道（阿里整段识别）**不发** speech_started
      // → 上层要把自动打断切到 energy VAD（而不是等一个永远不会来的信号）。
      const provider = typeof record.provider === "string" ? record.provider : null;
      const supports = record.supportsSpeechStarted !== false;
      setDiag({ provider, supportsSpeechStarted: supports });
      log(`[stt] capabilities provider=${provider ?? "?"} speechStarted=${supports ? 1 : 0}`);
      return;
    }
    if (type === "error") {
      switchToFallback(typeof record.reason === "string" ? record.reason : "upstream-error");
    }
  }

  function ensureSocket(): void {
    if (socket || disposed || diagnostics.channel !== "deepgram") return;
    let created: VoiceSocketLike;
    try {
      created = openSocket(sttUrl(lang));
    } catch {
      switchToFallback("ws-unavailable");
      return;
    }
    socket = created;
    setDiag({ prewarm: "connecting", reason: null });
    created.onopen = () => {
      if (socket !== created || disposed) return;
      socketReady = true;
      // 握手期间攒下的音频按序补发：这一段往往正是「用户开口」的那句
      const queued = preRoll.length;
      if (queued > 0) {
        for (const frame of preRoll) {
          try {
            created.send(frame);
          } catch {
            preRoll.length = 0;
            switchToFallback("ws-send-failed");
            return;
          }
        }
        preRoll.length = 0;
        preRollFlushed += queued;
        markTrace("stt:preroll-flush", `flushed=${preRollFlushed}`);
        log(`[stt] preroll flushed=${queued} dropped=${preRollDropped}`);
      }
      setDiag({ prewarm: "ready", prerollFlushed: preRollFlushed, prerollDropped: preRollDropped });
      log("[stt] ws ready");
    };
    created.onmessage = (event) => {
      if (socket !== created) return;
      handleMessage(event?.data);
    };
    created.onerror = () => {
      if (socket !== created) return;
      switchToFallback("ws-error");
    };
    created.onclose = () => {
      if (socket !== created) return;
      socketReady = false;
      if (disposed) return;
      switchToFallback("ws-closed");
    };
  }

  async function ensureRecorder(): Promise<boolean> {
    if (recorder) return true;
    if (disposed || diagnostics.channel !== "deepgram") return false;
    let captured: MediaStreamLike;
    try {
      // 回声消除 / 降噪 / 自动增益：语音打断的硬前提（不开 AEC，麦克风会收到角色自己的声音）
      captured = await getMic({ audio: bargeInAudioConstraints() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.onError?.(`拿不到麦克风：${message}`, "denied");
      return false;
    }
    stream = captured;
    // 实测生效设置：约束只是「请求」，浏览器可以静默忽略 → 必须回读 track.getSettings()
    {
      const settings = readAppliedMicSettings(captured);
      reportAppliedMicSettings(settings);
      setDiag({ micSettings: settings, aec: aecStateOf(settings) });
    }
    try {
      const created = makeRecorder(captured);
      // 先探能力、再挂回调：这一步反了，「有没有 stop 事件」就永远为真
      recorderHasStopEvent = "onstop" in created;
      created.ondataavailable = (event) => {
        const data = event?.data;
        if (!data) return;
        if (!socket || !socketReady) {
          // 握手还没完成：**不能丢**（用户很可能此刻就在说话）。进有界队列，open 后按序补发。
          preRoll.push(data);
          if (preRoll.length > PRE_ROLL_MAX_CHUNKS) {
            preRoll.shift();
            preRollDropped += 1;
            setDiag({ prerollDropped: preRollDropped });
            markTrace("stt:preroll-drop", `dropped=${preRollDropped}`);
          }
          return;
        }
        try {
          socket.send(data);
        } catch {
          switchToFallback("ws-send-failed");
        }
      };
      created.onerror = () => switchToFallback("recorder-error");
      // 最后一个数据块已送达 → 现在才告诉服务端「这句说完了」
      created.onstop = () => {
        if (finishPending) sendFinishUtterance();
      };
      recorder = created;
      return true;
    } catch {
      switchToFallback("recorder-unavailable");
      return false;
    }
  }

  const controller: DeepgramSttController = {
    get supported() {
      return diagnostics.channel !== "none";
    },
    get listening() {
      return listening;
    },
    get channel() {
      return diagnostics.channel;
    },
    get diagnostics() {
      return diagnostics;
    },

    prewarm() {
      if (disposed || diagnostics.channel !== "deepgram") return;
      // 两条腿同时迈出去：握手 ~1s 与相机式的麦克风授权哪条慢都无所谓
      ensureSocket();
      void ensureRecorder();
    },

    start() {
      if (disposed) return false;
      if (diagnostics.channel === "webspeech") {
        const fb = ensureFallback();
        const ok = fb?.start() ?? false;
        listening = ok;
        return ok;
      }
      if (diagnostics.channel === "none") {
        options.onError?.("这台设备只能打字：输入请用文本框。", "unsupported");
        return false;
      }
      wantListening = true;
      // 新一句开始：上一句的 interim 原文要清掉，否则「同一句短话」会命中
      // text === lastInterimText 而永不自动收尾
      lastInterimText = "";
      // 预热的意义就在这里：连接立刻发出，不等第一帧音频
      ensureSocket();
      // 兜底：上一句的「说完了」还没发出去（recorder 没给 stop 事件）就在这里补发，
      // 否则服务端会一直以为那句还没完，音轨也不会 flush。
      if (finishPending) sendFinishUtterance();
      void (async () => {
        const ok = await ensureRecorder();
        if (!ok || disposed || !wantListening || !recorder) return;
        try {
          recorder.start(CHUNK_MS);
        } catch {
          switchToFallback("recorder-start-failed");
          return;
        }
        if (!listening) {
          listening = true;
          options.onStateChange?.(true);
        }
      })();
      return true;
    },

    stop() {
      // 语义：**这句说完了，还想接着说下一句**。录音停掉 → 收尾音频送出 →
      // 服务的上游被 flush 出 final（浏览器 WS 与麦克风都留着，不用再等 1 秒握手）。
      clearAutoFinish();
      lastInterimText = "";
      wantListening = false;
      if (diagnostics.channel === "webspeech") {
        fallback?.stop();
        listening = false;
        return;
      }
      // 只停录音，**不关 WS 也不关麦克风**：下一句立刻接着说，重建要再等 1 秒
      const current = recorder;
      try {
        current?.stop();
      } catch {
        /* 忽略 */
      }
      if (current && recorderHasStopEvent) {
        // 真 MediaRecorder：最后一块音频在 stop 事件之前才到，等它到了再发控制消息
        finishPending = true;
      } else {
        // 没有 stop 事件的实现（测试替身）：立即发，语义一致
        sendFinishUtterance();
      }
      if (listening) {
        listening = false;
        options.onStateChange?.(false);
      }
    },

    abort() {
      // 语义：**彻底断开**（页面卸载、切语言、回退到别的通道）。
      // 这里不发 finish_utterance：关 WS 本身就是收尾信号，服务端会先 flush 尾段再收摊，
      // 发两条只会让服务端多做一次无意义的等待。
      clearAutoFinish();
      lastInterimText = "";
      wantListening = false;
      if (diagnostics.channel === "webspeech") {
        fallback?.abort();
        listening = false;
        options.onStateChange?.(false);
        return;
      }
      stopRecorder();
      finishPending = false;
      closeSocket("aborted");
      stopMic();
      listening = false;
      if (diagnostics.channel === "deepgram") setDiag({ prewarm: "idle" });
      options.onStateChange?.(false);
    },

    setLang(next) {
      if (next === lang) return;
      lang = next;
      fallback?.setLang(next);
      // 切语言会关掉 socket；旧通道的自动收尾定时器必须一起撤，否则 900ms 后
      // 会把新通道的会话当成旧会话 stop 掉（审查指出的路径）
      clearAutoFinish();
      lastInterimText = "";
      // 语言是上游 URL 的一部分：下次 prewarm/start 会用新语言重连
      closeSocket("lang-change");
    },
  };

  // 初始状态也要上报一次：诊断区不能等到第一次回退才有内容
  options.onDiagnostic?.(diagnostics);
  return controller;
}
