/**
 * LiveDirector —— 真模型导演（DeepSeek 直连，OpenAI 兼容 /chat/completions）。
 *
 * 关键设计：
 * 1. **结构化输出**：请求带 `response_format: {"type": "json_object"}`，模型只能吐
 *    `{"say": "...", "directives": [...]}`，省掉「从自由文本里抠指令」这件不稳的事。
 * 2. **仍然是流式**：开 `stream: true`，边收边从 JSON 里增量解析 `say` 字段的字符串值
 *    （处理转义与半截 token），到客户端仍是 2–6 字的小片；directives 在 JSON 尾部，收完再发。
 * 3. **不信任模型输出**：`directives` 全部过 validateDirective 白名单，非法值静默丢弃。
 * 4. 上游失败/超时 → 发一条 error{recoverable:true} 后正常结束，绝不 hang。
 *
 * 密钥纪律：apiKey 只用于拼 Authorization 头，不写日志、不进错误消息、不落盘。
 */
import type { Directive, Director, DirectorInput, SessionEvent } from "../../shared/protocol.ts";
import { LLM_DEFAULTS } from "../config.ts";
import { DIRECTIVE_VOCAB, validateDirectives } from "../scene/validate.ts";
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
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** 片间间隔：上游本身是流式的，这里只做轻微平滑，不人为拖慢 */
const LIVE_CHUNK_DELAY_MS = 28;

const SYSTEM_PROMPT = `你是 Mira，26 岁的旅行摄影师。琥珀色雨衣，银色星星发夹。
此刻你在打烊前的小咖啡馆里，窗外下雨，你在等一个没有说明原因的人。
你说话：中文、短句、克制、偶尔自嘲，不解释自己的处境太多，会岔开话题。

输出格式（严格遵守）：只输出一个 JSON 对象，不要 Markdown、不要代码围栏、不要任何解释文字。
{"say": "你要说出口的台词", "directives": [ {"kind": "emotion", "emotion": "warm"} ]}

规则：
1. say：中文口语，2–4 句，总共不超过 90 个字；不写旁白（不要「她低下头」这种描述）。
2. directives：可以为空数组 []。只有真的需要改动画面时才放，不要每轮都放。
3. 指令可用取值（只能用这些，kind 与字段名必须完全一致）：
   {"kind":"emotion","emotion":${JSON.stringify(DIRECTIVE_VOCAB.emotion)}}
   {"kind":"pose","pose":${JSON.stringify(DIRECTIVE_VOCAB.pose)}}
   {"kind":"action","action":${JSON.stringify(DIRECTIVE_VOCAB.action)}}
   {"kind":"camera","move":${JSON.stringify(DIRECTIVE_VOCAB.camera)}}
   {"kind":"vfx","vfx":${JSON.stringify(DIRECTIVE_VOCAB.vfx)}}
   {"kind":"scene","scene":${JSON.stringify(DIRECTIVE_VOCAB.scene)}}
4. 需要让玩家做选择时加一条：
   {"kind":"branch","options":[{"id":"stay","label":"陪你一起等"},{"id":"call","label":"我帮你打个电话"}]}
5. 不要重复已经演过的显著画面（闪电、灯暗这类一场对话只放一次）。`;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DirectorPayload {
  say: string;
  directives: Directive[];
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

  constructor(options: LiveDirectorOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? LLM_DEFAULTS.deepseek.baseUrl).replace(/\/+$/, "");
    this.#model = options.model || LLM_DEFAULTS.deepseek.model;
    this.#extraHeaders = options.extraHeaders ?? {};
    this.#temperature = options.temperature ?? 0.8;
    this.#maxTokens = options.maxTokens ?? 320;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 名字会出现在 SessionInfo.directorName 里，只放 provider 标签
    this.name = `live-${options.label ?? "openai-compatible"}`;
  }

  async *stream(input: DirectorInput, signal: AbortSignal): AsyncIterable<SessionEvent> {
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
        response = await fetch(`${this.#baseUrl}/chat/completions`, {
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
            // 强制结构化输出：模型只能吐 {"say","directives"} 形状的 JSON
            response_format: { type: "json_object" },
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
      let lineBuffer = "";
      let rawAll = "";
      let pending = "";
      let emitted = "";
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
          // 从 JSON 里增量抠出 say 的字符串值，边到边播
          pending += extractor.push(content);
          const ready = splitReady(pending);
          pending = ready.rest;

          for (const piece of ready.pieces) {
            if (signal.aborted) return;
            emitted += piece;
            yield { type: "text.delta", turnId: input.turnId, epoch: input.epoch, text: piece };
            await sleep(LIVE_CHUNK_DELAY_MS, signal);
          }
        }
      }

      if (signal.aborted) return;

      // ---- 收尾：补完台词 → 再发结构化指令（JSON 里 directives 在 say 之后）----
      const payload = parseDirectorPayload(rawAll);
      const remainder = remainderOf(payload, emitted) || pending;

      for (const piece of chunkText(remainder)) {
        if (signal.aborted) return;
        emitted += piece;
        yield { type: "text.delta", turnId: input.turnId, epoch: input.epoch, text: piece };
        await sleep(LIVE_CHUNK_DELAY_MS, signal);
      }

      if (payload) {
        for (const directive of payload.directives) {
          if (signal.aborted) return;
          yield { type: "directive", turnId: input.turnId, epoch: input.epoch, directive };
        }
      } else if (!emitted) {
        yield this.#failure(input, "上游返回的内容无法解析为 JSON");
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

    let out = "";
    while (this.#scan < this.#raw.length) {
      const char = this.#raw[this.#scan] ?? "";

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
      this.#scan += 1;
    }

    return out;
  }
}

/** 把待发文字切成 2–6 字小片；尾部只剩 1 字时先压住，等下一片拼 */
export function splitReady(text: string): { pieces: string[]; rest: string } {
  const pieces = chunkText(text);
  const last = pieces[pieces.length - 1];
  if (last && Array.from(last).length < 2) return { pieces: pieces.slice(0, -1), rest: last };
  return { pieces, rest: "" };
}

/** 解析完整 JSON 输出；容忍代码围栏与前后多余文字 */
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
  return {
    say: say.trim(),
    // 白名单校验：非法指令在这里被丢掉，不会流到渲染层
    directives: validateDirectives(record.directives),
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
