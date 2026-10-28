/**
 * 能力上报（`supportsSpeechStarted`）的客户端侧验证。
 *
 * 背景：阿里百炼 fun-asr 是**整段识别**，上游**不发** `speech_started`。
 * 客户端若仍按 `channel:"deepgram"` 判定，就会在这条通道上把「自动语音打断」
 * 当成可用 —— 实际上永远等不到那个信号（打断静默失效）。
 *
 * 修法（不伪造 speech_started）：服务端在 WS 建连后的第一条消息里上报能力，
 * 客户端读到后把自动打断切到 **energy VAD**（AEC / 回声门禁不变）。
 */
import { describe, expect, test } from "bun:test";
import { createDeepgramStt, type DeepgramSttDiagnostics } from "../../src/web/voice/deepgramStt";
import { resolveBargeInSource } from "../../src/web/voice/bargeInSource";
import { parseVoiceStatus } from "../../src/web/voice/voiceStatus";
import type { SttOptions } from "../../src/web/voice/stt";

class FakeSocket {
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  send(data: string | Blob | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  open(): void {
    this.onopen?.();
  }
  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function build() {
  const socket = new FakeSocket();
  const diagnostics: DeepgramSttDiagnostics[] = [];
  let speechStarted = 0;
  const stt = createDeepgramStt({
    lang: "zh-CN",
    deps: {
      openSocket: () => socket,
      getMic: async () => ({ getTracks: () => [{ stop() {} }] }) as never,
      createRecorder: () =>
        ({
          start() {},
          stop() {},
          ondataavailable: null,
          onerror: null,
        }) as never,
      createFallback: (_options: SttOptions) =>
        ({
          supported: false,
          listening: false,
          start: () => false,
          stop() {},
          abort() {},
          setLang() {},
        }) as never,
      sttUrl: () => "ws://test/api/stt",
    },
    onDiagnostic: (value) => diagnostics.push(value),
    onSpeechStarted: () => {
      speechStarted += 1;
    },
  });
  return { socket, diagnostics, stt, countSpeechStarted: () => speechStarted };
}

describe("能力上报：上游不发 speech_started → 客户端改走 energy VAD", () => {
  test("收到 capabilities(supportsSpeechStarted:false) → diagnostics 如实反映", async () => {
    const h = build();
    h.stt.prewarm();
    h.socket.open();
    h.socket.emit({ type: "capabilities", provider: "ali", supportsSpeechStarted: false });
    await flush();

    expect(h.stt.diagnostics.supportsSpeechStarted).toBe(false);
    expect(h.stt.diagnostics.provider).toBe("ali");
    // 关键：能力上报**不等于**伪造 speech_started（伪造比没有更糟）
    expect(h.countSpeechStarted()).toBe(0);
    h.stt.abort();
  });

  test("Deepgram 的能力消息 → 仍然是 deepgram 触发源（能量 VAD 只做电平显示）", async () => {
    const h = build();
    h.stt.prewarm();
    h.socket.open();
    h.socket.emit({ type: "capabilities", provider: "deepgram", supportsSpeechStarted: true });
    await flush();

    expect(h.stt.diagnostics.supportsSpeechStarted).toBe(true);
    const decision = resolveBargeInSource({
      bargeInEnabled: true,
      sttChannel: "deepgram",
      aec: "on",
      supportsSpeechStarted: h.stt.diagnostics.supportsSpeechStarted,
    });
    expect(decision.source).toBe("deepgram");
    h.stt.abort();
  });

  test("能力上报 → 触发源落到 energy（不是 none，也不动 AEC 门槛）", async () => {
    const h = build();
    h.stt.prewarm();
    h.socket.open();
    h.socket.emit({ type: "capabilities", provider: "ali", supportsSpeechStarted: false });
    await flush();

    const decision = resolveBargeInSource({
      bargeInEnabled: true,
      sttChannel: "deepgram",
      aec: "on",
      supportsSpeechStarted: h.stt.diagnostics.supportsSpeechStarted,
    });
    expect(decision.source).toBe("energy");
    expect(decision.reason).toBe("no-speech-started");
    expect(decision.energyForLevelOnly).toBe(false);
    h.stt.abort();
  });

  test("/api/voice/status 里的能力也能读到（老服务端没有这个字段 → 按 true 处理）", () => {
    expect(parseVoiceStatus({ stt: true, tts: true })?.supportsSpeechStarted).toBe(true);
    const ali = parseVoiceStatus({
      stt: true,
      tts: true,
      sttProvider: "ali",
      supportsSpeechStarted: false,
    });
    expect(ali?.supportsSpeechStarted).toBe(false);
    expect(ali?.sttProvider).toBe("ali");
  });
});
