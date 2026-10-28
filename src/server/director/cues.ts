/**
 * 时序指令（cue）的纯工具层：排序、夹紧、按已播字数取「该触发了的」。
 *
 * 为什么单独一个文件：
 *   · 导演要它 —— 服务端在把台词切成小片推送时，靠它决定「这一片之后该发哪条指令」；
 *   · 客户端要它 —— 客户端想自己按字数调度时，不该为了两个纯函数去依赖整个服务端；
 *   · 所以这里只 import 类型与指令白名单（都是纯 TS），零 DOM、零网络、零定时器、无随机：
 *     同一输入必得同一输出，可以单独测。
 *
 * 时间轴的约定（与 protocol.ts 的 AnchoredCue 一致）：
 *   atChar 是「say 的第几个字符」，0 起，按 Unicode 码点计数（Array.from 的长度），
 *   这样「雨」和「🙂」都算 1 个字符，与客户端逐字对齐不会错位半格。
 */
import type { AnchoredCue, Directive, SpokenPlan } from "../../shared/protocol.ts";
import { validateDirective } from "../scene/validate.ts";

/** 按 Unicode 码点数字符数（代理对算 1 个） */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** 稳定排序：atChar 升序；同一 atChar 保持输入顺序（先说的先变，可回放） */
export function sortCues(cues: readonly AnchoredCue[]): AnchoredCue[] {
  return cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.atChar - b.cue.atChar || a.index - b.index)
    .map((entry) => entry.cue);
}

/** 把单个 atChar 夹到 [0, sayLength]；非有限数按 0 处理（= 立即执行） */
export function clampAtChar(atChar: number, sayLength: number): number {
  const limit = Number.isFinite(sayLength) ? Math.max(0, Math.trunc(sayLength)) : 0;
  if (!Number.isFinite(atChar)) return 0;
  const value = Math.trunc(atChar);
  if (value <= 0) return 0;
  return value > limit ? limit : value;
}

/** 批量夹紧（不排序；需要顺序时配合 sortCues） */
export function clampCues(cues: readonly AnchoredCue[], sayLength: number): AnchoredCue[] {
  return cues.map((cue) => ({ atChar: clampAtChar(cue.atChar, sayLength), directive: cue.directive }));
}

/**
 * 「已越过但尚未触发」的 cues：atChar ≤ charsSpoken 且不在已触发前缀里，按 atChar 升序。
 *
 * firedCount = 已经触发过几条（按 sortCues 后的前缀算）。传同一个 firedCount 重算、
 * 或 charsSpoken 回退，都不会把已经触发过的再返回一次。
 *
 * charsSpoken 与 atChar 都用「say 的字符数」这把尺子：越界的 atChar 会被夹到 say.length，
 * 越界的 charsSpoken 也一样（说到最后就等于「全越过了」）。
 */
export function cuesUpTo(plan: SpokenPlan, charsSpoken: number, firedCount = 0): AnchoredCue[] {
  const sayLength = charCount(plan.say);
  const ordered = sortCues(clampCues(plan.cues, sayLength));
  const spoken = Number.isFinite(charsSpoken) ? Math.max(0, Math.trunc(charsSpoken)) : 0;
  const limit = Math.min(spoken, sayLength);
  const start = Number.isFinite(firedCount) ? Math.max(0, Math.trunc(firedCount)) : 0;

  const ready: AnchoredCue[] = [];
  for (let index = start; index < ordered.length; index += 1) {
    const cue = ordered[index];
    if (!cue || cue.atChar > limit) break;
    ready.push(cue);
  }
  return ready;
}

