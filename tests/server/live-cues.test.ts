/**
 * 真模型导演的时序解析与投递：
 *   · 新格式 {cues:[{atChar,d}], say} ・旧格式 {say, directives[]} 兼容
 *   · 非法 atChar / 非法指令逐条丢弃并计数（诊断可见）
 *   · cues 在 JSON 前缀时，指令按字符边界投递（不再全部堆在台词后面）
 *   · 结构化输出档位：探测一次 200 → json_schema；探测 400 → 退回 json_object
 *
 * 全部用 stub fetch，不联网（探针与对话都由同一个注入的 fetch 承担）。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { charCount } from "../../src/server/director/cues.ts";
import { LiveDirector, parseDirectorPayload } from "../../src/server/director/live.ts";
import { resetStructuredOutputCache } from "../../src/server/director/struct-probe.ts";
import type { DirectorInput, SessionEvent } from "../../src/shared/protocol.ts";

const input: DirectorInput = {
  userText: "外面雨好大",
  scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
  history: [],
  turnId: "turn-cues",
  epoch: 3,
};

describe("parseDirectorPayload · 新格式（cues + 短键 d）", () => {
  test("atChar 保留，d 映射成 directive，顺序按 atChar", () => {
    const payload = parseDirectorPayload(
      '{"cues":[{"atChar":7,"d":{"kind":"vfx","vfx":"lightning"}},{"atChar":0,"d":{"kind":"action","action":"shiver"}}],"say":"刚才那一下——你看见了吗。"}',
    );
    expect(payload?.say).toBe("刚才那一下——你看见了吗。");
    expect(payload?.cues).toEqual([
      { atChar: 0, directive: { kind: "action", action: "shiver" } },
      { atChar: 7, directive: { kind: "vfx", vfx: "lightning" } },
    ]);
    // 兼容字段：扁平指令列表，顺序与 cues 一致
    expect(payload?.directives).toEqual([
      { kind: "action", action: "shiver" },
      { kind: "vfx", vfx: "lightning" },
    ]);
    expect(payload?.dropped).toEqual({ atChar: 0, directive: 0 });
  });

  test("越界 atChar 夹到 say.length", () => {
    const payload = parseDirectorPayload(
      '{"cues":[{"atChar":999,"d":{"kind":"vfx","vfx":"rain_heavy"}}],"say":"雨又大了。"}',
    );
    expect(payload?.cues[0]?.atChar).toBe(charCount("雨又大了。"));
  });
});

describe("parseDirectorPayload · 旧格式兼容", () => {
  test("{say, directives[]} → atChar 均为 0 的 cues（= 立即执行，旧客户端不变）", () => {
    const payload = parseDirectorPayload(
      '{"say":"……一个不太守时的人。","directives":[{"kind":"pose","pose":"turn_away"},{"kind":"vfx","vfx":"rain_heavy"}]}',
    );
    expect(payload?.cues).toEqual([
      { atChar: 0, directive: { kind: "pose", pose: "turn_away" } },
      { atChar: 0, directive: { kind: "vfx", vfx: "rain_heavy" } },
    ]);
    expect(payload?.directives).toEqual([
      { kind: "pose", pose: "turn_away" },
      { kind: "vfx", vfx: "rain_heavy" },
    ]);
    expect(payload?.dropped).toEqual({ atChar: 0, directive: 0 });
  });
});

describe("parseDirectorPayload · 非法项丢弃并计数", () => {
  test("非法 atChar 丢整条，合法项保留", () => {
    const payload = parseDirectorPayload(
      '{"cues":[{"atChar":"七","d":{"kind":"action","action":"nod"}},{"atChar":1,"d":{"kind":"action","action":"nod"}}],"say":"嗯。"}',
    );
    expect(payload?.cues).toEqual([{ atChar: 1, directive: { kind: "action", action: "nod" } }]);
    expect(payload?.dropped.atChar).toBe(1);
    expect(payload?.dropped.directive).toBe(0);
  });

  test("非法指令丢弃计数，台词与其它指令照常", () => {
    const payload = parseDirectorPayload(
      '{"cues":[{"atChar":0,"d":{"kind":"vfx","vfx":"tornado"}},{"atChar":0,"d":{"kind":"teleport"}},{"atChar":2,"d":{"kind":"vfx","vfx":"rain_light"}}],"say":"雨小了点。"}',
    );
    expect(payload?.cues).toEqual([{ atChar: 2, directive: { kind: "vfx", vfx: "rain_light" } }]);
    expect(payload?.dropped.directive).toBe(2);
    expect(payload?.say).toBe("雨小了点。");
  });

  test("旧格式里的非法指令同样计数", () => {
    const payload = parseDirectorPayload('{"say":"嗯。","directives":[{"kind":"vfx","vfx":"tornado"},{"kind":"action","action":"nod"}]}');
    expect(payload?.directives).toEqual([{ kind: "action", action: "nod" }]);
    expect(payload?.dropped.directive).toBe(1);
  });

  test("不是 JSON → null；空对象 → 空台词空 cues", () => {
    expect(parseDirectorPayload("抱歉，我无法回答")).toBeNull();
    expect(parseDirectorPayload("{}")).toEqual({
      say: "",
      directives: [],
      cues: [],
      dropped: { atChar: 0, directive: 0 },
    });
  });
});

// ------------------------------------------------------------------ 流式投递

const SAY = "刚才那一下——你看见了吗。";
const PLAN_JSON = `{"cues":[{"atChar":0,"d":{"kind":"action","action":"shiver"}},{"atChar":7,"d":{"kind":"vfx","vfx":"lightning"}},{"atChar":13,"d":{"kind":"pose","pose":"glance_window"}}],"say":"${SAY}"}`;

/** 把一段 JSON 拆成多条 SSE 事件（模拟上游的流式分块） */
function sseBody(json: string, cuts: number[] = []): string {
  const parts: string[] = [];
  let previous = 0;
  for (const cut of [...cuts, json.length]) {
    if (cut <= previous) continue;
    parts.push(json.slice(previous, cut));
    previous = cut;
  }
  const events = parts.map(
    (piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
  );
  return `${events.join("")}data: [DONE]\n\n`;
}

interface StubCall {
  url: string;
  body: Record<string, unknown>;
}

/** 探针与对话共用的 stub：stream !== true 视为探针请求 */
function stubFetch(options: { probeStatus?: number; cuts?: number[] } = {}): {
  fetchImpl: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (body.stream !== true) {
      const status = options.probeStatus ?? 200;
      return new Response(status === 200 ? '{"ok":true}' : "probe rejected", { status });
    }
    return new Response(sseBody(PLAN_JSON, options.cuts ?? [40, 90]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function director(fetchImpl: typeof fetch, extra: { struct?: "auto" | "json_object" | "json_schema"; mode?: "chat" | "tool" } = {}): LiveDirector {
  return new LiveDirector({
    apiKey: "sk-fake",
    baseUrl: `https://stub.invalid/${Math.random()}`,
    model: "stub-model",
    fetchImpl,
    struct: extra.struct ?? "auto",
    mode: extra.mode ?? "chat",
  });
}

async function collect(instance: LiveDirector, signal = new AbortController().signal): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of instance.stream(input, signal)) events.push(event);
  return events;
}

/** 指令事件触发时已经播了多少字 */
function spokenBefore(events: SessionEvent[], index: number): number {
  let spoken = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const event = events[cursor];
    if (event && event.type === "text.delta") spoken += charCount(event.text);
  }
  return spoken;
}

describe("LiveDirector · 指令按字符位置投递", () => {
  beforeEach(() => resetStructuredOutputCache());

  test("闪电说到「刚才那一下——」之后才发，而不是开头全放", async () => {
    const { fetchImpl } = stubFetch();
    const events = await collect(director(fetchImpl));

    const text = events.flatMap((event) => (event.type === "text.delta" ? [event.text] : [])).join("");
    expect(text).toBe(SAY);

    const lightningAt = events.findIndex(
      (event) => event.type === "directive" && event.directive.kind === "vfx" && event.directive.vfx === "lightning",
    );
    expect(lightningAt).toBeGreaterThan(0);
    expect(spokenBefore(events, lightningAt)).toBeGreaterThanOrEqual(7);
    // 关键回归：不是「全放开头」，也不是「全堆在台词之后」
    const lastTextAt = events.map((event) => event.type).lastIndexOf("text.delta");
    expect(lightningAt).toBeLessThan(lastTextAt);

    const cueEvents = events.filter((event): event is Extract<SessionEvent, { type: "directive" }> => event.type === "directive");
    expect(cueEvents.map((event) => event.atChar)).toEqual([0, 7, 13]);
    // atChar = 0 的那条在开口之前
    expect(spokenBefore(events, events.indexOf(cueEvents[0]!))).toBe(0);
  });

  test("诊断统计可见：cue 条数 + 丢弃计数 + 结构化输出档位", async () => {
    const { fetchImpl } = stubFetch();
    const instance = director(fetchImpl);
    await collect(instance);
    expect(instance.lastStats.cues).toBe(3);
    expect(instance.lastStats.droppedAtChar).toBe(0);
    expect(instance.lastStats.droppedDirective).toBe(0);
    expect(instance.lastStats.struct?.strategy).toBe("json_schema");
  });
});

describe("LiveDirector · 结构化输出档位", () => {
  beforeEach(() => resetStructuredOutputCache());

  test("auto + 探针 200 → 对话请求带 json_schema；同一端点只探一次", async () => {
    const { fetchImpl, calls } = stubFetch({ probeStatus: 200 });
    const instance = director(fetchImpl);
    await collect(instance);
    await collect(instance);

    const probes = calls.filter((call) => call.body.stream !== true);
    const chats = calls.filter((call) => call.body.stream === true);
    expect(probes).toHaveLength(1);
    expect(chats).toHaveLength(2);
    for (const chat of chats) {
      expect((chat.body.response_format as { type?: string }).type).toBe("json_schema");
      expect((chat.body.response_format as { json_schema?: { schema?: unknown } }).json_schema?.schema).toBeTruthy();
    }
  });

  test("auto + 探针 400 → 退回 json_object，对话照常", async () => {
    const { fetchImpl, calls } = stubFetch({ probeStatus: 400 });
    const instance = director(fetchImpl);
    const events = await collect(instance);

    const chat = calls.find((call) => call.body.stream === true);
    expect((chat?.body.response_format as { type?: string }).type).toBe("json_object");
    expect(instance.lastStats.struct).toEqual({ strategy: "json_object", status: 400, reason: "unsupported" });
    expect(events.some((event) => event.type === "text.delta")).toBe(true);
  });

  test("强制 json_object 不发探针", async () => {
    const { fetchImpl, calls } = stubFetch({ probeStatus: 200 });
    await collect(director(fetchImpl, { struct: "json_object" }));
    expect(calls.filter((call) => call.body.stream !== true)).toHaveLength(0);
  });

  test("MIRA_LLM_MODE=tool → 明确报「未实现」，不发任何请求", async () => {
    const { fetchImpl, calls } = stubFetch();
    const events = await collect(director(fetchImpl, { mode: "tool" }));
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const [error] = events;
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.recoverable).toBe(true);
      expect(error.message).toContain("未实现");
      expect(error.message).toContain("MIRA_LLM_MODE=tool");
    }
  });

  test("上游 500 → 一条可恢复 error，不 hang", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const events = await collect(new LiveDirector({ apiKey: "sk-fake", baseUrl: "https://stub.invalid/x", model: "m", fetchImpl, struct: "json_object" }));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") expect(events[0].recoverable).toBe(true);
  });
});
