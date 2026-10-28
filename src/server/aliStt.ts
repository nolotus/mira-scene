/**
 * 语音识别（STT）provider：**阿里百炼 fun-asr**（Deepgram key 被吊销后的回退通道）。
 *
 * 为什么要有第二条通道：Deepgram 的 key 一旦被吊销，浏览器端就彻底没有语音输入了。
 * 阿里百炼的 fun-asr 是同形态的实时 WS 协议（但**不是**同一套报文），所以只能在**服务端**
 * 做 provider 选择 —— 浏览器侧的协议（`SttClientMessage`：interim / final / speech_started /
 * utterance_end / error / capabilities）保持不变，客户端**感知不到**换了供应商。
 *
 * ── 与 Deepgram 的三点实质差异（踩坑前先看这里）──
 *   1. **整段识别**：fun-asr-flash 不发 interim，也不发 speech_started；整段音频发完
 *      才出**一条**完整文本（约 +120~170ms），并且**不发 task-finished ——
 *      拿到 `sentence_end` 就算完。
 *   2. **不吃 webm 容器**（实测 `format=webm` 直接断连）：浏览器送的是 MediaRecorder 的
 *      webm/opus，所以服务端必须先把整段音频转成 **wav 16k mono** 再送。
 *   3. **不发 speech_started**：这是「打断」链路的唯一缺口。本模块**不伪造**它 ——
 *      伪造一个假的 speech_started 会让 bargeIn 在错误时机触发打断，比没有更糟。
 *      改为**显式上报能力**（`capabilities` 首帧 + `/api/voice/status`）：
 *      `supportsSpeechStarted:false` → 客户端改走 energy VAD（保留 AEC / 回声门禁）。
 *
 * ── 时序（为什么这么写）──
 *   浏览器 MediaRecorder 每 100ms 一块 → 服务端**攒着**（不逐块转发：上游要整段 wav）→
 *   收到「这句说完了」(`finish_utterance`) → ffmpeg 转 wav → 送上游 → 收一条 final → 回客户端。
 *   为了守住延迟预算，上游 WS 连接**提前建好**（prewarm），ffmpeg 进程也在第一块音频到达时
 *   就起好、边收边解 —— 收尾时只剩「关管道 + 等上游出文本」。
 *
 * ── 句子的边界**只**由显式 `finish_utterance` 决定 ──
 *   旧实现用「数据包间隔 > 120ms」猜「这句说完了」。那是错的：浏览器每 100ms 一块，
 *   只留 20ms 余量，任何调度抖动都会提前收尾，而后续 webm 块不保证带独立容器头，
 *   于是同一条录音被切成两半（长句被截断）。现在：
 *     · 句子边界 = 显式 `finish_utterance`（或 60s 绝对时长兜底）；
 *     · 帧间隔**不再**参与判断。
 *
 * ── 预算：到点必须有结论 ──
 *   每个阶段都有硬上限，超了就是**明确的失败**（给客户端 error），绝不静默丢句：
 *     · 握手/预热：从连接创建起 15s 内没有 task-started → `upstream-not-ready`；
 *     · 收尾（转码 + 上游往返）：从收尾起 15s 内没有 final → `timeout`；
 *     · 结果等待：送出音频后 15s 内没有终稿 → `result-timeout`（客户端据此回退）；
 *     · 累积：单句绝对时长 60s 兜底 → 到点强制收尾，给 final（不是错误）。
 *   ⇒ 一句从「开始录音」到「final 送达」的上限 = 60s（累积）+ 15s（收尾）= 75s，
 *     而且每一步都有结论（final 或 error），不存在挂成僵尸的会话。
 *   为什么不是「整句 15s」：那 15s 里有一半是**用户说话的时间**，
 *     连着说 20 秒是正常用法 —— 按整句 15s 砍会把正常长句切成两半，
 *     那正是本文件要修的 bug 的另一个版本。
 *
 * ── 资源上限（会话级，不是「原始输入」级）──
 *   原始输入 32MiB / 单句帧数 1500 / 转码输出 16MiB / 同时存在的会话 32 个，
 *   任何一个越界都是**明确的 error**（`audio-too-large` / `too-many-frames` /
 *   `transcode-too-large` / `too-many-sessions`），不是静默截断。
 *
 * ── 进程纪律 ──
 *   ffmpeg 是子进程：**任何**收尾路径（上游报错、转码失败、客户端断开、超时、正常结束）
 *   都必须把它 kill 掉，且不能重复 kill、不能漏掉「已 spawn 还没 attach」的那个窗口。
 *
 * ── 纪律 ──
 *   · 密钥只出现在 Authorization 头里，不进 URL、不进日志、不回响应。
 *   · 日志只写帧数/字节数/状态/事件类型，**绝不**打印转写文本与音频。
 */

import type { BrowserSink, SttBridge, SttClientMessage, UpstreamConnect, UpstreamSocket } from "./stt.ts";

// ------------------------------------------------------------------ 常量

