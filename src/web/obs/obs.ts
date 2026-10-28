/**
 * 观测数据（`?obs=1`）：把「一轮对话到底慢在哪」拆成可以加总的分段。
 *
 * 为什么单独做一层，而不是往 Diagnostics 里再塞几行：Diagnostics 回答「现在是什么状态」，
 * 这里回答「过去 N 轮的分布是什么」。优化需要的是 p50/p95、错误率、分段耗时，
 * 单次快照看不出来（一次 2.1s 可能只是网络抖，也可能是每轮都慢）。
 *
 * 和 `bargeInTrace` 的分工：trace 是打断链路的毫秒时间线（人肉读一行），
 * 这里是**结构化**的轮次记录（能聚合）。两者开关独立，都不记录音频与转写全文。
 *
 * 开销口径：`obsEvent` 第一行就 `if (!on) return` —— 调用点仍会构造那个参数对象字面量，
 * 但除此之外不发事件、不取时间、不进数组。热度可忽略，且默认关闭。
 */

export type ObsKind =
  | "turn:send"
  | "turn:first-event"
  | "turn:first-delta"
  | "turn:first-audio"
  | "turn:first-sound"
  | "turn:end"
  | "tts:request"
  | "tts:issue"
  | "status:ready"
  | "error";

export interface ObsEvent {
  /** 相对页面加载的毫秒（单调时钟） */
  t: number;
  kind: ObsKind;
  turnId?: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface ObsTurn {
  turnId: string;
  startedAt: number;
  /** 是否见过这一轮的 `turn:send`。没见过的（环形缓冲截断后的迟到事件）基准不可信 */
  sent: boolean;
  /** 发送 → 服务端第一个 SSE 事件（建连 + 模型开始响应） */
  firstEventMs: number | null;
  /** 发送 → 第一个 text.delta（模型首字） */
  firstDeltaMs: number | null;
  /** 发送 → 第一个音频分片交付给播放器（不含解码与起播） */
  firstAudioMs: number | null;
  /** 发送 → 第一段声音**真正开始播**（含解码 + AudioContext 排期，用户感知的那一段） */
  firstSoundMs: number | null;
  /** 发送 → turn.end */
  totalMs: number | null;
  /** 本轮 TTS 请求数 / 失败数 */
  ttsRequests: number;
  ttsFailed: number;
  /** 首个 TTS 请求的往返毫秒（≈ 首块音频的合成耗时） */
  ttsFirstMs: number | null;
  channel: string | null;
  error: string | null;
  interrupted: boolean;
}

export interface ObsSummary {
  turns: number;
  errors: number;
  failedTtsRequests: number;
  firstEvent: { p50: number | null; p95: number | null };
  firstDelta: { p50: number | null; p95: number | null };
  firstAudio: { p50: number | null; p95: number | null };
  firstSound: { p50: number | null; p95: number | null };
  total: { p50: number | null; p95: number | null };
  /** 被打断的轮次数（不计入 total 分布：它们的「时长」是用户开口的时刻，不是自然结束） */
  interrupted: number;
}

export interface ObsSnapshot {
  events: ObsEvent[];
  turns: ObsTurn[];
  summary: ObsSummary;
}

const MAX_EVENTS = 600;
const MAX_TURNS = 20;

let on = false;
let events: ObsEvent[] = [];
let startedAt = 0;
const listeners = new Set<() => void>();

export function enableObs(): void {
  on = true;
  startedAt = Math.round(performance.now());
  events = [];
}

export function obsEnabled(): boolean {
  return on;
}

function now(): number {
  return Math.round(performance.now());
}

/** 记一条事件。未开启 `?obs=1` 时什么都不做（含不取时间、不建对象）。 */
export function obsEvent(kind: ObsKind, init: { turnId?: string; detail?: ObsEvent["detail"] } = {}): void {
  if (!on) return;
  events.push({ t: now(), kind, turnId: init.turnId, detail: init.detail });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  for (const listener of listeners) listener();
}

const onceSeen = new Set<string>();

/** 轮次内的「第一次」事件：同一个 (turnId, kind) 只记一条，重复调用无害 */
export function obsFirst(
  kind: "turn:first-event" | "turn:first-delta" | "turn:first-audio" | "turn:first-sound",
  turnId?: string,
): void {
  if (!on) return;
  const id = turnId ?? currentObsTurnId() ?? "unknown";
  const key = `${id}:${kind}`;
  if (onceSeen.has(key)) return;
  onceSeen.add(key);
  obsEvent(kind, { turnId: turnId ?? currentObsTurnId() ?? undefined });
}

export function subscribeObs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 最近一轮的 id。
 *
 * 注意**不**在 `turn:end` 处截断：TTS 的分句是在 `flush()` 时才真正派发的，
 * 而 flush 发生在 turn.end 之后 —— 早退就会让这一轮的 TTS 请求与首个音频
 * 全挂在「空轮次」上，指标看起来永远缺一块（2026-10-28 实测踩到）。
 */
export function currentObsTurnId(): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === "turn:send") return event.turnId ?? null;
  }
  return null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function stat(values: Array<number | null>): { p50: number | null; p95: number | null } {
  const clean = values.filter((value): value is number => value !== null && Number.isFinite(value));
  clean.sort((a, b) => a - b);
  return { p50: percentile(clean, 50), p95: percentile(clean, 95) };
}

