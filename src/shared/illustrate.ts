/**
 * 生成式插图 —— 前后端共用的一份契约。
 *
 * 放在 shared/ 的原因：**prompt 是缓存键的一半**。
 *   服务端拿 sha256(prompt) 当进程内缓存键，客户端拿 prompt 本身当 localStorage 键。
 * 两边必须由同一个纯函数产生，否则「同一场景在服务端算一次、在客户端又算一次」永远对不上。
 *
 * 这里只有纯函数与类型，没有任何 fetch / env / DOM：
 * 服务端 http 细节在 server/illustrate.ts，客户端状态机在 web/stage/illustration/。
 */

/**
 * 固定角色前缀 —— 「外观连续」的全部赌注都在这一段。
 *
 * 每一张插图都要能让观众认出是同一个 Mira：同一个年龄、同一件雨衣、同一个发夹、
 * 同一个夜晚、同一家即将打烊的咖啡馆、同一层胶片颗粒。所以这六个特征写成固定短语，
 * 不随 beat 变化；变化的部分只能追加在后面（BEAT_CLAUSE / SCENE_CLAUSE / VARIANT_CLAUSE）。
 */
export const PROMPT_PREFIX = [
  "Cinematic 35mm film photograph, stormy night,",
  "26-year-old female travel photographer with a small silver star hair clip,",
  "wearing a wet amber raincoat,",
  "standing inside a small cafe that is about to close,",
  "heavy rain streaking the windows, cold blue lightning mixed with warm tungsten light,",
  "shallow depth of field, visible film grain, muted teal and amber palette,",
  "no text, no watermark, no logo, no caption.",
].join(" ");

/** beat 专属情境：只描述「这一幕发生什么」，绝不重复角色外观 */
export const BEAT_CLAUSE = {
  /** 雷雨命中：闪电、窗玻璃反光 */
  storm: "A lightning flash lights up the raindrop reflections on the window glass, hard rim light on her shoulder.",
  /** 望向雨夜街道 / 电话那端 */
  window_call: "She looks out through the rain-soaked window at the empty street, half-lit profile, far streetlights as bokeh.",
  /** 暖场：咖啡杯特写 */
  warm: "Close-up of the coffee cup on the wooden counter under warm light, steam rising, her hand just inside the frame.",
  /** 没有专属情境时的兜底：仍然是她、仍然是这个夜 */
  default: "She sits quietly at the counter and listens, rain moving behind her.",
} as const;

export type BeatClauseId = keyof typeof BEAT_CLAUSE;

/** 场景变体只微调环境，不改角色（否则「连续」就断了） */
export const SCENE_CLAUSE: Record<string, string> = {
  cafe_night: "The cafe is almost empty, hanging lamps low over the counter.",
  cafe_closing: "The cafe is closing down, half the lamps already off, chairs stacked.",
  window_rain: "The frame is dominated by the rain-covered window onto the street.",
};

/** variant 只是「同一幕的另一个机位」，用来让同一 beat 也能产出不同画面 */
export const VARIANT_CLAUSE: Record<string, string> = {
  wide: "Wide shot, the whole counter and the window in frame.",
  close: "Tight close-up, face and raincoat collar filling the frame.",
  over_shoulder: "Over-the-shoulder shot from behind her toward the rainy street.",
};

/** beatId 归一：导演层 / 片段层用的是不同命名（storm-strip、warm_beat…），这里统一成一个词 */
export function normalizeBeat(beatId: string | null | undefined): BeatClauseId {
  const raw = (beatId ?? "").trim().toLowerCase();
  if (raw === "storm" || raw.startsWith("storm-") || raw === "storm_beat") return "storm";
  if (raw === "window_call" || raw === "window" || raw === "window_call_beat") return "window_call";
  if (raw === "warm" || raw === "warm_beat" || raw === "warmth") return "warm";
  return "default";
}

/**
 * prompt 纯函数：同一 (scene, beatId) 永远得到同一段文本。
 * 这是缓存、配额、以及「同一会话不重复请求」三件事共同的前提。
 */
export function buildPrompt(scene: string | null | undefined, beatId: string | null | undefined): string {
  const beat = normalizeBeat(beatId);
  const sceneKey = (scene ?? "").trim().toLowerCase();
  const sceneClause = SCENE_CLAUSE[sceneKey] ?? SCENE_CLAUSE.cafe_night ?? "";
  return `${PROMPT_PREFIX} ${BEAT_CLAUSE[beat]} ${sceneClause}`.replace(/\s+/g, " ").trim();
}

/** 机位变体追加在最后：不进 buildPrompt 的签名，但进缓存键（所以要在拼 prompt 时带上） */
export function variantClause(variant: string | null | undefined): string {
  const key = (variant ?? "").trim().toLowerCase();
  if (!key) return "";
  return VARIANT_CLAUSE[key] ?? "";
}

/** 服务端 / 客户端共用的完整 prompt（含机位变体） */
export function buildPromptWithVariant(
  scene: string | null | undefined,
  beatId: string | null | undefined,
  variant?: string | null,
): string {
  const extra = variantClause(variant);
  const base = buildPrompt(scene, beatId);
  return extra ? `${base} ${extra}`.replace(/\s+/g, " ").trim() : base;
}

// ------------------------------------------------------------------ 线上契约

export interface IllustrateRequest {
  sessionId: string;
  beatId: string;
  scene?: string;
  /** 同一幕的另一个机位；参与缓存键 */
  variant?: string;
}

/**
 * 失败原因码。前两个是「正常状态」，客户端必须**不显示失败样式**：
 *   · not-configured：服务端没配 CF_ACCOUNT_ID / CF_AI_TOKEN（零密钥环境下这是常态）
 *   · session-limit / daily-limit：配额用尽，静默回落
 */
export type IllustrateReason =
  | "not-configured"
  | "no-session"
  | "bad-request"
  | "session-limit"
  | "daily-limit"
  | "upstream";

export type IllustrateResponse =
  | {
      ok: true;
      /** 直接可用的 data URL：`data:image/jpeg;base64,...` */
      dataUrl: string;
      /** 命中进程内缓存（同 prompt 第二人不重复烧钱） */
      cached: boolean;
      /** 服务端侧耗时（毫秒），不含网络 */
      ms: number;
    }
  | { ok: false; reason: IllustrateReason };

/** 正常状态（不是错误）：客户端据此静默降级，不写失败样式 */
export function isExpectedSkip(reason: IllustrateReason): boolean {
  return reason === "not-configured" || reason === "session-limit" || reason === "daily-limit";
}
