/**
 * 语音通道的外部信号（诊断区专用）。
 *
 * 为什么要有它：STT 的通道（Deepgram / WebSpeech / 无）与回退原因只有 App 那侧的
 * controller 知道，而 Diagnostics 是 Dock 深处的只读组件。走「模块级信号」的理由与
 * clipBus / illustrationRuntime 一致 —— 不为一行诊断把 props 从 App 一层层穿到 Dock。
 * 这里只存**通道名与原因码**，绝不存音频、转写或凭据。
 */

import { useSyncExternalStore } from "react";
import type { SttChannel, TtsTier, ZhTtsTier } from "./voiceStatus.ts";

export interface VoiceChannelSnapshot {
  stt: SttChannel;
  /** 英文合成档位（沿用旧字段名 `tts`，App 那侧已经在 patch 它） */
  tts: TtsTier;
  /** 中文合成档位：Edge 还是浏览器 */
  ttsZh: ZhTtsTier;
  /** 回退原因（如 ws-closed / not-configured）；null = 没回退过 */
  reason: string | null;
  /**
   * 中文语音的「非角色音色」提示：第一次用上本机合成音时写入一句人话。
   * 与 `reason`（STT 的回退原因）分开，避免两条线互相覆盖。
   */
  ttsNote: string | null;
}

const INITIAL: VoiceChannelSnapshot = {
  stt: "none",
  tts: "browser",
  ttsZh: "browser",
  reason: null,
  ttsNote: null,
};

let current: VoiceChannelSnapshot = INITIAL;
const listeners = new Set<() => void>();

export function reportVoiceChannel(patch: Partial<VoiceChannelSnapshot>): void {
  const next: VoiceChannelSnapshot = { ...current, ...patch };
  if (
    next.stt === current.stt &&
    next.tts === current.tts &&
    next.ttsZh === current.ttsZh &&
    next.reason === current.reason &&
    next.ttsNote === current.ttsNote
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

export function readVoiceChannel(): VoiceChannelSnapshot {
  return current;
}

/** 测试用：清回初始态 */
export function resetVoiceChannel(): void {
  current = INITIAL;
  for (const listener of listeners) listener();
}

export function useVoiceChannel(): VoiceChannelSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => INITIAL,
  );
}
