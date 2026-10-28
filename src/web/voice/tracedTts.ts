/**
 * 给 TTS 套一层「音频停止时刻」探针（只为 `?trace=1` 的时间线服务）。
 *
 * 为什么要套在 TTS 上而不是在 store 里打点：`cancel()` 是**唯一**让声音真的停下来的
 * 地方（BrowserTTS 走 speechSynthesis.cancel()，StreamTTS 走 sourceNode.stop()），
 * 而 store 只知道「我调了 cancel」，不知道它什么时候返回。套在这里能拿到
 * 「speech_started → 音频真的停」这条用户可感知的延迟。
 *
 * 代理必须原样保留：name / isSpeaking 取值器、pushChunk（StreamTTS 的音频分片入口）、
 * warmUp（AudioContext 必须在用户手势里创建）。丢一个就会有功能静默失效。
 */

import { markTrace } from "./bargeInTrace";
import type { AudioChunk, AudioChunkSink, TTSProvider } from "./tts";

export function withAudioTrace<T extends TTSProvider>(tts: T): T {
  const sink = (tts as Partial<AudioChunkSink>).pushChunk;
  const warmUp = (tts as Partial<{ warmUp(): void }>).warmUp;

  const proxy = {
    get name(): string {
      return tts.name;
    },
    get isSpeaking(): boolean {
      return tts.isSpeaking;
    },
    speak(text: string): void {
      markTrace("tts:speak", `${text.length} 字`);
      tts.speak(text);
    },
    flush(): void {
      tts.flush();
    },
    cancel(): void {
      markTrace("audio:cancel");
      try {
        tts.cancel();
      } finally {
        // cancel() 是同步的（这是 TTSProvider 的契约）：返回即「声音已经没了」
        markTrace("audio:stopped");
      }
    },
    dispose(): void {
      tts.dispose();
    },
  } as T;

  if (sink) {
    (proxy as TTSProvider & Partial<AudioChunkSink>).pushChunk = (chunk: AudioChunk): void => {
      sink.call(tts, chunk);
    };
  }
  if (warmUp) {
    (proxy as TTSProvider & Partial<{ warmUp(): void }>).warmUp = (): void => {
      warmUp.call(tts);
    };
  }

  return proxy;
}
