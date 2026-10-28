/**
 * 导演工厂：决定这一轮由谁来演。
 * 规则：显式 DIRECTOR=live 且解析到可用 provider 才用真模型，否则一律 Mock ——
 * 保证零密钥环境永远跑得起完整流程（这是正常状态，不是降级错误）。
 */
import type { Director } from "../../shared/protocol.ts";
import type { ServerConfig } from "../config.ts";
import { LiveDirector } from "./live.ts";
import { MockDirector } from "./mock.ts";

export type DirectorConfig = Pick<ServerConfig, "directorMode" | "llm" | "mockDelayScale">;

export function createDirector(config: DirectorConfig): Director {
  const provider = config.llm;
  if (config.directorMode === "live" && provider) {
    return new LiveDirector({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: provider.model,
      label: provider.label,
      extraHeaders: provider.extraHeaders,
    });
  }
  return new MockDirector({ delayScale: config.mockDelayScale });
}

/** 会话信息里的 mode：以「实际生效的导演」为准，避免客户端误判有没有音频 */
export function directorModeOf(director: Director): "mock" | "live" {
  return director instanceof LiveDirector ? "live" : "mock";
}

export { LiveDirector, MockDirector };
