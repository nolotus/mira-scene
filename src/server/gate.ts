/**
 * 访问口令（应用层 gate）：给公开演示站加一道「输入一次密码」的门。
 *
 * 为什么不做在 Caddy 层：basic auth 会破坏 WebSocket 升级握手（实测经 Caddy 带 auth
 * 时 `/api/stt` 返回 400，直连 101），于是「麦克风那条」直接不可用。放应用层用 cookie，
 * 浏览器升级 WS 时会自动带上同源 cookie，HTTP / SSE / WS 三处共用一道门。
 *
 * 安全口径：
 *  · 只在配了 `GATE_PASSWORD` 时启用；不配 = 站点行为与从前完全一致（本地开发零影响）。
 *  · cookie 是 HttpOnly + SameSite=Lax；HTTPS 下带 Secure。
 *  · 比较用 `timingSafeEqual`，长度不同直接失败，不泄漏长度。
 *  · 健康检查 `/api/health` 与口令页本身保持开放，否则监控和登录都进不来。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const GATE_COOKIE = "mira_gate";
export const GATE_PATH = "/gate";

/** 由密码派生的 cookie 值：不存明文，也不随密码长度暴露信息 */
export function gateToken(password: string): string {
  return createHmac("sha256", password).update("mira-gate-v1").digest("hex").slice(0, 32);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const raw = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        // 畸形百分号编码（`Cookie: mira_gate=%`）不能让 gate 自己抛 500
        return raw;
      }
    }
  }
  return null;
}

/** 常数时间比较；长度不同直接判失败 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 登录尝试节流：同一 IP 5 分钟内最多 6 次，超出直接 429（防在线爆破） */
const GATE_ATTEMPT_LIMIT = 6;
const GATE_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function gateAttemptKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** 记一次失败；返回 true 表示已超限 */
export function gateTooManyAttempts(key: string, now = Date.now()): boolean {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + GATE_ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > GATE_ATTEMPT_LIMIT;
}

export function resetGateAttempts(): void {
  attempts.clear();
}

export function hasGateCookie(request: Request, password: string): boolean {
  const token = readCookie(request.headers.get("cookie"), GATE_COOKIE);
  if (!token) return false;
  return safeEqual(token, gateToken(password));
}

/** 登录页：无框架、无 JS，POST 到 /gate 即可（表单也能用） */
export function gatePage(options: { error?: string | null; secure: boolean } = { secure: true }): Response {
  const error = options.error
    ? `<p class="err">${options.error}</p>`
    : "";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Mira · 需要口令</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0d0f12; color:#e9e2d6; font:15px/1.6 ui-sans-serif,system-ui,"PingFang SC",sans-serif; }
  form { width:min(92vw,320px); display:grid; gap:12px; }
  h1 { margin:0 0 4px; font-size:18px; font-weight:600; letter-spacing:.02em; }
  p.hint { margin:0; color:#9aa3ad; font-size:13px; }
  p.err { margin:0; color:#f2b45c; font-size:13px; }
  input { padding:12px 14px; border-radius:10px; border:1px solid rgba(255,255,255,.16);
          background:rgba(255,255,255,.06); color:inherit; font:inherit; }
  button { padding:12px 14px; border-radius:10px; border:1px solid #f2b45c; background:#f2b45c;
           color:#1a1208; font:inherit; font-weight:600; cursor:pointer; }
</style></head>
<body>
  <form method="post" action="${GATE_PATH}">
    <h1>Mira · 打烊前的咖啡馆</h1>
    <p class="hint">这是内部演示站，输入口令后即可对话。</p>
    ${error}
    <input name="password" type="password" autocomplete="current-password" placeholder="口令" autofocus required>
    <button type="submit">进入</button>
  </form>
</body></html>`;
  return new Response(html, {
    status: options.error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 设置 cookie 的响应（登录成功后 302 回首页） */
export function gateSuccess(password: string, secure: boolean): Response {
  const attrs = [
    `${GATE_COOKIE}=${gateToken(password)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000", // 30 天
  ];
  if (secure) attrs.push("Secure");
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": attrs.join("; ") },
  });
}
