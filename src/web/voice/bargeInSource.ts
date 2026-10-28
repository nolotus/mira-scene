/**
 * 「谁有权触发自动打断」——**单一触发源**的解析（纯函数，不碰 DOM/定时器）。
 *
 * 为什么必须有这一层：同一时刻只允许一个东西把「用户开口了」翻译成打断。
 * 真机踩过：Deepgram 的 `speech_started` 与 `MicEnergyVad.onSpeech` 同时在跑，
 * 结果打断确实发生了、时间线也自洽，但触发源是能量阈值 —— 等于「语音打断」这件事
 * 只在表面上成立（能量阈值分不清用户和外放的 TTS 回声，AEC 一失效它就会自己打断自己）。
 * 两个源各自都能「看起来正常」，所以只能在结构上保证只有一个能调 `store.onUserSpeech`。
 *
 * 优先级（`resolveBargeInSource`）：
 *   ① `?bargeIn=off`                        → none（用户明确关了）
 *   ② AEC 实测 **不是** `true`               → none（见下）
 *   ③ STT 通道是 deepgram / fake（假上游）    → deepgram
 *   ④ STT 通道是 webspeech / none            → energy（Deepgram 不可用时的回退）
 *
 * ② 为什么放在 ③④ 之前：回声消除是「自动打断」唯一的事实前提。
 *   `unknown`（浏览器不报 `getSettings().echoCancellation`）**不等于**有 AEC ——
 *   旧实现把 unknown 当放行，等于「不知道有没有回声消除也自动打断」，
 *   代价是她会被自己的声音打断。现在 unknown 与 `false`（实测被忽略）同等处理：
 *   不自动打断，只有实测 `echoCancellation === true` 才启用。
 *
 * 注意 `energy` 与 `deepgram` 的区别只在于「信号从哪来」，AEC 门槛对两者一致：
 * 能量阈值更怕回声，所以更不能在 AEC 不确定时放它进来。
 */

import type { AecState } from "./bargeInGate";

/** 自动打断的触发源：Deepgram 服务端 VAD / 能量 VAD / 没有（不自动打断） */
export type BargeInSource = "deepgram" | "energy" | "none";

export type BargeInSourceReason =
  /** `?bargeIn=off` */
  | "disabled"
  /** Deepgram（或 `?stt=fake` 的假上游）的 `speech_started` 是唯一触发源 */
  | "deepgram"
  /** Deepgram 不可用 → 回退能量 VAD（AEC 已实测生效） */
  | "energy"
  /** AEC 实测被忽略（`echoCancellation === false`） */
  | "aec-off"
  /** AEC 读不到（浏览器不报这个字段）→ 按「没有」处理 */
  | "aec-unknown";

export interface BargeInSourceInput {
  /** `?bargeIn=` 解析结果 */
  bargeInEnabled: boolean;
  /** 当前 STT 通道（`fake` = `?stt=fake` 的脚本化假上游，顶替 Deepgram） */
  sttChannel: "deepgram" | "fake" | "webspeech" | "none";
  /** 麦克风轨道实测 AEC 状态 */
  aec: AecState;
}

export interface BargeInSourceDecision {
  source: BargeInSource;
  reason: BargeInSourceReason;
  /** 一行给人看的诊断（控制台 / 时间线 / `window.__miraBargeInTrace.source`） */
  detail: string;
  /** 能量 VAD 还要不要跑：`true` = 只做电平显示，**不许**触发打断 */
  energyForLevelOnly: boolean;
}

const AEC_WHY: Record<AecState, string> = {
  on: "回声消除实测生效",
  off: "浏览器实测 echoCancellation=false（约束被忽略）",
  // 这句必须说清「不是我们没做」：是浏览器不报这个字段，我们拿不到依据
  unknown: "浏览器没报 getSettings().echoCancellation，无法区分你和回声",
};

export function resolveBargeInSource(input: BargeInSourceInput): BargeInSourceDecision {
  const { bargeInEnabled, sttChannel, aec } = input;
  const fake = sttChannel === "fake";

  if (!bargeInEnabled) {
    return {
      source: "none",
      reason: "disabled",
      detail: "barge-in source: none (bargeIn=off) — 只保留 Esc / 按钮打断",
      energyForLevelOnly: true,
    };
  }

  if (aec === "unknown") {
    return {
      source: "none",
      reason: "aec-unknown",
      detail:
        "barge-in source: none (aec-unknown) — " +
        `${AEC_WHY.unknown}；只有 echoCancellation===true 才自动打断，现在请用 Esc / 「打断」按钮`,
      energyForLevelOnly: true,
    };
  }

  if (aec === "off") {
    // 明确知道没有 AEC 时**不是**全关，而是退回能量 VAD：那条路有自己的回声守卫
    // （SpeakingSnapshot.sinceSpeechStartMs 的禁声窗口，见 state/bargeIn.ts），
    // 而 Deepgram 的 speech_started 在无 AEC 时会被外放直接点亮 —— 后者更不能信。
    return {
      source: "energy",
      reason: "aec-off",
      detail:
        "barge-in source: energy (aec-off) — " +
        `${AEC_WHY.off}；Deepgram 的 speech_started 在无 AEC 时会被外放点亮，` +
        "改用能量 VAD（带自己的回声禁声窗口）",
      energyForLevelOnly: false,
    };
  }

  const deepgramAvailable = sttChannel === "deepgram" || fake;
  if (deepgramAvailable) {
    return {
      source: "deepgram",
      reason: "deepgram",
      detail:
        `barge-in source: deepgram (aec=on) — ${fake ? "?stt=fake 的脚本化上游" : "Deepgram speech_started"}` +
        " → 200ms 内等 interim 确认；能量 VAD 不启动（单一触发源）",
      energyForLevelOnly: true,
    };
  }

  return {
    source: "energy",
    reason: "energy",
    detail:
      `barge-in source: energy (aec=on) — Deepgram 不可用，回退能量 VAD；` +
      "阈值分不清你和回声，打断会比 Deepgram 偏灵敏",
    energyForLevelOnly: false,
  };
}

/** 是否有任何自动触发源（none 时只有 Esc / 按钮 / 打字能打断） */
export function isAutoTrigger(decision: BargeInSourceDecision): boolean {
  return decision.source !== "none";
}
