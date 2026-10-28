/**
 * 演示开关（?demo=…）的解析与注入行为。
 *
 * 纯解析部分钉住「默认关闭」「各取值注入什么」「未知取值不静默」；
 * 注入部分用假 API 钉住「只注入一次，第二次就走真实实现」——
 * 这条性质是录屏里「故障 → 重试 → 恢复」能演完的前提。
 */
import { describe, expect, test } from "bun:test";
import { DEMO_BADGE, parseDemoFlag, withDemoApi } from "../../src/web/ui/demo";
import { ApiError, type HealthInfo, type SessionApi } from "../../src/web/state/api";
import type { CancelResult, SessionInfo, TurnRequest } from "../../src/shared/protocol";

describe("parseDemoFlag", () => {
  test("默认关闭：空 search 与显式关闭值都不注入", () => {
    for (const search of ["", "?foo=bar", "?demo=", "?demo=off", "?demo=0", "?demo=false"]) {
      const flags = parseDemoFlag(search);
      expect(flags.active).toBe(false);
      expect(flags.faults).toEqual([]);
      expect(flags.badge).toBe("");
      expect(flags.raw).toBeNull();
    }
  });

  test("?demo=fail 只注入首轮请求失败，并带角落标注", () => {
    const flags = parseDemoFlag("?demo=fail");
    expect(flags.active).toBe(true);
    expect(flags.faults).toEqual(["turn"]);
    expect(flags.badge).toBe(DEMO_BADGE);
    expect(flags.raw).toBe("fail");
    expect(flags.summary).toContain("演示模式：人为故障");
  });

  test("?demo=timeout / tts 各自只注入一项", () => {
    expect(parseDemoFlag("?demo=timeout").faults).toEqual(["timeout"]);
    expect(parseDemoFlag("?demo=tts").faults).toEqual(["tts"]);
  });

  test("?demo=all 三项全注入，顺序稳定", () => {
    expect(parseDemoFlag("?demo=all").faults).toEqual(["turn", "timeout", "tts"]);
  });

  test("大小写与额外交付参数不影响解析", () => {
    expect(parseDemoFlag("?lang=en-US&demo=FAIL").faults).toEqual(["turn"]);
    expect(parseDemoFlag("?demo=%20tts%20").faults).toEqual(["tts"]);
  });

  test("未知取值当作 fail：手打 ?demo=1 也必须能看到故障，而不是静默无效", () => {
    const flags = parseDemoFlag("?demo=1");
    expect(flags.active).toBe(true);
    expect(flags.faults).toEqual(["turn"]);
    expect(flags.badge).toBe(DEMO_BADGE);
  });
});

// ---------------------------------------------------------------- 注入

function fakeApi(): SessionApi & { streams: number } {
  const state = {
    streams: 0,
    health: async (): Promise<HealthInfo> => ({ ok: true }),
    createSession: async (): Promise<SessionInfo> => ({
      sessionId: "s1",
      mode: "mock" as const,
      directorName: "MockDirector",
      keyless: true,
    }),
    cancelTurn: async (): Promise<CancelResult> => ({ cancelled: true, epoch: 1 }),
    streamTurn: async (): Promise<void> => {
      state.streams += 1;
    },
  };
  return state as SessionApi & { streams: number };
}

const TURN: TurnRequest = {
  sessionId: "s1",
  turnId: "t1",
  epoch: 1,
  userText: "你好",
  scene: { scene: "cafe_night", emotion: "neutral", pose: "hold_cup", playedBeats: [] },
  history: [],
};

describe("withDemoApi", () => {
  test("未开启时不包装：直接返回原 api", () => {
    const api = fakeApi();
    expect(withDemoApi(api, parseDemoFlag(""))).toBe(api);
  });

  test("?demo=fail：首轮抛 ApiError(server)，第二轮走真实实现", async () => {
    const api = fakeApi();
    const wrapped = withDemoApi(api, parseDemoFlag("?demo=fail"));

    let first: unknown = null;
    try {
      await wrapped.streamTurn(TURN, { onEvent: () => {} });
    } catch (err) {
      first = err;
    }
    expect(first).toBeInstanceOf(ApiError);
    expect((first as ApiError).kind).toBe("server");
    expect((first as ApiError).message).toContain("演示模式");

    // 重试必须能成功，否则「演示故障 + 恢复」演不完
    await wrapped.streamTurn(TURN, { onEvent: () => {} });
    expect(api.streams).toBe(1);
  });

  test("?demo=fail：health / createSession 不受影响（否则连页面都进不去）", async () => {
    const api = fakeApi();
    const wrapped = withDemoApi(api, parseDemoFlag("?demo=fail"));
    expect(await wrapped.health()).toEqual({ ok: true });
    expect((await wrapped.createSession()).mode).toBe("mock");
  });

  test("打断（abort）会立刻结束注入的超时等待，不会留下悬挂的 promise", async () => {
    const api = fakeApi();
    const wrapped = withDemoApi(api, parseDemoFlag("?demo=timeout"));
    const controller = new AbortController();
    const pending = wrapped.streamTurn(
      TURN,
      { onEvent: () => {} },
      { signal: controller.signal, firstEventTimeoutMs: 5_000 },
    );
    controller.abort();
    let caught: unknown = null;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe("aborted");
    expect(api.streams).toBe(0);
  });
});
