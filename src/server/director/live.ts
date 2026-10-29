/**
 * LiveDirector —— 真模型导演（DeepSeek 直连，OpenAI 兼容 /chat/completions）。
 *
 * 关键设计：
 * 1. **结构化输出**：`MIRA_LLM_STRUCT` 决定用哪种约束（见 struct-probe.ts）：
 *    auto 先探一次端点支不支持 `json_schema`，支持就用严格 schema，否则退回 `json_object`。
 * 2. **时序指令**：模型输出 `{"cues":[{"atChar":N,"d":{...}}],"say":"..."}` —— cues 在前、
 *    短键 `d` 省 token。cues 在前不是为了好看：服务端要能在台词**开播之前**拿到 atChar，
 *    这样「说到第 N 个字符」的指令才能在那一瞬间投递出去，而不是等 JSON 尾巴补发。
 *    旧格式 `{"say","directives":[]}` 全兼容：转成 atChar 均为 0 的 cues（= 立即执行）。
 * 3. **仍然是流式**：开 `stream: true`，边收边从 JSON 里增量解析 `say` 的字符串值
 *    （处理转义与半截 token），到客户端仍是 2–6 字的小片；cues 用 CueScanner 边收边扫。
 * 4. **不信任模型输出**：atChar 必须有限、夹紧；指令过 validateDirective 白名单；
 *    非法项逐条丢弃并计数（`lastStats` 诊断可见），绝不打断整轮。
 * 5. 上游失败/超时 → 发一条 error{recoverable:true} 后正常结束，绝不 hang。
 *
 * 密钥纪律：apiKey 只用于拼 Authorization 头，不写日志、不进错误消息、不落盘。
 */
import type {
  AnchoredCue,
  Directive,
  Director,
  DirectorInput,
  SessionEvent,
} from "../../shared/protocol.ts";
import type { LlmMode, LlmStructMode } from "../config.ts";
import { LLM_DEFAULTS } from "../config.ts";
import { DIRECTIVE_VOCAB, validateDirectives } from "../scene/validate.ts";
import {
  CueScheduler,
  CueScanner,
  charCount,
  cueFromDirective,
  readRawCue,
  sortCues,
  clampCues,
} from "./cues.ts";
import {
  jsonObjectResponseFormat,
  jsonSchemaResponseFormat,
  resolveStructuredOutput,
  type StructuredOutputDecision,
} from "./struct-probe.ts";
import { chunkText, sleep } from "./stream-utils.ts";

