/**
 * 插图的本地缓存：localStorage，按 prompt 键，1 天过期。
 *
 * 键为什么是 prompt 原文而不是 beatId：**同一张图 = 同一段 prompt**。
 * 服务端用 sha256(prompt) 做进程内缓存，客户端用 prompt 本身做本地键 ——
 * 两边由 shared/illustrate.ts 的同一个纯函数产生，所以「用户在本地已经有一张」和
 * 「服务端算过这张」永远指向同一段文本，不会出现两套命名各自漂移。
 *
 * 所有 storage 访问都包在 try/catch 里：Safari 无痕模式下 setItem 会抛配额错误，
 * 那不该影响插图本身的显示（拿不到缓存就当没有缓存）。
 */

export const ILLUSTRATION_CACHE_PREFIX = "mira.illustration:";
/** 1 天：同一天内反复点同一幕不重复烧钱，跨天自然失效 */
export const ILLUSTRATION_TTL_MS = 24 * 60 * 60 * 1000;

/** 结构化的 Storage 子集：测试可以塞一个 Map 实现，不依赖真 localStorage */
export interface IllustrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface IllustrationCache {
  get(prompt: string): string | null;
  set(prompt: string, dataUrl: string): void;
}

interface CacheEntry {
  v: 1;
  at: number;
  dataUrl: string;
}

/** 浏览器里取 localStorage；SSR / 不可用时返回 null（调用方按「无缓存」处理） */
export function defaultIllustrationStorage(): IllustrationStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function createIllustrationCache(options: {
  storage?: IllustrationStorage | null;
  now?: () => number;
  ttlMs?: number;
} = {}): IllustrationCache {
  const storage = options.storage === undefined ? defaultIllustrationStorage() : options.storage;
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? ILLUSTRATION_TTL_MS;

  return {
    get(prompt: string): string | null {
      if (!storage) return null;
      const key = ILLUSTRATION_CACHE_PREFIX + prompt;
      try {
        const raw = storage.getItem(key);
        if (raw === null) return null;
        const entry = JSON.parse(raw) as Partial<CacheEntry>;
        if (entry?.v !== 1 || typeof entry.dataUrl !== "string" || typeof entry.at !== "number") {
          storage.removeItem(key);
          return null;
        }
        if (now() - entry.at > ttlMs) {
          // 过期即删：不留在磁盘上占位，也不会被下一次读当成命中
          storage.removeItem(key);
          return null;
        }
        return entry.dataUrl;
      } catch {
        return null;
      }
    },

    set(prompt: string, dataUrl: string): void {
      if (!storage) return;
      const entry: CacheEntry = { v: 1, at: now(), dataUrl };
      try {
        storage.setItem(ILLUSTRATION_CACHE_PREFIX + prompt, JSON.stringify(entry));
      } catch {
        // 配额满 / 隐私模式：缓存写不进去不是错误，本会话只是少一次复用
      }
    },
  };
}
