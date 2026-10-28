#!/usr/bin/env bun
/**
 * 语音链路基准：把「听」和「说」的延迟量成可比较的数字。
 *
 * 为什么需要它：选型时看榜单（AA 之类）只能得到「英文数据集上的错误率」和「吞吐」，
 * 而我们真正要决策的两个数字——**首块音频多久到**（说）、**说完多久出终稿**（听）——
 * 没有任何榜单给，只能自己在本机的真实链路上量。
 *
 * 用法：
 *   bun run scripts/voice-bench.ts tts --base http://localhost:8787 --runs 3
 *   bun run scripts/voice-bench.ts tts --base http://localhost:8787 --cold    # 含一次冷启动
 *   bun run scripts/voice-bench.ts stt --base http://localhost:8787 --audio /tmp/probe.webm
 *   bun run scripts/voice-bench.ts stt --audio ./sample.webm --url https://your.host   # 连线上
 *
 * 说明：
 *   - `tts` 走 `/api/tts?stream=1`，量的是**首块音频字节到达**的时刻（≈用户听到声音的前一步）
 *   - `stt` 走 `/api/stt` 的 WebSocket，按 100ms 节奏喂音频（模拟边说边发），
 *     分别记 speech_started / 首个 interim / final 三段
 *   - `--cold` 会先睡 16 秒（Edge 的 WS 空闲回收是 15s），用来量冷启动惩罚
 */

const DEFAULT_TEXT = "雨好像不打算停了，你要是没带伞，就再坐一会儿吧。";

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const base = (arg("base") ?? arg("url") ?? "http://localhost:8787").replace(/\/$/, "");
const text = arg("text") ?? DEFAULT_TEXT;
const runs = Number(arg("runs") ?? "3");

interface TtsSample {
  ttfbMs: number;
  firstChunkBytes: number;
  totalMs: number;
  bytes: number;
  ok: boolean;
  reason: string | null;
}