/**
 * 服务端用的有状态调度器：只往前走的水位线 + 已触发指针。
 *
 * 两个真实场景逼出来的设计：
 *   1. 真模型的 cues 在 JSON 里可能出现得比台词晚（模型不一定按顺序写）——
 *      所以要能 feed() 追加：追加时 atChar 已经越过水位的，下次 advance() 立刻放出来，
 *      语义就是「已越过但尚未触发 → 现在就执行」，不会丢指令。
 *   2. 客户端可能偶尔用一段旧字数回调 advance()（回退）——水位只增不减，
 *      已经放出去的不再重复放。
 */
export class CueScheduler {
  #pending: AnchoredCue[];
  #fired = 0;
  #watermark = 0;
  readonly #sayLength: number;

  constructor(cues: readonly AnchoredCue[] = [], options: { sayLength?: number } = {}) {
    this.#sayLength = options.sayLength !== undefined && Number.isFinite(options.sayLength)
      ? Math.max(0, Math.trunc(options.sayLength))
      : Number.POSITIVE_INFINITY;
    this.#pending = [];
    this.feed(cues);
  }

  /** 追加（可重复调用）：扫描器分批解析出来的 cues 随时可以塞进来 */
  feed(cues: readonly AnchoredCue[]): void {
    if (cues.length === 0) return;
    this.#pending = sortCues([...this.#pending, ...cues]);
  }

