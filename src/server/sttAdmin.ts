/**
 * 运行时 ASR 模型切换后台（owner 在手机上点着试不同识别模型）。
 *
 * ── 安全边界（站点是公开的，这里绝不允许裸奔）──
 *  · **fail-closed**：没配 `ADMIN_TOKEN` 时，页面与 API 一律 **404** —— 不是 403、不是放行。
 *    「忘了配 token」= 「这个后台不存在」，这是唯一安全的默认值。
 *  · token 只在内存里比对（常数时间比较），**不进日志、不进响应体**：
 *    401 的响应里绝不能回显正确的 token。
 *  · 「最近识别」只存在**内存**里（环形缓冲 10 条）：不落盘、不记音频、不记用户身份。
 *  · 切换只影响**之后新建**的麦克风会话 —— 正在说的那句不中途换模型。
 *
 * ── 抽象位置 ──
 *  这一层刻意**不碰**上游协议：`/api/stt` 的 WS 报文、客户端采集方式一律不变。
 *  「当前会话用哪个模型」由 app.ts 在**建会话那一刻**问 `getActiveModel()` 决定；
 *  「这次识别成什么样」由本模块包一层 sink 观测得到，不改上游实现。
 */

import { timingSafeEqual } from "node:crypto";
import type { BrowserSink, SttBridge } from "./stt.ts";

// ------------------------------------------------------------------ 模型清单

export type SttModelMode = "streaming" | "batch";

export interface SttModelOption {
  /** 上游认的模型名（也是切换时的 key） */
  id: string;
  /** 流式 / 整段 */
  mode: SttModelMode;
  /** 一句话说明（首字延迟、语言猜测等实测结论） */
  note: string;
  /** 价格档（元/时） */
  price: string;
  /** 页面上的短名（「qwen-3.0」这种） */
  short: string;
}

/**
 * 可切换的模型清单。
 *
 * 顺序 = 页面上的顺序（从「默认/最快」到「最省/最慢」）。
 * 价格与延迟是实测结论，改动前先重新测 —— 这个页面是 owner 做决策的依据。
 */
export const STT_MODEL_OPTIONS: readonly SttModelOption[] = [
  {
    id: "qwen-audio-3.0-asr-flash-streaming",
    mode: "streaming",
    note: "快（首字~540ms，定稿+230ms）",
    price: "1.19 元/时",
    short: "qwen-3.0",
  },
  {
    id: "qwen-audio-3.1-asr-flash-streaming",
    mode: "streaming",
    note: "省（定稿+660ms）",
    price: "~0.08 元/时",
    short: "qwen-3.1",
  },
  {
    id: "fun-asr-realtime-2026-02-28",
    mode: "streaming",
    note: "首字常猜错语言（2/8）",
    price: "1.19 元/时",
    short: "fun-realtime",
  },
  {
    id: "fun-asr-flash-2026-06-15",
    mode: "batch",
    note: "说完才出字",
    price: "0.79 元/时",
    short: "fun-flash",
  },
];

export function isKnownSttModel(model: string): boolean {
  return STT_MODEL_OPTIONS.some((option) => option.id === model);
}

// ------------------------------------------------------------------ 内存态

/**
 * 当前生效的模型（null = 没手动切过 = 用配置里的默认模型）。
 *
 * 进程内单例：切换是「运行时热切」，重启即回到默认 —— 这是刻意的，
 * 重启进程就意味着环境变量重新说了算。
 */
let activeModel: string | null = null;

/** 最近识别的环形缓冲（最新在前，最多 10 条） */
const RECENT_LIMIT = 10;

export interface SttRecognition {
  /** 本地时间 HH:MM:SS */
  at: string;
  /** 这次用的模型 id */
  model: string;
  /** 终稿文本（只存文本，不存音频、不存身份） */
  text: string;
  /** 第一块音频 → 第一段文字（interim 或 final）的毫秒数；没有音频则 null */
  firstTextMs: number | null;
  /** 客户端说「这句说完了」→ final 落地的毫秒数；没收到该信号则 null */
  finalMs: number | null;
}

let recentRecognitions: SttRecognition[] = [];

