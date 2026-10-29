/**
 * Edge TTS：中文语音合成的实际来源（Deepgram Aura 只有英语，没有中文音色）。
 *
 * 为什么是 CLI 而不是 HTTP：
 * Edge 的语音服务是 `wss://speech.platform.bing.com` 上的私有协议，请求里要带一个
 * 由 `Sec-MS-GEC` 算法生成的 token。本地已装 `edge-tts`（Python 包）替我们处理了这件事，
 * 所以这一层就是「调一个本地命令」。代价写在报告里：依赖 python + 该包、非官方接口、每句 1.7–2.0s。
 *
 * 四条硬约束（都是单测钉住的）：
 *  1. **CLI 不存在 / 超时 / 非 0 退出** → 干净失败（`tts-unavailable`），绝不 500、绝不空音频。
 *  2. **同时最多 2 个 CLI 进程**，多出来的排队；排队超时也是干净失败（不无限挂着）。
 *  3. **文本与音频绝不进日志**：日志只有 voice / 字节数 / 耗时 / 失败类别。
 *  4. 文本走**文件**而不是 argv：`ps` 里同机其他用户能看到命令行参数，看不到临时文件内容。
 *
 * 探测要轻：`--version` 只跑一次、结果缓存（单飞），每次请求都探会把延迟和进程数都搞坏。
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHARACTER_VOICE } from "../shared/characterVoice.ts";

export const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
export const DEFAULT_EDGE_BIN = "edge-tts";
/** 单句合成的上限：实测 1.7–2.0s，6s 已经是很宽的余量 */
export const EDGE_TIMEOUT_MS = 6_000;
/** 排队上限：两个进程在跑时第 3 个最多等这么久 */
export const EDGE_QUEUE_TIMEOUT_MS = 10_000;
export const MAX_EDGE_CONCURRENT = 2;
/** 探测的上限：`--version` 正常是百毫秒级，超时即当不可用 */
export const EDGE_PROBE_TIMEOUT_MS = 2_000;

/**
 * 失败类别。对外**只映射成 `tts-unavailable`**（客户端据此回退浏览器 TTS），
 * 分类只为了日志与单测能分辨「没装 / 超时 / 崩了 / 空输出」。
 */
export type EdgeFailureKind = "missing" | "timeout" | "exit" | "empty";

export interface EdgeJob {
  text: string;
  voice: string;
  /** Edge 语速，带符号百分比（`-8%`） */
  rate: string;
  /** Edge 音高，带符号 Hz（`-3Hz`） */
  pitch: string;
  timeoutMs: number;
}

export type EdgeRunResult = { ok: true; bytes: Uint8Array } | { ok: false; kind: EdgeFailureKind };

/** 真正跑一次 CLI 的东西；测试注入假实现（不 spawn、不联网） */
export type EdgeRunner = (job: EdgeJob) => Promise<EdgeRunResult>;

export type EdgeTtsResult =
  | { ok: true; bytes: Uint8Array; mime: "audio/mpeg" }
  | { ok: false; reason: "tts-unavailable" };

// ---------------------------------------------------------------- 子进程抽象

/**
 * 只需要这三个能力：等一下退出码 / 收 error（ENOENT 走它）/ 到点能杀。
 * 收窄成接口是为了让测试塞一个假 child，而不是真的起进程。
 */
export interface EdgeChild {
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: string): void;
}

export type EdgeSpawn = (command: string, args: string[]) => EdgeChild;

type ChildOutcome = { ok: true } | { ok: false; kind: EdgeFailureKind };

/** 等退出码，超时就 SIGKILL。ENOENT（没装）走 error 事件。 */
function runChild(
  spawnFn: EdgeSpawn,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(outcome);
    };

    let child: EdgeChild;
    try {
      child = spawnFn(command, args);
    } catch {
      settle({ ok: false, kind: "missing" });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经退出：kill 会抛，忽略 */
      }
      settle({ ok: false, kind: "timeout" });
    }, timeoutMs);

    child.on("error", () => settle({ ok: false, kind: "missing" }));
    child.on("exit", (code) => settle(code === 0 ? { ok: true } : { ok: false, kind: "exit" }));
  });
}

