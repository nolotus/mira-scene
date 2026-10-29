/**
 * 真模型输出的解析层：结构化 JSON + 增量取 say 字段。
 * 这部分最容易出隐蔽 bug（半截转义、半截 token、模型加围栏），所以单独测。
 */
import { describe, expect, test } from "bun:test";
import {
  LiveDirector,
  SayExtractor,
  parseDirectorPayload,
  splitReady,
} from "../../src/server/director/live.ts";
import type { DirectorInput, SessionEvent } from "../../src/shared/protocol.ts";

const FAKE_KEY = "sk-test";

const liveInput: DirectorInput = {
  userText: "外面还在下雨吗？",
  scene: { scene: "cafe_night", emotion: "neutral", pose: "stand", playedBeats: [] },
  history: [],
  turnId: "turn-dirty",
  epoch: 1,
};

/** 把若干增量包成 OpenAI 兼容的 SSE 流（不联网） */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 2026-10-28 线上实况原文：lithosai 上的 DeepSeek-V4.1-Flash 没守住 json_object，
 *  say 漏写结束引号、directives 用单引号，结果指令原文被当台词播了出去。 */
const DIRTY_LIVE_OUTPUT =
  `{"say": "哦，听错了。这雨声太吵。! 'directives': [{'kind':'emotion','emotion':'curious'}]}`;

/** 新格式（cues 在前或后、字段名变了）下同样的违约：say 漏结束引号，尾巴接着写 cues 数组。
 *  这条守住的是「护栏只认旧字段名 directives」的漏洞。 */
const DIRTY_CUES_OUTPUT =
  `{"say": "哦，听错了。这雨声太吵。! , "cues": [{"a":12,"d":{"kind":"emotion","emotion":"curious"}}]}`;


describe("parseDirectorPayload", () => {
  test("标准形状：say + directives", () => {
    const payload = parseDirectorPayload(
      '{"say":"…一个不太守时的人。","directives":[{"kind":"pose","pose":"turn_away"},{"kind":"vfx","vfx":"rain_heavy"}]}',
    );
    expect(payload?.say).toBe("…一个不太守时的人。");
    expect(payload?.directives).toEqual([
      { kind: "pose", pose: "turn_away" },
      { kind: "vfx", vfx: "rain_heavy" },
    ]);
  });

  test("非法的指令取值被丢弃，台词保留", () => {
    const payload = parseDirectorPayload(
      '{"say":"雨又大了。","directives":[{"kind":"emotion","emotion":"furious"},{"kind":"emotion","emotion":"anxious"},{"kind":"teleport"}]}',
    );
    expect(payload?.say).toBe("雨又大了。");
    expect(payload?.directives).toEqual([{ kind: "emotion", emotion: "anxious" }]);
  });

  test("容忍代码围栏与前后多余文字", () => {
    const payload = parseDirectorPayload('好的，这是 JSON：\n```json\n{"say":"嗯。","directives":[]}\n```');
    expect(payload?.say).toBe("嗯。");
    expect(payload?.directives).toEqual([]);
  });

  test("缺 directives 字段也接受；text 作为 say 的别名", () => {
    expect(parseDirectorPayload('{"say":"嗯。"}')?.directives).toEqual([]);
    expect(parseDirectorPayload('{"text":"嗯。"}')?.say).toBe("嗯。");
  });

  test("branch 指令解析成选项", () => {
    const payload = parseDirectorPayload(
      '{"say":"真的？","directives":[{"kind":"branch","options":[{"id":"stay","label":"陪你一起等"},{"id":"call","label":"我帮你打个电话"}]}]}',
    );
    expect(payload?.directives).toEqual([
      {
        kind: "branch",
        options: [
          { id: "stay", label: "陪你一起等" },
          { id: "call", label: "我帮你打个电话" },
        ],
      },
    ]);
  });

  test("不是 JSON / 空对象 → null 或空台词", () => {
    expect(parseDirectorPayload("抱歉，我无法回答")).toBeNull();
    expect(parseDirectorPayload("")).toBeNull();
    expect(parseDirectorPayload("{}")?.say).toBe("");
  });
});

