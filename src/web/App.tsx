import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage } from "./stage/Stage";
import { reportSessionSignal } from "./stage/clip/clipBus";
import { createHttpApi } from "./state/api";
import { SessionStore } from "./state/store";
import { useSessionView } from "./state/useSession";
import { createVoiceTts, type AudioMode, type TTSProvider } from "./voice/tts";
import { isSpeechRecognitionSupported, type SttLang } from "./voice/stt";
import { createDeepgramStt, type DeepgramSttController, type DeepgramSttDiagnostics, type DeepgramSttOptions } from "./voice/deepgramStt";
import { fetchVoiceStatus, type VoiceStatus } from "./voice/voiceStatus";
import { enableObs, obsEvent } from "./obs/obs";
import { ObsPanel } from "./obs/ObsPanel";
import { reportVoiceChannel } from "./voice/voiceDiag";
import { MicEnergyVad } from "./voice/vad";
import {
  SpeechBargeInGate,
  PRODUCTION_BARGE_IN_GATE,
  type AecState,
} from "./voice/bargeInGate";
import { VoiceBargeInWiring } from "./voice/bargeInWiring";
import { createFakeStt, parseFakeAecOverride, parseFakeSttFlag } from "./voice/fakeStt";
import { parseBargeInFlag } from "./voice/bargeInFlag";
import { describeAppliedMicSettings, readAecState, readMicDiagnostics } from "./voice/micConstraints";
import { logTrace, markTrace, parseTraceFlag, publishTrace, setTraceEnabled } from "./voice/bargeInTrace";
import { withAudioTrace } from "./voice/tracedTts";
import {
  createPresenceArbiter,
  createPresenceTrace,
  micPhaseOf,
  parsePresenceTraceFlag,
  readTtsError,
  requestPhaseOf,
  ttsPhaseOf,
  type Presence,
  type PresenceTrace,
} from "./state/presence";
import {
  attachRuntimeErrorWatcher,
  describeMicAvailability,
  describeRuntimeError,
  hasMicCapture,
  readSecureContext,
  type RuntimeErrorNotice,
} from "./ui/availability";
import { parseDemoFlag, withDemoApi, withDemoTts } from "./ui/demo";
import { Dock } from "./ui/Dock";
import { DockPortal } from "./ui/DockPortal";
import { DemoBadge } from "./ui/Notices";
import { StageBoundary } from "./ui/StageBoundary";
import { StatusBar } from "./ui/StatusBar";
import { useLinkProbe } from "./ui/useLinkProbe";

interface BootParams {
  audio: AudioMode;
  lang: SttLang;
  /** 语音自动打断（`?bargeIn=off` 可关；默认开） */
  bargeIn: boolean;
  /** `?stt=fake`：用脚本化假上游顶替 Deepgram（验证打断链路，不消耗 key、不需要真人说话） */
  sttFake: boolean;
  /** `?aec=on|off|unknown`：把「麦克风实测 AEC」强制成对应状态（只与 `?stt=fake` 一起用） */
  aecOverride: AecState | null;
}

/**
 * `?bargeIn=` 解析（实现见 voice/bargeInFlag.ts）：**默认开**，`?bargeIn=off` 关，
 * 旧的 `?bargeIn=voice` 仍视为开。这里保留同名导出，老链接/老测试不失效。
 */
export { parseBargeInFlag } from "./voice/bargeInFlag";

