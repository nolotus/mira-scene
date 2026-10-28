/**
 * 插图控制器：把「什么时候能请求 / 请求了怎么办 / 被打断了怎么办」收在一处。
 *
 * 为什么不是散在 React effect 里：这三件事全是**时序**问题，而时序在组件里最难验。
 * 这里依赖全部可注入（transport / cache / schedule / now），于是「缓存命中不发请求」
 * 「epoch 变化后迟到的 resolve 不许复活画面」「未配置不写失败记录」都能在无 DOM 的
 * bun test 里逐条钉死。
 *
 * 三条硬性质：
 *   ① 片段优先：arm 之后是 waiting，**必须**等 release（片段终态或 grace 超时）才请求，
 *      所以片段在播时插图不会抢屏。
 *   ② 打断即终态：abort 会把 generation +1，所有在途结果回来时对不上就丢弃；
 *      状态机侧 interrupted 也只接受 reset。两道闸，缺一不可。
 *   ③ 一会话一次：requested 闩 + 服务端配额，前端也不重复发第二枪。
 */

import {
  buildPromptWithVariant,
  type IllustrateReason,
  type IllustrateResponse,
} from "../../../shared/illustrate.ts";
import type { IllustrationCache } from "./illustrationCache.ts";
import {
  IDLE_ILLUSTRATION,
  abortReasonLabel,
  illustrationReducer,
  isTerminal,
  type IllustrationAbortReason,
  type IllustrationPhase,
  type IllustrationSkipReason,
  type IllustrationState,
} from "./illustrationState.ts";

/** 插图在屏幕上停留的时长：4s 后淡出回落角色 */
export const HOLD_MS = 4_000;
/** 等片段让出画面的最长等待（片段整段 1s，留足加载时间） */
export const CLIP_GRACE_MS = 3_000;

/** 片段让出画面的方式 */
export type ClipOutcome = "ended" | "failed" | "interrupted" | "absent";

export interface IllustrationTransportInput {
  sessionId: string;
  beatId: string;
  scene: string | null;
  variant: string | null;
  signal: AbortSignal;
}

export type IllustrationTransport = (
  input: IllustrationTransportInput,
) => Promise<IllustrateResponse>;

export type IllustrationTone = "info" | "warn" | "error";

export interface IllustrationRecord {
  id: number;
  at: number;
  tone: IllustrationTone;
  phase: IllustrationPhase;
  detail: string;
}

export interface IllustrationControllerOptions {
  transport: IllustrationTransport;
  cache: IllustrationCache;
  /** false = `?gen=0`：整层关闭，一次请求都不发、一条记录都不写 */
  enabled?: boolean;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  holdMs?: number;
  clipGraceMs?: number;
}

export interface ArmInput {
  sessionId: string | null;
  beatId: string;
  scene?: string | null;
  variant?: string | null;
}

export interface IllustrationController {
  readonly state: IllustrationState;
  readonly records: readonly IllustrationRecord[];
  /** 服务端明确回 not-configured 之后置 true：后续不再尝试，也不再刷记录 */
  readonly unavailable: boolean;
  subscribe(listener: () => void): () => void;
  arm(input: ArmInput): void;
  /** 片段开始占屏：取消 grace 兜底，老老实实等它的终态 */
  clipStarted(): void;
  /** 片段让出画面（播完 / 失败 / 被打断 / 本会话早播过了） */
  release(outcome: ClipOutcome): void;
  abort(reason: IllustrationAbortReason): void;
  reset(): void;
  dispose(): void;
}

const MAX_RECORDS = 8;

