/**
 * 服务端配置：所有环境变量的唯一读取点。
 *
 * 真模型走 DeepSeek 直连（OpenAI 兼容 /chat/completions），解析优先级：
 *   1. MIRA_LLM_BASE_URL + MIRA_LLM_API_KEY + MIRA_LLM_MODEL（显式覆盖，最高优先级）
 *   2. DEEPSEEK_API_KEY → deepseek 默认配置
 *   3. 都没有 → keyless，只用 Mock（正常状态，不是错误）
 *
 * 备注：OpenRouter 账号级 403（provider ToS 禁止，换任何模型都一样），已确认不可用，不接。
 *
 * 密钥纪律：只在这里读进内存，交给 fetch 使用；
 * 不打印、不写盘、不回显 —— 对外只暴露 provider label 与模型名。
 */

export type LlmProviderId = "deepseek" | "custom";

export interface LlmProvider {
  id: LlmProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 可在日志/SessionInfo 里安全展示的标签，绝不含密钥 */
  label: string;
  /** 额外的非敏感请求头 */
  extraHeaders?: Record<string, string>;
}

export const LLM_DEFAULTS = {
  deepseek: {
    // 注意：base 不带 /v1，最终请求 https://api.deepseek.com/chat/completions
    baseUrl: "https://api.deepseek.com",
    // deepseek-chat 是服务端别名（实际由 deepseek-flash 承接），是官方对话入口
    model: "deepseek-chat",
  },
} as const;

export interface ServerConfig {
  port: number;
  isProd: boolean;
  /** 实际生效的导演档位：显式 DIRECTOR=live 且解析到可用 key 才 live */
  directorMode: "mock" | "live";
  /** 解析出的真模型 provider；null = keyless（只剩 Mock） */
  llm: LlmProvider | null;
  /** Mock 台词节奏缩放：1 = 真实节奏，0 = 不停顿（测试用） */
  mockDelayScale: number;
  /** 开发模式放行 CORS 的前端源 */
  devOrigins: readonly string[];
}

export const DEFAULT_PORT = 8787;

function trimToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * 解析真模型 provider。
 * 返回对象里含密钥，调用方只应把它交给 LiveDirector，不要序列化到任何响应里。
 */
export function resolveLlmProvider(env: Record<string, string | undefined>): LlmProvider | null {
  const explicitKey = trimToNull(env.MIRA_LLM_API_KEY);
  if (explicitKey) {
    return {
      id: "custom",
      baseUrl: normalizeBaseUrl(trimToNull(env.MIRA_LLM_BASE_URL) ?? LLM_DEFAULTS.deepseek.baseUrl),
      apiKey: explicitKey,
      model: trimToNull(env.MIRA_LLM_MODEL) ?? LLM_DEFAULTS.deepseek.model,
      label: "custom",
    };
  }

  const deepseekKey = trimToNull(env.DEEPSEEK_API_KEY);
  if (deepseekKey) {
    return {
      id: "deepseek",
      baseUrl: normalizeBaseUrl(LLM_DEFAULTS.deepseek.baseUrl),
      apiKey: deepseekKey,
      model: trimToNull(env.MIRA_LLM_MODEL) ?? LLM_DEFAULTS.deepseek.model,
      label: "deepseek",
    };
  }

  return null;
}

function toPort(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return Math.trunc(parsed);
}

function toScale(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const llm = resolveLlmProvider(env);
  const wantsLive = (env.DIRECTOR ?? "mock").trim().toLowerCase() === "live";

  return {
    port: toPort(env.SERVER_PORT),
    isProd: (env.NODE_ENV ?? "development").trim() === "production",
    directorMode: wantsLive && llm ? "live" : "mock",
    llm,
    mockDelayScale: toScale(env.MOCK_DELAY_SCALE),
    devOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
  };
}
