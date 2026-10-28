/**
 * 语音通道能力（客户端侧）：`GET /api/voice/status` 的唯一读取点。
 *
 * 语义只有一个：**有没有**。没有 key 时 stt/tts 都是 false —— 这是正常态，
 * 客户端据此走 Web Speech / 浏览器 TTS，不需要报错、不要红字。
 * 网络失败 = 未知 → 返回 null，调用方按「两个都不可用」处理（宁可回退，也不要卡在等待里）。
 */

export interface VoiceStatus {
  stt: boolean;
  tts: boolean;
  sttModel: string;
}

export function parseVoiceStatus(raw: unknown): VoiceStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  return {
    stt: record.stt === true,
    tts: record.tts === true,
    sttModel: typeof record.sttModel === "string" ? record.sttModel : "nova-2",
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
export type TtsTier = "deepgram" | "browser";

/** 诊断区文案：STT=Deepgram/WebSpeech/无 · TTS=Deepgram/浏览器 */
export function sttChannelLabel(channel: SttChannel): string {
  if (channel === "deepgram") return "Deepgram";
  if (channel === "webspeech") return "WebSpeech";
  return "无";
}

export function ttsTierLabel(tier: TtsTier): string {
  return tier === "deepgram" ? "Deepgram" : "浏览器";
}
