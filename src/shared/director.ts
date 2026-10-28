/**
 * 导演档位的唯一定义与解析（前后端共用，纯函数）。
 *
 * 语义（对应「评审点开即用不烧钱，想演示时能切真模型」）：
 *  - 客户端 URL 带 `?director=live` → 这个会话请求真模型；
 *  - 不带 / 带别的值 → 不指定，由服务端默认档位决定（默认 Mock）；
 *  - 服务端若没有可用的 LLM 配置，即使请求 live 也温和回落到 Mock，不报错、不挂起。
 *
 * 注意：这里只做「请求」的归一化，不涉及密钥 —— 密钥是否存在只由服务端判断。
 */

/** 客户端请求的档位：live = 请求真模型，mock = 明确要 Mock，null = 不指定 */
export type DirectorRequest = "live" | "mock" | null;

/** 实际生效档位 */
export type DirectorMode = "mock" | "live";

/** 请求了 live 却回落成 mock 的原因码（没回落时为空） */
export type DirectorFallbackReason = "no-llm-config" | "forced-mock";

/**
 * 解析 `?director=` 的原始取值。
 * 只认 live / mock（大小写与空白不敏感），其它一律当作「没指定」——
 * 手打 `?director=1` 不会静默变成 live，也不会报错，就是默认档位。
 */
export function parseDirectorRequest(raw: string | null | undefined): DirectorRequest {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "live") return "live";
  if (value === "mock") return "mock";
  return null;
}

/** 回落到 Mock 的说明文案（界面与诊断面板共用，保证两处说法一致） */
export const DIRECTOR_FALLBACK_TEXT: Record<DirectorFallbackReason, string> = {
  "no-llm-config":
    "请求真模型，但服务端未配置密钥（MIRA_LLM_API_KEY / DEEPSEEK_API_KEY），已自动回落到 Mock",
  "forced-mock": "请求真模型，但服务端以 DIRECTOR=mock 强制运行 Mock 档",
};

export function isDirectorFallbackReason(value: unknown): value is DirectorFallbackReason {
  return value === "no-llm-config" || value === "forced-mock";
}

/** 原因码 → 一句人话；没有原因（没有回落）时返回 null */
export function describeDirectorFallback(
  reason: DirectorFallbackReason | null | undefined,
): string | null {
  if (!reason) return null;
  return DIRECTOR_FALLBACK_TEXT[reason] ?? null;
}