/** 阿里百炼 WS 入口（实测可用） */
export const ALI_ASR_WS_URL = "wss://llm-591oew115u3ce1c0.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference";
/** 实测通过的模型：fun-asr-flash（中文可用，整段识别） */
export const ALI_ASR_MODEL = "fun-asr-flash-2026-06-15";
/** 上游只认 wav；采样率必须与参数里声明的一致 */
export const ALI_ASR_SAMPLE_RATE = 16000;
/** 客户端 legacy 的 linear16 流的采样率（只用于「直接送 PCM」那条老路） */
export const ALI_PCM_INPUT_RATE = 22050;
/**
 * 单个阶段的硬预算（ms）。
 *
 * 为什么是「每个阶段」而不是「整段会话 15s」：整段会话包含**用户说话的时间**，
 * 而用户连着说 20 秒是正常用法（60s 绝对时长兜底就是为它准备的）。把说话时间算进
 * 15s 会把正常长句砍成两半 —— 那正是本文件要修的 bug 的另一个版本。
 * 所以预算按阶段切：预热/握手、收尾（转码+上游往返）、结果等待各 15s，
 * 累积阶段由 60s 绝对时长兜底。**每个阶段到点都有结论（final 或 error）**。
 */
export const ALI_TOTAL_BUDGET_MS = 15_000;
/** 等上游出终稿的上限（超时按错误处理，不让会话挂成僵尸） */
export const ALI_RESULT_TIMEOUT_MS = 15_000;
/**
 * 等握手 + task-started 的上限（从**连接创建**起算，因此**覆盖预热阶段**）。
 * 与总预算同值：预热不是「免费」的，它花的就是客户端的等待时间。
 */
export const ALI_HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * 单句的**绝对时长**上限（ms）：客户端一直不发 `finish_utterance` 时的兜底。
 * 到点强制收尾（给 final），不是错误 —— 句子太长总比把会话挂死好。
 */
export const ALI_MAX_UTTERANCE_MS = 60_000;
/** 单句原始输入的字节上限（兜底：不让一个坏客户端把内存吃光） */
export const ALI_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
/** 单句转码输出（wav）的字节上限：16k mono s16 ≈ 32KB/s → 16MiB ≈ 8 分钟 */
export const ALI_MAX_WAV_BYTES = 16 * 1024 * 1024;
/** 单句帧数上限（100ms/块 → 1500 帧 ≈ 150 秒，与上面的绝对时长互相兜底） */
export const ALI_MAX_FRAMES = 1500;
/** 同时存在的阿里会话上限（每个会话一条上游连接 + 一个 ffmpeg 进程） */
export const ALI_MAX_SESSIONS = 32;

// ------------------------------------------------------------------ 上游报文（纯函数，可单测）

export type AliEvent =
  | { kind: "task-started" }
  | { kind: "result"; text: string; sentenceEnd: boolean }
  | { kind: "task-finished" }
  | { kind: "error"; reason: string }
  | { kind: "other"; event: string };

/**
 * 阿里上游报文 → 归一化事件。纯函数：认不出来的回 `other`（不当错误）。
 *
 * 见过的几种：
 *   {"header":{"event":"task-started", ...}}
 *   {"header":{"event":"result-generated"},
 *    "payload":{"output":{"sentence":{"text":"你在这儿坐了很久了吧","sentence_end":true}}}}
 *   {"payload":{"output":{"type":"error","error":{"code":"...","message":"..."}}}}
 */
export function parseAliEvent(raw: string): AliEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "other", event: "unparsable" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "other", event: "unknown" };
  const record = parsed as Record<string, unknown>;

  const header = record.header;
  const headerRecord =
    header && typeof header === "object" ? (header as Record<string, unknown>) : {};
  const event =
    header && typeof header === "object" && typeof (header as Record<string, unknown>).event === "string"
      ? ((header as Record<string, unknown>).event as string)
      : "";

  const payload = record.payload;
  const output =
    payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).output as Record<string, unknown> | undefined)
      : undefined;

  // 错误有两种位置：payload.output.type==="error"，或 header.event==="task-failed"
  if (output && typeof output === "object" && output.type === "error") {
    const err = output.error;
    const reason =
      err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string"
        ? ((err as Record<string, unknown>).message as string)
        : "upstream-error";
    return { kind: "error", reason };
  }

  if (event === "task-started") return { kind: "task-started" };
  if (event === "task-finished") return { kind: "task-finished" };
  if (event === "task-failed") {
    // 阿里在 header 里带 error_code / error_message（例如 AccessDenied.Unpurchased：
    // 「这个 key 没有该模型的权限」）。把它带出来，日志才能一眼看出是**账号/权限**问题
    // 还是音频问题 —— 两者修法完全不同。
    const code = typeof headerRecord.error_code === "string" ? headerRecord.error_code : "";
    const message = typeof headerRecord.error_message === "string" ? headerRecord.error_message : "";
    const detail = code || message;
    return { kind: "error", reason: detail ? `task-failed:${detail}` : "task-failed" };
  }

  if (event === "result-generated" || output) {
    const sentence =
      output && typeof output.sentence === "object"
        ? (output.sentence as Record<string, unknown>)
        : undefined;
    const text =
      sentence && typeof sentence.text === "string"
        ? sentence.text
        : output && typeof output.text === "string"
          ? output.text
          : "";
    const sentenceEnd = sentence?.sentence_end === true;
    if (text.trim() || sentenceEnd) return { kind: "result", text: text.trim(), sentenceEnd };
  }

  return { kind: "other", event: event || "unknown" };
}

