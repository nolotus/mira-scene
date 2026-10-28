/**
 * 打断链路的时间线（`?trace=1`）。
 *
 * 为什么要有它：「说话就能打断」这类能力的唯一验收方式是时间线 —— 只证明「代码路径
 * 跑通了」没用，必须能说出 `speech_started` 到达之后多少毫秒音频真的停了。所以每个
 * 关键点都打一条带单调时钟的事件，最后算三组差值：
 *
 *   speech_started → 音频停止（用户能感知的延迟，越小越好，目标 < 250ms）
 *   speech_started → 状态切 listening（UI 反馈）
 *   TTS 开口 → speech_started（回声本身的往返，用来判断 AEC 是否压住了外放）
 *
 * 只在 `?trace=1` 时工作（默认零开销：`markTrace` 第一行就返回）。不记录音频、不记录
 * 转写全文（`detail` 里只有决策原因/epoch 这类短字符串）。
 */

export interface TraceMark {
  /** 相对 performance.timeOrigin 的毫秒（单调时钟） */
  atMs: number;
  label: string;
  detail?: string;
}

export interface BargeInTimeline {
  /** 触发源到达（speech_started） */
  speechStartedAtMs: number | null;
  /** 真正执行打断的时刻 */
  interruptAtMs: number | null;
  /** 音频停止（tts.cancel() 返回） */
  audioStoppedAtMs: number | null;
  /** 状态变成 listening */
  listeningAtMs: number | null;
  /** speech_started → 音频停止（毫秒）。用户能感知的延迟。 */
  audioLatencyMs: number | null;
  /** speech_started → listening */
  stateLatencyMs: number | null;
}

const MAX_MARKS = 400;
let enabled = false;
let marks: TraceMark[] = [];
/**
 * 当前自动打断的触发源（`deepgram` / `energy` / `none`）。
 * 单独存一份而不是从 marks 里倒推：验收时要能一句话回答「刚才是谁触发的」，
 * 而不是让人从一串 gate:ignore 里猜。理由说明见 voice/bargeInSource.ts。
 */
let source: string | null = null;
let sourceDetail: string | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function parseTraceFlag(search: string): boolean {
  const raw = (new URLSearchParams(search).get("trace") ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true" || raw === "yes";
}

export function setTraceEnabled(value: boolean): void {
  enabled = value;
}

export function traceEnabled(): boolean {
  return enabled;
}

export function markTrace(label: string, detail?: string): void {
  if (!enabled) return;
  const mark: TraceMark = detail === undefined ? { atMs: nowMs(), label } : { atMs: nowMs(), label, detail };
  marks.push(mark);
  if (marks.length > MAX_MARKS) marks = marks.slice(-MAX_MARKS);
  // console 里也留一份：headless 下可以直接从 CDP 的 console 事件里读
  try {
    console.log(`[barge-in] ${mark.atMs.toFixed(1)}ms ${mark.label}${detail ? ` ${detail}` : ""}`);
  } catch {
    /* console 被禁用也不影响 trace 本体 */
  }
}

export function readTrace(): TraceMark[] {
  return marks.map((mark) => ({ ...mark }));
}

export function resetTrace(): void {
  marks = [];
  source = null;
  sourceDetail = null;
}

/** 记录当前触发源（连同理由）：`window.__miraBargeInTrace.source` 读得到 */
export function setTraceSource(next: string, detail?: string): void {
  source = next;
  sourceDetail = detail ?? null;
}

export function readTraceSource(): { source: string | null; detail: string | null } {
  return { source, detail: sourceDetail };
}

function firstMark(list: TraceMark[], label: string, afterMs?: number): TraceMark | null {
  for (const mark of list) {
    if (mark.label !== label) continue;
    if (afterMs !== undefined && mark.atMs < afterMs) continue;
    return mark;
  }
  return null;
}

/** 从事件流里算出打断时间线（纯函数：时间线本身可单测） */
export function summarizeBargeInTimeline(list: TraceMark[]): BargeInTimeline {
  const speechStarted = firstMark(list, "speech-started");
  const startAt = speechStarted?.atMs ?? null;
  const interrupt = firstMark(list, "interrupt:begin", startAt ?? undefined);
  const audio = firstMark(list, "audio:stopped", startAt ?? undefined);
  const listening = firstMark(list, "status:listening", startAt ?? undefined);

  return {
    speechStartedAtMs: startAt,
    interruptAtMs: interrupt?.atMs ?? null,
    audioStoppedAtMs: audio?.atMs ?? null,
    listeningAtMs: listening?.atMs ?? null,
    audioLatencyMs:
      startAt !== null && audio !== null ? Math.round((audio.atMs - startAt) * 10) / 10 : null,
    stateLatencyMs:
      startAt !== null && listening !== null ? Math.round((listening.atMs - startAt) * 10) / 10 : null,
  };
}

/** 人读的时间线文本（E2E 报告直接贴这段） */
export function formatBargeInTimeline(list: TraceMark[]): string {
  const origin = list.at(0)?.atMs ?? 0;
  const lines = list.map((mark) => {
    const rel = (mark.atMs - origin).toFixed(1).padStart(8);
    return `  +${rel}ms ${mark.label}${mark.detail ? `  (${mark.detail})` : ""}`;
  });
  const summary = summarizeBargeInTimeline(list);
  const tail: string[] = [];
  if (summary.audioLatencyMs !== null) {
    tail.push(`  speech_started → 音频停止：${summary.audioLatencyMs}ms`);
  } else {
    tail.push("  speech_started → 音频停止：未能测量（缺少 audio:stopped 标记）");
  }
  if (summary.stateLatencyMs !== null) {
    tail.push(`  speech_started → listening：${summary.stateLatencyMs}ms`);
  }
  return ["[barge-in timeline]", ...lines, "[summary]", ...tail].join("\n");
}

/** 供 E2E 从 CDP 里读（`window.__miraBargeInTrace`） */
export function publishTrace(): void {
  if (typeof window === "undefined") return;
  const list = readTrace();
  (window as unknown as Record<string, unknown>).__miraBargeInTrace = {
    enabled,
    source,
    sourceDetail,
    marks: list,
    timeline: summarizeBargeInTimeline(list),
    text: formatBargeInTimeline(list),
  };
}

/** 时间线落到 console（打断完成后调一次即可） */
export function logTrace(): void {
  if (!enabled) return;
  try {
    console.log(formatBargeInTimeline(readTrace()));
  } catch {
    /* 忽略 */
  }
}
