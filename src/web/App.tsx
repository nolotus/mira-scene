import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Stage } from "./stage/Stage";
import { reportSessionSignal } from "./stage/clip/clipBus";
import { createHttpApi } from "./state/api";
import { SessionStore } from "./state/store";
import { useSessionView } from "./state/useSession";
import { createVoiceTts, type AudioMode, type TTSProvider } from "./voice/tts";
import { isSpeechRecognitionSupported, type SttLang } from "./voice/stt";
import { createDeepgramStt, type DeepgramSttController, type DeepgramSttDiagnostics } from "./voice/deepgramStt";
import { fetchVoiceStatus, type VoiceStatus } from "./voice/voiceStatus";
import { reportVoiceChannel } from "./voice/voiceDiag";
import { MicEnergyVad } from "./voice/vad";
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
  /** 语音自动打断开关（`?bargeIn=voice`），默认关闭 */
  bargeIn: boolean;
}

/**
 * 解析 `?bargeIn=voice`（风格对齐 ui/demo.ts 的开关解析：显式值才算开，默认关）。
 *
 * 为什么默认关：能量 VAD 与 STT 转写都不做回声消除，外放时角色自己的声音会被
 * 认成用户开口 → 自动打断等于自打断（话说一半卡住）。所以语音打断只作为实验特性
 * 显式开启；按钮 / Esc / 打字打断永远是主路径。
 */
export function parseBargeInFlag(search: string): boolean {
  const raw = (new URLSearchParams(search).get("bargeIn") ?? "").trim().toLowerCase();
  return raw === "voice" || raw === "1" || raw === "on" || raw === "true";
}

function readParams(): BootParams {
  if (typeof window === "undefined") return { audio: "browser", lang: "zh-CN", bargeIn: false };
  const params = new URLSearchParams(window.location.search);
  return {
    audio: params.get("audio") === "stream" ? "stream" : "browser",
    lang: params.get("lang") === "en-US" ? "en-US" : "zh-CN",
    bargeIn: parseBargeInFlag(window.location.search),
  };
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
    void fetchVoiceStatus().then((status) => {
      if (!alive) return;
      setVoiceStatus(status);
      reportVoiceChannel({ tts: status?.tts ? "deepgram" : "browser" });
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
        onSegment: setSpeakingSegment,
        // 分句现查：status 可能比第一句话晚到，也可能中途变了
        getStatus: () => voiceStatusRef.current,
      }),
    [boot],
  );
  const tts = useMemo(() => withDemoTts(nativeTts, demo), [nativeTts, demo]);
  const store = useMemo(
    () => new SessionStore({ api, tts, audioMode: boot.audio }),
    [api, tts, boot.audio],
  );

  const view = useSessionView(store);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

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

  useEffect(() => {
    const stt = createDeepgramStt({
      lang: boot.lang,
      continuous: true,
      interim: true,
      // status 说 false 就不建连（省一次必然失败的升级）；状态晚到也没关系：每次现查
      available: () => voiceStatusRef.current?.stt !== false,
      // 下面两个回调是「用 speech_started 替代能量 VAD 做打断」的接入点。
      // 本轮只留口子不接线：接法是 onSpeechStarted 里判 canInterrupt 后 store.onUserSpeech("speech")，
      // 详见报告（需要对 vad.ts 的 SpeechTriggerGate 做同一条防抖）。
      onSpeechStarted: () => {},
      onSpeechFinal: () => {},
      onDiagnostic: (diagnostics: DeepgramSttDiagnostics) => {
        reportVoiceChannel({ stt: diagnostics.channel, reason: diagnostics.reason });
      },
      onTranscript: ({ text, final }) => {
        if (!final) {
          setInterim(text);
          return;
        }
        setInterim("");
        const current = viewRef.current;
        if (!current) return;
        if (current.scene.characterStatus === "speaking") {
          if (!boot.bargeIn) {
            // 默认路径：不把角色自己的声音当成用户输入（回声防护），但要给出明确指引
            setNote(`听到「${text}」，但她还在说话 —— 按 Esc 打断，或等她说完再说一次`);
            return;
          }
          // ?bargeIn=voice：显式开启的语音打断。先 interrupt("speech") 把 epoch+1、
          // 静音并 abort 旧流，再提交这一句；转写本身不做回声消除，所以默认不开。
          setNote(null);
          store.interrupt("speech");
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
    });
    sttRef.current = stt;
    return () => {
      stt.abort();
      sttRef.current = null;
    };
  }, [store, tts, boot.lang, boot.bargeIn]);

  useEffect(() => {
    sttRef.current?.setLang(view.sttLang);
  }, [view.sttLang]);

  // ---------------------------------------------------------------- 交互

  const toggleMic = useCallback(async () => {
    if (micOnRef.current) {
      vadRef.current?.stop();
      vadRef.current = null;
      micOnRef.current = false;
      setMicLevel(0);
      sttRef.current?.stop();
      store.setMic("idle");
      return;
    }

    // 非安全上下文下 getUserMedia 根本不存在：直接说清根因，交给替代入口，
    // 而不是走一遍注定失败、还会把状态写成「权限被拒绝」的授权流程
    if (secureContext === false || (!micCapture && !speechSupported)) {
      setNote(
        secureContext === false
          ? "麦克风只在 https 或 localhost 下可用：把地址换成 http://localhost:5173 再点一次，或直接用文字输入"
          : "这个浏览器没有麦克风采集能力：用文字输入，或按住「按住说话」手动打断",
      );
      return;
    }

    store.setMic("requesting");
    setNote(null);
    const vad = new MicEnergyVad({
      onSpeech: () => {
        if (viewRef.current?.canInterrupt) store.onUserSpeech("speech");
      },
      onError: (message) => setNote(message),
      onLevel: (level) => setMicLevel(level),
    });

    const ok = await vad.start();
    if (!ok) {
      store.setMic("denied");
      return;
    }

    vadRef.current = vad;
    micOnRef.current = true;
    setSttBlocked(false);
    store.setMic("listening");

    // 麦克风一开就预热：建连实测约 1s，等用户开口才连必然丢第一句
    sttRef.current?.prewarm();

    if (sttRef.current?.supported) {
      sttRef.current.start();
    } else {
      setNote("当前浏览器不支持语音转写：已开启「开口即打断」检测，输入请用文字或「按住说话」");
    }
  }, [store, secureContext, micCapture, speechSupported]);

  const pushToTalkStart = useCallback(() => {
    warmUpTts(tts);
    const stt = sttRef.current;
    if (stt?.supported) {
      setNote(null);
      stt.start();
    } else {
      setNote("当前浏览器不支持语音识别：按住即可打断，松开后请在输入框里打字");
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
          <Stage state={view.scene} onBranchPick={(id) => store.pickBranch(id)} />
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
    </div>
  );
}
