/**
 * 档位解析：把「客户端请求」与「服务端环境」合成「这个会话实际用哪个导演」。
 *
 * 这是「回落」判断的唯一落点 —— 界面、SessionInfo、日志都只读这里算出来的 mode + reason，
 * 不在别处二次推断，避免两处说法不一致。
 *
 * 优先级（自上而下，先命中先返回）：
 *  1. `DIRECTOR=mock` → 一律 Mock；此时请求过 live 的会话记为 `forced-mock`（否则不记原因）
 *  2. 请求为 null（URL 没带 `?director=`）→ 用环境默认档位：`DIRECTOR=live` 则 live，否则 Mock
 *  3. 结果要 live 但没有可用 LLM 配置 → 温和回落 Mock，记 `no-llm-config`（不报错、不挂起）
 *
 * 纯函数、不看真实密钥内容：只认「有没有可用 provider」这一事实（liveAvailable）。
 */
import type {
  DirectorFallbackReason,
  DirectorMode,
  DirectorRequest,
} from "../../shared/director.ts";

export interface DirectorAvailability {
  /** 环境变量显式档位：`DIRECTOR=live|mock`；null = 没设置 */
  envMode: DirectorRequest;
  /** 服务端是否解析到了可用 LLM 配置（有 key 且能组出 provider） */
  liveAvailable: boolean;
}

export interface DirectorResolution {
  /** 实际生效档位 */
  mode: DirectorMode;
  /** 回落到 Mock 的原因；没有回落（或用的是 live）时为 null */
  reason: DirectorFallbackReason | null;
}

export function resolveDirectorMode(
  request: DirectorRequest,
  availability: DirectorAvailability,
): DirectorResolution {
  const forcedMock = availability.envMode === "mock";
  const envDefault: DirectorMode = availability.envMode === "live" ? "live" : "mock";
  const wanted: DirectorMode = request ?? envDefault;

  if (forcedMock) {
    return { mode: "mock", reason: wanted === "live" ? "forced-mock" : null };
  }

  if (wanted === "live" && !availability.liveAvailable) {
    return { mode: "mock", reason: "no-llm-config" };
  }

  return { mode: wanted, reason: null };
}