/** 当前生效的模型 id；null = 用默认 */
export function getActiveModel(): string | null {
  return activeModel;
}

/**
 * 切模型。幂等：切到当前模型不报错。
 * 未知模型返回 false（调用方回 400）。
 */
export function setActiveModel(model: string): boolean {
  const trimmed = model.trim();
  if (!isKnownSttModel(trimmed)) return false;
  activeModel = trimmed;
  return true;
}

/** 最近识别（最新在前，拷贝一份 —— 调用方别拿到内部数组） */
export function recentSttRecognitions(): SttRecognition[] {
  return recentRecognitions.slice();
}

function pushRecognition(record: SttRecognition): void {
  recentRecognitions.unshift(record);
  if (recentRecognitions.length > RECENT_LIMIT) recentRecognitions.length = RECENT_LIMIT;
}

/** 测试用：清空运行时状态（activeModel + 最近记录） */
export function resetSttAdminState(): void {
  activeModel = null;
  recentRecognitions = [];
}

// ------------------------------------------------------------------ 观测桥

/**
 * 把一条 STT 桥包一层，用来记「这次识别成什么样」。
 *
 * 为什么包在**外面**而不是改上游实现：这样 `/api/stt` 的协议、客户端采集方式、
 * aliStt 的实现全都不动 —— 这一层只观察 sink 上的消息与桥上的两个动作。
 *
 * 计时口径：
 *  · `firstTextMs` = 第一块音频进来 → 第一段文字（interim 或 final）落地；
 *  · `finalMs`     = 客户端声明「这句说完了」（finish_utterance）→ final 落地。
 */
export function openRecordingSttBridge(params: {
  sink: BrowserSink;
  /** 这次会话用的模型（建会话那一刻定下来的） */
  model: string;
  /** 真正的建桥动作（由 app.ts 传入，模型在那一刻注入） */
  open: (sink: BrowserSink) => SttBridge;
}): SttBridge {
  let firstAudioAt: number | null = null;
  let lastAudioAt: number | null = null;
  let finishAt: number | null = null;
  let firstTextAt: number | null = null;

  const sink: BrowserSink = {
    sendText(payload: string) {
      const message = parseClientMessage(payload);
      if (message) {
        const now = Date.now();
        const text = typeof message.text === "string" ? message.text : "";
        if (message.type === "interim" || message.type === "final") {
          if (text.trim() && firstTextAt === null) firstTextAt = now;
          if (message.type === "final" && text.trim()) {
            const base = finishAt ?? lastAudioAt ?? firstAudioAt;
            pushRecognition({
              at: formatClock(now),
              model: params.model,
              text,
              firstTextMs:
                firstTextAt !== null && firstAudioAt !== null ? firstTextAt - firstAudioAt : null,
              finalMs: base !== null ? now - base : null,
            });
            // 同一连接会被复用：说完这句后用户可能继续下一句（连接不关）。
            // 不复位的话，第 2 句的 firstTextMs 会沿用第 1 句的时间戳，finalMs 会把
            // 两句之间的空闲也算进去 —— 后台会显示「定稿 +28500ms」这种假数据
            // （2026-10-29 审查发现）。
            firstAudioAt = null;
            lastAudioAt = null;
            finishAt = null;
            firstTextAt = null;
          }
        }
      }
      params.sink.sendText(payload);
    },
    close(code?: number, reason?: string) {
      params.sink.close(code, reason);
    },
  };

  const bridge = params.open(sink);

  return {
    pushAudio(data) {
      const now = Date.now();
      if (firstAudioAt === null) firstAudioAt = now;
      lastAudioAt = now;
      bridge.pushAudio(data);
    },
    finishUtterance() {
      finishAt = Date.now();
      bridge.finishUtterance();
    },
    clientClosed() {
      bridge.clientClosed();
    },
    get closed() {
      return bridge.closed;
    },
    get lastUpstreamType() {
      return bridge.lastUpstreamType;
    },
  };
}

interface ParsedClientMessage {
  type?: string;
  text?: string;
}