async function ttsOnce(): Promise<TtsSample> {
  const startedAt = performance.now();
  try {
    const res = await fetch(`${base}/api/tts?stream=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      let reason = `status-${res.status}`;
      try {
        const body = (await res.json()) as { reason?: string };
        if (body?.reason) reason = body.reason;
      } catch {
        /* 非 JSON */
      }
      return { ttfbMs: -1, firstChunkBytes: 0, totalMs: -1, bytes: 0, ok: false, reason };
    }
    if (!res.body) {
      return { ttfbMs: -1, firstChunkBytes: 0, totalMs: -1, bytes: 0, ok: false, reason: "no-body" };
    }

    const reader = res.body.getReader();
    let ttfbMs = -1;
    let firstChunkBytes = 0;
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (ttfbMs < 0) {
        ttfbMs = performance.now() - startedAt;
        firstChunkBytes = value.byteLength;
      }
      bytes += value.byteLength;
    }
    return {
      ttfbMs,
      firstChunkBytes,
      totalMs: performance.now() - startedAt,
      bytes,
      ok: bytes > 0,
      reason: bytes > 0 ? null : "empty-audio",
    };
  } catch (error) {
    return {
      ttfbMs: -1,
      firstChunkBytes: 0,
      totalMs: -1,
      bytes: 0,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function median(values: number[]): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

async function runTts(): Promise<void> {
  console.log(`# TTS 基准  base=${base}`);
  console.log(`# 文本：「${text}」（${text.length} 字）\n`);

  const rows: Array<{ label: string; sample: TtsSample }> = [];

  if (hasFlag("cold")) {
    console.log("冷启动：先静置 16s 让上游 WS 空闲关闭……");
    await Bun.sleep(16_000);
    rows.push({ label: "cold（空闲后首次）", sample: await ttsOnce() });
  }

  for (let i = 1; i <= runs; i += 1) {
    rows.push({ label: `warm #${i}`, sample: await ttsOnce() });
  }

  console.log("");
  console.log("| 样本 | 首块音频 | 首块字节 | 全部收完 | 总字节 | 结果 |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const s = row.sample;
    console.log(
      `| ${row.label} | ${s.ok ? `${Math.round(s.ttfbMs)}ms` : "—"} | ${s.firstChunkBytes || "—"} | ${
        s.ok ? `${Math.round(s.totalMs)}ms` : "—"
      } | ${s.bytes || "—"} | ${s.ok ? "ok" : `✗ ${s.reason}`} |`,
    );
  }

  const warm = rows.filter((row) => row.label.startsWith("warm") && row.sample.ok).map((row) => row.sample.ttfbMs);
  if (warm.length > 0) {
    console.log(`\n热路径首块：median ${median(warm)}ms（n=${warm.length}）`);
  }
  const cold = rows.find((row) => row.label.startsWith("cold"));
  if (cold?.sample.ok && warm.length > 0) {
    console.log(`冷启动惩罚：+${Math.round(cold.sample.ttfbMs - median(warm))}ms`);
  }
}

/**
 * 从 WAV 头读「每秒字节数」。
 *
 * 为什么必须读：喂音频的节奏要**等于真实语速**，否则量出来的延迟没有意义
 * （第一次实现按「文件大小/300」切块，154KB 的 4.8 秒音频拖成 15.6 秒才发完，
 * speech_started 与 interim 全被拉长 3 倍）。webm/mp3 读不到，用 --byte-rate 兜底。
 */
function wavByteRate(audio: Uint8Array): number | null {
  if (audio.byteLength < 44) return null;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  const riff = String.fromCharCode(...audio.slice(0, 4));
  const wave = String.fromCharCode(...audio.slice(8, 12));
  if (riff !== "RIFF" || wave !== "WAVE") return null;
  const byteRate = view.getUint32(28, true);
  return byteRate > 0 && byteRate < 1_000_000 ? byteRate : null;
}

interface SttMark {
  at: number;
  label: string;
}

async function runStt(): Promise<void> {
  const audioPath = arg("audio");
  if (!audioPath) {
    console.error("缺少 --audio <文件>（webm/wav/mp3 都行，服务端会原样转给上游）");
    process.exit(2);
  }
  const file = Bun.file(audioPath);
  if (!(await file.exists())) {
    console.error(`音频不存在：${audioPath}`);
    process.exit(2);
  }
  const audio = new Uint8Array(await file.arrayBuffer());
  const wsUrl = `${base.replace(/^http/, "ws")}/api/stt?lang=zh-CN`;
  const chunkMs = Number(arg("chunk-ms") ?? "100");
  const byteRate = wavByteRate(audio) ?? Number(arg("byte-rate") ?? "32000");
  const audioMs = Math.round((audio.byteLength / byteRate) * 1000);
  const chunkSize = Math.max(1, Math.round((byteRate / 1000) * chunkMs));

  console.log(`# STT 基准  ${wsUrl}`);
  console.log(
    `# 音频：${audioPath}（${(audio.byteLength / 1024).toFixed(1)} KB，约 ${audioMs}ms，${byteRate} B/s）`,
  );
  console.log(`# 按实时速率喂入：${chunkMs}ms/块 = ${chunkSize} 字节\n`);

  const marks: SttMark[] = [];
  const startedAt = performance.now();
  const mark = (label: string) => marks.push({ at: performance.now() - startedAt, label });

  const transcripts: Array<{ t: number; kind: string; text: string }> = [];
  const errors: string[] = [];

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const done = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      errors.push("超时（25s 内没有收到 final / utterance_end）");
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      resolve();
    }, 25_000);

    ws.onopen = () => {
      mark("ws:open");
      // 按真实节奏喂：每 chunkMs 发一块，模拟「边说边发」
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= audio.byteLength) {
          clearInterval(timer);
          mark("audio:done");
          // 模拟「说完」：浏览器端 stop() 就是发这条控制消息（服务端据此冲 final）。
          // 不发的话只有 Deepgram 那条靠 endpointing 自己收尾，阿里整段识别会一直等。
          ws.send(JSON.stringify({ type: "finish_utterance" }));
          mark("finish_utterance");
          return;
        }
        ws.send(audio.slice(offset, offset + chunkSize));
        offset += chunkSize;
      }, chunkMs);
    };

    ws.onmessage = (event) => {
      let payload: { type?: string; text?: string } | null = null;
      try {
        payload = JSON.parse(String(event.data)) as { type?: string; text?: string };
      } catch {
        return;
      }
      const type = payload?.type ?? "unknown";
      if (type === "error") {
        errors.push(payload?.text ?? "upstream-error");
        return;
      }
      if (type === "speech_started" && !marks.some((m) => m.label === "speech_started")) {
        mark("speech_started");
      }
      if (type === "interim" && !marks.some((m) => m.label === "first:interim")) {
        mark("first:interim");
      }
      if (type === "final") {
        transcripts.push({ t: performance.now() - startedAt, kind: "final", text: payload?.text ?? "" });
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
        resolve();
      }
      if (type === "utterance_end" && !marks.some((m) => m.label === "utterance_end")) {
        mark("utterance_end");
      }
    };

    ws.onerror = () => errors.push("ws:error");
    ws.onclose = () => {
      clearTimeout(timeout);
      resolve();
    };
  });

  await done;
  mark("end");

  console.log("| 事件 | 相对开始 | 相对 audio:done |");
  console.log("| --- | --- | --- |");
  const audioDone = marks.find((m) => m.label === "audio:done")?.at ?? null;
  for (const m of marks) {
    const rel = audioDone !== null && m.at >= audioDone ? `+${Math.round(m.at - audioDone)}ms` : "—";
    console.log(`| ${m.label} | ${Math.round(m.at)}ms | ${rel} |`);
  }

  if (transcripts.length > 0) {
    console.log(`\n转写结果：`);
    for (const t of transcripts) console.log(`  [${Math.round(t.t)}ms] ${t.kind}: ${t.text}`);
  }
  if (errors.length > 0) {
    console.log(`\n错误：${errors.join(" / ")}`);
    if (errors.some((e) => e.includes("503") || e.includes("not-configured"))) {
      console.log("（服务端没配 DEEPGRAM_API_KEY —— 这是正常的「未配置」态，不是故障）");
    }
  }
}

const mode = process.argv[2];
if (mode === "tts") {
  await runTts();
} else if (mode === "stt") {
  await runStt();
} else {
  console.log("用法：");
  console.log("  bun run scripts/voice-bench.ts tts --base http://localhost:8787 [--runs 3] [--cold] [--text \"...\"]");
  console.log("  bun run scripts/voice-bench.ts stt --base http://localhost:8787 --audio sample.webm");
  process.exit(mode ? 2 : 0);
}

export {};
