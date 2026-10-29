/**
 * 演示开关（?demo=…）——「人为故障」注入器。
 *
 * 为什么需要它：题目要求当场演示「超时 / 断线 / 失败反馈」，但真实故障不好在录屏里复现
 * （要靠拔网线、杀服务端、等 8 秒）。这里提供一个 URL 开关，默认关闭，开启后界面角落有
 * 「演示模式：人为故障」标注，避免被误认为真 bug。
 *
 * 取值：
 *   ?demo=fail     首轮 SSE 请求直接失败（API 层抛错，走的是和真实 5xx 同一套反馈路径）
 *   ?demo=timeout  首轮不发请求，等满 8s 触发「首事件超时」（真实超时逻辑，不是假提示）
 *   ?demo=tts      首轮 TTS 抛错 → 未捕获拒绝 → 媒体错误提示（走全局 unhandledrejection 兜底）
 *   ?demo=media    片段资源地址换成必定 404 的地址（演示「加载失败 → 静默降级 → 诊断留痕」）
 *   ?demo=all      以上三种对话故障全部注入（media 需显式指定，避免污染既有录屏）
 *   其它任何非空值  等同于 fail（手打 ?demo=1 也一定能看到故障，不会静默无效）
 *
 * 注入都是「一次性」的：第二次请求/第二次朗读走真实实现，
 * 于是「故障 → 点重试 → 恢复正常」可以在一次录制里完整演完。
 */

import type {
  CreateSessionOptions,
  HealthInfo,
  SessionApi,
  StreamOptions,
  TurnStreamHandlers,
} from "../state/api";
import { ApiError } from "../state/api";
import type { AudioChunk, AudioChunkSink, TTSProvider } from "../voice/tts";
import type { TurnRequest, CancelResult, SessionInfo } from "../../shared/protocol";

export type DemoFault = "turn" | "timeout" | "tts" | "media";

export interface DemoFlags {
  /** 是否开启演示模式 */
  active: boolean;
  /** 原始 ?demo= 取值（未开启时为 null） */
  raw: string | null;
  /** 要注入的故障，空数组 = 不注入 */
  faults: readonly DemoFault[];
  /** 角落标注文案（未开启时为空串） */
  badge: string;
  /** 徽标 title：逐项说明注入了什么 */
  summary: string;
}

export const DEMO_BADGE = "演示模式：人为故障";

const OFF: DemoFlags = { active: false, raw: null, faults: [], badge: "", summary: "" };

const FAULT_LABEL: Record<DemoFault, string> = {
  turn: "首次对话请求直接失败",
  timeout: "首字等待满 8s（真实超时链路）",
  tts: "首句朗读抛错（走 unhandledrejection 兜底）",
  media: "片段地址必定 404（演示加载失败后的静默降级）",
};

/** 解析 `?demo=…`。纯函数，输入的 search 直接来自 location.search。 */
export function parseDemoFlag(search: string): DemoFlags {
  const raw = (new URLSearchParams(search).get("demo") ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "off" || raw === "false" || raw === "no") {
    return OFF;
  }

  const faults = new Set<DemoFault>();
  if (raw === "fail" || raw === "all") faults.add("turn");
  if (raw === "timeout" || raw === "all") faults.add("timeout");
  if (raw === "tts" || raw === "all") faults.add("tts");
  // media 不并入 all：片段故障会遮住视觉层，只应在专门演示降级时显式打开
  if (raw === "media") faults.add("media");
  // 未知取值一律当作 fail：评审手打 ?demo=xyz 时应看到故障与标注，而不是「什么都没发生」
  if (faults.size === 0) faults.add("turn");

  const list = (["turn", "timeout", "tts", "media"] as const).filter((fault) => faults.has(fault));
  return {
    active: true,
    raw,
    faults: list,
    badge: DEMO_BADGE,
    summary: `${DEMO_BADGE}（?demo=${raw}）：${list.map((f) => FAULT_LABEL[f]).join("；")}。只注入一次，重试即恢复。`,
  };
}

