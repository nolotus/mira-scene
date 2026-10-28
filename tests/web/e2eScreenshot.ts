/**
 * 真实浏览器截图（CDP，不用 --virtual-time-budget）。
 *
 * 为什么自己写 CDP 而不是装 playwright：仓库没有 playwright 依赖，而这台机器有 Chrome。
 * 这个脚本只做三件事：设精确视口（430×932 / dSF=2）→ 等页面稳定 → 截图存盘。
 *
 * 用法：
 *   bun run tests/web/e2eScreenshot.ts --url=http://localhost:5173/preview.html?char=photo \
 *     --out=/tmp/shot.png [--w=430] [--h=932] [--dsf=2] [--settle=1200] [--rect=".char-photo"]
 *
 * `--rect` 会额外打印该选择器的 getBoundingClientRect（边缘采样要靠它把截图坐标对上）。
 * 进程自己退出（Chrome 一起带走），不留后台进程。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface Args {
  url: string;
  out: string;
  w: number;
  h: number;
  dsf: number;
  settle: number;
  rect: string | null;
  at: string | null;
  prefetch: boolean;
  port: number;
}

function parseArgs(): Args {
  const map = new Map<string, string>();
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (m) map.set(m[1]!, m[2]!);
  }
  return {
    url: map.get("url") ?? "http://localhost:5173/preview.html?nopanel&char=photo",
    out: map.get("out") ?? "/tmp/mira-shot.png",
    w: Number(map.get("w") ?? 430),
    h: Number(map.get("h") ?? 932),
    dsf: Number(map.get("dsf") ?? 2),
    settle: Number(map.get("settle") ?? 1500),
    rect: map.get("rect") ?? null,
    at: map.get("at") ?? null,
    prefetch: map.get("prefetch") === "1",
    port: Number(map.get("port") ?? 9333),
  };
}

/** 一个极简 CDP 客户端：只用到 Page / Runtime / Emulation */
class Cdp {
  private id = 0;
  private pending = new Map<number, (v: unknown) => void>();
  private ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (data.id === undefined) return;
      const resolve = this.pending.get(data.id);
      if (!resolve) return;
      this.pending.delete(data.id);
      if (data.error) throw new Error(`CDP ${data.id}: ${data.error.message}`);
      resolve(data.result);
    });
  }

  static async connect(port: number): Promise<Cdp> {
    // 等 Chrome 把调试端口挂起来（最多 10s）
    const deadline = Date.now() + 10_000;
    let target: { webSocketDebuggerUrl?: string } | null = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = list.find((t) => t.type === "page");
        if (page?.webSocketDebuggerUrl) {
          target = page;
          break;
        }
      } catch {
        // 还没起来
      }
      await Bun.sleep(120);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error("Chrome 调试端口没起来");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (v) => resolve(v as T));
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  close(): void {
    this.ws.close();
  }
}

const args = parseArgs();
await mkdir(dirname(args.out), { recursive: true });

const chrome = Bun.spawn(
  [
    "google-chrome",
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${args.port}`,
    `--user-data-dir=/tmp/chrome-mira-shot-${args.port}`,
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

let exitCode = 0;
try {
  const cdp = await Cdp.connect(args.port);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: args.w,
    height: args.h,
    deviceScaleFactor: args.dsf,
    mobile: true,
  });
  const loaded = new Promise<void>((resolve) => {
    const ws = (cdp as unknown as { ws: WebSocket }).ws;
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(String(event.data)) as { method?: string };
      if (data.method === "Page.loadEventFired") {
        ws.removeEventListener("message", handler);
        resolve();
      }
    };
    ws.addEventListener("message", handler);
  });
  await cdp.send("Page.navigate", { url: args.url });
  await Promise.race([loaded, Bun.sleep(12_000)]);
  // 「实时」等待：让 CSS 动画与解码落定，而不是用虚拟时间快进
  await Bun.sleep(args.settle);

  if (args.at) {
    const [x, y] = args.at.split(",").map(Number);
    const res = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: `(() => {
        // 舞台装饰层是 pointer-events:none（装饰不该抢交互），默认会被 elementsFromPoint 跳过。
        // 探测时临时打开命中测试，取完立刻还原 —— 否则拿到的不是「那个像素上真正画着什么」。
        const layers = [...document.querySelectorAll(".scene, .sc-room, .sc-window, .sc-warm, .sc-fg")];
        const saved = layers.map((el) => el.style.pointerEvents);
        layers.forEach((el) => { el.style.pointerEvents = "auto"; });
        const stack = document.elementsFromPoint(${x}, ${y}).slice(0, 8).map((el) => {
          const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            cls: el.className && typeof el.className === "string" ? el.className : (el.getAttribute("class") ?? ""),
            rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
            bg: cs.backgroundImage !== "none" ? cs.backgroundImage.slice(0, 80) : cs.backgroundColor,
            radius: cs.borderRadius, opacity: cs.opacity, filter: cs.filter, overflow: cs.overflow,
            parentOverflow: el.parentElement ? getComputedStyle(el.parentElement).overflow : null,
          };
        });
        return stack.map((s) => \`\${s.tag}.\${String(s.cls).split(" ").join(".")} | \${s.rect.x},\${s.rect.y} \${s.rect.w}x\${s.rect.h} | bg=\${s.bg} | r=\${s.radius} | op=\${s.opacity} | filter=\${s.filter} | pOverflow=\${s.parentOverflow}\`).join("\n");
      })()`,
      returnByValue: true,
    });
    console.log(`AT\n${String(res.result.value)}`);
  }


  if (args.prefetch) {
    const res = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: `(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const paints = performance.getEntriesByType("paint").map((p) => ({ name: p.name, at: Math.round(p.startTime) }));
        const el = document.querySelector(".char-photo__base");
        const rect = el ? el.getBoundingClientRect() : null;
        return { line: document.documentElement.dataset.miraPrefetch ?? null,
                 domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
                 loadEnd: nav ? Math.round(nav.loadEventEnd) : null,
                 paints, snapshot: window.__miraPrefetch ?? null,
                 rect: rect && { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
      })()`,
      returnByValue: true,
    });
    console.log(`PREFETCH ${JSON.stringify(res.result.value)}`);
  }

{
    const res = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(args.rect ?? ".char-photo")});
        const r = el ? el.getBoundingClientRect() : null;
        return { rect: r && { x: r.x, y: r.y, w: r.width, h: r.height }, dpr: devicePixelRatio,
                 char: document.documentElement.dataset.miraChar ?? null,
                 prefetch: document.documentElement.dataset.miraPrefetch ?? null,
                 title: document.title }; })()`,
      returnByValue: true,
    });
    console.log(`RECT ${JSON.stringify(res.result.value)}`);
  }

  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await Bun.write(args.out, Buffer.from(shot.data, "base64"));
  console.log(`SHOT ${args.out}`);
  cdp.close();
} catch (error) {
  console.error(`截图失败：${(error as Error).message}`);
  exitCode = 1;
} finally {
  chrome.kill("SIGTERM");
  await chrome.exited;
}
process.exit(exitCode);
