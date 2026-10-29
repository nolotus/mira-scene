/**
 * 素材预取 —— 只为消掉「第一次演出那一顿」，不抢首屏。
 *
 * 三条纪律（每条都对应一次真实的坏体验）：
 *   ① **load 之后**才启动，且再等 300ms（或 `requestIdleCallback`）。
 *      首屏 LCP 与字体/主图共用带宽，预取提前一步就是在和数据竞争。
 *   ② `navigator.connection.saveData` 为真时**整轮跳过**：省流模式的用户已经表态了。
 *   ③ 失败即降级：任何一张图失败只记一行诊断（含原因），绝不抛错、绝不阻塞渲染。
 *
 * 可观测：`prefetchLine()` 是一行人话（`预取：portrait ✓ / clip ✗（HTTP 404）`），
 * 同时写进 `document.documentElement.dataset.miraPrefetch` 与 `window.__miraPrefetch`，
 * 诊断面板与截图脚本读同一份快照 —— 不靠 console 里翻。
 */


/** 片段素材（spritesheet 是第一次暴雨演出卡顿的主要来源） */
export const CLIP_ASSET = "/clip/storm-strip.png";

export type PrefetchState = "pending" | "ok" | "fail" | "skipped";

export interface PrefetchEntry {
  /** 人读名字：portrait / eyes_open / clip … */
  name: string;
  url: string;
  state: PrefetchState;
  /** 相对 `navigationStart` 的发起时刻（ms） */
  startedAt: number;
  /** 相对 `navigationStart` 的完成时刻（ms，未完成时 null） */
  doneAt: number | null;
  /** 失败原因（人话，诊断里直接显示） */
  reason: string | null;
}

export interface PrefetchSnapshot {
  /** 是否整轮跳过（省流模式 / 无 window） */
  skipped: boolean;
  /** 跳过原因 */
  skipReason: string | null;
  /** 什么时候被调度起来的（ms，相对 navigationStart） */
  scheduledAt: number | null;
  /** 启动方式：idle 回调 / 定时器 */
  startedVia: "requestIdleCallback" | "timeout" | null;
  entries: readonly PrefetchEntry[];
}

/** 等待窗口：load 之后再留 300ms，给首屏渲染与字体让路 */
export const PREFETCH_DELAY_MS = 300;

/**
 * 预取清单：只剩片段。
 *
 * 照片级角色（`?char=photo`、定妆照 + 6 张眼/嘴贴片）已于 2026-10-29 整条删掉：
 * 写实人像 + 程序化嘴眼贴片掉进恐怖谷，观感问题不是调色/羽化能救的。
 * 现在角色只有 SVG 分层版，没有位图可预取。
 */
export function prefetchAssets(): Array<{ name: string; url: string }> {
  return [{ name: "clip", url: CLIP_ASSET }];
}

/**
 * 省流模式判定。显式 `saveData` 优先；`effectiveType` 为 2g 时也不预取
 * （预取在 2g 上不是「晚一点用」，而是「把当前这一页拖慢几十秒」）。
 */
export function shouldSkipPrefetch(connection: { saveData?: boolean; effectiveType?: string } | null | undefined): string | null {
  if (!connection) return null;
  if (connection.saveData) return "省流模式（saveData）";
  if (connection.effectiveType === "slow-2g" || connection.effectiveType === "2g") return `网络过慢（${connection.effectiveType}）`;
  return null;
}

/** 调度时刻：load 时刻 + 300ms（已经超过就不再多等） */
export function scheduleAt(loadAt: number): number {
  return loadAt + PREFETCH_DELAY_MS;
}

/** 一行人话摘要（诊断 / 截图脚本共用，保证两边说法一致） */
export function prefetchLine(snapshot: PrefetchSnapshot): string {
  if (snapshot.skipped) return `预取：跳过（${snapshot.skipReason ?? "未知原因"}）`;
  if (snapshot.entries.length === 0) return "预取：未开始";
  const parts = snapshot.entries.map((e) => {
    if (e.state === "ok") return `${e.name} ✓`;
    if (e.state === "fail") return `${e.name} ✗（${e.reason ?? "失败"}）`;
    if (e.state === "skipped") return `${e.name} —`;
    return `${e.name} …`;
  });
  const done = snapshot.entries.filter((e) => e.state === "ok").length;
  return `预取：${parts.join(" / ")}〔${done}/${snapshot.entries.length}，${snapshot.startedVia ?? "-"}〕`;
}

// ---------------------------------------------------------------- 运行时

type Loader = (url: string) => Promise<void>;

export interface PrefetchDeps {
  /** 当前时刻（ms，相对 navigationStart） */
  now?: () => number;
  /** 首页 load 发生的时刻；未 load 时传 null（调用方用 'load' 事件补上） */
  idle?: (cb: () => void) => void;
  connection?: { saveData?: boolean; effectiveType?: string } | null;
  loader?: Loader;
  /**
   * 清单覆盖（测试用）：默认 `prefetchAssets()`。
   * 为什么留这个口子：真实清单现在只有 1 项（照片素材删了），
   * 而「一张失败不影响其余」这种串行语义必须用 ≥2 项才测得出来。
   */
  assets?: ReadonlyArray<{ name: string; url: string }>;
}

