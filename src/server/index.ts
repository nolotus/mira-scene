#!/usr/bin/env bun
/**
 * 服务端入口：只负责起进程。
 * 路由与 SSE 都在 app.ts 里，测试可以直接 import createApp() 而不占端口。
 */
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { directorModeOf } from "./director/index.ts";

const config = loadConfig();
const app = createApp({ config });

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    // SSE 可能长时间不说话，别被默认 10s 空闲超时切断
    idleTimeout: 120,
  });
} catch (error) {
  console.error(`[server] 无法监听端口 ${config.port}：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const mode = directorModeOf(app.director);
const llmLabel = config.llm ? `${config.llm.label}/${config.llm.model}` : "none(keyless)";
console.log(`[server] listening on http://localhost:${server.port}`);
console.log(`[server] director=${app.director.name} mode=${mode} keyless=${mode === "mock"} llm=${llmLabel} prod=${config.isProd}`);

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，正在退出`);
  // true = 连同进行中的 SSE 连接一起关掉，不留半开的流
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
