/**
 * 语音输入（STT）—— Web Speech API。
 *
 * 关键取舍：不支持时绝不静默降级。
 * `createStt()` 返回的 controller 会带 `supported=false` + 明确原因，
 * UI 必须据此显示「当前浏览器不支持语音识别，请用文字或按住说话」。
 */

export type SttLang = "zh-CN" | "en-US";

export type SttErrorCode =
  | "unsupported"
  | "denied"
  | "no-speech"
  | "network"
  | "aborted"
  | "busy"
  | "unknown";

export interface SttTranscript {
  text: string;
  /** false 表示临时结果（interim），UI 可边听边显示 */
  final: boolean;
}

export interface SttOptions {
  lang?: SttLang;
  /** 持续识别：一次 start 里允许多次出结果（默认真） */
  continuous?: boolean;
  interim?: boolean;
  onTranscript?(transcript: SttTranscript): void;
  onError?(message: string, code: SttErrorCode): void;
  onStateChange?(listening: boolean): void;
}

export interface SttController {
  readonly supported: boolean;
  readonly listening: boolean;
  start(): boolean;
  /** 停止并等最后一个结果 */
  stop(): void;
  /** 立即丢弃 */
  abort(): void;
  setLang(lang: SttLang): void;
}

// ---------------------------------------------------------------- 最小 WebSpeech 类型

interface SpeechAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternativeLike;
}

interface SpeechResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getCtor() !== null;
}

const ERROR_MESSAGES: Record<string, { code: SttErrorCode; text: string }> = {
  "not-allowed": { code: "denied", text: "麦克风权限被拒绝：请在浏览器地址栏允许麦克风，或改用文字输入" },
  "service-not-allowed": { code: "denied", text: "浏览器禁止了语音识别服务：请改用文字输入" },
  "audio-capture": { code: "denied", text: "找不到麦克风设备：请插入麦克风，或改用文字输入" },
  "no-speech": { code: "no-speech", text: "没有听到声音，再说一次试试" },
  network: { code: "network", text: "语音识别需要网络，当前网络异常" },
  aborted: { code: "aborted", text: "语音识别已停止" },
  "invalid-state": { code: "busy", text: "语音识别已在进行中" },
};

export function createStt(options: SttOptions = {}): SttController {
  const ctor = getCtor();
  const onTranscript = options.onTranscript;
  const onError = options.onError;
  const onStateChange = options.onStateChange;

  let lang: SttLang = options.lang ?? "zh-CN";
  const continuous = options.continuous ?? true;
  const interim = options.interim ?? true;

  if (!ctor) {
    return {
      supported: false,
      listening: false,
      start() {
        onError?.(
          "当前浏览器不支持 Web Speech 语音识别（请用 Chrome / Edge，或改用文字与「按住说话」）",
          "unsupported",
        );
        return false;
      },
      stop() {},
      abort() {},
      setLang(next) {
        lang = next;
      },
    };
  }

  let recognition: SpeechRecognitionLike | null = null;
  let listening = false;
  /** 用户要求停止后不再自动拉起 */
  let wantListening = false;
  /** Chrome 在 start/stop 竞争时会抛 InvalidStateError，用它做重入护栏 */
  let starting = false;

  const setListening = (next: boolean) => {
    if (listening === next) return;
    listening = next;
    onStateChange?.(next);
  };

  const build = (): SpeechRecognitionLike => {
    const rec = new ctor();
    rec.lang = lang;
    rec.continuous = continuous;
    rec.interimResults = interim;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      starting = false;
      setListening(true);
    };

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        const text = alternative.transcript.trim();
        if (!text) continue;
        onTranscript?.({ text, final: result.isFinal });
      }
    };

    rec.onerror = (event) => {
      starting = false;
      const mapped = ERROR_MESSAGES[event.error];
      if (event.error !== "no-speech" && event.error !== "aborted") {
        wantListening = false;
      }
      onError?.(mapped?.text ?? `语音识别出错：${event.error}`, mapped?.code ?? "unknown");
      setListening(false);
    };

    rec.onend = () => {
      starting = false;
      setListening(false);
      // 持续识别：浏览器会在静音后自己结束，用户没喊停就重新拉起
      if (wantListening && recognition) {
        try {
          recognition.start();
          starting = true;
        } catch {
          wantListening = false;
        }
      }
    };

    return rec;
  };

  return {
    supported: true,
    get listening() {
      return listening;
    },
    start() {
      if (listening || starting) return true;
      wantListening = true;
      if (!recognition) recognition = build();
      recognition.lang = lang;
      try {
        recognition.start();
        starting = true;
        return true;
      } catch (err) {
        starting = false;
        wantListening = false;
        onError?.(`语音识别启动失败：${err instanceof Error ? err.message : String(err)}`, "busy");
        return false;
      }
    },
    stop() {
      wantListening = false;
      if (!recognition) return;
      try {
        recognition.stop();
      } catch {
        /* 忽略 */
      }
    },
    abort() {
      wantListening = false;
      if (!recognition) return;
      try {
        recognition.abort();
      } catch {
        /* 忽略 */
      }
      setListening(false);
    },
    setLang(next) {
      lang = next;
      if (recognition) recognition.lang = next;
    },
  };
}