// ---------------------------------------------------------------- 注入：API

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError("aborted", "请求已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError("aborted", "请求已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 包一层 SessionApi：只拦 streamTurn，其余原样转发。
 * 抛出的错误类型与 api.ts 完全一致（ApiError），所以 store 的错误分类、
 * 「是否是网络断线」判断、重试入口都不需要为演示模式写特例。
 */
export function withDemoApi(api: SessionApi, flags: DemoFlags): SessionApi {
  if (!flags.faults.includes("turn") && !flags.faults.includes("timeout")) return api;

  let turnFired = false;
  let stallFired = false;
  const faults = flags.faults;

  const wrapped: SessionApi = {
    health(signal?: AbortSignal): Promise<HealthInfo> {
      return api.health(signal);
    },
    createSession(signal?: AbortSignal, options?: CreateSessionOptions): Promise<SessionInfo> {
      // 包装层必须原样转发：否则 ?demo= 会顺手把 ?director= 吃掉
      return api.createSession(signal, options);
    },
    cancelTurn(turnId: string, epoch: number, signal?: AbortSignal): Promise<CancelResult> {
      return api.cancelTurn(turnId, epoch, signal);
    },
    async streamTurn(
      req: TurnRequest,
      handlers: TurnStreamHandlers,
      opts?: StreamOptions,
    ): Promise<void> {
      const budget = opts?.firstEventTimeoutMs ?? 8_000;

      if (faults.includes("timeout") && !stallFired) {
        stallFired = true;
        // 真的什么事件都不发：8s 后由这里以和 api.ts 相同的措辞判超时，
        // 因此 UI 走的是生产代码里的超时分支（状态回待机 + 提示 + 重试）
        await sleep(budget, opts?.signal);
        throw new ApiError(
          "timeout",
          `模型 ${Math.round(budget / 1000)}s 内没有响应（首事件超时）`,
        );
      }

      if (faults.includes("turn") && !turnFired) {
        turnFired = true;
        // 先让界面进入「思考」，录屏里能看清「请求发出 → 失败」的先后
        await sleep(400, opts?.signal);
        throw new ApiError("server", `演示模式：人为注入的故障（?demo=${flags.raw ?? "fail"}）`);
      }

      return api.streamTurn(req, handlers, opts);
    },
  };

  return wrapped;
}

// ---------------------------------------------------------------- 注入：TTS

/**
 * 包一层 TTS：第一句朗读不发声，而是抛出一个没人接管的 Promise 拒绝。
 * 这样演示的是**真实的生产兜底路径**（window.onunhandledrejection），
 * 而不是造一条只有演示模式才走的假提示。
 */
export function withDemoTts(
  tts: TTSProvider & Partial<AudioChunkSink>,
  flags: DemoFlags,
): TTSProvider & Partial<AudioChunkSink> {
  if (!flags.faults.includes("tts")) return tts;

  let fired = false;
  const pushChunk = (tts as Partial<AudioChunkSink>).pushChunk;

  const wrapped: TTSProvider & Partial<AudioChunkSink> = {
    get name(): string {
      return tts.name;
    },
    get playback() { return tts.playback; },
    get synchronized() { return tts.synchronized; },
    get isSpeaking(): boolean {
      return tts.isSpeaking;
    },
    speak(text: string): void {
      if (!fired) {
        fired = true;
        const error = new Error(`演示模式：TTS 朗读失败（?demo=${flags.raw ?? "tts"}）`);
        error.name = "DemoTtsError";
        void Promise.reject(error);
        return;
      }
      tts.speak(text);
    },
    flush(): void {
      tts.flush();
    },
    cancel(): void {
      tts.cancel();
    },
    dispose(): void {
      tts.dispose();
    },
  };

  if (typeof pushChunk === "function") {
    wrapped.pushChunk = (chunk: AudioChunk): void => {
      pushChunk.call(tts, chunk);
    };
  }

  // StreamTTS 的 warmUp 必须在用户手势里调用，包装层不能把它弄丢
  const warmUp = (tts as { warmUp?: () => void }).warmUp;
  if (typeof warmUp === "function") {
    (wrapped as { warmUp?: () => void }).warmUp = () => {
      warmUp.call(tts);
    };
  }

  return wrapped;
}
