/**
 * 流式产出的公共小工具：分片 + 可打断的等待。
 * Mock 导演与真模型导演共用同一套节奏，客户端不需要区分两者。
 */

/** 分片长度循环：每片 2–6 字，节奏不均才像真人说话 */
const CHUNK_SIZES = [4, 2, 6, 3, 5, 2, 6, 4] as const;

/** 断句点：在这些字符后断开更像自然的呼吸 */
const SOFT_BREAK: ReadonlySet<string> = new Set([
  "，",
  "。",
  "？",
  "！",
  "、",
  "…",
  "—",
  "：",
  "；",
  " ",
  "“",
  "”",
]);

/** 片间间隔循环（毫秒），均值落在 40–70ms 区间 */
export const CHUNK_DELAYS = [46, 58, 52, 68, 44, 62] as const;

/**
 * 把一段台词切成 2–6 字的小片。
 * 纯函数、确定性：同一段文本永远得到同一组切片（可回放、可测试）。
 */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const pieces: string[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < clean.length) {
    const size = CHUNK_SIZES[index % CHUNK_SIZES.length] ?? 4;
    index += 1;
    let end = Math.min(clean.length, cursor + size);

    // 优先在标点后断开，但不切出 1 字碎屑
    for (let probe = cursor + 1; probe < end; probe += 1) {
      const char = clean[probe] ?? "";
      if (SOFT_BREAK.has(char) && probe + 1 - cursor >= 2) {
        end = probe + 1;
        break;
      }
    }

    // 末尾只剩 1 个字时调整本片边界，保证每一片都落在 2–6 字
    if (clean.length - end === 1) {
      end = end - cursor >= 3 ? end - 1 : Math.min(clean.length, end + 1);
    }

    pieces.push(clean.slice(cursor, end));
    cursor = end;
  }

  return pieces;
}

/**
 * 可打断的等待：signal 中止后立刻 resolve（而不是抛错），
 * 让调用方在每个 await 之后统一检查 aborted 并干净返回。
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, Math.max(0, Math.round(ms)));
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** 按序号取片间间隔，配合 delayScale 做整体加速/减速 */
export function delayFor(index: number, scale: number): number {
  const base = CHUNK_DELAYS[index % CHUNK_DELAYS.length] ?? 50;
  return Math.round(base * Math.max(0, scale));
}