export interface SpawnEdgeRunnerOptions {
  /** CLI 路径（`ETTS_BIN`，默认 `edge-tts`） */
  bin: string;
  /** 测试注入：假 spawn（不真起进程） */
  spawnFn?: EdgeSpawn;
  /** 临时目录根；默认系统 tmp */
  tmpRoot?: string;
}

const defaultSpawn: EdgeSpawn = (command, args) =>
  spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] }) as unknown as EdgeChild;

/**
 * 生产用 runner：临时目录 → 写文本文件 → 调 CLI 合成到临时 mp3 → 读回字节 → 清目录。
 * 目录用 `mkdtemp`（权限 0700），文本文件 0600，`finally` 里一定删干净。
 */
export function createSpawnEdgeRunner(options: SpawnEdgeRunnerOptions): EdgeRunner {
  const bin = options.bin;
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const tmpRoot = options.tmpRoot;
  return async (job) => {
    let dir: string;
    try {
      dir = await mkdtemp(join(tmpRoot ?? tmpdir(), "mira-etts-"));
    } catch {
      return { ok: false, kind: "missing" };
    }
    try {
      const textPath = join(dir, "in.txt");
      const mediaPath = join(dir, "out.mp3");
      // 文本走文件：既能避开 argv 泄露，也绕开 shell 转义/长度问题
      await writeFile(textPath, job.text, { mode: 0o600 });
      const args = [
        "--file",
        textPath,
        "--write-media",
        mediaPath,
        // 进度条会写 stderr；这里不需要任何多余输出
        "--no-progress",
      ];
      if (job.voice) args.push("--voice", job.voice);
      // 角色音色的两个参数：`--rate +0%` / `--pitch +0Hz` 是 CLI 的既有形态（--help 实测）
      if (job.rate) args.push("--rate", job.rate);
      if (job.pitch) args.push("--pitch", job.pitch);

      const outcome = await runChild(spawnFn, bin, args, job.timeoutMs);
      if (!outcome.ok) return outcome;

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(mediaPath));
      } catch {
        // 退出码 0 但没产出文件：同样算不可用，绝不回空音频
        return { ok: false, kind: "empty" };
      }
      return bytes.byteLength > 0 ? { ok: true, bytes } : { ok: false, kind: "empty" };
    } catch {
      return { ok: false, kind: "exit" };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

// ---------------------------------------------------------------- 合成器（闸门 + 缓存前置的可用性）

export interface EdgeTtsSynthesizerOptions {
  runner?: EdgeRunner;
  bin?: string;
  voice?: string;
  /** 角色语速（`EDGE_TTS_RATE`，默认取角色档案） */
  rate?: string;
  /** 角色音高（`EDGE_TTS_PITCH`，默认取角色档案） */
  pitch?: string;
  maxConcurrent?: number;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  /** 测试注入探测（生产用 `--version`） */
  probeFn?: () => Promise<boolean>;
  /** 只喂 voice / 字节数 / 耗时 / 失败类别，绝不喂文本 */
  log?: (line: string) => void;
}

export interface EdgeTtsStats {
  active: number;
  queued: number;
}

export interface EdgeTtsSynthesizer {
  readonly bin: string;
  readonly voice: string;
  /** 生效的角色语速/音高（诊断与缓存键要用） */
  readonly rate: string;
  readonly pitch: string;
  /** 最近一次探测的结论；没探测过 = false（宁可回退浏览器，也不假装可用） */
  readonly available: boolean;
  /** 轻探测：单飞，只跑一次，结果缓存 */
  probe(): Promise<boolean>;
  synthesize(text: string): Promise<EdgeTtsResult>;
  readonly stats: EdgeTtsStats;
}

interface Waiter {
  grant(): void;
  timer: ReturnType<typeof setTimeout>;
}

function defaultProbe(bin: string, spawnFn: EdgeSpawn): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: EdgeChild;
    try {
      child = spawnFn(bin, ["--version"]);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      resolve(false);
    }, EDGE_PROBE_TIMEOUT_MS);
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      resolve(value);
    };
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