/** 只取两个字段；解析失败当作「不是我们关心的消息」 */
function parseClientMessage(payload: string): ParsedClientMessage | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const text = typeof record.text === "string" ? record.text : undefined;
    return { type, text };
  } catch {
    return null;
  }
}

function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// ------------------------------------------------------------------ 鉴权

/**
 * token 比对。**未配置 token 一律不通过**（fail-closed）。
 * 用常数时间比较，避免按字节试探。
 */
export function adminTokenMatches(expected: string | null, provided: string | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ HTTP 层

export interface SttAdminConfig {
  /** 生效中的模型 id */
  active: string;
  /** 可选模型清单 */
  options: readonly SttModelOption[];
  /** 最近识别（最新在前） */
  recent: SttRecognition[];
}

export interface SttAdminDeps {
  /** 环境里的 ADMIN_TOKEN；null = 未配置 = 整个后台 404 */
  adminToken: string | null;
  /** 没手动切过时用哪个模型（= 配置里的默认模型） */
  defaultModel: string;
}

export function sttAdminConfig(deps: SttAdminDeps): SttAdminConfig {
  return {
    active: getActiveModel() ?? deps.defaultModel,
    options: STT_MODEL_OPTIONS,
    recent: recentSttRecognitions(),
  };
}

const ADMIN_PAGE_PATH = "/admin";
const ADMIN_API_PATH = "/api/stt/admin/config";

/**
 * 后台的入口。**返回 null = 这个请求不是后台的**，交给 app.ts 继续走别的路由。
 *
 * 路由表：
 *   GET  /admin?token=…                 → 服务端渲染的 HTML 页面
 *   GET  /api/stt/admin/config?token=…   → { active, options, recent }
 *   POST /api/stt/admin/config?token=…   → 切换并返回最新配置
 *
 * 状态码：
 *   404 —— 未配置 ADMIN_TOKEN（fail-closed，整套后台不存在）
 *   401 —— token 不匹配（响应体**不**回显正确的 token）
 *   400 —— model 不在清单里
 */
export async function handleSttAdminRequest(
  request: Request,
  url: URL,
  deps: SttAdminDeps,
): Promise<Response | null> {
  const path = url.pathname;
  const isPage = path === ADMIN_PAGE_PATH;
  const isApi = path === ADMIN_API_PATH;
  if (!isPage && !isApi) return null;

  // fail-closed：没配 token = 这个后台不存在
  if (!deps.adminToken) return notFound(isApi);

  const provided = url.searchParams.get("token");
  if (!adminTokenMatches(deps.adminToken, provided)) return unauthorized(isApi);

  if (isPage) {
    if (request.method !== "GET") return notFound(false);
    return html(renderAdminPage(sttAdminConfig(deps), provided ?? ""));
  }

  if (request.method === "GET") {
    return json(sttAdminConfig(deps), 200);
  }
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const model = await readRequestedModel(request);
  if (!model) return json({ error: "missing model" }, 400);
  if (!setActiveModel(model)) return json({ error: "unknown model" }, 400);

  // 浏览器表单提交（content-type 是表单编码）→ 回后台页面，让 owner 直接看到新状态；
  // JSON 调用（content-type: application/json）→ 直接回最新配置。
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const location = `${ADMIN_PAGE_PATH}?token=${encodeURIComponent(provided ?? "")}`;
    return new Response(null, { status: 303, headers: { location } });
  }
  return json(sttAdminConfig(deps), 200);
}

/** body 里的 model：JSON `{ model }` 或表单 `model=…` 都认 */
async function readRequestedModel(request: Request): Promise<string> {
  const raw = await request.text();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>).model;
      if (typeof value === "string") return value.trim();
    }
  } catch {
    /* 不是 JSON —— 走表单解析 */
  }
  return (new URLSearchParams(raw).get("model") ?? "").trim();
}

