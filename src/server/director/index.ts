/**
 * 导演工厂：决定这一轮由谁来演。
 * 规则：显式 DIRECTOR=live 且解析到可用 provider 才用真模型，否则一律 Mock ——
 * 保证零密钥环境永远跑得起完整流程（这是正常状态，不是降级错误）。
 */
import type { Director } from "../../shared/protocol.ts";
import { resolveLlmMode, resolveLlmStructMode, type ServerConfig } from "../config.ts";
import { LiveDirector } from "./live.ts";
import { MockDirector } from "./mock.ts";

/**
 * 结构化输出/调用模式的配置是**可选**的：既有调用点（app.ts）只传老三样也能建导演，
 * 缺省时回落到 MIRA_LLM_STRUCT / MIRA_LLM_MODE 的环境解析（仍然由 config.ts 读 env）。
 */
export type DirectorConfig = Pick<ServerConfig, "directorMode" | "llm" | "mockDelayScale"> &
  Partial<Pick<ServerConfig, "llmStruct" | "llmMode">>;

export function createDirector(config: DirectorConfig): Director {
  const provider = config.llm;
  if (config.directorMode === "live" && provider) {
    return new LiveDirector({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      label: provider.label,
      extraHeaders: provider.extraHeaders,
      struct: config.llmStruct ?? resolveLlmStructMode(process.env),
      mode: config.llmMode ?? resolveLlmMode(process.env),
    });
  }
  return new MockDirector({ delayScale: config.mockDelayScale });
}

/** 会话信息里的 mode：以「实际生效的导演」为准，避免客户端误判有没有音频 */
export function directorModeOf(director: Director): "mock" | "live" {
  return director instanceof LiveDirector ? "live" : "mock";
}

export { LiveDirector, MockDirector };
