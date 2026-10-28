/**
 * `?bargeIn=` 开关解析。
 *
 * 语义（2026-10 改）：**默认开**。理由 —— 「用户一开口就打断角色」是题目要求的头号能力，
 * 默认关等于没做。关掉仍然可以：`?bargeIn=off`。
 *
 *   (缺省)       → on
 *   on / 1 / true / voice / yes → on   （`voice` 是旧语义，视为 on，老链接不失效）
 *   off / 0 / false / none / no → off
 *   其它未知值   → on（不猜，按默认；显式关必须写 off）
 */

export type BargeInMode = "on" | "off";

const OFF = new Set(["off", "0", "false", "none", "no", "disabled"]);
const ON = new Set(["on", "1", "true", "voice", "yes", "enabled"]);

export function parseBargeInFlag(search: string, fallback: BargeInMode = "on"): BargeInMode {
  const raw = (new URLSearchParams(search).get("bargeIn") ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if (OFF.has(raw)) return "off";
  if (ON.has(raw)) return "on";
  return fallback;
}

export function bargeInEnabled(search: string, fallback: BargeInMode = "on"): boolean {
  return parseBargeInFlag(search, fallback) === "on";
}