  /** 推进到「已播 N 个字符」，返回这一批该触发的 cues（升序，不重复） */
  advance(charsSpoken: number): AnchoredCue[] {
    if (Number.isFinite(charsSpoken)) {
      this.#watermark = Math.max(this.#watermark, Math.trunc(charsSpoken));
    }
    const limit = Math.min(this.#watermark, this.#sayLength);
    const ready: AnchoredCue[] = [];
    while (this.#pending.length > 0) {
      const next = this.#pending[0];
      if (!next || next.atChar > limit) break;
      this.#pending.shift();
      ready.push(next);
    }
    this.#fired += ready.length;
    return ready;
  }

  /** 收尾：把剩下的一次性全放掉（含 atChar 越界被夹到末尾的那些，不丢指令） */
  takeAll(): AnchoredCue[] {
    const rest = this.#pending;
    this.#pending = [];
    this.#fired += rest.length;
    return rest;
  }

  /** 已触发条数（诊断/断言用） */
  get firedCount(): number {
    return this.#fired;
  }

  /** 还没触发的条数 */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** 当前水位（已播字符数） */
  get watermark(): number {
    return this.#watermark;
  }
}

// ------------------------------------------------------------ 模型输出的逐条校验

export type CueDropReason = "atChar" | "directive";

export interface RawCueRead {
  cue: AnchoredCue | null;
  /** cue 为 null 时的原因；合法时为 null */
  dropped: CueDropReason | null;
}

/**
 * 校验模型给的一条 cue：`{atChar, d}`（短键省 token），也认 `{atChar, directive}`，
 * 还容忍模型把指令字段直接摊平写在同一层（`{atChar, kind:"vfx", vfx:"lightning"}`）。
 *
 * atChar 必须是有限数字，否则整条丢弃（原因计入诊断）；指令必须过既有白名单，
 * 否则丢弃指令、同样计数 —— 这里不抛错，坏数据只影响它自己那一条。
 */
export function readRawCue(raw: unknown): RawCueRead {
  if (!raw || typeof raw !== "object") return { cue: null, dropped: "directive" };
  const record = raw as Record<string, unknown>;

  if (typeof record.atChar !== "number" || !Number.isFinite(record.atChar)) {
    return { cue: null, dropped: "atChar" };
  }
  const atChar = Math.max(0, Math.trunc(record.atChar));

  const source = record.d ?? record.directive ?? (record.kind ?? record.type ? record : null);
  const directive: Directive | null = validateDirective(source);
  if (!directive) return { cue: null, dropped: "directive" };

  return { cue: { atChar, directive }, dropped: null };
}

/** 旧格式里的一条裸指令 → atChar = 0 的 cue（旧行为 = 立即执行） */
export function cueFromDirective(directive: Directive): AnchoredCue {
  return { atChar: 0, directive };
}

// ------------------------------------------------------------ 增量扫描（流式用）

export interface CueScannerStats {
  /** atChar 不是有限数字而被丢弃的条数 */
  droppedAtChar: number;
  /** 指令不过白名单而被丢弃的条数 */
  droppedDirective: number;
}

/** 跳过一段 JSON 字符串：start 指向开引号，返回收尾引号之后的位置；半截返回 -1 */
function skipJsonString(raw: string, start: number): number {
  let index = start + 1;
  while (index < raw.length) {
    const char = raw[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return -1;
}

/** 找到与 start 处 `{` 配对的 `}`，返回其后位置；还没收到完整的返回 -1 */
function findObjectEnd(raw: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      const next = skipJsonString(raw, index);
      if (next < 0) return -1;
      index = next;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

/**
 * 边收边扫 cues 数组：只吐「已经收完整、且合法」的 cue。
 *
 * 为什么不在最后一次性解析：真模型的 JSON 是流式回来的，等整段收完，
 * 台词早就播完了，指令又只能补发（这就是「视觉抢在台词前面」的反面版本）。
 * 让 prompt 把 cues 放在 say 之前，这个扫描器就能在台词开播之前拿到 atChar。
 *
 * 容错：半截对象先留着等下一片；某个对象 JSON 坏了就跳过它继续扫后面的；
 * 非法项的条数记在 stats 里（诊断可见），绝不抛错打断整轮。
 */
export class CueScanner {
  #raw = "";
  #pos = -1;
  #closed = false;
  #cues: AnchoredCue[] = [];
  #droppedAtChar = 0;
  #droppedDirective = 0;

  /** 喂入一段增量原文，返回这段里新收全的 cues（按 JSON 顺序） */
  push(delta: string): AnchoredCue[] {
    this.#raw += delta;
    if (this.#closed) return [];

    if (this.#pos < 0) {
      const match = /"cues"\s*:\s*\[/.exec(this.#raw);
      if (!match) return [];
      // 台词字符串里也可能出现 "cues" 这几个字，只认 say 之前的那一个
      const sayAt = this.#raw.indexOf('"say"');
      if (sayAt >= 0 && match.index > sayAt) return [];
      this.#pos = match.index + match[0].length;
    }

    const fresh: AnchoredCue[] = [];
    while (!this.#closed) {
      while (this.#pos < this.#raw.length && /[\s,]/.test(this.#raw[this.#pos] ?? "")) this.#pos += 1;
      if (this.#pos >= this.#raw.length) break;

      const char = this.#raw[this.#pos];
      if (char === "]") {
        this.#closed = true;
        this.#pos += 1;
        break;
      }
      if (char !== "{") {
        // 夹在中间的多余字符：跳过，不影响后面的对象
        this.#pos += 1;
        continue;
      }

      const end = findObjectEnd(this.#raw, this.#pos);
      if (end < 0) break; // 半截对象，等下一片

      const slice = this.#raw.slice(this.#pos, end);
      this.#pos = end;

      let parsed: unknown;
      try {
        parsed = JSON.parse(slice);
      } catch {
        this.#droppedDirective += 1;
        continue;
      }
      const read = readRawCue(parsed);
      if (read.cue) {
        this.#cues.push(read.cue);
        fresh.push(read.cue);
      } else if (read.dropped === "atChar") {
        this.#droppedAtChar += 1;
      } else {
        this.#droppedDirective += 1;
      }
    }
    return fresh;
  }

  /** 到目前为止收全的 cues（按 JSON 顺序） */
  get cues(): AnchoredCue[] {
    return this.#cues;
  }

  /** cues 数组是否已经收尾（见到 `]`） */
  get closed(): boolean {
    return this.#closed;
  }

  get stats(): CueScannerStats {
    return { droppedAtChar: this.#droppedAtChar, droppedDirective: this.#droppedDirective };
  }
}