/** 上游连接握手的请求体（实测可用，参数别乱改） */
export function aliRunTaskMessage(taskId: string, model: string): string {
  return JSON.stringify({
    header: { action: "run-task", task_id: taskId, streaming: "duplex" },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model,
      parameters: { format: "wav", sample_rate: ALI_ASR_SAMPLE_RATE },
      input: {},
    },
  });
}

/** 收尾请求：告诉上游「音频发完了，出终稿」 */
export function aliFinishTaskMessage(taskId: string): string {
  return JSON.stringify({
    header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
    payload: { input: {} },
  });
}

// ------------------------------------------------------------------ 音频转码（ffmpeg）

/**
 * 一段音频的转码器：喂进原始字节，finish() 拿到 16k mono wav。
 * 测试注入假的实现，生产走 ffmpeg。
 */
export interface AudioEncoder {
  write(chunk: Uint8Array): void | Promise<void>;
  /** 收尾：返回完整的 wav 字节 */
  finish(): Promise<Uint8Array>;
  /**
   * 放弃这个转码器：**必须**杀掉已经 spawn 的子进程。
   *
   * 约定：
   *   · 可重复调用（幂等）：重复 kill 同一个进程没有意义，也不许因此抛错；
   *   · 进程已经退出时必须是空操作；
   *   · `finish()` 失败（ffmpeg 报错退出）之后也**要**能调用（兜底 kill）。
   */
  kill?(): void;
}

export type EncoderFactory = (input: "webm-opus" | "linear16" | "webm-forced") => AudioEncoder;

/**
 * ffmpeg 转码器：**整段喂进去**，一次转完。
 *
 * 为什么**不能**边收边喂（这是真实用户用不了的根因）：
 *   浏览器 MediaRecorder 产出的是 webm/opus 的**分块流** —— 只有第一块带 EBML 容器头，
 *   后续块是裸 cluster 数据。把这些字节一块块喂给 `ffmpeg -i pipe:0`，ffmpeg 拿到的是
 *   一个没有头 / 头不全的流，探测阶段直接失败：
 *     `[in#0] Error opening input: Invalid data found when processing input`
 *   → 整句没有转写（线上实测：frames=24 bytes=43981 reason=audio encode failed）。
 *
 * 所以：先**攒完整段**，再一次性转码。阿里本来就是整段识别，延迟已经达标
 * （真实端点实测：说完 → final ≈ 400ms，其中转码只占几十到几百毫秒）。
 *
 * 进程纪律：`spawn()` 是懒的（第一次 write 才起），「已 spawn 未 attach」的窗口就在
 * write() 里 —— 那里抛出的异常（ffmpeg 不存在、管道写失败）必须被上层接住，
 * 并且 kill() 必须能收拾掉这个已经起来的进程。
 */
