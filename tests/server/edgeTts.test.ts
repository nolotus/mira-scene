/**
 * Edge TTS CLI 适配层测试。
 *
 * 纪律：**不 spawn、不联网**。子进程用假 `EdgeSpawn`（可控退出码/error/不退出），
 * 临时目录是真的 —— 因为「文本走文件、读完删干净」正是要被验证的东西。
 *
 * 覆盖：超时 kill / 非 0 退出 / 退出 0 但无产物 / CLI 不存在 /
 *       并发 3 个只跑 2 个 / 排队超时干净失败 / 探测单飞 / 日志不含文本。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEdgeTtsSynthesizer,
  createSpawnEdgeRunner,
  type EdgeChild,
  type EdgeRunner,
  type EdgeSpawn,
} from "../../src/server/edgeTts.ts";

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 假子进程：只实现 EdgeChild 需要的那三个能力 */
class FakeChild {
  readonly exitCbs: Array<(code: number | null) => void> = [];
  readonly errorCbs: Array<(error: Error) => void> = [];
  readonly killSignals: string[] = [];
  /** 假 spawn 在退出前想记录的东西（例如文本文件内容） */
  seenText: string | null = null;

  constructor(
    readonly command: string,
    readonly argv: string[],
  ) {}

  on(event: string, listener: (value: never) => void): void {
    if (event === "exit") this.exitCbs.push(listener as unknown as (code: number | null) => void);
    else this.errorCbs.push(listener as unknown as (error: Error) => void);
  }

  kill(signal?: string): void {
    this.killSignals.push(signal ?? "SIGTERM");
  }

  exit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code);
  }

  fail(error: Error): void {
    for (const cb of this.errorCbs) cb(error);
  }
}

function argOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

let tmpRoot = "";

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "mira-etts-test-"));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("createSpawnEdgeRunner：CLI 调用形态", () => {
  test("文本走文件不进 argv；--voice/--rate/--pitch 都在；成功读回字节并清掉临时目录", async () => {
    const children: FakeChild[] = [];
    const dirsSeen: string[] = [];
    const spawnFn: EdgeSpawn = (command, argv) => {
      const child = new FakeChild(command, argv);
      children.push(child);
      const textPath = argOf(argv, "--file");
      const mediaPath = argOf(argv, "--write-media");
      expect(textPath).toBeDefined();
      expect(mediaPath).toBeDefined();
      dirsSeen.push(join(textPath!, ".."));
      // 假 spawn 顺手把「CLI 的产物」写出来，验证真实文件读取路径
      child.seenText = readFileSync(textPath!, "utf8");
      writeFileSync(mediaPath!, new Uint8Array([1, 2, 3, 4, 5]));
      setTimeout(() => child.exit(0), 0);
      return child as unknown as EdgeChild;
    };

    const runner = createSpawnEdgeRunner({ bin: "edge-tts", spawnFn, tmpRoot });
    const result = await runner({
      text: "外面还在下雨吗",
      voice: "zh-CN-XiaoxiaoNeural",
      rate: "-8%",
      pitch: "-3Hz",
      timeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5]);

    const argv = children[0]!.argv;
    expect(argv).toContain("--no-progress");
    expect(argOf(argv, "--voice")).toBe("zh-CN-XiaoxiaoNeural");
    expect(argOf(argv, "--rate")).toBe("-8%");
    expect(argOf(argv, "--pitch")).toBe("-3Hz");
    // 文本进了文件：argv 里任何一处都不许出现原文
    expect(argv.join(" ").includes("下雨")).toBe(false);
    expect(children[0]!.seenText).toBe("外面还在下雨吗");

    // 临时目录已清：文本与音频都不留在盘上
    const textPath = argOf(argv, "--file")!;
    const mediaPath = argOf(argv, "--write-media")!;
    expect(existsSync(textPath)).toBe(false);
    expect(existsSync(mediaPath)).toBe(false);
  });

  test("不退出 → 到点 SIGKILL，回 timeout", async () => {
    const children: FakeChild[] = [];
    const spawnFn: EdgeSpawn = (command, argv) => {
      const child = new FakeChild(command, argv);
      children.push(child);
      // 永不退出
      return child as unknown as EdgeChild;
    };
    const runner = createSpawnEdgeRunner({ bin: "edge-tts", spawnFn, tmpRoot });
    const result = await runner({
      text: "慢",
      voice: "v",
      rate: "+0%",
      pitch: "+0Hz",
      timeoutMs: 20,
    });
    expect(result).toEqual({ ok: false, kind: "timeout" });
    expect(children[0]!.killSignals).toContain("SIGKILL");
  });

  test("非 0 退出 → exit；退出 0 但没产物 → empty", async () => {
    const exitSpawn: EdgeSpawn = (command, argv) => {
      const child = new FakeChild(command, argv);
      setTimeout(() => child.exit(2), 0);
      return child as unknown as EdgeChild;
    };
    const failed = await createSpawnEdgeRunner({ bin: "e", spawnFn: exitSpawn, tmpRoot })({
      text: "x",
      voice: "v",
      rate: "+0%",
      pitch: "+0Hz",
      timeoutMs: 500,
    });
    expect(failed).toEqual({ ok: false, kind: "exit" });

    const emptySpawn: EdgeSpawn = (command, argv) => {
      const child = new FakeChild(command, argv);
      setTimeout(() => child.exit(0), 0); // 退出码 0，但 --write-media 的文件没生成
      return child as unknown as EdgeChild;
    };
    const empty = await createSpawnEdgeRunner({ bin: "e", spawnFn: emptySpawn, tmpRoot })({
      text: "x",
      voice: "v",
      rate: "+0%",
      pitch: "+0Hz",
      timeoutMs: 500,
    });
    expect(empty).toEqual({ ok: false, kind: "empty" });
  });

  test("CLI 不存在（error 事件）→ missing", async () => {
    const spawnFn: EdgeSpawn = (command, argv) => {
      const child = new FakeChild(command, argv);
      setTimeout(() => child.fail(new Error("spawn edge-tts ENOENT")), 0);
      return child as unknown as EdgeChild;
    };
    const result = await createSpawnEdgeRunner({ bin: "nope", spawnFn, tmpRoot })({
      text: "x",
      voice: "v",
      rate: "+0%",
      pitch: "+0Hz",
      timeoutMs: 500,
    });
    expect(result).toEqual({ ok: false, kind: "missing" });
  });
});