export interface LiveDirectorOptions {
  apiKey: string;
  /** 默认 https://api.deepseek.com（不带 /v1） */
  baseUrl?: string;
  model?: string;
  /** 日志/诊断用的 provider 标签（不含密钥） */
  label?: string;
  extraHeaders?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  /** 上游无响应超时（毫秒）：超时按可恢复错误收尾，而不是让 SSE 挂着 */
  timeoutMs?: number;
  /** 结构化输出档位（默认 auto；由 config 的 MIRA_LLM_STRUCT 决定） */
  struct?: LlmStructMode;
  /** 调用模式（默认 chat；tool 目前只有配置位，未实现） */
  mode?: LlmMode;
  /** 测试注入用（探针与对话共用）；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 探针超时（毫秒），默认 4s */
  probeTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** 片间间隔：上游本身是流式的，这里只做轻微平滑，不人为拖慢 */
const LIVE_CHUNK_DELAY_MS = 28;

const SYSTEM_PROMPT = `你是 Mira，26 岁的旅行摄影师。琥珀色雨衣，银色星星发夹。
此刻你在打烊前的小咖啡馆里，窗外下雨，你在等一个没有说明原因的人。
你说话：中文、短句、克制、偶尔自嘲，不解释自己的处境太多，会岔开话题。

输出格式（严格遵守）：只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要任何解释文字。
{"cues": [{"atChar": 0, "d": {"kind": "emotion", "emotion": "warm"}}], "say": "你要说出口的台词"}

规则：
1. say：中文口语，2–4 句，总共不超过 90 个字；不写旁白（不要「她低下头」这种描述）。
2. cues：可以为空数组 []。atChar 表示「说到 say 的第几个字符时」触发（0 起，按字符数；
   0 = 开口之前）。把动作放在它对应的那句话之后，而不是全部堆在开头：
   例：say="刚才那一下——你看见了吗。" 时，闪电写 atChar=6（「刚才那一下——」说完）。
   一定要先写 cues，再写 say（顺序会影响投递时机）。
3. d 是指令本体，可用取值（只能用这些，kind 与字段名必须完全一致）：
   {"kind":"emotion","emotion":${JSON.stringify(DIRECTIVE_VOCAB.emotion)}}
   {"kind":"pose","pose":${JSON.stringify(DIRECTIVE_VOCAB.pose)}}
   {"kind":"action","action":${JSON.stringify(DIRECTIVE_VOCAB.action)}}
   {"kind":"camera","move":${JSON.stringify(DIRECTIVE_VOCAB.camera)}}
   {"kind":"vfx","vfx":${JSON.stringify(DIRECTIVE_VOCAB.vfx)}}
   {"kind":"scene","scene":${JSON.stringify(DIRECTIVE_VOCAB.scene)}}
4. 需要让玩家做选择时加一条 cue，atChar 放在台词末尾：
   {"atChar": <say 的字符数>, "d": {"kind":"branch","options":[{"id":"stay","label":"陪你一起等"},{"id":"call","label":"我帮你打个电话"}]}}
5. 不要重复已经演过的显著画面（闪电、灯暗这类一场对话只放一次）。
6. 场景只在**用户明确提到地点或时间**时才切，一轮最多一条 scene，且不要切成当前场景：
   **只能用下面这几个场景**（其余地点的画面还不存在，切过去会是空场）：
   · 说「去海边 / 看海 / 海边 / 大海」→ scene = seaside_dawn（破晓的海面、礁石与沙）
   · 说「去街上 / 上街 / 出门 / 出去走走」→ scene = street_night（雨夜街道、湿地反光与街灯）
   · 说「去酒店 / 楼下等 / 门廊下 / 大堂」→ scene = hotel_entrance（酒店门廊、雨棚与暖光溢出）
   · 说「打烊了 / 要关门 / 该走了」→ scene = cafe_closing（灯暗、桌椅收起）
   · 说「看看窗外 / 街对面 / 看雨」→ scene = window_rain（雨窗视角）
   · 又要「回店里 / 还是店里暖和」→ scene = cafe_night（回到咖啡店夜景）
   · 用户点名**画面里仍然没有的地点**（车站、地铁、海上、山顶…）时：不要发 scene 指令，也不要说
     「我们到了」这种假装切走的台词；用一句话如实承认边界（例如「车站现在什么都没有，
     我只能在这儿陪你等」），然后留在当前场景继续对话。
   · 同时**不要**接着聊与当前场景矛盾的天气或光线：人在室内就别写成他正淋雨；
     切到海边后就按破晓的海边说话（天快亮了、海面发白），不要写暴雨。
   用户没点地点也不要主动切场景——画面自己乱逛比不切更糟。`;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 解析结果：新格式带 cues，旧格式的 directives 会被转成 atChar=0 的 cues */
export interface DirectorPayload {
  say: string;
  /** 兼容字段：扁平指令列表（按 atChar 排序，等价于 cues.map(c => c.directive)） */
  directives: Directive[];
  /** 带时序的指令（已排序、已夹到 [0, say.length]） */
  cues: AnchoredCue[];
  /** 诊断：被丢弃的条数（atChar 非法 / 指令非法） */
  dropped: { atChar: number; directive: number };
}

/** 一轮的解析统计（诊断可见：谁被丢了、为什么、用的哪种结构化输出） */
export interface LiveTurnStats {
  cues: number;
  droppedAtChar: number;
  droppedDirective: number;
  struct: StructuredOutputDecision | null;
}

export class LiveDirector implements Director {
  readonly name: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #extraHeaders: Record<string, string>;
  readonly #temperature: number;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;
  readonly #struct: LlmStructMode;
  readonly #mode: LlmMode;
  readonly #fetch: typeof fetch;
  readonly #probeTimeoutMs: number | undefined;
  #lastStats: LiveTurnStats = {
    cues: 0,
    droppedAtChar: 0,
    droppedDirective: 0,
    struct: null,
  };