// ------------------------------------------------------------------ 响应

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 后台页面不该被缓存（状态是活的）
      "cache-control": "no-store",
    },
  });
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 404：响应体里**不**带任何 token 线索 */
function notFound(isApi: boolean): Response {
  if (isApi) return json({ error: "not found" }, 404);
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** 401：只说「没权限」，**绝不**回显正确的 token */
function unauthorized(isApi: boolean): Response {
  if (isApi) return json({ error: "unauthorized" }, 401);
  return new Response("unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ------------------------------------------------------------------ 页面

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shortModelName(model: string): string {
  const known = STT_MODEL_OPTIONS.find((option) => option.id === model);
  return known ? known.short : model;
}

/**
 * 服务端渲染的最小页面（无框架、无构建步骤、内联样式）。
 *
 * 切换用**普通表单 POST**（无 JS 也能用）；顺带挂一小段内联脚本做「点一下就切」。
 * 表单 action 里带 token：这个页面本来就要靠 token 才能进，token 已经在地址栏里了。
 */
function renderAdminPage(config: SttAdminConfig, token: string): string {
  const action = `${ADMIN_API_PATH}?token=${encodeURIComponent(token)}`;

  const options = config.options
    .map((option) => {
      const checked = option.id === config.active ? " checked" : "";
      const meta = `${option.mode === "streaming" ? "流式" : "整段"} · ${option.note} · ${option.price}`;
      return `      <li><label>
        <input type="radio" name="model" value="${escapeHtml(option.id)}"${checked}>
        <span class="id">${escapeHtml(option.id)}</span>
        <span class="meta">${escapeHtml(meta)}</span>
      </label></li>`;
    })
    .join("\n");

  const recent =
    config.recent.length === 0
      ? "      <li class=\"empty\">（还没有记录）</li>"
      : config.recent
          .map((record) => {
            const timing = [
              record.firstTextMs !== null ? `首字 ${record.firstTextMs}ms` : null,
              record.finalMs !== null ? `定稿 +${record.finalMs}ms` : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" / ");
            const timingHtml = timing ? ` <span class="ms">${escapeHtml(timing)}</span>` : "";
            return `      <li>
        <span class="at">${escapeHtml(record.at)}</span>
        <span class="model">${escapeHtml(shortModelName(record.model))}</span>
        <span class="text">「${escapeHtml(record.text)}」</span>${timingHtml}
      </li>`;
          })
          .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ASR 模型切换</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; margin: 0; padding: 20px 16px 40px; max-width: 720px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 6px; }
  .cur { margin: 0 0 18px; font-size: 15px; }
  .cur code { font-size: 15px; font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; }
  ul.opts li { margin: 0 0 8px; }
  label { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 8px 10px; border: 1px solid #8884; border-radius: 8px; cursor: pointer; }
  label:has(input:checked) { border-color: #3b82f6; background: #3b82f61a; }
  .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
  .meta { opacity: .75; font-size: 13px; }
  button { margin-top: 10px; padding: 8px 16px; font-size: 15px; border-radius: 8px; border: 1px solid #8886; background: #8881; }
  .hint { opacity: .7; font-size: 13px; margin: 6px 0; }
  ul.recent li { padding: 5px 0; border-bottom: 1px solid #8883; font-size: 14px; }
  ul.recent .at { opacity: .6; margin-right: 8px; }
  ul.recent .model { opacity: .8; margin-right: 8px; }
  ul.recent .ms { opacity: .6; margin-left: 8px; font-size: 13px; }
  ul.recent .empty { opacity: .6; }
  a { color: #3b82f6; }
</style>
</head>
<body>
<h1>ASR 模型</h1>
<p class="cur">当前模型　<code>${escapeHtml(config.active)}</code></p>

<form method="post" action="${escapeHtml(action)}">
  <ul class="opts">
${options}
  </ul>
  <button type="submit">切换</button>
</form>
<p class="hint">切换立刻生效，但只对<strong>之后新建</strong>的麦克风会话生效：正在说的那句不中途换模型。</p>

<h2>最近识别</h2>
<p class="hint">切完回场景说一句，这里会出记录（只在内存里，不落盘、不记音频）。</p>
<ul class="recent">
${recent}
</ul>

<p style="margin-top:28px"><a href="/">← 回到场景</a></p>
<script>
  // 点一下就切（没有 JS 时上面的「切换」按钮同样能用）
  for (const input of document.querySelectorAll('input[name="model"]')) {
    input.addEventListener('change', () => input.form.submit());
  }
</script>
</body>
</html>
`;
}