function readParams(): BootParams {
  const fallback: BootParams = {
    audio: "browser",
    lang: "zh-CN",
    bargeIn: true,
    sttFake: false,
    aecOverride: null,
  };
  if (typeof window === "undefined") return fallback;
  const params = new URLSearchParams(window.location.search);
  const sttFake = parseFakeSttFlag(window.location.search);
  return {
    audio: params.get("audio") === "stream" ? "stream" : "browser",
    lang: params.get("lang") === "en-US" ? "en-US" : "zh-CN",
    bargeIn: parseBargeInFlag(window.location.search) === "on",
    sttFake,
    // 强制 AEC 只在假上游下有语义（真麦克风的实测值不许被 URL 覆盖）
    aecOverride: sttFake ? parseFakeAecOverride(window.location.search) : null,
  };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function warmUpTts(tts: TTSProvider): void {
  // StreamTTS 的 AudioContext 必须在用户手势里创建/恢复（BrowserTTS 没有这个钩子）
  const candidate = tts as Partial<{ warmUp(): void }>;
  candidate.warmUp?.();
}

export function App() {
  const boot = useMemo(readParams, []);
  // 演示开关：?demo=fail / timeout / tts / all，默认关闭（详见 ui/demo.ts）
  const demo = useMemo(
    () => parseDemoFlag(typeof window === "undefined" ? "" : window.location.search),
    [],
  );

  const httpApi = useMemo(() => createHttpApi(), []);
  const api = useMemo(() => withDemoApi(httpApi, demo), [httpApi, demo]);
  // 「正在朗读」的句子：BrowserTTS 每句开口时回调，用来证明语音节奏与字幕对齐
  const [speakingSegment, setSpeakingSegment] = useState("");
  /** 服务端语音能力（无 key → stt/tts 都 false，正常态） */
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const voiceStatusRef = useRef<VoiceStatus | null>(null);
  useEffect(() => {
    voiceStatusRef.current = voiceStatus;
  }, [voiceStatus]);
  useEffect(() => {
    let alive = true;
    // 失败 = 未知 → null（客户端按「都不可用」回退，不报错、不卡住）
    const statusStartedAt = nowMs();
    void fetchVoiceStatus().then((status) => {
      if (!alive) return;
      setVoiceStatus(status);
      obsEvent("status:ready", {
        detail: {
          ms: Math.round(nowMs() - statusStartedAt),
          ttsZh: status?.ttsZh === true,
          tts: status?.tts === true,
        },
      });
      // 两档分别上报：中文看 Edge CLI，英文看 Deepgram key
      reportVoiceChannel({
        ttsZh: status?.ttsZh ? "edge" : "browser",
        tts: status?.tts ? "deepgram" : "browser",
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  const nativeTts = useMemo(
    () =>
      createVoiceTts({
        mode: boot.audio,
        lang: boot.lang,
        onSegment: (text: string) => {
          setSpeakingSegment(text);
          // 爬升期守卫的基准点：本轮 TTS 第一次真的开口的时刻
          if (speakingSinceRef.current === null) speakingSinceRef.current = nowMs();
          markTrace("tts:segment", text.slice(0, 12));
        },
        // 分句现查：status 可能比第一句话晚到，也可能中途变了
        getStatus: () => voiceStatusRef.current,
        // 第一次用上本机合成音时在诊断区说明一句（不打断对话、不弹窗）
        onBrowserFallback: (reason) => reportVoiceChannel({ ttsNote: reason }),
        // 单句合成失败 → 只有字幕，不出第二个音色（原因上报到诊断区）
        onSynthIssue: (reason) => reportVoiceChannel({ ttsNote: reason }),
      }),
    [boot],
  );
  // withAudioTrace 只负责给时间线打「音频停止」点，行为与 withDemoTts 完全一致
  const tts = useMemo(
    () => withAudioTrace(withDemoTts(nativeTts, demo)),
    [nativeTts, demo],
  );
  // 必须在 store 之前声明：SessionStore 构造时就会 emit() → buildView() → audioPlaying()
  // 会立刻读它，声明在后会踩 TDZ（Cannot access 'presenceRef' before initialization → 黑屏）
  const presenceRef = useRef(createPresenceArbiter());

  const store = useMemo(
    () =>
      new SessionStore({
        api,
        tts,
        audioMode: boot.audio,
        // 「音频真的在响」——打断判据的第二条腿，见 SessionStoreDeps.audioPlaying
        audioPlaying: () => presenceRef.current.get().mouthDrive,
      }),
    [api, tts, boot.audio],
  );

  // `?obs=1`：量化观测面板（分段耗时 / 错误 / TTS 通道），独立于主界面
  const obsOn = useMemo(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("obs") === "1",
    [],
  );
  useEffect(() => {
    if (obsOn) enableObs();
  }, [obsOn]);

  const view = useSessionView(store);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // ---------------------------------------------------------------- 在场状态（presence）
  //
  // 视觉状态不再直接吃事件流推导出来的 `characterStatus`（首个 text.delta 就 speaking、
  // turn.end 就 idle），而是由三路**真实信号**仲裁：
  //   request（本轮请求阶段）/ tts（真的有声音在播吗）/ mic（真的在采集吗）
  // 判据全部在 state/presence.ts 的纯函数里（有单测）；这里只负责喂信号与渲染。
  const traceOn = useMemo(
    () => parsePresenceTraceFlag(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const traceRef = useRef<PresenceTrace | null>(null);
  if (traceOn && traceRef.current === null) traceRef.current = createPresenceTrace();
  const signalsRef = useRef({
    turnKey: null as string | null,
    hasText: false,
    /** 「本轮已经真的有过声音」。分片到达不算 —— 解码失败的分片不会出声 */
    hasAudio: false,
    playing: false,
    error: null as string | null,
  });
  const [presence, setPresence] = useState<Presence>(() => presenceRef.current.get());
  const ttsLiveRef = useRef(tts);
  ttsLiveRef.current = tts;

  const pushPresence = useCallback(() => {
    const current = viewRef.current;
    const machine = current.machine;
    const signals = signalsRef.current;
    // 换轮即重置本轮信号：上一轮有没有过声音，与这一轮无关
    if (machine.turnId !== signals.turnKey) {
      signals.turnKey = machine.turnId;
      signals.hasText = false;
      signals.hasAudio = false;
      signals.error = null;
    }
    if (machine.text.length > 0) signals.hasText = true;
    signals.playing = ttsLiveRef.current?.isSpeaking === true;
    if (signals.playing) signals.hasAudio = true;
    signals.error = readTtsError(ttsLiveRef.current) ?? signals.error;

    const request = requestPhaseOf(machine);
    const ttsPhase = ttsPhaseOf({ playing: signals.playing, error: signals.error, request });
    const next = presenceRef.current.update({
      request,
      tts: ttsPhase,
      mic: micPhaseOf(current.mic),
      hasText: signals.hasText,
      hasAudio: signals.hasAudio,
    });
    setPresence((prev) =>
      prev.status === next.status &&
      prev.reason === next.reason &&
      prev.mouthDrive === next.mouthDrive
        ? prev
        : next,
    );
    // ?trace=1：50ms 一条 {t, status, tts, hasAudio, subtitleLen}，用来给「嘴和声音对不上」取证
    traceRef.current?.push({
      status: next.status,
      tts: ttsPhase,
      hasAudio: signals.hasAudio,
      subtitleLen: machine.scene.subtitle.trim().length,
    });
  }, []);

  // 只有「有活儿」或开了 ?trace=1 才跑 50ms 采样，待机不空转
  const presenceActive = view.machine.turnActive || presence.status === "speaking" || traceOn;
  useEffect(() => {
    pushPresence();
    if (!presenceActive) return;
    const timer = window.setInterval(pushPresence, 50);
    return () => window.clearInterval(timer);
  }, [presenceActive, pushPresence, view.machine.turnId, view.mic]);

  // 口型/画面用的状态：status 取仲裁结果（而不是事件流推导值），其余字段原样透传
  const stageState = useMemo(
    () =>
      view.scene.characterStatus === presence.status
        ? view.scene
        : { ...view.scene, characterStatus: presence.status },
    [view.scene, presence.status],
  );

  // ?trace=1 的取数口（仅诊断；不参与任何业务判断）
  useEffect(() => {
    if (!traceOn || typeof window === "undefined") return;
    const handle = {
      json: () => traceRef.current?.json() ?? "[]",
      summary: () => traceRef.current?.summary() ?? null,
      records: () => traceRef.current?.records ?? [],
      clear: () => traceRef.current?.clear(),
      submit: (text: string) => {
        warmUpTts(tts);
        void store.submit(text);
      },
    };
    (window as unknown as { __miraTrace?: unknown }).__miraTrace = handle;
    return () => {
      delete (window as unknown as { __miraTrace?: unknown }).__miraTrace;
    };
  }, [traceOn, store, tts]);

  // 片段的外部中止源：epoch 变化（用户打断 / 换轮）或新一轮开始 → 立刻停帧并隐藏。
  // 注意不能拿「轮次数」当信号：它在 turn.end 才 +1，会在片段播到一半时误判成打断。
  useEffect(() => {
    // sessionId 一起上报：插图层要用它发请求（Stage 的 props 已冻结，只能走这条窄通道）
    reportSessionSignal(
      view.machine.epoch,
      view.machine.turnId ?? null,
      view.session?.sessionId ?? null,
    );
  }, [view.machine.epoch, view.machine.turnId, view.session?.sessionId]);

  const [interim, setInterim] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  /** 未捕获错误 / 资源加载失败 / 朗读失败 —— 可关闭，不打断对话 */
  const [mediaError, setMediaError] = useState<RuntimeErrorNotice | null>(null);
  /** 麦克风通了但语音识别服务没响应（与「权限被拒」是两件事，文案必须分开） */
  const [sttBlocked, setSttBlocked] = useState(false);

  const sttRef = useRef<DeepgramSttController | null>(null);
  const vadRef = useRef<MicEnergyVad | null>(null);
  const micOnRef = useRef(false);
  /** speech_started 触发闸门（三道守卫 + AEC 前提，见 voice/bargeInGate.ts） */
  const gate = useMemo(() => new SpeechBargeInGate(PRODUCTION_BARGE_IN_GATE), []);
  /** 本轮 TTS 第一次开口的时刻（爬升期基准） */
  const speakingSinceRef = useRef<number | null>(null);
  /** 本轮已经因语音打断过（避免 interim 触发后再被 final 打断一次） */
  const bargedRef = useRef(false);
  /** AEC 不可用的说明只提示一次 */
  const aecWarnedRef = useRef(false);

  useEffect(() => {
    setTraceEnabled(parseTraceFlag(typeof window === "undefined" ? "" : window.location.search));
    markTrace("boot", `bargeIn=${boot.bargeIn ? "on" : "off"} aec=${readAecState()}`);
    // 让 E2E/控制台随时能读到时间线（不必等到第一次打断）
    publishTrace();
  }, [boot.bargeIn]);

  const isSpeakingNow = useCallback(() => {
    return viewRef.current?.scene.characterStatus === "speaking" || tts.isSpeaking;
  }, [tts]);

  /**
   * **fire 那一刻**（interim 到达时）她是否仍在出声 —— 与 `isSpeakingNow` 的唯一区别
   * 是「本轮已经收尾」这一种情形：那时 `tts.isSpeaking` 仍可能为真（在飞的合成任务、
   * 未清空的播放队列），但声音早就停了。真机 trace：3226ms 已经 status:idle，
   * 3492ms 的 speech_started 仍 arm，3692ms 的 interim 就靠这条过期信号打断了新请求。
   */
  const isSpeakingAtFire = useCallback(() => {
    const current = viewRef.current;
    if (!current) return false;
    if (current.scene.characterStatus === "speaking") return true;
    // 轮次还在跑 → 尾巴音频可能在放，按 tts 的实时信号算「仍在说话」
    if (!current.machine.turnActive) return false;
    return tts.isSpeaking;
  }, [tts]);

  /**
   * 打断的**唯一**入口（见 voice/bargeInWiring.ts）：谁有权触发由 `source` 决定，
   * 能量 VAD 与 Deepgram 不可能同时调 `store.onUserSpeech`。
   * 时间线标记（speech-started / gate:* / interrupt:*）也都在那里打，顺序不可绕。
   */
  const wiring = useMemo(
    () =>
      new VoiceBargeInWiring({
        gate,
        now: nowMs,
        aec: () => readAecState(),
        speaking: () => isSpeakingNow(),
        // arm 之后可能已经回 idle：真正放行前必须现读（见 isSpeakingAtFire 注释）
        speakingAtFire: () => isSpeakingAtFire(),
        turnId: () => viewRef.current?.machine.turnId ?? null,
        epoch: () => viewRef.current?.machine.epoch ?? 0,
        ttsStartedAtMs: () => speakingSinceRef.current,
        interrupt: (via) => {
          markTrace("interrupt:accept", `via=${via}`);
          const result = store.interrupt("speech");
          bargedRef.current = true;
          setNote("听到你开口，已打断 —— 可以直接说下一句");
          publishTrace();
          logTrace();
          return result;
        },
        onRejected: (decision) => {
          // AEC 实测不可用 → 自动退回手动打断，并把原因说清（诊断不止一行日志）
          if (decision.action !== "ignore") return;
          if (decision.reject !== "aec-unavailable" || aecWarnedRef.current) return;
          aecWarnedRef.current = true;
          const mic = readMicDiagnostics();
          setNote(
            `${mic.note ?? "回声消除不可用"} —— 已退回手动打断（Esc / 按钮），不然她会被自己的声音打断`,
          );
        },
      }),
    [gate, isSpeakingNow, isSpeakingAtFire, store],
  );

  // 状态轨迹进时间线（speaking → listening 是验收项之一）
  useEffect(() => {
    const status = view.scene.characterStatus;
    markTrace(`status:${status}`);
    publishTrace();
    if (status === "speaking") {
      if (speakingSinceRef.current === null) speakingSinceRef.current = nowMs();
    } else if (!tts.isSpeaking) {
      speakingSinceRef.current = null;
    }
  }, [view.scene.characterStatus, tts]);

  // 有任一可用 STT 路径就算「可用」：Deepgram 走服务端代理，不依赖 Web Speech
  const speechSupported = useMemo(
    () => isSpeechRecognitionSupported() || voiceStatus?.stt === true,
    [voiceStatus],
  );
  const secureContext = useMemo(
    () => readSecureContext(typeof window === "undefined" ? undefined : window),
    [],
  );
  const micCapture = useMemo(
    () => hasMicCapture(typeof navigator === "undefined" ? undefined : navigator),
    [],
  );

  // 麦克风三分支文案：权限拒绝 / 浏览器不支持 / 非安全上下文（公网 http 必现）
  const micNotice = useMemo(
    () =>
      describeMicAvailability({
        mic: view.mic,
        speechSupported,
        hasMicCapture: micCapture,
        secureContext,
        sttBlocked,
      }),
    [view.mic, speechSupported, micCapture, secureContext, sttBlocked],
  );

  // ---------------------------------------------------------------- 连通性

  const probe = useLinkProbe(httpApi);
  const storeOffline = view.connection === "offline";
  const offline = storeOffline || probe.down;

  // store 报告掉线时立刻探一次：是「真的没服务」还是「只是这一轮断了」，提示文案不一样
  useEffect(() => {
    if (!storeOffline) return;
    void probe.probeNow();
    // probeNow 引用稳定，只跟 storeOffline 的变化走
  }, [storeOffline, probe.probeNow]);

  const reconnect = useCallback(async () => {
    const ok = await probe.probeNow();
    if (!ok) return;
    // init() 只重建会话，不动 machine.scene / 历史：断线期间的对话与画面状态都保留
    await store.init();
  }, [probe, store]);

  const dismissMediaError = useCallback(() => setMediaError(null), []);

  // ---------------------------------------------------------------- 全局兜底

  useEffect(() => {
    if (typeof window === "undefined") return;
    // window error + unhandledrejection（TTS 抛错、资源加载失败、脚本异常都走这里）
    return attachRuntimeErrorWatcher(window, (notice) => setMediaError(notice));
  }, []);

  // ---------------------------------------------------------------- 生命周期

  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);

  useEffect(() => {
    return () => {
      tts.dispose();
    };
  }, [tts]);

  // vfx 衰减 / 状态条过期：唯一的时间驱动入口，保持在组件之外的状态机里结算
  useEffect(() => {
    if (typeof requestAnimationFrame !== "function") return;
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      store.tick(dt);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [store]);

  // ---------------------------------------------------------------- 语音识别

  /** 当前 STT 通道（`?stt=fake` 时如实报 fake：诊断里不能冒充真 Deepgram） */
  const sttChannelOf = useCallback((): "deepgram" | "fake" | "webspeech" | "none" => {
    if (boot.sttFake) return "fake";
    return sttRef.current?.channel ?? "none";
  }, [boot.sttFake]);

  /**
   * 重新解析触发源 + 写一行「source 与 aecSettings 同时可见」的诊断。
   * 三个写入点（控制台时间线 / `window.__miraBargeInDiag` / Dock note）都用同一份数据，
   * 免得「界面上一个说法、trace 里另一个说法」。
   */
  const refreshSource = useCallback(() => {
    // 能力上报（服务端给的）：这条通道**会不会**发 speech_started。
    // 阿里百炼整段识别不发 → 这里报 false → 触发源自动落到 energy VAD
    //（AEC / 回声门禁不变）。**不伪造** speech_started。
    const supportsSpeechStarted =
      sttRef.current?.diagnostics.supportsSpeechStarted ??
      voiceStatusRef.current?.supportsSpeechStarted ??
      true;
    const decision = wiring.update({
      bargeInEnabled: boot.bargeIn,
      sttChannel: sttChannelOf(),
      supportsSpeechStarted,
    });
    const mic = readMicDiagnostics();
    const aecSettings = describeAppliedMicSettings(mic.settings);
    const diag = {
      source: decision.source,
      reason: decision.reason,
      detail: decision.detail,
      aec: mic.aec,
      aecSettings,
    };
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>).__miraBargeInDiag = diag;
    }
    markTrace("diag", `${decision.detail} | ${aecSettings}`);
    publishTrace();
    return decision;
  }, [boot.bargeIn, sttChannelOf, wiring]);

  const stopEnergyVad = useCallback(() => {
    vadRef.current?.stop();
    vadRef.current = null;
  }, []);

  /**
   * 能量 VAD **只**在 `source === "energy"` 时启动（Deepgram 不可用 + AEC 实测生效）。
   * deepgram 源下不启动它：既省一路 getUserMedia，也从结构上断掉双源
   * （它以前是 `store.onUserSpeech` 的直接调用者，那就是这次事故的现场）。
   */
  const startEnergyVad = useCallback(async () => {
    if (vadRef.current) return;
    const vad = new MicEnergyVad({
      onSpeech: () => wiring.onEnergySpeech(),
      onError: (message) => setNote(message),
      onLevel: (level) => setMicLevel(level),
    });
    const ok = await vad.start();
    if (!ok) {
      setNote("能量 VAD 起不来：麦克风不可用，打断只能用 Esc / 按钮");
      return;
    }
    vadRef.current = vad;
  }, [wiring]);

  // STT 的 effect 比这两个回调早建立（回调依赖 STT 通道），用 ref 打破循环依赖
  const refreshSourceRef = useRef(refreshSource);
  refreshSourceRef.current = refreshSource;
  const startEnergyVadRef = useRef(startEnergyVad);
  startEnergyVadRef.current = startEnergyVad;

  useEffect(() => {
    const sttOptions: DeepgramSttOptions = {
      lang: boot.lang,
      continuous: true,
      interim: true,
      // status 说 false 就不建连（省一次必然失败的升级）；状态晚到也没关系：每次现查
      available: () => voiceStatusRef.current?.stt !== false,
      // speech_started 是「用户开口」的触发源（Deepgram 服务端 VAD，比能量阈值可靠）。
      // 它本身不直接打断：先过闸门（爬升期/防抖/AEC），由随后的 interim 确认 → 见 bargeInGate.ts。
      onSpeechStarted: () => {
        // 闸门里会打 `speech-started`（= 验收要看到的那条），这里只转发
        wiring.onSpeechStarted();
      },
      onSpeechFinal: () => {},
      onDiagnostic: (diagnostics: DeepgramSttDiagnostics) => {
        reportVoiceChannel({ stt: diagnostics.channel, reason: diagnostics.reason });
        // AEC 是取流之后才读到的：拿到就重新解析触发源（可能从 none 变成 deepgram/energy）
        const decision = refreshSourceRef.current();
        if (decision.source === "energy") void startEnergyVadRef.current();
      },
      onTranscript: ({ text, final }) => {
        if (!final) {
          setInterim(text);
          // interim = 「真的有人连续在说话」：闸门在这里放行（短促噪声不会产生 interim）
          wiring.onInterim();
          return;
        }
        setInterim("");
        const current = viewRef.current;
        if (!current) return;
        if (current.scene.characterStatus === "speaking" || tts.isSpeaking) {
          if (!boot.bargeIn) {
            // ?bargeIn=off：不自动打断，给出明确指引（按钮/Esc 才是主路径）
            setNote(`听到「${text}」，但她还在说话 —— 按 Esc 打断，或等她说完再说一次`);
            return;
          }
          // final = 有归属的用户原文：守卫只用来过滤「无归属的 speech_started」，
          // 到这一步直接打断；interim 已经触发过就不再重复打断（只提交这一句）
          if (!bargedRef.current) wiring.onFinal();
          bargedRef.current = false;
          warmUpTts(tts);
          void store.submit(text);
          return;
        }
        setNote(null);
        warmUpTts(tts);
        void store.submit(text);
      },
      onStateChange: (listening) => {
        if (!listening) setInterim("");
      },
      onError: (message, code) => {
        setNote(message);
        if (code === "denied" && micOnRef.current) {
          // 麦克风已经在跑，说明权限没问题 —— 失败的是语音识别服务本身
          setSttBlocked(true);
          store.setMic("unsupported");
          return;
        }
        if (code === "denied") store.setMic("denied");
        else if (code === "unsupported") store.setMic("unsupported");
        else if (code === "network") setSttBlocked(true);
      },
    };

    let stt: DeepgramSttController;
    if (boot.sttFake) {
      // 假上游只替换 deps（WS/麦克风/Recorder），客户端仍是生产代码：见 voice/fakeStt.ts
      const harness = createFakeStt({
        ...sttOptions,
        available: () => true,
        aecOverride: boot.aecOverride,
      });
      stt = harness.controller;
      // E2E/控制台可直接读：上游吐了哪几条、客户端发了多少音频帧
      (window as unknown as Record<string, unknown>).__miraFakeStt = harness.probe;
    } else {
      stt = createDeepgramStt(sttOptions);
    }
    sttRef.current = stt;
    return () => {
      stt.abort();
      sttRef.current = null;
    };
  }, [store, tts, boot.lang, boot.bargeIn, boot.sttFake, boot.aecOverride, gate, wiring]);

  useEffect(() => {
    sttRef.current?.setLang(view.sttLang);
  }, [view.sttLang]);

  // ---------------------------------------------------------------- 交互

  const toggleMic = useCallback(async () => {
    if (micOnRef.current) {
      stopEnergyVad();
      micOnRef.current = false;
      setMicLevel(0);
      sttRef.current?.stop();
      store.setMic("idle");
      return;
    }

    // 非安全上下文下 getUserMedia 根本不存在：直接说清根因，交给替代入口，
    // 而不是走一遍注定失败、还会把状态写成「权限被拒绝」的授权流程
    if (secureContext === false || (!micCapture && !speechSupported && !boot.sttFake)) {
      setNote(
        secureContext === false
          ? "麦克风只在 https 或 localhost 下可用：把地址换成 http://localhost:5173 再点一次，或直接用文字输入"
          : "这个浏览器没有麦克风采集能力：用文字输入；打断用 Esc 或「打断」按钮",
      );
      return;
    }

    store.setMic("requesting");
    setNote(null);
    micOnRef.current = true;
    gate.reset();
    setSttBlocked(false);

    const stt = sttRef.current;
    // 麦克风一开就预热：建连实测约 1s，等用户开口才连必然丢第一句
    // （握手窗口的音频现在会进 pre-roll 队列补发，不再丢：见 deepgramStt.ts）
    stt?.prewarm();
    if (stt?.supported) {
      stt.start();
    } else {
      setNote("当前浏览器不支持语音转写：输入请用文字；打断用 Esc 或「打断」按钮");
    }

    // 触发源在这之后定：AEC 要等 getMic 回来才读得到，
    // onDiagnostic 里会再解析一次（可能从 none 收敛成 deepgram / energy）
    const decision = refreshSource();
    if (decision.source === "energy") await startEnergyVad();
    else stopEnergyVad();

    store.setMic("listening");
  }, [
    store,
    secureContext,
    micCapture,
    speechSupported,
    boot.sttFake,
    gate,
    refreshSource,
    startEnergyVad,
    stopEnergyVad,
  ]);

  const pushToTalkStart = useCallback(() => {
    warmUpTts(tts);
    const stt = sttRef.current;
    if (stt?.supported) {
      setNote(null);
      stt.start();
    } else {
      setNote("当前浏览器不支持语音识别：松开后在输入框里打字；打断用 Esc 或「打断」按钮");
    }
    store.onUserSpeech("button");
  }, [store, tts]);

  const pushToTalkEnd = useCallback(() => {
    sttRef.current?.stop();
  }, []);

  const send = useCallback(
    (text: string) => {
      warmUpTts(tts);
      setNote(null);
      void store.submit(text);
    },
    [store, tts],
  );

  const retry = useCallback(() => {
    warmUpTts(tts);
    void store.retry();
  }, [store, tts]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!viewRef.current?.canInterrupt) return;
      event.preventDefault();
      store.interrupt("key");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  useEffect(() => {
    return () => {
      vadRef.current?.stop();
      vadRef.current = null;
      micOnRef.current = false;
      sttRef.current?.abort();
    };
  }, []);

  // ---------------------------------------------------------------- 渲染

  return (
    <div className={`mira-app mira-app--${view.audioMode}`} data-demo={demo.active ? "on" : "off"}>
      <div className="mira-stage">
        {/* 画面渲染期抛错时兜住：不白屏，dock 仍然可用 */}
        <StageBoundary onError={(error) => setMediaError(describeRuntimeError(error, "error"))}>
          <Stage
            state={stageState}
            presence={presence}
            presenceDebug={traceOn}
            onBranchPick={(id) => store.pickBranch(id)}
          />
        </StageBoundary>
      </div>

      <DemoBadge demo={demo} />

      <StatusBar banner={view.banner} onRetry={retry} onDismiss={() => store.clearBanner()} />

      <DockPortal>
        <Dock
          view={view}
          interim={interim}
          speaking={speakingSegment}
          note={note}
          micLevel={micLevel}
          micNotice={micNotice}
          offline={offline}
          recovered={probe.recovered && !probe.down}
          reconnecting={probe.checking}
          probeError={probe.error}
          onReconnect={() => void reconnect()}
          mediaError={mediaError}
          onDismissMedia={dismissMediaError}
          demo={demo}
          diagnostics={{
            online: !offline,
            probes: probe.probes,
            secureContext,
            speechSupported,
          }}
          onDraft={(value) => store.setDraft(value)}
          onSend={send}
          onInterrupt={() => store.interrupt("button")}
          onMicToggle={() => void toggleMic()}
          onPushToTalkStart={pushToTalkStart}
          onPushToTalkEnd={pushToTalkEnd}
          onRetry={retry}
          onLangChange={(lang) => store.setSttLang(lang)}
        />
      </DockPortal>

      {obsOn ? <ObsPanel /> : null}
    </div>
  );
}