  constructor(options: LiveDirectorOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? LLM_DEFAULTS.deepseek.baseUrl).replace(/\/+$/, "");
    this.#model = options.model || LLM_DEFAULTS.deepseek.model;
    this.#extraHeaders = options.extraHeaders ?? {};
    this.#temperature = options.temperature ?? 0.8;
    this.#maxTokens = options.maxTokens ?? 320;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#struct = options.struct ?? "auto";
    this.#mode = options.mode ?? "chat";
    this.#fetch = options.fetchImpl ?? fetch;
    this.#probeTimeoutMs = options.probeTimeoutMs;
    // 名字会出现在 SessionInfo.directorName 里，只放 provider 标签
    this.name = `live-${options.label ?? "openai-compatible"}`;
  }

  /** 最近一轮的解析/能力统计（诊断页或测试读取；不含密钥与响应体） */
  get lastStats(): LiveTurnStats {
    return this.#lastStats;
  }

  /** 选结构化输出档位：auto 时这里会触发一次探测（进程内缓存，只探一次） */
  async resolveStructDecision(): Promise<StructuredOutputDecision> {
    return resolveStructuredOutput({
      mode: this.#struct,
      provider: { baseUrl: this.#baseUrl, model: this.#model, apiKey: this.#apiKey, extraHeaders: this.#extraHeaders },
      fetchImpl: this.#fetch,
      timeoutMs: this.#probeTimeoutMs,
    });
  }

  async *stream(input: DirectorInput, signal: AbortSignal): AsyncIterable<SessionEvent> {
    // tool calling 只留配置位：明确报「未实现」，不写半成品分支
    if (this.#mode === "tool") {
      yield this.#failure(
        input,
        "MIRA_LLM_MODE=tool 尚未实现：本版本只支持 chat + 结构化输出（json_schema / json_object）",
      );
      return;
    }

    const decision = await this.resolveStructDecision();
    if (signal.aborted) return;
    this.#lastStats = { cues: 0, droppedAtChar: 0, droppedDirective: 0, struct: decision };

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#apiKey}`,
            ...this.#extraHeaders,
          },
          body: JSON.stringify({
            model: this.#model,
            messages: this.#buildMessages(input),
            stream: true,
            temperature: this.#temperature,
            max_tokens: this.#maxTokens,
            // 结构化输出：json_schema（端点支持时）或 json_object（保底）
            response_format:
              decision.strategy === "json_schema" ? jsonSchemaResponseFormat() : jsonObjectResponseFormat(),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (signal.aborted) return;
        yield this.#failure(
          input,
          timedOut ? `上游模型超时（${this.#timeoutMs}ms）` : `上游模型请求失败：${describe(error)}`,
        );
        return;
      }

      if (!response.ok || !response.body) {
        yield this.#failure(input, `上游模型返回 ${response.status}：${await snippet(response)}`);
        return;
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const extractor = new SayExtractor();
      const scanner = new CueScanner();
      // cues 在 JSON 里的出现顺序未必严格（模型不一定守规矩），调度器负责按 atChar 重排
      const scheduler = new CueScheduler([], {});
      let lineBuffer = "";
      let rawAll = "";
      let pending = "";
      let emitted = "";
      let spoken = 0;
      let doneSeen = false;

      while (!doneSeen) {
        if (signal.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const content = parseSseContent(line);
          if (content === null) continue;
          if (content === DONE) {
            doneSeen = true;
            break;
          }

          rawAll += content;
          // cues 是 JSON 前缀：先扫它，台词开播前就有 atChar 可用
          scheduler.feed(scanner.push(content));

          // 从 JSON 里增量抠出 say 的字符串值，边到边播
          pending += extractor.push(content);
          const ready = splitReady(pending);
          pending = ready.rest;

          for (const piece of ready.pieces) {
            if (signal.aborted) return;
            // 片前先放「已经越过」的指令：说到第 N 个字符时，画面就在这一刻变
            for (const cue of scheduler.advance(spoken)) {
              yield this.#cueEvent(input, cue);
            }
            emitted += piece;
            spoken += charCount(piece);
            yield { type: "text.delta", turnId: input.turnId, epoch: input.epoch, text: piece };
            await sleep(LIVE_CHUNK_DELAY_MS, signal);
          }
        }
      }

      if (signal.aborted) return;

      // ---- 收尾：补完台词 → 再补在后面才扫到的 cues ----
      const payload = parseDirectorPayload(rawAll);

      if (!payload) {
        // 模型违约（漏引号 / 单引号 / 散文 / 截断）：**不再**把它当用户可见错误，
        // 也**不**把残留文本当台词交出去。违约时那部分可能夹带 `directives` 的原文
        // 字面量（2026-10-29 真实踩过：字幕里出现
        // `!'directives': [{'kind':'emotion',…}]}`），静默当正常台词就等于把它
        // 交给字幕和 TTS。所以：本轮的残段整段丢弃、本轮安静结束。
        // 原则：字幕/语音边界可信 > 动作完整性；违约必须可观测，但**只记长度与类别**，
        // 绝不记原文（原文就是用户会听到的那句话）。
        console.warn(
          // 只记长度，**绝不记原文**：emitted 是台词本身（用户会听到的那句话），
          // 写成 ${emitted} 会把它原样落进日志（实测踩过）。
          `[director:live] payload invalid turn=${input.turnId} raw=${rawAll.length}chars emitted=${emitted.length}chars`,
        );
        return;
      }

      const remainder = remainderOf(payload, emitted) || pending;

      for (const piece of chunkText(remainder)) {
        if (signal.aborted) return;
        emitted += piece;
        spoken += charCount(piece);
        yield { type: "text.delta", turnId: input.turnId, epoch: input.epoch, text: piece };
        await sleep(LIVE_CHUNK_DELAY_MS, signal);
      }

      {
        // 扫描器已经放出去的那批不重复；剩下的（旧格式 directives / 尾巴才到的 cues）在这里补
        scheduler.feed(payload.cues.slice(Math.max(0, scanner.cues.length)));
        for (const cue of scheduler.advance(spoken)) {
          if (signal.aborted) return;
          yield this.#cueEvent(input, cue);
        }
        for (const cue of scheduler.takeAll()) {
          if (signal.aborted) return;
          yield this.#cueEvent(input, cue);
        }

        const scanned = scanner.stats;
        this.#lastStats = {
          cues: payload.cues.length,
          droppedAtChar: Math.max(payload.dropped.atChar, scanned.droppedAtChar),
          droppedDirective: Math.max(payload.dropped.directive, scanned.droppedDirective),
          struct: decision,
        };
      }
    } catch (error) {
      if (signal.aborted) return;
      yield this.#failure(input, `导演流异常：${describe(error)}`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", forwardAbort);
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // 流可能已经被上游关闭，忽略
        }
      }
    }
  }

  /** 指令事件：带上 atChar，客户端不认这个字段也不会坏（旧行为 = 立即执行） */
  #cueEvent(input: DirectorInput, cue: AnchoredCue): SessionEvent {
    return {
      type: "directive",
      turnId: input.turnId,
      epoch: input.epoch,
      directive: cue.directive,
      atChar: cue.atChar,
    };
  }

  #buildMessages(input: DirectorInput): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
    // 只回带最近若干轮，控制 token 成本
    for (const item of input.history.slice(-12)) {
      messages.push({ role: item.role === "user" ? "user" : "assistant", content: item.text });
    }
    const sceneHint = `[画面] 场景=${input.scene.scene} 情绪=${input.scene.emotion} 姿势=${input.scene.pose}；已演过的显著画面=${input.scene.playedBeats.join(",") || "无"}`;
    messages.push({ role: "user", content: `${sceneHint}\n玩家：${input.userText}` });
    return messages;
  }

  #failure(input: DirectorInput, message: string): SessionEvent {
    return { type: "error", turnId: input.turnId, epoch: input.epoch, message, recoverable: true };
  }
}