describe("SayExtractor（边收 JSON 边取台词）", () => {
  test("跨多个 chunk 增量取出，直到遇到收尾引号为止", () => {
    const extractor = new SayExtractor();
    const chunks = ['{ "say"', ': "', "你好", "呀，", "外面雨好大", "。", '", "directives"', ": [] }"];
    let text = "";
    for (const chunk of chunks) text += extractor.push(chunk);

    expect(text).toBe("你好呀，外面雨好大。");
    expect(extractor.done).toBe(true);
    // 收尾引号之后的内容不再当台词
    expect(extractor.push('"directives":[]}')).toBe("");
  });

  test("处理转义：\\\" \\n \\u4f60 以及半截转义", () => {
    const extractor = new SayExtractor();
    let text = "";
    text += extractor.push('{"say":"他说：\\"等我');
    text += extractor.push('\\"\\n然后\\u4f60'); // 半截 \u4f60 需要下一片补齐
    text += extractor.push("\\u597d。\"}");
    expect(text).toBe('他说："等我"\n然后你好。');
  });

  test("say 之前有别的字段也认得；没有 say 什么都不吐", () => {
    const extractor = new SayExtractor();
    expect(extractor.push('{"directives":[],"say":"嗯')).toBe("嗯");
    expect(new SayExtractor().push('{"directives":[]}')).toBe("");
  });
});

describe("splitReady", () => {
  test("尾部 1 字先压住，等下一片拼，保证每片 2–6 字", () => {
    const first = splitReady("你好呀");
    for (const piece of first.pieces) {
      const length = Array.from(piece).length;
      expect(length).toBeGreaterThanOrEqual(2);
      expect(length).toBeLessThanOrEqual(6);
    }
    expect(Array.from(first.rest).length).toBeLessThan(2);
  });

  test("短文本（1 字）不产出碎屑", () => {
    const result = splitReady("嗯");
    expect(result.pieces).toEqual([]);
    expect(result.rest).toBe("嗯");
  });
});

describe("SayExtractor · 模型违约时的护栏", () => {
  test("漏写结束引号 + 单引号 directives：只吐台词，不夹带指令原文", () => {
    const extractor = new SayExtractor();
    let text = "";
    for (const chunk of DIRTY_LIVE_OUTPUT.match(/[\s\S]{1,5}/g) ?? [DIRTY_LIVE_OUTPUT]) {
      text += extractor.push(chunk);
    }
    // 尾部写坏的引号被回退，指令原文一个字都不进台词
    expect(text).toBe("哦，听错了。这雨声太吵。!");
    expect(text).not.toContain("directives");
    expect(extractor.done).toBe(true);
    expect(parseDirectorPayload(DIRTY_LIVE_OUTPUT)).toBeNull();
  });

  test("遇到对象收尾就停，不把尾随文字当台词", () => {
    const extractor = new SayExtractor();
    expect(extractor.push('{"say":"嗯，雨停了}外面有人喊"')).toBe("嗯，雨停了");
    expect(extractor.done).toBe(true);
  });

  test("结构性字段名跨 chunk 被切断时也要停住", () => {
    const extractor = new SayExtractor();
    let text = extractor.push('{"say":"嗯。\'direc');
    text += extractor.push("tives': []}");
    expect(text).toBe("嗯。");
    expect(extractor.done).toBe(true);
  });

  test("模型不守长度时在 180 字处硬截断", () => {
    const extractor = new SayExtractor();
    const out = extractor.push(`{"say":"${"雨".repeat(300)}`);
    expect(Array.from(out).length).toBe(180);
    expect(extractor.done).toBe(true);
  });

  test("新格式的 cues 字段同样是结构性标记，不能当台词吐出去", () => {
    const extractor = new SayExtractor();
    let text = extractor.push('{"say":"哦，听错了。! , "cu');
    text += extractor.push('es": [{"a":12,"d":{"kind":"emotion"}}]}');
    // 尾部 `, "` 被回退，cues 原文一个字都不进台词
    expect(text).toBe("哦，听错了。!");
    expect(text).not.toContain("cues");
    expect(extractor.done).toBe(true);
  });
});