describe("createEdgeTtsSynthesizer：闸门与探测", () => {
  const okRunner = (bytes = 8): EdgeRunner => async () => ({
    ok: true,
    bytes: new Uint8Array(bytes),
  });

  test("探测未跑 → available=false，合成直接 tts-unavailable（不 spawn）", async () => {
    let runs = 0;
    const edge = createEdgeTtsSynthesizer({
      runner: async () => {
        runs += 1;
        return { ok: true, bytes: new Uint8Array(1) };
      },
      probeFn: async () => true,
    });
    expect(edge.available).toBe(false);
    expect(await edge.synthesize("你好")).toEqual({ ok: false, reason: "tts-unavailable" });
    expect(runs).toBe(0);
  });

  test("探测单飞：并发 3 次 probe 只探一次，结果缓存", async () => {
    let probes = 0;
    const edge = createEdgeTtsSynthesizer({
      runner: okRunner(),
      probeFn: async () => {
        probes += 1;
        await tick(5);
        return true;
      },
    });
    // 三次同步调用必须在同一个在飞 promise 上合流
    expect(await Promise.all([edge.probe(), edge.probe(), edge.probe()])).toEqual([true, true, true]);
    expect(probes).toBe(1);
    expect(edge.available).toBe(true);
    // 已缓存：再调一次不会再探
    await edge.probe();
    expect(probes).toBe(1);
  });

  test("并发 3 个请求：同时最多 2 个在跑，第 3 个排队后拿到名额", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const edge = createEdgeTtsSynthesizer({
      maxConcurrent: 2,
      probeFn: async () => true,
      runner: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve();
          });
        });
        return { ok: true, bytes: new Uint8Array(4) };
      },
    });
    await edge.probe();

    const inflight = [edge.synthesize("一"), edge.synthesize("二"), edge.synthesize("三")];
    await tick();
    // 前两个占满名额，第三个在排队
    expect(maxActive).toBe(2);
    expect(edge.stats).toEqual({ active: 2, queued: 1 });

    releases.shift()!();
    await tick();
    // 名额转交给排队者：active 仍是 2，排队清零
    expect(edge.stats).toEqual({ active: 2, queued: 0 });
    expect(maxActive).toBe(2);

    while (releases.length > 0) releases.shift()!();
    const results = await Promise.all(inflight);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxActive).toBe(2);
  });

  test("排队超时：干净失败，不无限挂", async () => {
    const edge = createEdgeTtsSynthesizer({
      maxConcurrent: 1,
      queueTimeoutMs: 20,
      probeFn: async () => true,
      runner: () => new Promise(() => undefined), // 永不返回
    });
    await edge.probe();
    void edge.synthesize("占住名额");
    await tick(5);
    expect(await edge.synthesize("排队者")).toEqual({ ok: false, reason: "tts-unavailable" });
  });

  test("失败类别对外一律映射成 tts-unavailable；日志只有 voice/字节数/耗时/类别，没有文本", async () => {
    const lines: string[] = [];
    const edge = createEdgeTtsSynthesizer({
      probeFn: async () => true,
      log: (line) => lines.push(line),
      runner: async () => ({ ok: false, kind: "timeout" }),
    });
    await edge.probe();
    await edge.synthesize("外面还在下雨吗");
    const all = lines.join("\n");
    expect(all.includes("下雨")).toBe(false);
    expect(all.includes("外面")).toBe(false);
    expect(all).toContain("kind=timeout");
  });

  test("成功日志只有 voice/字节数/耗时，没有文本", async () => {
    const lines: string[] = [];
    const edge = createEdgeTtsSynthesizer({
      probeFn: async () => true,
      log: (line) => lines.push(line),
      runner: okRunner(24),
    });
    await edge.probe();
    const result = await edge.synthesize("我在等一个人");
    expect(result.ok).toBe(true);
    const all = lines.join("\n");
    expect(all.includes("我在等一个人")).toBe(false);
    expect(all).toContain("bytes=24");
  });
});