// ---------------------------------------------------------------- 流式 JSON 解析

const DONE = Symbol("sse-done");

/** 提示词要求 say ≤90 字；模型违约时留一倍余量后强行截断，防止无限吐 */
const MAX_SAY_CHARS = 180;
/**
 * 结构性字段名：模型输出不合法（单引号/漏引号）时用它当停止标记。
 * 必须覆盖当前提示词用到的每一个字段名——旧格式 `directives`、新格式 `cues`。
 * 漏一个就等于留一条把指令原文播出去的通道。
 */
const STRUCTURAL_WORDS = ["cues", "directives"] as const;
/** 台词尾部的「可能属于结构化语法」的字符：引号、冒号、逗号、空白 */
const TRAILING_DIRT = /[\s'"`:,\uFF1A]+$/u;

/** 解析一行 SSE，返回 delta.content；`[DONE]` 返回哨兵；其他返回 null */
function parseSseContent(line: string): string | typeof DONE | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === "[DONE]") return DONE;

  try {
    const parsed = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
    };
    const choice = parsed.choices?.[0];
    const content = choice?.delta?.content ?? choice?.message?.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * 从半成品 JSON 文本里增量取出 say 字段的字符串值。
 * 处理 `\"`、`\n`、`\uXXXX` 与「转义只到一半」的情况：不完整就等下一片。
 * 顺带让客户端在第一句话时就开口，而不是等整段 JSON 到齐。
 */
