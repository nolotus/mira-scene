/**
 * 假 STT provider（只由 `?stt=fake` 启用）：脚本化的「Deepgram」上游。
 *
 * 为什么要有它：验证「`speech_started` 真的能一路穿到打断」需要一条会**按时**吐出
 * `speech_started` / `interim` / `final` 的上游，而真机验证需要 Deepgram key + 会说话的人。
 * 这个替身把 key 那一段换掉，**其余全是生产代码**：它只注入 `deps`
 * （WS / 麦克风 / MediaRecorder），客户端仍是 `createDeepgramStt` 原样的那一套 ——
 * 包括消息解析、预建连、以及打断链路。所以它证明的不是「测试替身能不能打断」，
 * 而是「上游发出 speech_started 后，客户端能不能观察到并走完打断」。
 *
 * 脚本（相对「连接就绪」的时刻，可用 `?stt=fake&fakeSpeech=…` 之外仅测试注入覆盖）：
 *   +300ms  {"type":"speech_started"}
 *   +500ms  {"type":"interim","text":"停一下"}     ← speech_started 之后 200ms
 *   +800ms  {"type":"final","text":"停一下"}       ← interim 之后 300ms
 *
 * 麦克风是假的，但 `track.getSettings()` 会如实报 `echoCancellation: true`：
 * 这样 `aec=on` 这条前提在无麦克风的 headless 环境里也能成立（否则按新规则
 * 「unknown 不自动打断」，脚本永远走不到打断那一步）。要验证反例，用
 * `?stt=fake&aec=unknown` / `?stt=fake&aec=off` 把实测值强制成对应状态。
 *
 * 它**不**记录音频内容，也不连任何网络：send() 只统计帧数与文本帧，供测试断言。
 */

import type { AecState } from "./bargeInGate";
import {
  createDeepgramStt,
  type DeepgramSttController,
  type DeepgramSttDeps,
  type DeepgramSttOptions,
  type MediaStreamLike,
  type RecorderLike,
  type VoiceSocketLike,
} from "./deepgramStt";

/** 脚本时刻（相对 WS 就绪）；单位 ms */
export interface FakeSttScript {
  /** WS 握手耗时（真机实测约 1s，这里默认 120ms，够让「预建连期音频」这条路径被走到） */
  openMs: number;
  /** 连接就绪 → `speech_started` */
  speechStartedMs: number;
  /** 连接就绪 → `interim`（= speech_started 之后 200ms） */
  interimMs: number;
  /** 连接就绪 → `final`（= interim 之后 300ms） */
  finalMs: number;
  text: string;
  /** 每 100ms 一块假音频 */
  chunkMs: number;
}

export const DEFAULT_FAKE_STT_SCRIPT: FakeSttScript = {
  openMs: 120,
  speechStartedMs: 300,
  interimMs: 500,
  finalMs: 800,
  text: "停一下",
  chunkMs: 100,
};

export function parseFakeSttFlag(search: string): boolean {
  const raw = (new URLSearchParams(search).get("stt") ?? "").trim().toLowerCase();
  return raw === "fake";
}

/** `?aec=unknown|off`：把「麦克风实测的 AEC」强制成对应状态（只用于假上游验证） */
export function parseFakeAecOverride(search: string): AecState | null {
  const raw = (new URLSearchParams(search).get("aec") ?? "").trim().toLowerCase();
  if (raw === "on") return "on";
  if (raw === "off") return "off";
  if (raw === "unknown") return "unknown";
  return null;
}

/** 断言用的观察面：客户端到底发了什么、上游到底发了什么 */
export interface FakeSttProbe {
  /** 客户端发到上游的音频帧数（不含文本控制帧） */
  audioFrames(): number;
  /** 客户端发到上游的文本控制帧（finish_utterance 等） */
  controlFrames(): string[];
  /** 上游按脚本吐出的消息类型 */
  emitted(): string[];
  /** WS 是否就绪 */
  ready(): boolean;
  /** 手动补发一条（测试里造边角场景用） */
  emit(message: Record<string, unknown>): void;
  /** 清掉所有待触发的脚本（abort 之后不再有幽灵消息） */
  dispose(): void;
}

