#!/usr/bin/env bun
/**
 * 一条命令起两个进程：vite(5173) + API 服务(8787)。
 *
 * 关键点：
 * - 任一进程退出，立刻清理另一个（否则 Ctrl-C 一次会留下孤儿 vite / 孤儿 server 占着端口）；
 * - SIGINT/SIGTERM 自己接管，转发给两个子进程，先 SIGTERM 优雅收，3 秒不退再 SIGKILL；
 * - 额外参数透传给 vite（例如 `bun run dev -- --open`）。
 */
import { spawn, type Subprocess } from "bun";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const viteArgs = process.argv.slice(2);

interface Child {
  name: string;
  proc: Subprocess<"inherit", "inherit", "inherit">;
}

const children: Child[] = [];

function launch(name: string, command: string[]): Child {
  const proc = spawn(command, {
    cwd: root,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  });
  return { name, proc };
}

let cleaning = false;

/** 先礼后兵地清场，绝不把子进程留成孤儿 */
async function cleanup(exitCode: number): Promise<never> {
  if (cleaning) {
    // 清理过程中再次被调用（例如连续两次 Ctrl-C）：直接硬退
    process.exit(exitCode);
  }
  cleaning = true;

  for (const child of children) {
    if (child.proc.exitCode === null) {
      try {
        child.proc.kill("SIGTERM");
      } catch {
        // 进程可能刚好自己退了
      }
    }
  }

  const deadline = Date.now() + 3000;
  while (children.some((child) => child.proc.exitCode === null) && Date.now() < deadline) {
    await Bun.sleep(50);
  }

  for (const child of children) {
    if (child.proc.exitCode === null) {
      try {
        child.proc.kill("SIGKILL");
      } catch {
        // 忽略
      }
    }
  }

  process.exit(exitCode);
}

const server = launch("server", [process.execPath, "run", join(root, "src", "server", "index.ts")]);
children.push(server);

const viteFileExists = await Bun.file(viteBin).exists();
if (!viteFileExists) {
  console.error(`[dev] 找不到 vite：${viteBin}（先 bun install）`);
  await cleanup(1);
}
children.push(launch("vite", [process.execPath, viteBin, ...viteArgs]));

console.log("[dev] server → http://localhost:8787   vite → http://localhost:5173");
console.log("[dev] Ctrl-C 会同时关掉两个进程");

const exits = children.map((child) =>
  child.proc.exited.then((code) => ({ source: child.name, code: code ?? 0 })),
);

const signalled = new Promise<{ source: string; code: number }>((resolve) => {
  process.once("SIGINT", () => resolve({ source: "SIGINT", code: 0 }));
  process.once("SIGTERM", () => resolve({ source: "SIGTERM", code: 0 }));
});

const finished = await Promise.race([...exits, signalled]);
if (finished.source !== "SIGINT" && finished.source !== "SIGTERM") {
  console.log(`[dev] ${finished.source} 已退出（code=${finished.code}），正在清理另一个进程…`);
}

await cleanup(finished.code);
