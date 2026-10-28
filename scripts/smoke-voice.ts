#!/usr/bin/env bun
/**
 * 语音链路 stub 冒烟：三条打印，全部用假 key + 假 fetch，**不联网**。
 *
 *   bun run scripts/smoke-voice.ts
 *
 * 它证明的是「接线对了」：无 key 时 status 回双 false、中文在发上游前被 400 拦掉、
 * 英文转发的 URL 与字节数符合预期。它**不证明** Deepgram 真实可用的音质，
 * 也不证明 MP3 能被浏览器解出来 —— 那两件事需要真 key 与真浏览器。
 */
import { createApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { createTtsProxy, upstreamSpeakUrl } from "../src/server/tts.ts";

const STUB_KEY = "stub-key-not-a-real-credential";
const STUB_MP3_BYTES = 2048;

function postTts(app: ReturnType<typeof createApp>, text: string): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
}

// ① 无 key：status 两个 false，客户端据此回退（不是错误）
const keyless = createApp({ config: loadConfig({}) });
const status = (await (await keyless.fetch(new Request("http://localhost/api/voice/status"))).json()) as {
  stt: boolean;
  tts: boolean;
  sttModel: string;
};
console.log(
  `1) GET /api/voice/status（无 key）→ ${JSON.stringify(status)}` +
    ` → 客户端回退：STT=WebSpeech/纯文字，TTS=浏览器`,
);

// ② 有 key + 中文：发上游之前就 400
const upstreamCalls: string[] = [];
const config = loadConfig({ DEEPGRAM_API_KEY: STUB_KEY });
const app = createApp({
  config,
  tts: createTtsProxy({
    config: { apiKey: STUB_KEY },
    log: () => {},
    fetch: async (url, init) => {
      upstreamCalls.push(`${url} bytes=${STUB_MP3_BYTES} body=${init.body}`);
      return new Response(new Uint8Array(STUB_MP3_BYTES));
    },
  }),
});

const zh = await postTts(app, "外面还在下雨吗");
console.log(
  `2) POST /api/tts「外面还在下雨吗」→ ${zh.status} ${JSON.stringify(await zh.json())}` +
    `（上游调用次数=${upstreamCalls.length}）`,
);

// ③ 英文：转发到 /v1/speak，字节数原样回来
const en = await postTts(app, "The rain outside.");
const bytes = (await en.arrayBuffer()).byteLength;
console.log(
  `3) POST /api/tts "The rain outside." → ${en.status} ${en.headers.get("content-type")} bytes=${bytes}` +
    ` upstream=${upstreamCalls.at(-1)?.split(" bytes=")[0] ?? "—"}`,
);
console.log(`   期望的 speak URL（不联网对照）：${upstreamSpeakUrl()}`);
