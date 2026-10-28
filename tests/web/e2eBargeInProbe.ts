/**
 * 真实浏览器探针：headless Chrome + 假麦克风，验证两件事
 *   ① `getUserMedia({echoCancellation:true,noiseSuppression:true,autoGainControl:true})`
 *      在这台机器上**实际生效**了什么（`track.getSettings()` 实测值，不是我们自己传的约束）；
 *   ② 页面里打断链路的时间线探针在跑（`window.__miraBargeInTrace` 有内容）。
 *
 * 为什么单独成文件：`bun test` 只收 `*.test.*` / `*.spec.*`，这个脚本是手动跑的 E2E，
 * 需要 8787 上已经有服务（`bun run start`）与真实的 Chrome。
 *
 * 用法：
 *   bun run tests/web/e2eBargeInProbe.ts --url=http://localhost:8787/?trace=1
 */

const args = new Map<string, string>();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(raw);
  if (match) args.set(match[1]!, match[2]!);
}

const pageUrl = args.get("url") ?? "http://localhost:8787/?trace=1";
const port = args.get("port") ?? "9333";
const audioFile = args.get("audio") ?? "/tmp/zh_test.wav";

const chrome = Bun.spawn(
  [
    "google-chrome",
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/chrome-bargein-${port}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${audioFile}`,
    "--autoplay-policy=no-user-gesture-required",
    pageUrl,
  ],
  { stdout: "ignore", stderr: "ignore" },
);

interface CdpReply {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
}

async function wsUrl(): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = list.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome 还没起 */
    }
    await Bun.sleep(250);
  }
  throw new Error(`拿不到 CDP target（chrome 没起来？端口 ${port}）`);
}

const socket = new WebSocket(await wsUrl());
await new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error("CDP 连接失败"));
});

let nextId = 1;
const pending = new Map<number, (reply: CdpReply) => void>();
socket.onmessage = (event) => {
  const reply = JSON.parse(String((event as MessageEvent).data)) as CdpReply;
  if (typeof reply.id !== "number") return;
  pending.get(reply.id)?.(reply);
  pending.delete(reply.id);
};

function send(method: string, params: Record<string, unknown> = {}): Promise<CdpReply> {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression: string): Promise<unknown> {
  const reply = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.text ?? "页面内脚本抛错");
  }
  return reply.result?.result?.value;
}

await send("Runtime.enable");
// 等页面把 boot 打完（App 的 trace 探针在第一次渲染后就会有内容）
await Bun.sleep(2_500);

const micProbe = await evaluate(`(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings ? track.getSettings() : null;
    const label = track.label;
    stream.getTracks().forEach((t) => t.stop());
    return JSON.stringify({ ok: true, settings, label });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error && error.name || error) });
  }
})()`);

const trace = await evaluate(
  "JSON.stringify({mount: !!document.querySelector('[data-demo]'), title: document.title, ready: document.readyState, diag: window.__miraBargeInTrace ? {enabled: window.__miraBargeInTrace.enabled, marks: window.__miraBargeInTrace.marks.map(m=>m.label + (m.detail ? ':' + m.detail : '')), timeline: window.__miraBargeInTrace.timeline} : null})",
);

console.log("[e2e] page:", pageUrl);
console.log("[e2e] mic:", micProbe);
console.log("[e2e] trace:", trace);

socket.close();
chrome.kill();
process.exit(0);

export {};