let snapshot: PrefetchSnapshot = { skipped: false, skipReason: null, scheduledAt: null, startedVia: null, entries: [] };
const listeners = new Set<() => void>();
let started = false;

function emit(next: PrefetchSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
  if (typeof document !== "undefined") {
    try {
      document.documentElement.dataset.miraPrefetch = prefetchLine(next);
    } catch {
      // 忽略：dataset 写失败不影响预取本身
    }
  }
  if (typeof window !== "undefined") {
    (window as unknown as { __miraPrefetch?: unknown }).__miraPrefetch = next;
  }
}

export function prefetchSnapshot(): PrefetchSnapshot {
  return snapshot;
}

export function subscribePrefetch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 默认装载器：`new Image()` + `decode()`（decode 完成才是真的「能立刻画出来」） */
async function imageLoader(url: string): Promise<void> {
  if (typeof Image === "undefined") throw new Error("无 Image 构造器");
  const img = new Image();
  img.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("加载失败（404 / 解码错误）"));
  });
  img.src = url;
  await loaded;
  if (typeof img.decode === "function") {
    await img.decode().catch(() => {
      // decode 失败但 onload 成功：图能画，只是没法提前解码，不算预取失败
    });
  }
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return Math.round(performance.now());
  return 0;
}

/** 重置（测试用；正常渲染路径不会调） */
export function resetPrefetch(): void {
  started = false;
  snapshot = { skipped: false, skipReason: null, scheduledAt: null, startedVia: null, entries: [] };
  listeners.clear();
}

/**
 * 启动预取。**必须由调用方在 load 之后调用**（Stage 的 effect 在 mount 时挂 load 监听）。
 * 重复调用（StrictMode 双跑）只发一轮。
 */
export function startPrefetch(deps: PrefetchDeps = {}): void {
  if (started) return;
  started = true;
  const now = deps.now ?? nowMs;
  const connection =
    deps.connection ?? (typeof navigator !== "undefined" ? (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection ?? null : null);
  const skipReason = shouldSkipPrefetch(connection);
  const assets = deps.assets ?? prefetchAssets();
  const entries: PrefetchEntry[] = assets.map((a) => ({ name: a.name, url: a.url, state: "pending", startedAt: 0, doneAt: null, reason: null }));

  if (skipReason) {
    emit({ skipped: true, skipReason, scheduledAt: null, startedVia: null, entries: entries.map((e) => ({ ...e, state: "skipped" as const })) });
    return;
  }

  emit({ skipped: false, skipReason: null, scheduledAt: null, startedVia: null, entries });

  const run = () => {
    const startedAt = now();
    emit({ ...snapshot, scheduledAt: startedAt, entries: snapshot.entries });
    const loader = deps.loader ?? imageLoader;
    let i = 0;
    // 串行而不是并行：预取是「借空闲」，同时开 8 个请求就是抢带宽
    const next = (): void => {
      if (i >= entries.length) return;
      const entry = entries[i++]!;
      const at = now();
      entry.startedAt = at;
      entry.state = "pending";
      emit({ ...snapshot, entries: [...entries] });
      loader(entry.url)
        .then(() => {
          entry.state = "ok";
          entry.doneAt = now();
          entry.reason = null;
        })
        .catch((error: unknown) => {
          entry.state = "fail";
          entry.doneAt = now();
          entry.reason = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          emit({ ...snapshot, entries: [...entries] });
          next();
        });
    };
    next();
  };

  const via: "requestIdleCallback" | "timeout" = typeof window !== "undefined" && typeof window.requestIdleCallback === "function" ? "requestIdleCallback" : "timeout";
  const idle = deps.idle ?? ((cb: () => void) => {
    if (typeof window === "undefined") return;
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(cb, { timeout: 1200 });
    else window.setTimeout(cb, 0);
  });
  emit({ ...snapshot, startedVia: via });
  idle(run);
}

/** 在页面 load 之后 300ms 启动（比 load 早登记的调用方也能用） */
export function startPrefetchAfterLoad(deps: PrefetchDeps = {}): void {
  if (started) return;
  if (typeof window === "undefined") return;
  const launch = () => {
    const wait = Math.max(0, PREFETCH_DELAY_MS);
    window.setTimeout(() => {
      const idle: PrefetchDeps["idle"] =
        typeof window.requestIdleCallback === "function"
          ? (cb) => window.requestIdleCallback(cb, { timeout: 1200 })
          : (cb) => window.setTimeout(cb, 0);
      startPrefetch({ ...deps, idle });
    }, wait);
  };
  if (document.readyState === "complete") launch();
  else window.addEventListener("load", launch, { once: true });
}