export interface FakeSttHarness {
  controller: DeepgramSttController;
  probe: FakeSttProbe;
}

/**
 * 造一条假上游 + 假麦克风，并把它们塞进**真实的** `createDeepgramStt`。
 * `options.deps` 会被忽略：这个函数的意义就是提供整套替身。
 */
export function createFakeStt(
  options: DeepgramSttOptions & {
    script?: Partial<FakeSttScript>;
    /** 强制「麦克风实测 AEC」的结果（`?stt=fake&aec=unknown|off` 走这里） */
    aecOverride?: AecState | null;
  } = {},
): FakeSttHarness {
  const script: FakeSttScript = { ...DEFAULT_FAKE_STT_SCRIPT, ...(options.script ?? {}) };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const controls: string[] = [];
  const emitted: string[] = [];
  let audioFrames = 0;
  let socketReady = false;
  let socket: FakeSocket | null = null;

  const later = (ms: number, fn: () => void): void => {
    const handle = setTimeout(() => {
      timers.delete(handle);
      fn();
    }, ms);
    timers.add(handle);
  };

  class FakeSocket implements VoiceSocketLike {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event?: unknown) => void) | null = null;
    onerror: ((event?: unknown) => void) | null = null;
    closed = false;

    constructor() {
      later(script.openMs, () => {
        if (this.closed) return;
        socketReady = true;
        this.onopen?.();
        // 脚本从「连接就绪」开始计时（brief 的 300/200/300 就是这个口径）
        later(script.speechStartedMs, () => this.deliver({ type: "speech_started" }));
        later(script.interimMs, () => this.deliver({ type: "interim", text: script.text }));
        later(script.finalMs, () => this.deliver({ type: "final", text: script.text }));
      });
    }

    deliver(message: Record<string, unknown>): void {
      if (this.closed) return;
      emitted.push(String(message.type));
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    send(data: string | Blob | ArrayBufferLike | ArrayBufferView): void {
      if (typeof data === "string") controls.push(data);
      else audioFrames += 1;
    }

    close(): void {
      this.closed = true;
      socketReady = false;
      this.onclose?.({ code: 1000 });
    }
  }

  const stream: MediaStreamLike = {
    getTracks: () => [{ stop: () => {} }],
    // 假麦克风如实报「回声消除生效」：没有这一条，新规则下 aec 永远 unknown，
    // 脚本永远走不到打断那一步（那是 `?aec=unknown` 那个反例要的场面）
    getAudioTracks: () => [
      {
        getSettings: () => {
          const aec = options.aecOverride ?? "on";
          const settings: Record<string, unknown> = {
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48_000,
            channelCount: 1,
          };
          // unknown = 浏览器不报这个字段（如实模拟），而不是报 true
          if (aec === "on") settings.echoCancellation = true;
          if (aec === "off") settings.echoCancellation = false;
          return settings;
        },
      },
    ],
  };

  const deps: DeepgramSttDeps = {
    openSocket: () => {
      socket = new FakeSocket();
      return socket;
    },
    getMic: async () => stream,
    createRecorder: (): RecorderLike => {
      let interval: ReturnType<typeof setInterval> | null = null;
      const recorder: RecorderLike = {
        ondataavailable: null,
        onerror: null,
        onstop: null,
        start(timeslice?: number) {
          const every = timeslice ?? script.chunkMs;
          interval = setInterval(() => {
            recorder.ondataavailable?.({ data: new Blob([new Uint8Array(8)]) });
          }, every);
        },
        stop() {
          if (interval !== null) clearInterval(interval);
          interval = null;
          recorder.onstop?.();
        },
      };
      return recorder;
    },
    // 走不到 Web Speech：假上游让 deepgramUsable() 永远成立
    sttUrl: () => "ws://fake-stt.local/api/stt",
  };

  const controller = createDeepgramStt({ ...options, deps });

  const probe: FakeSttProbe = {
    audioFrames: () => audioFrames,
    controlFrames: () => [...controls],
    emitted: () => [...emitted],
    ready: () => socketReady,
    emit: (message) => socket?.deliver(message),
    dispose: () => {
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
  };

  return { controller, probe };
}
