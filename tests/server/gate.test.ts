import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import { loadConfig } from "../../src/server/config.ts";
import { GATE_COOKIE, gateToken, hasGateCookie, resetGateAttempts, safeEqual } from "../../src/server/gate.ts";

const env = { GATE_PASSWORD: "mira2026" } as Record<string, string>;

describe("访问口令 gate", () => {
  resetGateAttempts();
  const app = createApp({ config: loadConfig(env) });

  test("没配 GATE_PASSWORD 时站点公开（本地开发零影响）", async () => {
    const open = createApp({ config: loadConfig({}) });
    const res = await open.fetch(new Request("http://x/api/voice/status"));
    expect(res.status).not.toBe(401);
  });

  test("无 cookie：页面给登录页（200），API 给 401，健康检查仍放行", async () => {
    const page = await app.fetch(new Request("http://x/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("口令");

    const api = await app.fetch(new Request("http://x/api/voice/status"));
    expect(api.status).toBe(401);

    const health = await app.fetch(new Request("http://x/api/health"));
    expect(health.status).toBe(200);
  });

  test("密码对 → 303 + Set-Cookie；cookie 带对了才放行 API", async () => {
    const form = new FormData();
    form.set("password", "mira2026");
    const res = await app.fetch(new Request("http://x/gate", { method: "POST", body: form }));
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${GATE_COOKIE}=`);

    const token = gateToken("mira2026");
    const ok = await app.fetch(
      new Request("http://x/api/voice/status", { headers: { cookie: `${GATE_COOKIE}=${token}` } }),
    );
    expect(ok.status).not.toBe(401);
  });

  test("密码错 → 401 且不发 cookie", async () => {
    const form = new FormData();
    form.set("password", "wrong");
    const res = await app.fetch(new Request("http://x/gate", { method: "POST", body: form }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("cookie 校验用常数时间比较，长度不同直接 false（不抛）", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    const req = new Request("http://x/", { headers: { cookie: `${GATE_COOKIE}=deadbeef` } });
    expect(hasGateCookie(req, "mira2026")).toBe(false);
  });
});

describe("gate 加固", () => {
  const app = createApp({ config: loadConfig(env) });

  test("畸形 cookie 不抛（公开可触发面）", async () => {
    resetGateAttempts();
    const res = await app.fetch(new Request("http://x/api/voice/status", { headers: { cookie: `${GATE_COOKIE}=%` } }));
    expect(res.status).toBe(401);
  });

  test("连续错口令会被节流成 429", async () => {
    resetGateAttempts();
    const submit = async () => {
      const form = new FormData();
      form.set("password", "wrong");
      return app.fetch(new Request("http://x/gate", { method: "POST", body: form }));
    };
    let last = 0;
    for (let i = 0; i < 8; i += 1) last = (await submit()).status;
    expect(last).toBe(429);
  });

  test("反代带 x-forwarded-proto: https 时 cookie 带 Secure", async () => {
    resetGateAttempts();
    const form = new FormData();
    form.set("password", "mira2026");
    const res = await app.fetch(
      new Request("http://x/gate", { method: "POST", body: form, headers: { "x-forwarded-proto": "https" } }),
    );
    expect(res.headers.get("set-cookie") ?? "").toContain("Secure");
  });

  test("无 cookie 的 POST /api/turn 与 /admin 都被拦", async () => {
    resetGateAttempts();
    const turn = await app.fetch(new Request("http://x/api/turn", { method: "POST", body: "{}" }));
    expect(turn.status).toBe(401);
    const admin = await app.fetch(new Request("http://x/admin"));
    expect(await admin.text()).toContain("口令");
  });
});