describe("LiveDirector · 模型输出违约", () => {
  test("已经流出的脏台词：违约现在**不报错**，残段整段丢弃、字幕不含指令原文", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(DIRTY_LIVE_OUTPUT.match(/[\s\S]{1,8}/g) ?? [DIRTY_LIVE_OUTPUT])) as unknown as typeof fetch;
    try {
      const director = new LiveDirector({ apiKey: FAKE_KEY, baseUrl: "http://127.0.0.1:1", timeoutMs: 5000 });
      const events: SessionEvent[] = [];
      const logs: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
      try {
        for await (const event of director.stream(liveInput, new AbortController().signal)) {
          events.push(event);
        }
      } finally {
        console.warn = originalWarn;
      }

      const text = events.flatMap((event) => (event.type === "text.delta" ? [event.text] : [])).join("");
      expect(text).not.toContain("directives");
      // 安全底线不变：违约时那部分残段（可能夹带指令原文）绝不允许进字幕
      expect(text).not.toContain("kind");
      // 正向断言：丢弃残段**不能**误伤已经正常流出的前半句
      expect(text).toBe("哦，听错了。这雨声太吵。!");

      // 日志纪律：违约只记长度，绝不把台词原文写进日志
      expect(logs.join("\n")).not.toContain("哦，听错了");
      // 新契约：违约不再产生用户可见错误（旧行为会在末尾发 recoverable error，
      // 用户看到「出错了：上游返回的内容无法解析为 JSON」，整轮台词被吞）
      const errors = events.flatMap((event) => (event.type === "error" ? [event] : []));
      expect(errors).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("新格式 cues 下的违约：台词干净、不重复投递 cues、且不报错", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(DIRTY_CUES_OUTPUT.match(/[\s\S]{1,8}/g) ?? [DIRTY_CUES_OUTPUT])) as unknown as typeof fetch;
    try {
      const director = new LiveDirector({ apiKey: FAKE_KEY, baseUrl: "http://127.0.0.1:1", timeoutMs: 5000 });
      const events: SessionEvent[] = [];
      for await (const event of director.stream(liveInput, new AbortController().signal)) {
        events.push(event);
      }

      const text = events.flatMap((event) => (event.type === "text.delta" ? [event.text] : [])).join("");
      // 安全底线：脏尾巴不进字幕（用输入里**真实存在**的关键字，别写成 vacuous 断言）
      expect(text).not.toContain("cues");
      expect(text).not.toContain("directives");
      // 正向断言：合法前半句必须完整流出（防止「丢残段」误伤正常台词）
      expect(text).toBe("哦，听错了。这雨声太吵。!");
      // CueScanner 只认 say 之前出现的 cues；这段脏尾巴不能变成 directive 事件
      expect(events.filter((event) => event.type === "directive").length).toBe(0);
      // 新契约：不报错（旧行为末尾发 recoverable error）
      expect(events.filter((event) => event.type === "error")).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});


describe("LiveDirector · 纯文本叙述（不带 JSON）", () => {
  const PLAIN = "雨下这么大，你想让我淋成落汤鸡啊？不过店里暖气还开着。";

  test("完全没有 JSON 结构 → 原文当台词放行，且不报错", async () => {
    // 2026-10-29 线上实测：模型连续三轮直接吐 30~45 字纯叙述，emitted=0，
    // 用户体感就是「她不回话」。这类输出没有任何结构字样，放行是安全的。
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(PLAIN.match(/[\s\S]{1,8}/g) ?? [PLAIN])) as unknown as typeof fetch;
    try {
      const director = new LiveDirector({ apiKey: FAKE_KEY, baseUrl: "http://127.0.0.1:1", timeoutMs: 5000 });
      const events: SessionEvent[] = [];
      for await (const event of director.stream(liveInput, new AbortController().signal)) {
        events.push(event);
      }
      const text = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
      expect(text).toBe(PLAIN);
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("散装/无括号的结构痕迹：整段丢弃，不许放行", async () => {
    // 这些形态**没有可救的 say**：解析器返回 null，必须整段丢弃。
    // 契约：脏内容绝不进字幕，但这一轮**必须有回应**（零输出由服务端给可信接话）。
    for (const dirty of [
      "哦，听错了。!'directives': [{'kind':'emotion'}]}",
      '废话一句 {"cues":[{"atChar":3}]}',
      // 审查实测的漏网形态：全角引号、裸 say、散装 kind
      '“say”: “雨下大了”',
      'say: 雨下大了',
      'say：雨下大了',
      "kind: 'emotion', name: 'smile'",
    ]) {
      const original = globalThis.fetch;
      globalThis.fetch = (async () =>
        sseResponse(dirty.match(/[\s\S]{1,6}/g) ?? [dirty])) as unknown as typeof fetch;
      try {
        const director = new LiveDirector({ apiKey: FAKE_KEY, baseUrl: "http://127.0.0.1:1", timeoutMs: 5000 });
        const events: SessionEvent[] = [];
        for await (const event of director.stream(liveInput, new AbortController().signal)) {
          events.push(event);
        }
        const text = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
        expect(text).not.toContain("directives");
        expect(text).not.toContain("cues");
        expect(text).not.toContain("kind");
        expect(text.length).toBeGreaterThan(0);
        expect(events.filter((e) => e.type === "error")).toEqual([]);
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  test("say 完整、尾巴截断（directives 未闭合）→ 照旧救出台词，只是丢动作", async () => {
    // 这是解析器的既有能力，不能因为本轮收紧正则而被误伤。
    const dirty = '{"say": "台词", "directives": [';
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(dirty.match(/[\s\S]{1,6}/g) ?? [dirty])) as unknown as typeof fetch;
    try {
      const director = new LiveDirector({ apiKey: FAKE_KEY, baseUrl: "http://127.0.0.1:1", timeoutMs: 5000 });
      const events: SessionEvent[] = [];
      for await (const event of director.stream(liveInput, new AbortController().signal)) {
        events.push(event);
      }
      const text = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
      expect(text).toBe("台词");
      expect(events.filter((e) => e.type === "directive")).toEqual([]);
      expect(events.filter((e) => e.type === "error")).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("LiveDirector · 零输出兜底（保证一定回话）", () => {
  test("模型吐非 JSON 且一个字都没发出 → 必须给出可信接话，且不带动作", async () => {
    const dirty = "哦，听错了。!'directives': [{'kind':'emotion'}]}";
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      sseResponse(dirty.match(/[\s\S]{1,6}/g) ?? [dirty])) as unknown as typeof fetch;
    try {
      const director = new LiveDirector({ apiKey: FAKE_KEY, baseUrl: "http://127.0.0.1:1", timeoutMs: 5000 });
      const events: SessionEvent[] = [];
      for await (const event of director.stream(liveInput, new AbortController().signal)) {
        events.push(event);
      }
      const text = events.flatMap((e) => (e.type === "text.delta" ? [e.text] : [])).join("");
      // 保证有回应
      expect(text.length).toBeGreaterThan(0);
      // 但绝不把脏内容当台词
      expect(text).not.toContain("directives");
      expect(text).not.toContain("kind");
      // 兜底句不带动作
      expect(events.filter((e) => e.type === "directive")).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
