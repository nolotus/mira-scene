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

import { parseDirectorRequest, type DirectorRequest } from "../shared/director.ts";
import { resolveDirectorMode } from "./director/resolve.ts";
import { DEFAULT_EDGE_BIN } from "./edgeTts.ts";
import { resolveCharacterVoice } from "../shared/characterVoice.ts";
import { DEFAULT_TTS_CACHE_ENTRIES } from "./tts.ts";

export type LlmProviderId = "deepseek" | "custom";

/**
 * 结构化输出的档位（`MIRA_LLM_STRUCT`）：
 *   · auto        —— 默认。首次调用前探测一次端点是否支持 json_schema，结果缓存（进程内）
 *   · json_schema —— 直接用严格 schema（假定端点支持；探测失败/不确定都别选它）
 *   · json_object —— 只用 `{"type":"json_object"}` + 解析层兜底（DeepSeek 当前的支持度）
 * 探测不会用真实对话内容，只看状态码，也不打印响应体（里面可能有 token 计数之外的脏东西）。
 */
export type LlmStructMode = "auto" | "json_object" | "json_schema";

/**
 * 调用模式（`MIRA_LLM_MODE`）：
 *   · chat —— 默认，/chat/completions + 结构化输出
 *   · tool —— tool calling。**未实现**：本版本只留配置位，选到它时导演会明确回
 *             "未实现" 的可恢复错误，而不是走半成品分支假装能用。
 */
export type LlmMode = "chat" | "tool";

const LLM_STRUCT_MODES: readonly LlmStructMode[] = ["auto", "json_object", "json_schema"];
const LLM_MODES: readonly LlmMode[] = ["chat", "tool"];

/** 解析 `MIRA_LLM_STRUCT`：未设置/拼错 → auto（默认） */
export function resolveLlmStructMode(env: Record<string, string | undefined>): LlmStructMode {
  const raw = (env.MIRA_LLM_STRUCT ?? "").trim().toLowerCase();
  return (LLM_STRUCT_MODES as readonly string[]).includes(raw) ? (raw as LlmStructMode) : "auto";
}

/** 解析 `MIRA_LLM_MODE`：未设置/拼错 → chat */
export function resolveLlmMode(env: Record<string, string | undefined>): LlmMode {
  const raw = (env.MIRA_LLM_MODE ?? "").trim().toLowerCase();
  return (LLM_MODES as readonly string[]).includes(raw) ? (raw as LlmMode) : "chat";
}

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

/**
 * Deepgram 语音凭据（STT + TTS 共用同一个 key）。
 * null = 没配 key，语音通道整体不可用 —— 这是**正常状态**（纯文字对话仍然完整可跑），
 * 所以 /api/voice/status 会如实回 stt:false / tts:false，而不是报错。
 */
export interface DeepgramConfig {
  apiKey: string;
}

/**
 * Edge TTS（中文合成）的本地配置。
 * 注意它**不是凭据**：`edge-tts` 是本地命令，不需要 key，所以它永远「已配置」，
 * 是否真的可用由启动时的一次 `--version` 探测决定（结果缓存，见 edgeTts.ts）。
 */
export interface EdgeTtsConfig {
  /** CLI 路径（`ETTS_BIN`，默认 `edge-tts`） */
  bin: string;
  /** 默认音色（`EDGE_TTS_VOICE`，默认 zh-CN-XiaoxiaoNeural） */
  voice: string;
  /** 角色语速（`EDGE_TTS_RATE`，默认 -8%） */
  rate: string;
  /** 角色音高（`EDGE_TTS_PITCH`，默认 -3Hz） */
  pitch: string;
  /** 音色档案的人话描述（诊断用） */
  label: string;
  /** 合成结果的内存 LRU 条数上限（`TTS_CACHE_MAX`） */
  cacheEntries: number;
}

export interface ServerConfig {
  port: number;
  isProd: boolean;
  /** 语音凭据；null = 未配置（语音通道关闭，文字通道不受影响） */
  deepgram: DeepgramConfig | null;
  /** 中文语音合成（Edge CLI）配置；无凭据，恒有值 */
  edgeTts: EdgeTtsConfig;
  /**
   * 环境变量显式请求的档位（`DIRECTOR=live|mock`）；null = 没设置，默认 Mock。
   * 注意这只表示「环境想要什么」，会话实际用哪个档位由 resolveDirectorMode() 决定。
   */
  directorEnvMode: DirectorRequest;
  /**
   * 环境默认档位（= 客户端不指定时用的档位）：DIRECTOR=live 且解析到可用 key 才 live。
   * 保留原有字段名与语义，仅作「默认值」，单个会话可被 URL 请求覆盖。
   */
  directorMode: "mock" | "live";
  /** 解析出的真模型 provider；null = keyless（只剩 Mock） */
  llm: LlmProvider | null;
  /** Mock 台词节奏缩放：1 = 真实节奏，0 = 不停顿（测试用） */
  mockDelayScale: number;
  /** 结构化输出档位（`MIRA_LLM_STRUCT`，默认 auto = 首次调用前探测一次） */
  llmStruct: LlmStructMode;
  /** 调用模式（`MIRA_LLM_MODE`，默认 chat；tool 只有配置位，未实现） */
  llmMode: LlmMode;
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

/** 读 DEEPGRAM_API_KEY。缺了就返回 null（未配置，正常状态）。 */
export function resolveDeepgramConfig(
  env: Record<string, string | undefined>,
): DeepgramConfig | null {
  const apiKey = trimToNull(env.DEEPGRAM_API_KEY);
  return apiKey ? { apiKey } : null;
}

function toPort(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return Math.trunc(parsed);
}

/** 缓存条数：非法/缺省回默认；上限 4096，避免一条环境变量把内存撑爆 */
function toCacheEntries(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTS_CACHE_ENTRIES;
  return Math.min(4096, Math.trunc(parsed));
}

/** 读 Edge TTS 配置。无凭据、无需开关：CLI 在不在由运行时探测决定。 */
export function resolveEdgeTtsConfig(env: Record<string, string | undefined>): EdgeTtsConfig {
  // 音色/语速/音高来自角色档案（shared/characterVoice.ts），env 只做覆盖
  const character = resolveCharacterVoice(env);
  return {
    bin: trimToNull(env.ETTS_BIN) ?? DEFAULT_EDGE_BIN,
    voice: character.voice,
    rate: character.rate,
    pitch: character.pitch,
    label: character.label,
    cacheEntries: toCacheEntries(env.TTS_CACHE_MAX),
  };
}

function toScale(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const llm = resolveLlmProvider(env);
  // DIRECTOR=live → 所有会话默认 live；DIRECTOR=mock → 强制 mock；未设置/无法识别 → 默认 mock
  const directorEnvMode = parseDirectorRequest(env.DIRECTOR);
  // 默认档位 = 「客户端没指定」时的解析结果，与单会话共用同一套回落规则
  const defaults = resolveDirectorMode(null, {
    envMode: directorEnvMode,
    liveAvailable: llm !== null,
  });

  return {
    port: toPort(env.SERVER_PORT),
    isProd: (env.NODE_ENV ?? "development").trim() === "production",
    deepgram: resolveDeepgramConfig(env),
    edgeTts: resolveEdgeTtsConfig(env),
    directorEnvMode,
    directorMode: defaults.mode,
    llm,
    mockDelayScale: toScale(env.MOCK_DELAY_SCALE),
    llmStruct: resolveLlmStructMode(env),
    llmMode: resolveLlmMode(env),
    devOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
  };
}