export class SayExtractor {
  #raw = "";
  #start = -1;
  #scan = 0;
  #done = false;
  /** 已吐出的台词字数：模型违约时用它兜住长度（提示词要求 ≤90 字） */
  #chars = 0;
  /** 是否因「结构性字段」而停（停在脏字符上时要回退尾部标点） */
  #dirtyStop = false;
  /**
   * 可能变成脏字符的尾巴，留一片再决定发不发。
   * 跨 chunk 的情况（`'` 已在上一片发出、下一片才认出 directives）没法撤回，
   * 所以最后一个字符永远压一拍。
   */
  #tail = "";

  get done(): boolean {
    return this.#done;
  }

  /** 喂入一段增量原文，返回这段里新解出来的台词片段 */
  push(delta: string): string {
    this.#raw += delta;
    if (this.#done) return "";

    if (this.#start < 0) {
      const match = /"say"\s*:\s*"/.exec(this.#raw);
      if (!match) return "";
      this.#start = match.index + match[0].length;
      this.#scan = this.#start;
    }

    let out = this.#tail;
    this.#tail = "";
    while (this.#scan < this.#raw.length) {
      const char = this.#raw[this.#scan] ?? "";

      // ---- 护栏：模型不守 JSON 时（漏结束引号、directives 写成单引号），
      // 绝不能让结构性字段流成台词（2026-10-28 线上 lithosai 代理实况：
      // 字幕里播出了 `! 'directives': [{'kind':'emotion',...}]}`）。
      // 见到对象收尾、directives 字段名、或超过长度上限，立刻停。
      if (char === "}") {
        this.#dirtyStop = true;
        this.#done = true;
        break;
      }
      if (this.#atStructuralField()) {
        this.#dirtyStop = true;
        this.#done = true;
        break;
      }
      if (this.#chars >= MAX_SAY_CHARS) {
        this.#dirtyStop = true;
        this.#done = true;
        break;
      }

      if (char === "\\") {
        const next = this.#raw[this.#scan + 1];
        if (next === undefined) break; // 半截转义，等下一片
        if (next === "u") {
          const hex = this.#raw.slice(this.#scan + 2, this.#scan + 6);
          if (hex.length < 4) break;
          const code = Number.parseInt(hex, 16);
          out += Number.isFinite(code) ? String.fromCharCode(code) : "";
          this.#scan += 6;
          continue;
        }
        out += next === "n" ? "\n" : next === "t" ? " " : next;
        this.#scan += 2;
        continue;
      }

      if (char === '"') {
        this.#done = true;
        this.#scan += 1;
        break;
      }

      out += char;
      this.#chars += 1;
      this.#scan += 1;
    }

    // 停在脏字符上时（例如 `! '` 之后才认出 directives），回退尾部 ASCII 标点；
    // 正常收尾时也要回退——模型常写成 `台词! , "cues": [...]`，
    // 那个 `, "` 会先于 `cues` 在上一片就被当台词发出去，只能在这里回退。
    // 中文台词不会以 , : 引号 这类字符结尾，所以不会误伤。
    // 没停也没结束时压住最后一个字符，等下一片确认它不是脏尾巴。
    if (this.#dirtyStop || this.#done) {
      out = out.replace(TRAILING_DIRT, "");
    } else {
      const dirt = TRAILING_DIRT.exec(out)?.[0] ?? "";
      if (dirt) {
        this.#tail = dirt;
        out = out.slice(0, out.length - dirt.length);
      }
    }

    return out;
  }

  /** 扫描位置是否正对着结构性字段，含跨 chunk 的半截情况（"direc" / "cu"） */
  #atStructuralField(): boolean {
    for (const word of STRUCTURAL_WORDS) {
      const tail = this.#raw.slice(this.#scan, this.#scan + word.length);
      if (!tail) continue;
      // 半截前缀先停住等下一片，否则会被当台词吐出去；完整命中直接停
      if (word.startsWith(tail) || tail.startsWith(word)) return true;
    }
    return false;
  }
}

