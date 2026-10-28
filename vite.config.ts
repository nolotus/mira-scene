import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
        // 必须开：`/api/stt` 是 WebSocket 升级。不开的话浏览器连 5173 时握手失败，
        // deepgramStt 会静默回退浏览器 Web Speech —— 现象和「没配 key」一模一样，
        // 本地做真人语音测试时会误判成 key 无效（2026-10-28 审查发现）。
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