export function createEdgeTtsSynthesizer(
  options: EdgeTtsSynthesizerOptions = {},
): EdgeTtsSynthesizer {
  const bin = options.bin?.trim() || DEFAULT_EDGE_BIN;
  const voice = options.voice?.trim() || DEFAULT_EDGE_VOICE;
  // 语速/音高缺省跟随角色档案：调用方不传时也保持「角色感」，而不是 CLI 的播报默认
  const rate = options.rate?.trim() || CHARACTER_VOICE.rate;
  const pitch = options.pitch?.trim() || CHARACTER_VOICE.pitch;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? MAX_EDGE_CONCURRENT);
  const timeoutMs = options.timeoutMs ?? EDGE_TIMEOUT_MS;
  const queueTimeoutMs = options.queueTimeoutMs ?? EDGE_QUEUE_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const runner = options.runner ?? createSpawnEdgeRunner({ bin });
  const probeFn = options.probeFn ?? (() => defaultProbe(bin, defaultSpawn));

  let available = false;
  let probed = false;
  let probing: Promise<boolean> | null = null;
  let active = 0;
  const waiting: Waiter[] = [];

  /** 拿一个名额；排队超时回 false（调用方据此干净失败） */
  function acquire(): Promise<boolean> {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          resolve(true);
        },
        timer: setTimeout(() => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          // 名额没拿到：active 不变，不需要 release
          resolve(false);
        }, queueTimeoutMs),
      };
      waiting.push(waiter);
    });
  }

  function release(): void {
    const next = waiting.shift();
    if (next) {
      // 名额直接转交：active 数量不变，避免「先降后升」的窗口
      next.grant();
      return;
    }
    active = Math.max(0, active - 1);
  }

  return {
    bin,
    voice,
    rate,
    pitch,

    get available() {
      return available;
    },

    get stats(): EdgeTtsStats {
      return { active, queued: waiting.length };
    },

    probe(): Promise<boolean> {
      if (probing) return probing;
      // 结论常驻：探测只跑一次（`--version` 一次就够，每次请求都探会把延迟和进程数搞坏）。
      // 代价是装/卸 CLI 之后要重启服务才生效 —— 与「启动时探测一次」的语义一致。
      if (probed) return Promise.resolve(available);
      probing = probeFn().then((ok) => {
        available = ok;
        probed = true;
        probing = null;
        log(`[tts:edge] probe bin=${bin} available=${ok ? "yes" : "no"}`);
        return ok;
      });
      return probing;
    },

    async synthesize(text: string): Promise<EdgeTtsResult> {
      if (!available) return { ok: false, reason: "tts-unavailable" };

      const granted = await acquire();
      if (!granted) {
        log(`[tts:edge] queue-timeout voice=${voice}`);
        return { ok: false, reason: "tts-unavailable" };
      }

      const started = performance.now();
      try {
        const attempt = () => runner({ text, voice, rate, pitch, timeoutMs });
        let result = await attempt();
        // 首次调用偶发失败：线上实测 `[tts:edge] fail kind=exit ... 1656ms`，
        // 紧接着同样的请求就成功（12:51:38 失败 → 12:51:50 正常出音频）。
        // 代价只是一次进程启动，收益是消掉「开场第一句没声音」这种最刺眼的失败。
        if (!result.ok) {
          log(`[tts:edge] retry after kind=${result.kind} voice=${voice}`);
          result = await attempt();
        }
        const ms = Math.round(performance.now() - started);
        if (!result.ok) {
          // 只有类别，没有文本、没有 stderr 原文
          log(`[tts:edge] fail kind=${result.kind} voice=${voice} ${ms}ms`);
          return { ok: false, reason: "tts-unavailable" };
        }
        log(`[tts:edge] voice=${voice} bytes=${result.bytes.byteLength} ${ms}ms`);
        return { ok: true, bytes: result.bytes, mime: "audio/mpeg" };
      } catch {
        log(`[tts:edge] fail kind=exit voice=${voice}`);
        return { ok: false, reason: "tts-unavailable" };
      } finally {
        release();
      }
    },
  };
}