/** 把待发文字切成 2–6 字小片；尾部只剩 1 字时先压住，等下一片拼 */
export function splitReady(text: string): { pieces: string[]; rest: string } {
  const pieces = chunkText(text);
  const last = pieces[pieces.length - 1];
  if (last && Array.from(last).length < 2) return { pieces: pieces.slice(0, -1), rest: last };
  return { pieces, rest: "" };
}

/**
 * 解析完整 JSON 输出；容忍代码围栏与前后多余文字。
 *
 * 两种形状都吃：
 *   新：{"cues":[{"atChar":6,"d":{...}}, ...],"say":"..."}
 *   旧：{"say":"...","directives":[{...}]}  →  每条转成 atChar=0 的 cue（立即执行）
 * 非法的 atChar / 指令逐条丢弃并计数，say 保留 —— 一条脏数据不该毁掉整轮。
 */
/**
 * 抢救台词：模型偶尔吐出被截断/夹了散文的 JSON，整轮直接报错太粗暴。
 * 这里从原文里捞出 `"say":"…"` 的完整部分（遇到未转义的结尾引号就停），
 * 返回不含 cues 的 payload —— 用户听到的是「这轮没有动作，但有台词」，
 * 而不是「出错了：上游返回的内容无法解析为 JSON」。
 */
export function salvageSay(raw: string): DirectorPayload | null {
  const match = /"say"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
  if (!match) return null;
  let body = match[1] ?? "";
  // 截断在半个转义序列上时，回退到最后一个完整反斜杠之前
  const trailing = /\\$/.test(body) ? body.slice(0, -1) : body;
  const text = trailing.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
  if (!text) return null;
  return { say: text, cues: [], directives: [], dropped: { atChar: 0, directive: 0 } } as DirectorPayload;
}

export function parseDirectorPayload(raw: string): DirectorPayload | null {
  const cleaned = raw.replace(/```[a-zA-Z]*\n?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const say =
    typeof record.say === "string" ? record.say : typeof record.text === "string" ? record.text : "";
  const sayText = say.trim();
  const sayLength = charCount(sayText);

  const dropped = { atChar: 0, directive: 0 };
  const rawCues = Array.isArray(record.cues) ? record.cues : null;

  let cues: AnchoredCue[] = [];
  if (rawCues) {
    for (const item of rawCues) {
      const read = readRawCue(item);
      if (read.cue) cues.push(read.cue);
      else if (read.dropped === "atChar") dropped.atChar += 1;
      else dropped.directive += 1;
    }
  } else {
    // 旧格式：白名单校验（非法项在这里丢掉，不会流到渲染层），atChar 一律 0
    const legacy = validateDirectives(record.directives);
    const rawLegacy = Array.isArray(record.directives) ? record.directives.length : 0;
    dropped.directive += Math.max(0, rawLegacy - legacy.length);
    cues = legacy.map(cueFromDirective);
  }

  cues = sortCues(clampCues(cues, sayLength));

  return {
    say: sayText,
    directives: cues.map((cue) => cue.directive),
    cues,
    dropped,
  };
}

/** 流式已经播了一部分时，只补没播过的那段 */
function remainderOf(payload: DirectorPayload | null, emitted: string): string {
  if (!payload || !payload.say) return "";
  if (!emitted) return payload.say;
  if (payload.say.startsWith(emitted)) return payload.say.slice(emitted.length);
  return "";
}

async function snippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, " ").slice(0, 200);
  } catch {
    return "";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
