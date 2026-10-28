/**
 * 照片模式诊断探针（CDP + 真实时钟，不用 --virtual-time-budget）。
 *
 * 为什么单独一个脚本：`?char=photo` 的三处「贴上去」缺陷（SVG 层是否真在渲染、
 * 桌面杯与角色谁挡住谁、底部渐隐与字幕带的间距）没有一处能靠肉眼下结论 ——
 * 分别需要 DOM 里的层计数、两者的 rect 与遮挡关系、以及渐隐高度与字幕上沿的像素距离。
 * 这个探针把这三组的**事实**打成一行 JSON，改前改后各跑一次就是对照。
 *
 * 用法：
 *   bun run tests/web/photoDiag.ts \
 *     --url='http://localhost:5173/preview.html?nopanel&char=photo&status=idle' \
 *     --out=/tmp/after_idle.png --settle=2600
 *
 * 补充：截图必须等真实 setTimeout 落定（≥2.5s），否则会截到眨眼中间帧。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface Args {
  url: string;
  out: string | null;
  w: number;
  h: number;
  dsf: number;
  settle: number;
  port: number;
}

function parseArgs(): Args {
  const map = new Map<string, string>();
  for (const raw of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (m) map.set(m[1]!, m[2]!);
  }
  return {
    url: map.get("url") ?? "http://localhost:5173/preview.html?nopanel&char=photo&status=idle",
    out: map.get("out") ?? null,
    w: Number(map.get("w") ?? 430),
    h: Number(map.get("h") ?? 932),
    dsf: Number(map.get("dsf") ?? 2),
    settle: Number(map.get("settle") ?? 2600),
    port: Number(map.get("port") ?? 9334),
  };
}

type Send = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** 页内收集：只读 DOM，不改 DOM，不动样式 */
const COLLECT = `(() => {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             bot: +(r.y + r.height).toFixed(1), right: +(r.x + r.width).toFixed(1) };
  };
  const cs = (el) => (el ? getComputedStyle(el) : null);

  const svgRigs = [...document.querySelectorAll(".char-rig")];
  const svgInfo = svgRigs.map((el) => {
    const s = cs(el);
    return { cls: el.className, visibility: s.visibility, display: s.display, opacity: s.opacity,
             zIndex: s.zIndex, rect: rectOf(el), inert: !!el.closest("[inert]") };
  });

  const char = document.querySelector(".char-photo");
  const cup = document.querySelector(".table-cup");
  const saucer = document.querySelector(".table-saucer");
  const subtitle = document.querySelector(".stage-subtitle");
  const sub = document.querySelector(".sub");
  const canvas = document.querySelector(".stage-canvas");
  const nod = document.querySelector(".char-photo__nod");
  const base = document.querySelector(".char-photo__base");

  const desc = (el) => {
    if (!el) return null;
    const s = cs(el);
    return { rect: rectOf(el), visibility: s.visibility, display: s.display, opacity: s.opacity,
             zIndex: s.zIndex, filter: s.filter, mixBlendMode: s.mixBlendMode,
             maskImage: (s.maskImage || s.webkitMaskImage || "").slice(0, 200) };
  };

  const root = document.documentElement;
  const diag = {};
  for (const k of Object.keys(root.dataset)) {
    if (k.startsWith("mira")) diag[k] = root.dataset[k];
  }

  return {
    diag,
    svgLayerCount: svgRigs.length,
    svg: svgInfo,
    char: desc(char),
    cup: desc(cup),
    saucer: desc(saucer),
    subtitle: desc(subtitle),
    sub: desc(sub),
    canvas: desc(canvas),
    nod: desc(nod),
    base: desc(base),
    gapCharBottomToSubtitleTop: (() => {
      const c = rectOf(char), s = rectOf(subtitle);
      return c && s ? +(s.y - c.bot).toFixed(1) : null;
    })(),
    cupVsChar: (() => {
      const c = rectOf(char), k = rectOf(cup);
      if (!c || !k) return null;
      const ix = Math.max(0, Math.min(c.right, k.right) - Math.max(c.x, k.x));
      const iy = Math.max(0, Math.min(c.bot, k.bot) - Math.max(c.y, k.y));
      return { intersectArea: +(ix * iy).toFixed(1), cupArea: +(k.w * k.h).toFixed(1),
               overlapPctOfCup: k.w * k.h > 0 ? +((ix * iy) / (k.w * k.h) * 100).toFixed(1) : null };
    })(),
  };
})()`;

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.out) await mkdir(dirname(args.out), { recursive: true });

  const chrome = Bun.spawn(
    [
      "google-chrome",
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=/tmp/chrome-mira-diag-${args.port}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  let exitCode = 0;
  try {
    const cdp = await connect(args.port);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: args.w,
      height: args.h,
      deviceScaleFactor: args.dsf,
      mobile: true,
    });
    const loaded = new Promise<void>((resolve) => {
      const ws = cdp.ws;
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
    // 真实时钟：眨眼间隔 1.8–7s，2.6s 足以落在一个稳定的睁眼相位
    await Bun.sleep(args.settle);

    const res = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
      expression: COLLECT,
      returnByValue: true,
    });
    console.log(`DIAG ${JSON.stringify(res.result.value)}`);

    if (args.out) {
      const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      await Bun.write(args.out, Buffer.from(shot.data, "base64"));
      console.log(`SHOT ${args.out}`);
    }
    cdp.close();
  } catch (error) {
    console.error(`诊断失败：${(error as Error).message}`);
    exitCode = 1;
  } finally {
    chrome.kill("SIGTERM");
    await chrome.exited;
  }
  process.exit(exitCode);
}

interface Client {
  send: Send;
  ws: WebSocket;
  close: () => void;
}

async function connect(port: number): Promise<Client> {
  const deadline = Date.now() + 10_000;
  let target: { webSocketDebuggerUrl?: string } | null = null;
  while (Date.now() < deadline) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
        type: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) {
        target = page;
        break;
      }
    } catch {
      // 端口还没起来
    }
    await Bun.sleep(120);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome 调试端口没起来");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws 连接失败")), { once: true });
  });

  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.addEventListener("message", (event: MessageEvent) => {
    const data = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (data.id === undefined) return;
    const resolve = pending.get(data.id);
    if (!resolve) return;
    pending.delete(data.id);
    if (data.error) throw new Error(`CDP ${data.id}: ${data.error.message}`);
    resolve(data.result);
  });

  const send: Send = <T>(method: string, params?: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, (v) => resolve(v as T));
      ws.send(JSON.stringify({ id: messageId, method, params }));
      setTimeout(() => {
        if (pending.has(messageId)) {
          pending.delete(messageId);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20_000);
    });

  return { send, ws, close: () => ws.close() };
}

await main();
