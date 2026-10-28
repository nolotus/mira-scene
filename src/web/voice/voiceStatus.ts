/**
 * 语音通道能力（客户端侧）：`GET /api/voice/status` 的唯一读取点。
 *
 * 语义只有一个：**有没有**。没有 key 时 stt/tts 都是 false —— 这是正常态，
 * 客户端据此走 Web Speech / 浏览器 TTS，不需要报错、不要红字。
 * 网络失败 = 未知 → 返回 null，调用方按「两个都不可用」处理（宁可回退，也不要卡在等待里）。
 */

export interface VoiceStatus {
  stt: boolean;
  /** Deepgram key 是否配置（英文合成 + 语音识别） */
  tts: boolean;
  sttModel: string;
  /** 本地 `edge-tts` CLI 是否可用（中文合成；服务端启动时探测一次） */
  ttsZh: boolean;
  /**
   * 上游**会不会**发 `speech_started`（默认 true = 会发）。
   *
   * 阿里百炼 fun-asr 是整段识别，**不发**它 → 客户端不能拿它做「用户开口」的
   * 打断触发源，必须改走 energy VAD（服务端不伪造 speech_started）。
   */
  supportsSpeechStarted: boolean;
  /** 实际在用的 STT provider（`ali` / `deepgram` / `none`） */
  sttProvider: "ali" | "deepgram" | "none";
}

export function parseVoiceStatus(raw: unknown): VoiceStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const provider = record.sttProvider;
  return {
    stt: record.stt === true,
    tts: record.tts === true,
    sttModel: typeof record.sttModel === "string" ? record.sttModel : "nova-2",
    // 老服务端没有这个字段 → false → 中文回退浏览器（保守但永远可用）
    ttsZh: record.ttsZh === true,
    // 老服务端没有这个字段 → true（按「会发」处理，与改造前行为一致）
    supportsSpeechStarted: record.supportsSpeechStarted !== false,
    sttProvider: provider === "ali" || provider === "deepgram" ? provider : "none",
  };
}

export async function fetchVoiceStatus(
  fetcher: typeof fetch = fetch,
  url = "/api/voice/status",
): Promise<VoiceStatus | null> {
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return parseVoiceStatus(await res.json());
  } catch {
    return null;
  }
}

export type SttChannel = "deepgram" | "webspeech" | "none";
/** 英文合成档位（Deepgram Aura / 浏览器） */
export type TtsTier = "deepgram" | "browser";
/** 中文合成档位（Edge 本机 CLI / 浏览器） */
export type ZhTtsTier = "edge" | "browser";

/** 诊断区文案：STT=Deepgram/WebSpeech/无 */
export function sttChannelLabel(channel: SttChannel): string {
  if (channel === "deepgram") return "Deepgram";
  if (channel === "webspeech") return "WebSpeech";
  return "无";
}

/** 诊断区文案：TTS(英文)=Deepgram/浏览器 */
export function ttsTierLabel(tier: TtsTier): string {
  return tier === "deepgram" ? "Deepgram" : "浏览器";
}

/** 诊断区文案：TTS(中文)=Edge/浏览器 */
export function ttsZhLabel(tier: ZhTtsTier): string {
  return tier === "edge" ? "Edge" : "浏览器";
}