export function createFfmpegEncoder(
  input: "webm-opus" | "linear16" | "webm-forced" = "webm-opus",
): AudioEncoder {
  const args = ["ffmpeg", "-hide_banner", "-loglevel", "error"];
  if (input === "linear16") {
    // legacy 路径：客户端直送 PCM，必须显式声明格式，否则 ffmpeg 会当成 wav 去解析
    args.push("-f", "s16le", "-ar", String(ALI_PCM_INPUT_RATE), "-ac", "1");
  } else if (input === "webm-forced") {
    // 兜底：探测失败时**强制**按 webm 解析（浏览器送的就是 webm，跳过探测更稳）
    args.push("-f", "webm");
  }
  args.push(
    "-i",
    "pipe:0",
    "-f",
    "wav",
    "-acodec",
    "pcm_s16le",
    "-ac",
    "1",
    "-ar",
    String(ALI_ASR_SAMPLE_RATE),
    "pipe:1",
  );

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  /** 进程是否已经退出（退出后再 kill 是空操作） */
  let exited = false;
  /** kill 是否已经做过（幂等） */
  let killed = false;

  const spawn = (): ReturnType<typeof Bun.spawn> => {
    if (proc) return proc;
    proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    return proc;
  };

  /** Bun 的 spawn 类型把 stdin/stdout 写成联合类型，这里收窄成「一定是管道」 */
  interface PipeSink {
    /**
     * 返回实际写进去的字节数，**也可能是 Promise** ——
     * Bun 的 FileSink 在超过管道容量（64KB）时会异步排空并返回 Promise<number>。
     * 当成 number 用会把 `offset += written` 拼成字符串，循环第一轮就退出
     * （审查指出、2026-10-28 修）。
     */
    write(chunk: Uint8Array): number | Promise<number>;
    flush(): void;
    end(): void;
  }
  const stdinOf = (child: ReturnType<typeof Bun.spawn>): PipeSink =>
    child.stdin as unknown as PipeSink;
  const stdoutOf = (child: ReturnType<typeof Bun.spawn>): ReadableStream<Uint8Array> =>
    child.stdout as unknown as ReadableStream<Uint8Array>;
  const stderrOf = (child: ReturnType<typeof Bun.spawn>): ReadableStream<Uint8Array> =>
    child.stderr as unknown as ReadableStream<Uint8Array>;

  return {
    async write(chunk): Promise<void> {
      if (killed || exited) return;
      if (chunk.byteLength === 0) return;
      const child = spawn();
      // 管道容量有限（64KB）：write() 可能只写进去一部分，必须循环写完，
      // 否则 ffmpeg 收到的是**截断**的音频（表现为「转写内容少了尾巴」）。
      let offset = 0;
      let stalled = 0;
      while (offset < chunk.byteLength) {
        const piece = chunk.subarray(offset);
        let written = 0;
        try {
          const result = stdinOf(child).write(piece);
          written = typeof result === "number" ? result : await result;
        } catch {
          // 管道写失败（ffmpeg 已退出）：记下来，finish() 时用退出码报错
          break;
        }
        if (written <= 0) {
          // 写不进去（ffmpeg 已退出 / 管道满）：再试几次，仍不行就交给 finish() 报错
          stalled += 1;
          if (stalled > 3) break;
          continue;
        }
        stalled = 0;
        offset += written;
        try {
          stdinOf(child).flush();
        } catch {
          break;
        }
      }
    },
    async finish() {
      const child = proc;
      if (!child) return new Uint8Array(0);
      try {
        stdinOf(child).end();
      } catch {
        /* 已经关了 */
      }
      const [out, err, code] = await Promise.all([
        new Response(stdoutOf(child)).arrayBuffer(),
        new Response(stderrOf(child)).text(),
        child.exited,
      ]);
      exited = true;
      if (code !== 0) {
        // 只带 ffmpeg 的错误摘要，绝不带音频
        throw new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 200)}`);
      }
      return new Uint8Array(out);
    },
    kill() {
      if (killed) return;
      killed = true;
      const child = proc;
      proc = null;
      if (!child || exited) return;
      try {
        child.kill();
      } catch {
        /* 已经死了 */
      }
    },
  };
}

/**
 * 把 ffmpeg 管道输出的 wav **规整成标准 PCM wav**（44 字节头 + data）。
 *
 * 为什么必须整：ffmpeg 往管道写 wav 时有两个坑 ——
 *   ① 不知道最终多长，RIFF/data 长度字段是 0xFFFFFFFF 占位；
 *      有些 wav 解析器（部分 ASR 后端）照着这个长度去读，就是「等 4GB 音频」或直接截断。
 *   ② 会在 fmt 与 data 之间塞一个 LIST/INFO 块（Lavf 版本号）；
 *      只认「RIFF-fmt-data」三段式的老解析器会在这里错位。
 * 规整之后只剩标准三段，长度字段也是真实值。
 *
 * 认不出来（非 wav / 非 PCM）时原样返回：不猜、不改。
 */
export function normalizeWav(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 44) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return bytes;

  let fmt: Uint8Array | null = null;
  let dataStart = -1;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      fmt = bytes.slice(offset + 8, offset + 8 + Math.min(size, 16));
    } else if (id === "data") {
      dataStart = offset + 8;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || fmt.byteLength < 16 || dataStart < 0) return bytes;

  const dataSize = bytes.byteLength - dataStart;
  const out = new Uint8Array(44 + dataSize);
  const outView = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  outView.setUint32(4, 36 + dataSize, true); // RIFF 总长（不含前 8 字节）
  out.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  out.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  outView.setUint32(16, 16, true);
  out.set(fmt, 20);
  out.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  outView.setUint32(40, dataSize, true);
  out.set(bytes.subarray(dataStart), 44);
  return out;
}

// ------------------------------------------------------------------ 桥

export interface AliSttOptions {
  apiKey: string;
  wsUrl?: string;
  model?: string;
  connect: UpstreamConnect;
  sink: BrowserSink;
  lang?: "zh-CN" | "en-US";
  format?: "webm-opus" | "linear16";
  /** 只喂帧数/字节数/状态，绝不喂文本与音频 */
  log?: (line: string) => void;
  /** 转码器工厂（测试注入假的，不依赖真实 ffmpeg） */
  encoder?: EncoderFactory;
  /** 单阶段硬预算（ms）：预热/握手、收尾、结果等待共用 */
  totalBudgetMs?: number;
  /** 单句绝对时长上限（ms）：到点强制收尾 */
  maxUtteranceMs?: number;
  /** 等终稿上限（ms） */
  resultTimeoutMs?: number;
  /** 单句帧数上限 */
  maxFrames?: number;
  /** 转码输出上限（字节） */
  maxWavBytes?: number;
  /** 同时存在的会话上限 */
  maxSessions?: number;
}

interface UpstreamTask {
  socket: UpstreamSocket;
  taskId: string;
  /** WS 已 open（连接层就绪） */
  opened: boolean;
  /** 已收到 task-started（任务层就绪） */
  ready: boolean;
  /** run-task 已经发出（每个 task 只发一次） */
  runTaskSent: boolean;
  /** 握手截止时刻（从连接创建起算，覆盖预热阶段） */
  deadline: number;
}

/** 同时存在的会话数（模块级）：每个会话 = 一条上游连接 + 一个 ffmpeg 进程 */
let activeSessions = 0;

/** 当前活跃的阿里会话数（诊断 / 测试用） */
export function aliActiveSessions(): number {
  return activeSessions;
}

/**
 * 建立一条阿里通道的桥。
 *
 * 与 Deepgram 桥的**对外行为一致**（同一套 SttBridge 接口、同一套客户端消息），
 * 差别只在内部：攒音频 → 转 wav → 整段送上游 → 一条 final。
 */
export function createAliSttBridge(options: AliSttOptions): SttBridge {
  const log = options.log ?? ((line: string) => console.warn(line));
  const wsUrl = options.wsUrl ?? ALI_ASR_WS_URL;
  const model = options.model ?? ALI_ASR_MODEL;
  const makeEncoder = options.encoder ?? createFfmpegEncoder;
  const totalBudgetMs = options.totalBudgetMs ?? ALI_TOTAL_BUDGET_MS;
  const maxUtteranceMs = options.maxUtteranceMs ?? ALI_MAX_UTTERANCE_MS;
  const resultTimeoutMs = options.resultTimeoutMs ?? ALI_RESULT_TIMEOUT_MS;
  const maxFrames = options.maxFrames ?? ALI_MAX_FRAMES;
  const maxWavBytes = options.maxWavBytes ?? ALI_MAX_WAV_BYTES;
  const maxSessions = options.maxSessions ?? ALI_MAX_SESSIONS;

  let closed = false;
  /** 收尾态：客户端已经走了 → 不再新建上游连接（否则白烧一条连接的钱） */
  let tearingDown = false;
  let frames = 0;
  let bytes = 0;
  let lastEvent: string | null = null;
  /** 当前这句的帧数 */
  let frameCount = 0;

  /** 当前这句的原始字节（转码失败时可以整段重试；也是内存兜底的观测点） */
  const rawChunks: Uint8Array[] = [];
  let rawBytes = 0;
  /** 当前这句的转码器（第一块音频到达时才起，边收边解）；**唯一**的持有者引用 */
  let currentEncoder: AudioEncoder | null = null;

  /** 当前上游（一个 task 一条连接） */
  let upstream: UpstreamTask | null = null;
  /** 正在收尾（避免并发收两次） */
  let running = false;
  let queued: { reason: string; keep: boolean } | null = null;
  /** 单句绝对时长兜底定时器 */
  let utteranceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 收尾阶段的截止时刻（预热 + 转码 + 上游往返共用同一个预算） */
  let finalizeDeadline = 0;
  /** 收尾预算定时器（转码 + 上游往返） */
  let finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  const sinkSend = (message: SttClientMessage): void => {
    if (closed && message.type !== "error") return;
    try {
      options.sink.sendText(JSON.stringify(message));
    } catch {
      // 浏览器侧已经没了：按断开处理
      shutdown(1001, "client gone");
    }
  };

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimeout(timer);
    return null;
  };

  /**
   * 杀掉当前转码器（幂等）。
   *
   * 纪律：**所有**收尾路径都必须经过它 ——
   * 上游报错、转码失败、客户端断开、超时、正常结束。
   * 「已 spawn 未 attach」的窗口也在这里被兜住：进程起来之后 encoder 立刻被记录，
   * 任何一条异常路径都会走到 kill。
   */
  const killEncoder = (): void => {
    const enc = currentEncoder;
    currentEncoder = null;
    if (!enc) return;
    try {
      enc.kill?.();
    } catch {
      /* 已经死了 */
    }
  };

  const closeUpstream = (): void => {
    const current = upstream;
    upstream = null;
    if (!current) return;
    try {
      current.socket.close(1000, "segment done");
    } catch {
      /* 可能已经关了 */
    }
  };

  const shutdown = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    utteranceTimer = clearTimer(utteranceTimer);
    finalizeTimer = clearTimer(finalizeTimer);
    rawChunks.length = 0;
    rawBytes = 0;
    // 进程纪律：收摊时 ffmpeg 必须死
    killEncoder();
    closeUpstream();
    // 别让等待者挂着：结果等待者一律拿 null（= 没有终稿）
    if (resultWaiter) {
      const waiter = resultWaiter;
      resultWaiter = null;
      waiter(null);
    }
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (resultTimer !== null) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    activeSessions = Math.max(0, activeSessions - 1);
    try {
      options.sink.close(code, reason);
    } catch {
      /* 浏览器侧可能已经关了 */
    }
    log(`[stt:ali] closed frames=${frames} bytes=${bytes} reason=${reason} lastEvent=${lastEvent ?? "none"}`);
  };

  /** 为下一句预热一条上游连接（握手 + task-started 在这句说完的时间里就付掉了） */
  const openUpstream = (): void => {
    if (closed || tearingDown || upstream) return;
    const taskId = crypto.randomUUID();
    let socket: UpstreamSocket;
    try {
      socket = options.connect(wsUrl, {
        // key 只出现在这里：不写日志、不进 URL、不回响应
        Authorization: `Bearer ${options.apiKey}`,
      });
    } catch {
      log("[stt:ali] connect threw");
      upstream = null;
      return;
    }
    const task: UpstreamTask = {
      socket,
      taskId,
      opened: false,
      ready: false,
      runTaskSent: false,
      // 握手截止 = 连接创建 + min(阶段预算, 握手上限)：预热阶段也在预算内
      deadline: Date.now() + Math.min(totalBudgetMs, ALI_HANDSHAKE_TIMEOUT_MS),
    };
    upstream = task;

    socket.onopen = () => {
      if (closed || upstream !== task) return;
      // 连接层就绪。**不**在这里发 run-task：
      // 阿里那边的 task 一旦创建却收不到音频，几秒后就会被判 task-failed
      // （实测：真人说话的 5.2s 累积期里，预热的 task 直接失败）。
      // 正确做法：连接可以预热，**任务**必须在音频就绪的那一刻才创建。
      task.opened = true;
    };

    socket.onmessage = (event) => {
      if (closed || upstream !== task) return;
      if (typeof event.data !== "string") return;
      const parsed = parseAliEvent(event.data);
      lastEvent = parsed.kind === "other" ? `other:${parsed.event}` : parsed.kind;
      if (parsed.kind === "task-started") {
        task.ready = true;
        log("[stt:ali] task-started");
        return;
      }
      if (parsed.kind === "result") {
        // 终稿：整段识别模型只出一条结果，sentence_end 即完
        deliverResult(parsed.text, parsed.sentenceEnd);
        return;
      }
      if (parsed.kind === "error") {
        log(`[stt:ali] upstream error detail=${parsed.reason.slice(0, 120)}`);
        sinkSend({ type: "error", reason: "upstream-error" });
        shutdown(1000, "upstream error");
        return;
      }
      if (parsed.kind === "task-finished") {
        // fun-asr-flash 实测**不发**这个；真发了就当收尾信号（结果通常已经在前面来过）
        deliverResult("", true);
      }
    };

    socket.onclose = () => {
      if (closed || upstream !== task) return;
      upstream = null;
      // 空闲的预热连接被对端关掉（还没创建 task）：不是错误 —— 收尾时会重连
      if (!task.runTaskSent) {
        log("[stt:ali] idle prewarm connection closed");
        return;
      }
      // 没拿到结果就断了：客户端必须收到收摊信号，否则它会一直等字幕
      if (!delivered) {
        sinkSend({ type: "error", reason: "upstream-closed" });
        shutdown(1000, "upstream closed");
      }
    };

    socket.onerror = () => {
      if (closed || upstream !== task) return;
      sinkSend({ type: "error", reason: "upstream-error" });
      shutdown(1011, "upstream error");
    };
  };

  /** 当前这句的终稿 */
  let delivered = false;
  /** 已落定的终稿文本（结果可能比 waitResult() 先到） */
  let lastText = "";
  let pendingResult: { text: string; sentenceEnd: boolean } | null = null;
  let resultWaiter: ((value: string | null) => void) | null = null;
  /** 「还没带 sentence_end，先攒一下」的宽限定时器 */
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 等终稿的总超时 */
  let resultTimer: ReturnType<typeof setTimeout> | null = null;

  const deliverResult = (text: string, sentenceEnd: boolean): void => {
    if (delivered || closed) return;
    if (text) pendingResult = { text, sentenceEnd };
    else if (!pendingResult) pendingResult = { text: "", sentenceEnd };
    if (!sentenceEnd) {
      // 没带 sentence_end：先攒一下（模型偶尔先给一段再补尾），最多等 300ms
      if (graceTimer === null) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          flushResult();
        }, 300);
      }
      return;
    }
    flushResult();
  };

  /**
   * 终稿落定：**只**唤醒等待者，由 finalizeOnce 统一发给客户端
   * （这里直接发会出现「两条 final」）。
   */
  const flushResult = (): void => {
    if (delivered) return;
    delivered = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (resultTimer !== null) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
    const text = pendingResult?.text ?? "";
    pendingResult = null;
    lastText = text;
    const waiter = resultWaiter;
    resultWaiter = null;
    waiter?.(text || null);
  };

  /**
   * 等这条 task 的终稿；超时回 null。
   *
   * 超时**不是**静默丢句：这里直接给客户端一条 error（`result-timeout`），
   * 客户端据此回退（而不是一直等字幕）。
   */
  const waitResult = (): Promise<string | null> => {
    if (delivered) return Promise.resolve(lastText || null);
    return new Promise<string | null>((resolve) => {
      resultWaiter = resolve;
      resultTimer = setTimeout(() => {
        resultTimer = null;
        const waiter = resultWaiter;
        resultWaiter = null;
        waiter?.(null);
        if (closed) return;
        sinkSend({ type: "error", reason: "result-timeout" });
        shutdown(1011, "result timeout");
      }, resultTimeoutMs);
    });
  };

  /**
   * 整段转码：**一次性**把攒好的整段音频喂给 ffmpeg。
   *
   * 为什么是「整段」而不是「边收边喂」：浏览器的 MediaRecorder 给的是 webm/opus
   * 分块流（只有第一块带 EBML 容器头，后续块是裸 cluster），
   * 边收边喂会让 ffmpeg 的探测阶段直接失败（Invalid data found）→ 整句没有转写。
   *
   * `input` 用来做兜底重试：自动探测失败时按 webm 强制解析再试一次。
   */
  const encodeWholeSegment = async (
    raw: Uint8Array,
    input: "webm-opus" | "linear16" | "webm-forced",
  ): Promise<Uint8Array> => {
    const enc = makeEncoder(input);
    // 登记当前转码器：收摊/超时路径（shutdown）也要能把它 kill 掉
    currentEncoder = enc;
    try {
      await enc.write(raw);
      const out = await enc.finish();
      if (out.byteLength === 0) throw new Error("empty wav");
      return out;
    } catch (error) {
      // 失败的转码器也可能有活着的进程：必须杀掉（统一走桥的 kill，幂等）
      killEncoder();
      throw error;
    }
  };

  const takeAudio = (): Uint8Array => {
    const raw = new Uint8Array(rawBytes);
    let offset = 0;
    for (const chunk of rawChunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    rawChunks.length = 0;
    rawBytes = 0;
    frameCount = 0;
    return raw;
  };

  /** 收尾一次：转码 → 送上游 → 出 final */
  const finalizeOnce = async (reason: string, keep: boolean): Promise<void> => {
    utteranceTimer = clearTimer(utteranceTimer);
    finalizeTimer = clearTimer(finalizeTimer);

    if (!keep) {
      // 客户端已经走了：不再新建上游、不再转码（省一条连接的钱，也省一次 ffmpeg）
      tearingDown = true;
      killEncoder();
      rawChunks.length = 0;
      rawBytes = 0;
      shutdown(1000, reason);
      return;
    }

    // 收尾预算（转码 + 上游往返都在里面）：到点必须有结论
    finalizeDeadline = Date.now() + totalBudgetMs;
    finalizeTimer = setTimeout(() => {
      finalizeTimer = null;
      if (closed) return;
      sinkSend({ type: "error", reason: "timeout" });
      shutdown(1011, "finalize timeout");
    }, totalBudgetMs);

    try {
      await finalizeBody();
    } finally {
      // 收尾结束 → 预算计时器作废（否则会在下一句都结束之后才炸出一个假 timeout）
      finalizeTimer = clearTimer(finalizeTimer);
    }
  };

  /** 收尾的正身：转码 → 送上游 → 出 final */
  const finalizeBody = async (): Promise<void> => {
    const raw = takeAudio();
    if (raw.byteLength === 0) {
      // 没有音频：什么都不用做（客户端可能只是先点了停止）；上游留着给下一句
      openUpstream();
      return;
    }

    let wav: Uint8Array;
    const primary = options.format === "linear16" ? "linear16" : "webm-opus";
    try {
      wav = await encodeWholeSegment(raw, primary);
    } catch (error) {
      log(`[stt:ali] encode failed: ${error instanceof Error ? error.message : "unknown"}`);
      if (closed) return;
      // 兜底再试一次：自动探测失败时**强制**按 webm 解析（浏览器送的就是 webm）
      if (primary === "webm-opus") {
        try {
          wav = await encodeWholeSegment(raw, "webm-forced");
          log("[stt:ali] encode recovered with forced webm demuxer");
        } catch (error2) {
          log(`[stt:ali] encode failed (forced): ${error2 instanceof Error ? error2.message : "unknown"}`);
          if (closed) return;
          sinkSend({ type: "error", reason: "audio-encode-failed" });
          shutdown(1011, "audio encode failed");
          return;
        }
      } else {
        sinkSend({ type: "error", reason: "audio-encode-failed" });
        shutdown(1011, "audio encode failed");
        return;
      }
    }
    // 转码器已经退出了（成功或失败都杀过）：这里再走一遍 kill 是幂等的空操作
    killEncoder();

    // 会话级资源上限：转码输出也算内存，超了就是明确的失败
    if (wav.byteLength > maxWavBytes) {
      sinkSend({ type: "error", reason: "transcode-too-large" });
      killEncoder();
      shutdown(1009, "transcoded audio too large");
      return;
    }
    wav = normalizeWav(wav);

    if (closed) return;
    if (!upstream) openUpstream();
    const task = upstream;
    if (!task) {
      sinkSend({ type: "error", reason: "upstream-unavailable" });
      shutdown(1011, "upstream unavailable");
      return;
    }
    // 任务在**音频就绪**这一刻才创建（预热的 task 会因为收不到音频被判 task-failed）
    const ready = await startTask(task, finalizeDeadline);
    if (!ready) {
      if (closed) return;
      sinkSend({ type: "error", reason: "upstream-unavailable" });
      shutdown(1011, "upstream not ready");
      return;
    }

    delivered = false;
    pendingResult = null;
    lastText = "";
    try {
      task.socket.send(wav);
      task.socket.send(aliFinishTaskMessage(task.taskId));
    } catch {
      sinkSend({ type: "error", reason: "upstream-error" });
      shutdown(1011, "upstream send failed");
      return;
    }

    const text = await waitResult();
    if (text) sinkSend({ type: "final", text });
    // 超时路径已经报过 error 并收摊了（closed=true）；空文本则只是没有 final
    if (closed) return;
    // 这条 task 是一次性的：关掉，为下一句预热新的连接
    closeUpstream();
    if (tearingDown) return;
    openUpstream();
  };

  /**
   * 等某个条件成立（带上限）：收尾阶段的等待都走这里，统一受收尾预算约束。
   */
  const waitFor = (predicate: () => boolean, deadline: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (predicate()) {
        resolve(true);
        return;
      }
      const tick = (): void => {
        if (predicate()) {
          resolve(true);
          return;
        }
        if (closed || tearingDown || Date.now() > deadline) {
          resolve(false);
          return;
        }
        setTimeout(tick, 20);
      };
      tick();
    });

  /**
   * **音频就绪的那一刻**才创建上游任务：等连接 open → 发 run-task → 等 task-started。
   *
   * 为什么不能在预热时就发 run-task：阿里的 task 一旦创建却迟迟收不到音频，
   * 几秒后就会被判 task-failed（实测真人说话 5.2s 的累积期里，预热的 task 直接失败）。
   * 连接（TCP/TLS/WS）可以提前建好省握手时间，**任务**不行。
   */
  const startTask = async (task: UpstreamTask, deadline: number): Promise<boolean> => {
    // 收尾预算覆盖「等连接 open + 发 run-task + 等 task-started」；
    // 留 30ms 余量，让等待**先于**收尾定时器放弃 → 结论明确且可复现。
    const waitDeadline = deadline - 30;
    if (!task.opened) {
      const opened = await waitFor(() => task.opened, waitDeadline);
      if (!opened) return false;
    }
    if (!task.runTaskSent) {
      task.runTaskSent = true;
      try {
        task.socket.send(aliRunTaskMessage(task.taskId, model));
      } catch {
        return false;
      }
    }
    return await waitFor(() => task.ready, waitDeadline);
  };

  /** 串行化收尾：同一时刻只跑一次 finalize，多的排队 */
  const runFinalize = async (reason: string, keep: boolean): Promise<void> => {
    if (closed) return;
    if (running) {
      // 已经在收尾：记下「还要再收一次」，并且「保留浏览器连接」的意图要保住
      queued = { reason, keep: keep || (queued?.keep ?? false) };
      return;
    }
    running = true;
    try {
      let next: { reason: string; keep: boolean } | null = { reason, keep };
      while (next !== null && !closed) {
        queued = null;
        await finalizeOnce(next.reason, next.keep);
        next = queued;
      }
    } finally {
      running = false;
    }
  };

  /**
   * 单句绝对时长兜底：到点强制收尾（给 final），不再等 `finish_utterance`。
   *
   * 注意这里**不是**用帧间隔猜句子边界（那是旧 bug）：只有绝对时长，
   * 与「帧间隔」无关，所以调度抖动不会把句子切坏。
   */
  const armUtteranceTimer = (): void => {
    if (utteranceTimer !== null) return;
    utteranceTimer = setTimeout(() => {
      utteranceTimer = null;
      void runFinalize("utterance-too-long", true);
    }, maxUtteranceMs);
  };

  // 会话级资源上限：同时存在的会话太多 → 明确失败，不静默
  if (activeSessions >= maxSessions) {
    log(`[stt:ali] too many sessions (${activeSessions})`);
    try {
      options.sink.sendText(JSON.stringify({ type: "error", reason: "too-many-sessions" }));
      options.sink.close(1013, "too many sessions");
    } catch {
      /* 浏览器侧可能已经关了 */
    }
    return {
      pushAudio() {},
      finishUtterance() {},
      clientClosed() {},
      get closed() {
        return true;
      },
      get lastUpstreamType() {
        return null;
      },
    };
  }
  activeSessions += 1;

  // 能力上报：客户端据此决定「能不能用 speech_started 做打断触发源」。
  // 阿里整段识别**不发** speech_started —— 我们上报「没有」，让客户端走 energy VAD，
  // **绝不伪造** speech_started（伪造比没有更糟：会在错误时机打断）。
  sinkSend({ type: "capabilities", provider: "ali", supportsSpeechStarted: false });

  // 预热：只把**连接**建起来（TCP/TLS/WS 的握手时间省掉）；
  // 任务（run-task）留到音频就绪时才创建 —— 见 startTask 的说明。
  openUpstream();

  return {
    pushAudio(data) {
      if (closed) return;
      frames += 1;
      const frame =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : typeof data === "string"
            ? new TextEncoder().encode(data)
            : data;
      const copy = frame.slice();
      bytes += copy.byteLength;

      // 资源上限（会话级）：原始输入
      if (rawBytes + copy.byteLength > ALI_MAX_AUDIO_BYTES) {
        sinkSend({ type: "error", reason: "audio-too-large" });
        shutdown(1009, "audio too large");
        return;
      }
      // 资源上限（会话级）：帧数
      frameCount += 1;
      if (frameCount > maxFrames) {
        sinkSend({ type: "error", reason: "too-many-frames" });
        shutdown(1009, "too many frames");
        return;
      }

      rawChunks.push(copy);
      rawBytes += copy.byteLength;

      // 注意：这里**不**起 ffmpeg，也**不**把字节喂进去。
      // 浏览器的 MediaRecorder 给的是 webm/opus 分块流（只有第一块带 EBML 头），
      // 边收边喂 ffmpeg 会让它的探测阶段直接失败（Invalid data found）→ 整句没转写。
      // 正确做法：攒完整段，收尾时一次性转码（阿里本来就是整段识别）。
      //
      // 句子边界只由显式 finish_utterance 决定；这里只挂绝对时长兜底
      armUtteranceTimer();
    },

    finishUtterance() {
      void runFinalize("utterance-end", true);
    },

    clientClosed() {
      // 客户端已经走了：立刻进入收尾态 —— **不再新建上游连接**
      tearingDown = true;
      void runFinalize("client-closed", false);
    },

    get closed() {
      return closed;
    },

    get lastUpstreamType() {
      return lastEvent;
    },
  };
}
