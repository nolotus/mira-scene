/**
 * 采集端约束与「AEC 到底生效了没有」的实测读取。
 *
 * 为什么必须实测而不是信自己传的约束：`getUserMedia({audio:{echoCancellation:true}})`
 * 只是**请求**，浏览器可以静默忽略（旧设备驱动、Safari 的部分版本、虚拟机/无声卡的
 * headless 环境都会这么干）。不确认的话，「自动打断」就会变成「角色自己打断自己」，
 * 而且从代码上看一切正常 —— 这类 bug 只能靠 `track.getSettings()` 实测兜住。
 *
 * 唯一可信的读法：拿到 stream 后读 `getAudioTracks()[0].getSettings().echoCancellation`：
 *   · `true`    → AEC 真的在跑（`aec: "on"`）
 *   · `false`   → 被忽略了（`aec: "off"`）→ 上层自动退回「不自动打断」
 *   · `undefined` / 读不到 → 未知（`aec: "unknown"`），按 `allowWhenAecUnknown` 决定
 */

import type { AecState } from "./bargeInGate";

/** 语音打断必须开的三件事：回声消除、降噪、自动增益 */
export const BARGE_IN_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

/** 每次 getMic 都用一份新对象（避免被上游 mutate 后影响下一次） */
export function bargeInAudioConstraints(): MediaTrackConstraints {
  return { ...BARGE_IN_AUDIO_CONSTRAINTS };
}

export interface AppliedMicSettings {
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  sampleRate: number | null;
  channelCount: number | null;
  /** 是否真的读到了 getSettings（false = 浏览器/替身不支持，全部字段为 null） */
  readable: boolean;
}

/** 结构化的最小接口：只依赖我们真正用到的两个方法，测试替身好造 */
export interface MicStreamLike {
  getAudioTracks?(): Array<{ getSettings?(): unknown }>;
}

const EMPTY_SETTINGS: AppliedMicSettings = {
  echoCancellation: null,
  noiseSuppression: null,
  autoGainControl: null,
  sampleRate: null,
  channelCount: null,
  readable: false,
};

function boolOf(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 读实际生效的采集设置。任何一步缺失都降级成 null，绝不抛错（采集已经在跑了）。 */
export function readAppliedMicSettings(stream: unknown): AppliedMicSettings {
  try {
    const candidate = stream as MicStreamLike | null | undefined;
    const track = candidate?.getAudioTracks?.()?.[0];
    if (!track || typeof track.getSettings !== "function") return { ...EMPTY_SETTINGS };
    const raw = (track.getSettings() ?? {}) as Record<string, unknown>;
    return {
      echoCancellation: boolOf(raw.echoCancellation),
      noiseSuppression: boolOf(raw.noiseSuppression),
      autoGainControl: boolOf(raw.autoGainControl),
      sampleRate: numOf(raw.sampleRate),
      channelCount: numOf(raw.channelCount),
      readable: true,
    };
  } catch {
    return { ...EMPTY_SETTINGS };
  }
}

/** `true` → on，`false` → off（实测被忽略），读不到 → unknown */
export function aecStateOf(settings: AppliedMicSettings): AecState {
  if (settings.echoCancellation === true) return "on";
  if (settings.echoCancellation === false) return "off";
  return "unknown";
}

/** 一行给人看的诊断（进 Dock 的 note 与 console，不弹窗） */
export function describeAppliedMicSettings(settings: AppliedMicSettings): string {
  if (!settings.readable) return "读不到麦克风实测设置（浏览器不支持 getSettings），无法确认回声消除是否生效";
  const flag = (value: boolean | null): string =>
    value === true ? "开" : value === false ? "被忽略" : "未报";
  const extra: string[] = [];
  if (settings.sampleRate !== null) extra.push(`${Math.round(settings.sampleRate / 1000)}kHz`);
  if (settings.channelCount !== null) extra.push(`${settings.channelCount}ch`);
  const suffix = extra.length > 0 ? `（${extra.join(" ")}）` : "";
  return `麦克风实测：回声消除${flag(settings.echoCancellation)}、降噪${flag(settings.noiseSuppression)}、自动增益${flag(settings.autoGainControl)}${suffix}`;
}

// ---------------------------------------------------------------- 模块级上报

/**
 * 设置是在 voice/deepgramStt 里读到的，而闸门在 App 里用 —— 不为一份只读诊断把端口
 * 一层层穿下去（与 voiceDiag / clipBus 同一套做法）。
 */
export interface MicDiagnostics {
  settings: AppliedMicSettings;
  aec: AecState;
  /** 给人看的一句话（null = 还没读过） */
  note: string | null;
}

const INITIAL_DIAGNOSTICS: MicDiagnostics = {
  settings: { ...EMPTY_SETTINGS },
  aec: "unknown",
  note: null,
};

let current: MicDiagnostics = INITIAL_DIAGNOSTICS;

export function reportAppliedMicSettings(settings: AppliedMicSettings): MicDiagnostics {
  current = {
    settings,
    aec: aecStateOf(settings),
    note: describeAppliedMicSettings(settings),
  };
  return current;
}

export function readMicDiagnostics(): MicDiagnostics {
  return current;
}

/** 只读当前 AEC 状态（闸门在每次判定时现查，不等 React 渲染） */
export function readAecState(): AecState {
  return current.aec;
}

/** 测试用：清回初始态 */
export function resetMicDiagnostics(): void {
  current = INITIAL_DIAGNOSTICS;
}
