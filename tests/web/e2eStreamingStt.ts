/**
 * 真流式 STT 的**真实浏览器**验收：headless Chrome + MediaRecorder，
 * 逐块（**不**拼完整文件）发给服务端 WS。
 *
 * 验收点（流式与整段的本质区别）：
 *   首个 interim 必须**在** audio:done（最后一块音频发出）**之前**到达。
 *
 * 用法：
 *   bun run tests/web/e2eStreamingStt.ts --wav /tmp/stt_s2.wav --ws ws://127.0.0.1:8787/api/stt
 */
import { spawn } from "node:child_process";

interface Args {
  wav: string;
  ws: string;
  recordMs: number;
  chromePort: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    wav: get("wav", "/tmp/stt_s2.wav"),
    ws: get("ws", "ws://127.0.0.1:8787/api/stt"),
    recordMs: Number(get("recordMs", "0")),
    chromePort: Number(get("chromePort", "9223")),
  };
}

const args = parseArgs();

/** wav 是 16k mono s16le：时长 = (字节数 - 44) / 32000 秒。录够整段，别把尾巴切掉。 */
async function wavDurationMs(path: string): Promise<number> {
  const buf = await Bun.file(path).arrayBuffer();
  return Math.round(((buf.byteLength - 44) / 2 / 16000) * 1000);
}
const recordMs = args.recordMs > 0 ? args.recordMs : (await wavDurationMs(args.wav)) + 400;

// 调试端口**每次都要换**：端口被占时，Chrome 会把新进程交给已存在的浏览器实例
// （新进程的 --use-file-for-fake-audio-capture 被忽略 → 录到的还是上一次的音频）。
const debugPort = args.chromePort + (process.pid % 900);

// ------------------------------------------------------------------ CDP 客户端

class Cdp {
  #socket: WebSocket;
  #id = 0;
  #pending = new Map<number, (value: any) => void>();

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (msg.id !== undefined) {
        const resolve = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        resolve?.(msg.result);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("CDP 连接失败"));
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string, tries = 40): Promise<any> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`等不到 ${url}`);
}

// ------------------------------------------------------------------ 浏览器内的录音脚本

const PAGE_SCRIPT = `
(async (cfg) => {
  const t0 = performance.now();
  const events = [];
  const ws = new WebSocket(cfg.ws);
  ws.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("ws 连接失败"));
  });
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    events.push({ t: Math.round(performance.now() - t0), type: m.type, text: m.text ?? null, reason: m.reason ?? null });
  };

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  let bytes = 0;
  let chunks = 0;
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    chunks += 1;
    bytes += e.data.size;
    ws.send(e.data);            // 逐块发，**不**拼完整文件
  };
  rec.start(100);
  const recStartAt = Math.round(performance.now() - t0);
  await new Promise((r) => setTimeout(r, cfg.recordMs));
  const stopAt = performance.now();
  rec.stop();
  await new Promise((r) => setTimeout(r, 800));   // 等最后一块（stop 之后才到）
  const audioDoneAt = Math.round(performance.now() - t0);
  ws.send(JSON.stringify({ type: "finish_utterance" }));
  await new Promise((r) => setTimeout(r, 4000));
  return { events, bytes, chunks, audioDoneAt, recStartAt, stopAt: Math.round(stopAt - t0) };
})
`;

/**
 * 页面必须从 http://127.0.0.1 起（不是 about:blank）：
 *   · getUserMedia 要求**安全上下文**（127.0.0.1 算安全来源，about:blank 的
 *     不透明来源不算）；
 *   · 顺便让 WebSocket 的 Origin 是个正常来源。
 */
const pageServer = Bun.serve({
  port: 0,
  fetch() {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>stt e2e</title><body>ok</body>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
const pageUrl = `http://127.0.0.1:${pageServer.port}/`;

// ------------------------------------------------------------------ 主流程

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${args.wav}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
    // **必须每次用不同的 profile 目录**：同一个目录会让 Chrome 复用已存在的
    // 浏览器进程，于是新进程的 --use-file-for-fake-audio-capture 被忽略
    // （第一次录的文件被重放，看起来像「转写串了」）。
    `--user-data-dir=/tmp/e2e-streaming-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"], detached: true },
);
chrome.stderr.on("data", () => {});

let exitCode = 0;
try {
  const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = (targets as any[]).find((t) => t.type === "page");
  if (!page) throw new Error("找不到 page target");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: pageUrl });
  await sleep(800);

  const result = await cdp.send("Runtime.evaluate", {
    expression: `(${PAGE_SCRIPT})(${JSON.stringify({ ws: args.ws, recordMs })})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(`页面脚本异常：${JSON.stringify(result.exceptionDetails).slice(0, 500)}`);
  }
  const value = result?.result?.value;
  if (!value) {
    throw new Error(`页面脚本没有返回值：${JSON.stringify(result).slice(0, 800)}`);
  }
  const data = value as {
    events: Array<{ t: number; type: string; text: string | null; reason: string | null }>;
    bytes: number;
    chunks: number;
    audioDoneAt: number;
    recStartAt: number;
  };

  // ── 报告 ──
  console.log(`\n=== 真实浏览器分块验收（${args.wav}）===`);
  console.log(
    `音频块数=${data.chunks} 总字节=${data.bytes} 开始说话@${data.recStartAt}ms audio:done@${data.audioDoneAt}ms`,
  );
  console.log("事件时间线：");
  for (const e of data.events) {
    const marker = e.t < data.audioDoneAt ? "  " : "←(audio:done 之后)";
    console.log(`  ${String(e.t).padStart(5)}ms ${e.type.padEnd(12)} ${e.text ?? e.reason ?? ""} ${marker}`);
  }

  const interims = data.events.filter((e) => e.type === "interim");
  const finals = data.events.filter((e) => e.type === "final");
  const firstInterim = interims[0];
  const final = finals[0];
  console.log(`\n首个 interim：${firstInterim ? `${firstInterim.t}ms「${firstInterim.text}」` : "（无）"}`);
  console.log(`final：${finals.map((f) => `${f.t}ms「${f.text}」`).join(" / ") || "（无）"}`);
  if (firstInterim && final) {
    console.log(
      `\n首字延迟（相对开始说话）=${firstInterim.t - data.recStartAt}ms` +
        `  整句完成延迟=${final.t - data.recStartAt}ms` +
        `  （音频时长≈${data.audioDoneAt - data.recStartAt}ms，总字节=${data.bytes}）`,
    );
  }

  const ok =
    interims.length > 0 &&
    finals.length > 0 &&
    firstInterim !== undefined &&
    firstInterim.t < data.audioDoneAt;
  console.log(
    `\n结论：${ok ? "✅ 首个 interim 在 audio:done 之前到达（真流式成立）" : "❌ 不满足「首个 interim 在 audio:done 之前」"}`,
  );
  if (!ok) exitCode = 1;
} catch (error) {
  console.error("验收失败：", error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  // 杀掉整个进程组（Chrome 会 fork 出 zygote / renderer；只杀父进程会留一堆）
  try {
    if (chrome.pid !== undefined) process.kill(-chrome.pid, "SIGKILL");
  } catch {
    chrome.kill("SIGKILL");
  }
  pageServer.stop(true);
}
process.exit(exitCode);