/** 从事件流聚合出轮次与分布。事件被环形缓冲截断时只统计还能完整看到的部分。 */
export function obsSnapshot(): ObsSnapshot {
  const byTurn = new Map<string, ObsTurn>();
  const order: string[] = [];

  for (const event of events) {
    const turnId = event.turnId;
    if (!turnId) continue;
    let turn = byTurn.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        startedAt: event.t,
        sent: false,
        firstEventMs: null,
        firstDeltaMs: null,
        firstAudioMs: null,
        firstSoundMs: null,
        totalMs: null,
        ttsRequests: 0,
        ttsFailed: 0,
        ttsFirstMs: null,
        channel: null,
        error: null,
        interrupted: false,
      };
      byTurn.set(turnId, turn);
      order.push(turnId);
    }
    switch (event.kind) {
      case "turn:send":
        turn.startedAt = event.t;
        turn.sent = true;
        break;
      case "turn:first-event":
        turn.firstEventMs ??= event.t - turn.startedAt;
        break;
      case "turn:first-delta":
        turn.firstDeltaMs ??= event.t - turn.startedAt;
        break;
      case "turn:first-audio":
        turn.firstAudioMs ??= event.t - turn.startedAt;
        break;
      case "turn:first-sound":
        turn.firstSoundMs ??= event.t - turn.startedAt;
        break;
      case "tts:request": {
        turn.ttsRequests += 1;
        const ms = typeof event.detail?.ms === "number" ? event.detail.ms : null;
        if (turn.ttsFirstMs === null && ms !== null) turn.ttsFirstMs = ms;
        const ok = event.detail?.ok === true;
        if (!ok) turn.ttsFailed += 1;
        const tier = typeof event.detail?.tier === "string" ? event.detail.tier : null;
        turn.channel ??= tier;
        break;
      }
      case "tts:issue":
        turn.error ??= typeof event.detail?.reason === "string" ? event.detail.reason : "tts-issue";
        break;
      case "turn:end":
        turn.totalMs = event.t - turn.startedAt;
        turn.interrupted = event.detail?.interrupted === true;
        break;
      case "error":
        turn.error ??= typeof event.detail?.message === "string" ? event.detail.message : "error";
        break;
      default:
        break;
    }
  }

  // 只保留「见过 turn:send」的轮次：否则缓冲截断后剩下的事件会造出一个
  // startedAt = 第一个所见事件的幽灵轮次，分段全算成 0，把 p50 往下拉。
  // 先过滤再切片：幽灵轮次同样占 order 的位次，先 slice 会把真实轮次挤出窗口
  const turns = order
    .map((turnId) => byTurn.get(turnId))
    .filter((turn): turn is ObsTurn => turn !== undefined && turn.sent)
    .slice(-MAX_TURNS);

  // 打断轮次的 totalMs 也非空，但它的「长度」是「用户开口到被切断」——
  // 混进分位数会系统性拉低整轮耗时（barge-in 恰恰是语音应用的主路径）。
  const finished = turns.filter((turn) => turn.totalMs !== null && !turn.interrupted);
  const summary: ObsSummary = {
    turns: finished.length,
    errors: turns.filter((turn) => turn.error !== null).length,
    failedTtsRequests: turns.reduce((sum, turn) => sum + turn.ttsFailed, 0),
    firstEvent: stat(turns.map((turn) => turn.firstEventMs)),
    firstDelta: stat(turns.map((turn) => turn.firstDeltaMs)),
    firstAudio: stat(turns.map((turn) => turn.firstAudioMs)),
    firstSound: stat(turns.map((turn) => turn.firstSoundMs)),
    total: stat(finished.map((turn) => turn.totalMs)),
    interrupted: turns.filter((turn) => turn.interrupted).length,
  };

  return { events: events.slice(-120), turns, summary };
}

/** 重置（面板上的按钮用，不影响正在跑的轮次） */
export function resetObs(): void {
  if (!on) return;
  events = [];
  onceSeen.clear();
  startedAt = now();
  for (const listener of listeners) listener();
}

export function obsStartedAt(): number {
  return startedAt;
}
