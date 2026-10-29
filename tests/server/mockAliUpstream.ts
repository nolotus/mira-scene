/**
 * 本地假上游：模仿阿里百炼**流式** ASR 的报文节奏。
 *
 * 用途：让「真流式」这条链路（浏览器分块 → 服务端 ffmpeg 流式转码 → 边转边喂上游
 * → 边说边出字）**不烧真实配额**也能端到端跑一遍。
 *
 * 怎么用：
 *   MOCK_ALI_PORT=8801 bun run tests/server/mockAliUpstream.ts
 *   DASHSCOPE_API_KEY=fake ALI_ASR_WS_URL=ws://127.0.0.1:8801 SERVER_PORT=8788 bun run src/server/index.ts
 *   bun run tests/web/e2eStreamingStt.ts --wav /tmp/stt_s2.wav --ws ws://127.0.0.1:8788/api/stt
 */
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.MOCK_ALI_PORT ?? 8799);

/** 每连接的状态（不要往 ServerWebSocket 上挂自定义字段） */
interface Session {
  taskId: string;
  /** 已收到的音频时长（ms） */
  audioMs: number;
  /** 上次发结果的时刻（按音频时长计） */
  lastEmitMs: number;
}

const sessions = new Map<ServerWebSocket, Session>();

function textFor(audioMs: number): string {
  // 假文本：长度随音频增长，方便看「字在长」
  const base = "你在这儿坐了很久了吧要不要再来一杯";
  const n = Math.max(1, Math.round((audioMs / 250) * 2));
  return base.slice(0, Math.min(base.length, n));
}

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined as unknown as Response;
    return new Response("mock ali upstream", { status: 200 });
  },
  websocket: {
    open(ws) {
      sessions.set(ws, { taskId: "", audioMs: 0, lastEmitMs: 0 });
    },
    close(ws) {
      sessions.delete(ws);
    },
    message(ws, message) {
      const state = sessions.get(ws);
      if (!state) return;

      if (typeof message === "string") {
        let parsed: { header?: { action?: string; task_id?: string } };
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        const action = parsed.header?.action;
        state.taskId = parsed.header?.task_id ?? state.taskId;

        if (action === "run-task") {
          ws.send(JSON.stringify({ header: { event: "task-started", task_id: state.taskId } }));
          return;
        }
        if (action === "finish-task") {
          ws.send(
            JSON.stringify({
              header: { event: "result-generated", task_id: state.taskId },
              payload: { output: { sentence: { text: textFor(state.audioMs), sentence_end: true } } },
            }),
          );
          ws.send(JSON.stringify({ header: { event: "task-finished", task_id: state.taskId } }));
        }
        return;
      }

      // 二进制 = PCM（16k mono s16le）→ 累计音频时长
      const bytes = message.byteLength;
      state.audioMs += (bytes / 2 / 16000) * 1000;
      if (state.audioMs - state.lastEmitMs >= 250) {
        state.lastEmitMs = state.audioMs;
        ws.send(
          JSON.stringify({
            header: { event: "result-generated", task_id: state.taskId },
            payload: { output: { sentence: { text: textFor(state.audioMs), sentence_end: false } } },
          }),
        );
      }
    },
  },
});

console.log(`mock ali upstream on ws://127.0.0.1:${server.port}`);