export function createIllustrationController(
  options: IllustrationControllerOptions,
): IllustrationController {
  const enabled = options.enabled !== false;
  const now = options.now ?? (() => Date.now());
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const holdMs = options.holdMs ?? HOLD_MS;
  const clipGraceMs = options.clipGraceMs ?? CLIP_GRACE_MS;

  let state: IllustrationState = enabled
    ? IDLE_ILLUSTRATION
    : { ...IDLE_ILLUSTRATION, phase: "disabled" };
  let records: readonly IllustrationRecord[] = [];
  const listeners = new Set<() => void>();
  let recordSeq = 0;

  /** 打断代数：每次 abort/reset +1，在途结果回来对不上就整包丢弃 */
  let generation = 0;
  let inFlight: AbortController | null = null;
  let cancelGrace: (() => void) | null = null;
  let cancelHold: (() => void) | null = null;
  let unavailable = false;
  let clipClaimed = false;
  /** arm 时记下的上下文（transport 需要 scene / variant，状态机里不重复存） */
  let context: { scene: string | null; variant: string | null } = { scene: null, variant: null };

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function push(tone: IllustrationTone, detail: string): void {
    recordSeq += 1;
    const next: IllustrationRecord = { id: recordSeq, at: now(), tone, phase: state.phase, detail };
    const list = [...records, next];
    records = list.length > MAX_RECORDS ? list.slice(list.length - MAX_RECORDS) : list;
  }

  /** 返回 false 表示状态机认为这次事件无效（同引用），调用方据此决定是否留痕 */
  function apply(event: Parameters<typeof illustrationReducer>[1]): boolean {
    const next = illustrationReducer(state, event);
    if (next === state) return false;
    state = next;
    notify();
    return true;
  }

  function clearTimers(): void {
    cancelGrace?.();
    cancelGrace = null;
    cancelHold?.();
    cancelHold = null;
  }

  function skip(reason: IllustrationSkipReason, tone: IllustrationTone, detail: string): void {
    if (apply({ type: "skip", reason })) push(tone, detail);
  }

  function finish(token: number, dataUrl: string, cached: boolean): void {
    if (token !== generation) return;
    if (!apply({ type: "resolved", dataUrl, cached })) return;
    push("info", cached ? "生成式插图：命中本地缓存（未发请求）" : "生成式插图：已呈现（4s 后淡出回落角色）");
    cancelHold?.();
    cancelHold = schedule(() => {
      cancelHold = null;
      apply({ type: "hold" });
    }, holdMs);
  }

  function handleFailure(reason: IllustrateReason): void {
    switch (reason) {
      case "not-configured":
        // 正常状态：服务端没有 CF_ACCOUNT_ID / CF_AI_TOKEN。不是错误，不写失败记录。
        unavailable = true;
        skip("not-configured", "info", "生成式插图：服务端未配置");
        return;
      case "session-limit":
        skip("session-limit", "info", "生成式插图：本会话已达 2 张上限 → 静默回落");
        return;
      case "daily-limit":
        skip("daily-limit", "info", "生成式插图：今日额度已用完（60 张）→ 静默回落");
        return;
      case "no-session":
        skip("no-session", "warn", "生成式插图：会话未建立，已跳过");
        return;
      case "bad-request":
        skip("bad-request", "warn", "生成式插图：请求参数无效，已跳过");
        return;
      default:
        skip("upstream", "error", "生成式插图生成失败（上游）→ 已静默回落");
    }
  }

  async function run(): Promise<void> {
    const prompt = state.prompt;
    if (!prompt) return;
    if (!apply({ type: "request" })) return;
    const token = generation;

    // ① 本地缓存命中：不发请求（也不占服务端配额）
    const cachedUrl = options.cache.get(prompt);
    if (cachedUrl) {
      finish(token, cachedUrl, true);
      return;
    }

    const sessionId = state.sessionId;
    if (!sessionId) {
      skip("no-session", "warn", "生成式插图：会话未建立，已跳过");
      return;
    }

    const controller = new AbortController();
    inFlight = controller;
    try {
      const response = await options.transport({
        sessionId,
        beatId: state.beatId ?? "storm",
        scene: context.scene,
        variant: context.variant,
        signal: controller.signal,
      });
      // 打断 / 重置之后回来的结果一律丢弃：这是「epoch 变了画面不会被拉回来」的第一道闸
      if (token !== generation) return;
      if (response.ok) {
        options.cache.set(prompt, response.dataUrl);
        finish(token, response.dataUrl, false);
        return;
      }
      handleFailure(response.reason);
    } catch {
      if (token !== generation) return;
      skip("upstream", "error", "生成式插图生成失败（网络）→ 已静默回落");
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  /** 片段让出画面：取消 grace，真正开跑（arm 的 grace 兜底与外部 release 共用） */
  function releaseNow(outcome: ClipOutcome): void {
    if (state.phase !== "waiting") return;
    void outcome;
    cancelGrace?.();
    cancelGrace = null;
    void run();
  }

  return {
    get state() {
      return state;
    },
    get records() {
      return records;
    },
    get unavailable() {
      return unavailable;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    arm(input: ArmInput): void {
      // 关闭态：完全静默，连记录都不写（?gen=0 时界面不该有任何插图痕迹）
      if (!enabled) return;
      // 服务端已明确未配置：不再尝试，也不再刷记录
      if (unavailable) return;
      if (state.phase !== "idle") return;

      const scene = input.scene ?? null;
      const variant = input.variant ?? null;
      const prompt = buildPromptWithVariant(scene, input.beatId, variant);
      if (state.requested) {
        apply({
          type: "arm",
          prompt,
          sessionId: input.sessionId,
          beatId: input.beatId,
          requested: true,
        });
        push("info", "生成式插图：本会话已请求过，跳过");
        return;
      }

      if (
        !apply({
          type: "arm",
          prompt,
          sessionId: input.sessionId,
          beatId: input.beatId,
          requested: false,
        })
      ) {
        return;
      }
      context = { scene, variant };
      clipClaimed = false;
      // 片段迟迟不占屏（比如它本会话已播过 / 资源缺失）：grace 到点就直接放行
      cancelGrace = schedule(() => {
        cancelGrace = null;
        if (clipClaimed) return;
        releaseNow("absent");
      }, clipGraceMs);
    },

    clipStarted(): void {
      clipClaimed = true;
      cancelGrace?.();
      cancelGrace = null;
    },

    release(outcome: ClipOutcome): void {
      releaseNow(outcome);
    },

    abort(reason: IllustrationAbortReason): void {
      if (!enabled) return;
      if (isTerminal(state.phase) && state.phase !== "interrupted") return;
      generation += 1;
      inFlight?.abort();
      inFlight = null;
      clearTimers();
      if (apply({ type: "abort", reason })) {
        push("warn", `插图被中止（${abortReasonLabel(reason)}）→ 立刻隐藏`);
      }
    },

    reset(): void {
      generation += 1;
      inFlight?.abort();
      inFlight = null;
      clearTimers();
      unavailable = false;
      clipClaimed = false;
      context = { scene: null, variant: null };
      state = enabled ? IDLE_ILLUSTRATION : { ...IDLE_ILLUSTRATION, phase: "disabled" };
      records = [];
      notify();
    },

    dispose(): void {
      generation += 1;
      inFlight?.abort();
      inFlight = null;
      clearTimers();
      listeners.clear();
    },
  };
}
