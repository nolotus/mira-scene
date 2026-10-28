/**
 * 角色音色档案：**唯一**的「这个角色怎么说话」数据源。
 *
 * 为什么放在 `src/shared/` 而不是 `src/web/stage/scenes/`：
 * 服务端要用它拼 `edge-tts --voice/--rate/--pitch`，客户端要用它对齐浏览器回退，
 * 而 `src/server/**` 不能 import `src/web/**`（跨构建）。放 shared 才能同一份数据两头用，
 * 也避免「服务端参数改了、回退音色没改」这种最难查的不一致。
 *
 * 为什么是 -8% / -3Hz：角色的设定是 26 岁旅行摄影师、深夜在等人 ——
 * 默认的 Xiaoxiao 是明亮偏快的播报腔，语速放慢 8%、音高降 3Hz 之后才像「累但还愿意说话」。
 * 这两个数字是**听感取值**，不是客观测量结果：只有 round-trip（Edge → Deepgram STT conf=1.00）
 * 证明过可懂度，没有证明过「像角色」。想改就改这里一处，缓存键会跟着变（不会命中旧音频）。
 *
 * 环境变量覆盖：`EDGE_TTS_VOICE` / `EDGE_TTS_RATE` / `EDGE_TTS_PITCH`。
 */

export interface CharacterVoice {
  /** 目前只有 Edge（Deepgram Aura 没有中文音色） */
  provider: "edge";
  /** Edge 音色名，如 `zh-CN-XiaoxiaoNeural` */
  voice: string;
  /** Edge 语速，带符号的百分比字符串，如 `-8%` */
  rate: string;
  /** Edge 音高，带符号的 Hz 字符串，如 `-3Hz` */
  pitch: string;
  /** 人话描述，只用于诊断文案，不参与合成 */
  label: string;
}

export const CHARACTER_VOICE: CharacterVoice = {
  provider: "edge",
  voice: "zh-CN-XiaoxiaoNeural",
  rate: "-8%",
  pitch: "-3Hz",
  label: "深夜疲惫但不失温度",
};

/** Edge 的 `+0%` / `-8%` 形态校验：非法值不接受（宁可用默认，也不让 CLI 报错） */
const RATE_PATTERN = /^[+-]\d{1,3}%$/;
const PITCH_PATTERN = /^[+-]\d{1,3}Hz$/;

function pick(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : fallback;
}

/**
 * 解析生效的音色档案。env 里给了非法格式就回默认值 ——
 * 一个手滑的 `EDGE_TTS_RATE=slow` 不该让整条中文语音瘫掉。
 */
export function resolveCharacterVoice(
  env: Record<string, string | undefined>,
): CharacterVoice {
  const rate = pick(env.EDGE_TTS_RATE, CHARACTER_VOICE.rate);
  const pitch = pick(env.EDGE_TTS_PITCH, CHARACTER_VOICE.pitch);
  const voice = pick(env.EDGE_TTS_VOICE, CHARACTER_VOICE.voice);
  return {
    provider: "edge",
    voice,
    rate: RATE_PATTERN.test(rate) ? rate : CHARACTER_VOICE.rate,
    pitch: PITCH_PATTERN.test(pitch) ? pitch : CHARACTER_VOICE.pitch,
    label: voice === CHARACTER_VOICE.voice ? CHARACTER_VOICE.label : `${CHARACTER_VOICE.label}（${voice}）`,
  };
}

/** `-8%` → `0.92`（SpeechSynthesisUtterance.rate 是倍率，1 = 正常） */
export function browserRateOf(rate: string): number {
  const matched = /^([+-])(\d{1,3})%$/.exec(rate.trim());
  if (!matched) return 1;
  const delta = Number(matched[2]) / 100;
  const value = matched[1] === "-" ? 1 - delta : 1 + delta;
  // 浏览器对 rate 的有效区间很窄，夹一下避免 0 或负数
  return Math.min(2, Math.max(0.5, Number(value.toFixed(2))));
}

/**
 * `-3Hz` → `0.97`（SpeechSynthesisUtterance.pitch 是 0–2 的无量纲值，1 = 正常）。
 * 这是**近似映射**：Edge 的 Hz 是绝对音高偏移，浏览器的 pitch 是相对倍率，
 * 两者没有严格换算关系，这里按 100Hz ≈ 1.0 粗略对齐方向与幅度。
 */
export function browserPitchOf(pitch: string): number {
  const matched = /^([+-])(\d{1,3})Hz$/.exec(pitch.trim());
  if (!matched) return 1;
  const delta = Number(matched[2]) / 100;
  const value = matched[1] === "-" ? 1 - delta : 1 + delta;
  return Math.min(2, Math.max(0.5, Number(value.toFixed(2))));
}

/** 诊断区一句话：角色音色的可读摘要（不含任何凭据） */
export function characterVoiceLabel(voice: CharacterVoice): string {
  return `${voice.voice} ${voice.rate}/${voice.pitch} · ${voice.label}`;
}
