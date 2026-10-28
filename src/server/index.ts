#!/usr/bin/env bun
/**
 * 服务端入口：只负责起进程。
 * 路由与 SSE 都在 app.ts 里，测试可以直接 import createApp() 而不占端口。
 *
 * WS `/api/stt` 是唯一在这里处理的路由 —— `server.upgrade()` 需要拿到 Bun.serve 的
 * server 句柄，而 app.fetch 只是个纯函数式的 Request → Response。
 * 升级前的门禁（没配 key）与桥的建立仍然在 app.ts / stt.ts 里，这里只做三件事：
 * 门禁 → upgrade → 把 ServerWebSocket 和 SttBridge 绑在一起（close 时拆开）。
 */
import { createApp, sttUpgradeGate } from "./app.ts";
import { loadConfig } from "./config.ts";
import { directorModeOf } from "./director/index.ts";
import { parseSttControl, type SttBridge } from "./stt.ts";

const config = loadConfig();
const app = createApp({ config });

/** ws → 它那条上游桥。close 时必须 delete，否则一次说话漏一条上游连接。 */
const bridges = new Map<unknown, SttBridge>();

type SttUpgradeData = { lang: "zh-CN" | "en-US" };

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port: config.port,
    // SSE 可能长时间不说话，别被默认 10s 空闲超时切断
    idleTimeout: 120,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/api/stt") {
        // 没配 Deepgram：**明确 503 + reason**，不是静默失败也不是 101 之后的空连接
        const gate = sttUpgradeGate(app.voice);
        if (gate) return gate;
        const lang: SttUpgradeData["lang"] = url.searchParams.get("lang") === "en-US" ? "en-US" : "zh-CN";
        if (!srv.upgrade(request, { data: { lang } })) {
          return new Response(JSON.stringify({ type: "error", reason: "upgrade-failed" }), {
            status: 400,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        // upgrade 成功：这条请求已经变成 WS，不再有 HTTP 响应
        return undefined as unknown as Response;
      }
      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        const data = (ws as unknown as { data: SttUpgradeData }).data;
        const bridge = app.openSttStream(
          {
            sendText: (payload) => ws.send(payload),
            close: (code, reason) => ws.close(code, reason),
          },
          { lang: data?.lang ?? "zh-CN" },
        );
        if (!bridge) {
          // 理论上到不了（门禁已经挡了），但漏了就是无声的坏体验
          ws.send(JSON.stringify({ type: "error", reason: "not-configured" }));
          ws.close(1011, "not configured");
          return;
        }
        bridges.set(ws, bridge);
      },
      message(ws, message) {
        const bridge = bridges.get(ws);
        if (!bridge) return;
        // 帧类型即语义：**二进制 = 音频**（原样转上游，不解析、不落盘、不打印），
        // **文本 = 控制消息**。收到控制消息时不能当音频喂给上游 —— 上游会按容器去解析那串 JSON。
        if (typeof message === "string") {
          const control = parseSttControl(message);
          if (control === "finish_utterance") {
            // 「这句说完了，还要说下一句」：冲 final，浏览器连接留着（不是断开）
            bridge.finishUtterance();
          }
          // 认不出来的控制消息：丢掉。宁可少一条指令，也不要污染音频流。
          return;
        }
        bridge.pushAudio(new Uint8Array(message));
      },
      close(ws) {
        // 浏览器彻底断开（关 WS / 页面卸载）：先让上游 flush 尾段，再两侧收摊。
        // 不做这件事，上游会一直等音频直到超时（白烧配额）；硬断则会吞掉最后一条 final。
        bridges.get(ws)?.clientClosed();
        bridges.delete(ws);
      },
    },
  });
} catch (error) {
  console.error(`[server] 无法监听端口 ${config.port}：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const mode = directorModeOf(app.director);
const llmLabel = config.llm ? `${config.llm.label}/${config.llm.model}` : "none(keyless)";
const voiceLabel = `stt=${app.voice.stt ? app.voice.sttModel : "off"} tts=${app.voice.tts ? "on" : "off"}`;
console.log(`[server] listening on http://localhost:${server.port}`);
console.log(`[server] director=${app.director.name} mode=${mode} keyless=${mode === "mock"} llm=${llmLabel} voice(${voiceLabel})`);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，正在退出`);
  // 先把上游语音连接一条条关掉，再停服务
  for (const bridge of bridges.values()) bridge.clientClosed();
  bridges.clear();
  // true = 连同进行中的 SSE 连接一起关掉，不留半开的流
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
