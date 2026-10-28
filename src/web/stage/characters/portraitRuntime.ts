/**
 * 照片角色的运行时装配：`?char=` 开关 / 素材装载 / 回退决策 / 诊断留痕。
 *
 * 三条硬性质（都对应「照片不可用」的现实，而不是假想故障）：
 *   ① 默认 SVG：不写 `char` 走的是既有渲染路径，一个字节都不变（三场景像素验收靠这条）。
 *   ② 任何一环出问题都**整体**回退 SVG，且只在诊断区留一行——不弹错、不白屏、不半张脸。
 *      单项变体缺失不算故障（眼睛没变体就露 portrait 原样），只有「spec / 定妆照」缺才算。
 *   ③ 装载单飞：React StrictMode 会把 effect 跑两遍，这里用模块级 promise 保证只发一轮请求。
 *
 * 素材全部同源（`/char/*`），不引入任何外部请求域；代码不生成图，只消费人生产好的图。
 */

import { useSyncExternalStore } from "react";
import {
  PORTRAIT_BASE_FILE,
  PORTRAIT_DIR,
  PORTRAIT_SPEC_FILE,
  allVariantFiles,
  parseSpecJson,
  parsePortraitSpec,
  portraitUrl,
  type PortraitSpec,
  type PortraitSpecIssue,
} from "./portraitSpec";

// ---------------------------------------------------------------- ?char= 开关

export type CharMode = "svg" | "photo";

export interface CharFlag {
  mode: CharMode;
  /** 原始取值（null = 没写这个参数） */
  raw: string | null;
  /** 认得的取值：未知值不静默当 photo 用，也不假装没写过 */
  recognized: boolean;
}

const PHOTO_TOKENS = new Set(["photo", "1", "on", "true", "png", "raster"]);
const SVG_TOKENS = new Set(["", "svg", "0", "off", "false", "no", "vector"]);

/**
 * `?char=photo` 才启用照片；默认（空 / svg / 关值）仍是 SVG。
 * 未知取值 → SVG 且 `recognized: false`（诊断区会写一行「未知取值」，不静默吞掉）。
 */
export function parseCharFlag(search: string): CharFlag {
  const raw = new URLSearchParams(search).get("char");
  if (raw === null) return { mode: "svg", raw: null, recognized: true };
  const value = raw.trim().toLowerCase();
  if (PHOTO_TOKENS.has(value)) return { mode: "photo", raw, recognized: true };
  if (SVG_TOKENS.has(value)) return { mode: "svg", raw, recognized: true };
  return { mode: "svg", raw, recognized: false };
}

/** 从 location.search 读（SSR / 无 window 时按 SVG） */
export function readCharFlag(): CharFlag {
  if (typeof window === "undefined") return { mode: "svg", raw: null, recognized: true };
  return parseCharFlag(window.location.search);
}

// ---------------------------------------------------------------- 回退决策

/** 回退原因：同时也是诊断文案的键，不允许出现「未分类」的静默回退 */
export type PortraitFallbackReason =
  | "flag_off"
  | "loading"
  | "spec_missing"
  | "spec_invalid"
  | "version_mismatch"
  | "portrait_missing"
  | "portrait_load_failed";

export type PortraitAssetFile = string;

export type PortraitResource =
  | { phase: "idle" }
  | { phase: "loading" }
  | {
      phase: "ready";
      spec: PortraitSpec;
      /** 实际能用的变体文件（portrait.png 永远在内） */
      assets: readonly PortraitAssetFile[];
    }
  | { phase: "failed"; reason: Exclude<PortraitFallbackReason, "flag_off" | "loading">; detail: string };

export interface PortraitDecision {
  mode: CharMode;
  reason: PortraitFallbackReason | null;
  /** 原因的人话解释（诊断区 title 用） */
  detail: string;
}

const SPEC_ISSUE_TO_REASON: Record<PortraitSpecIssue, Exclude<PortraitFallbackReason, "flag_off" | "loading">> = {
  empty: "spec_missing",
  not_json: "spec_invalid",
  not_object: "spec_invalid",
  bad_version: "spec_invalid",
  version_mismatch: "version_mismatch",
  bad_size: "spec_invalid",
  bad_anchor: "spec_invalid",
  bad_region: "spec_invalid",
};

/** spec 解析问题 → 回退原因（版本不匹配单独一档，因为那是「素材和代码不同代」） */
export function reasonOfSpecIssue(issue: PortraitSpecIssue): Exclude<PortraitFallbackReason, "flag_off" | "loading"> {
  return SPEC_ISSUE_TO_REASON[issue] ?? "spec_invalid";
}

/**
 * 回退决策（纯函数）：只有「开关打开 + 素材就绪」才走照片。
 * 装载中先渲染 SVG —— 照片通常比首屏晚到几十毫秒，宁可见到角色，也不要白屏或半个框。
 */
export function decidePortraitMode(input: { mode: CharMode; resource: PortraitResource }): PortraitDecision {
  if (input.mode !== "photo") {
    return { mode: "svg", reason: "flag_off", detail: "未开启 ?char=photo，走既有 SVG 渲染" };
  }
  const resource = input.resource;
  switch (resource.phase) {
    case "ready":
      return { mode: "photo", reason: null, detail: "照片素材就绪" };
    case "failed":
      return { mode: "svg", reason: resource.reason, detail: resource.detail };
    case "loading":
      return { mode: "svg", reason: "loading", detail: "照片素材装载中，先渲染 SVG" };
    case "idle":
    default:
      return { mode: "svg", reason: "loading", detail: "照片素材尚未请求，先渲染 SVG" };
  }
}

// ---------------------------------------------------------------- 诊断留痕

export type PortraitTone = "info" | "warn";

export interface PortraitDiagRecord {
  id: number;
  at: number;
  tone: PortraitTone;
  mode: CharMode;
  reason: PortraitFallbackReason | null;
  detail: string;
}

/** 诊断区只显示「一行」：同 (mode, reason) 的重复记录合并，避免一次重渲染刷出多行 */
const MAX_RECORDS = 4;

let records: readonly PortraitDiagRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function reportPortraitDiag(record: {
  mode: CharMode;
  reason: PortraitFallbackReason | null;
  detail: string;
  tone?: PortraitTone;
  at?: number;
}): void {
  const last = records[records.length - 1];
  if (last && last.mode === record.mode && last.reason === record.reason && last.detail === record.detail) {
    return;
  }
  const entry: PortraitDiagRecord = {
    id: nextId++,
    at: record.at ?? Date.now(),
    tone: record.tone ?? (record.mode === "photo" ? "info" : "warn"),
    mode: record.mode,
    reason: record.reason,
    detail: record.detail,
  };
  records = [...records, entry].slice(-MAX_RECORDS);
  emit();
}

export function latestPortraitDiag(list = records): PortraitDiagRecord | null {
  return list.length > 0 ? list[list.length - 1]! : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 诊断面板读的最新一条（null = 从没跑过 / 开关关着） */
export function usePortraitDiag(): PortraitDiagRecord | null {
  const list = useSyncExternalStore(
    subscribe,
    () => records,
    () => records,
  );
  return latestPortraitDiag(list);
}

export function usePortraitRecords(): readonly PortraitDiagRecord[] {
  return useSyncExternalStore(
    subscribe,
    () => records,
    () => records,
  );
}

// ---------------------------------------------------------------- 装载

export interface PortraitLoadDeps {
  fetchImpl?: typeof fetch;
  /** 图片探测（默认用 Image 标签；无 DOM 环境返回 false） */
  probeImage?: (url: string) => Promise<boolean>;
  base?: string;
}

let resource: PortraitResource = { phase: "idle" };
const resourceListeners = new Set<() => void>();

function setResource(next: PortraitResource): void {
  resource = next;
  for (const listener of [...resourceListeners]) listener();
}

function failPortrait(
  reason: Exclude<PortraitFallbackReason, "flag_off" | "loading">,
  detail: string,
): PortraitResource {
  const failed: PortraitResource = { phase: "failed", reason, detail };
  setResource(failed);
  reportPortraitDiag({ mode: "svg", reason, detail });
  return failed;
}

export function getPortraitResource(): PortraitResource {
  return resource;
}

/** 仅供测试 / 演示复位 */
export function resetPortraitResource(): void {
  resource = { phase: "idle" };
  inFlight = null;
  records = [];
  nextId = 1;
  emit();
  for (const listener of [...resourceListeners]) listener();
}

/** 用 <img> 探测而不是 fetch：既能触发浏览器缓存，又天然覆盖「文件在但解不出来」的情况 */
export function probeImageWithTag(url: string): Promise<boolean> {
  if (typeof window === "undefined" || typeof window.Image !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new window.Image();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });
}

let inFlight: Promise<PortraitResource> | null = null;

/**
 * 装载素材（单飞）。顺序刻意是「先 spec 后图」：
 * spec 是唯一的定位依据，spec 不通就没必要把几 MB 的图拖下来。
 */
export async function loadPortraitAssets(deps: PortraitLoadDeps = {}): Promise<PortraitResource> {
  const base = deps.base ?? PORTRAIT_DIR;
  const fetchImpl = deps.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  const probe = deps.probeImage ?? probeImageWithTag;

  if (!fetchImpl) {
    return failPortrait("spec_missing", "当前环境没有 fetch，无法读取 /char/spec.json → 回退 SVG");
  }

  setResource({ phase: "loading" });

  const specUrl = portraitUrl(PORTRAIT_SPEC_FILE, base);
  let specText: string;
  try {
    const res = await fetchImpl(specUrl, { cache: "no-cache" });
    if (!res.ok) {
      return failPortrait("spec_missing", `${specUrl} 取不到（HTTP ${res.status}）→ 回退 SVG`);
    }
    specText = await res.text();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return failPortrait("spec_missing", `${specUrl} 请求失败（${why}）→ 回退 SVG`);
  }

  const parsed = parseSpecJson(specText);
  if (!parsed.ok) {
    return failPortrait(reasonOfSpecIssue(parsed.issue), `spec.json 不可用：${parsed.detail} → 回退 SVG`);
  }

  const portraitOk = await probe(portraitUrl(PORTRAIT_BASE_FILE, base));
  if (!portraitOk) {
    return failPortrait(
      "portrait_load_failed",
      `${portraitUrl(PORTRAIT_BASE_FILE, base)} 加载失败（缺失或解码失败）→ 回退 SVG`,
    );
  }

  // 变体是可选的：逐个探测，缺谁就少一层（眼睛没有变体就露 portrait 原样）
  const variantResults = await Promise.all(
    allVariantFiles().map(async (file) => ({ file, ok: await probe(portraitUrl(file, base)) })),
  );
  const assets = [PORTRAIT_BASE_FILE, ...variantResults.filter((r) => r.ok).map((r) => r.file)];
  const missing = variantResults.filter((r) => !r.ok).map((r) => r.file);

  const ready: PortraitResource = { phase: "ready", spec: parsed.spec, assets };
  setResource(ready);
  reportPortraitDiag({
    mode: "photo",
    reason: null,
    detail:
      `照片角色就绪：portrait.png + ${assets.length - 1} 个变体` +
      (missing.length > 0 ? `（缺 ${missing.join("、")}，该部位用定妆照原样）` : ""),
  });
  return ready;
}

/** 单飞：StrictMode 双跑 effect 也只发一轮请求 */
export function ensurePortraitAssets(deps: PortraitLoadDeps = {}): Promise<PortraitResource> {
  if (resource.phase === "ready" || resource.phase === "failed") return Promise.resolve(resource);
  if (inFlight) return inFlight;
  inFlight = loadPortraitAssets(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function usePortraitResource(): PortraitResource {
  return useSyncExternalStore(
    (listener) => {
      resourceListeners.add(listener);
      return () => {
        resourceListeners.delete(listener);
      };
    },
    () => resource,
    () => resource,
  );
}

/** 素材里是否真有这个文件（渲染层逐层判断用） */
export function hasAsset(resourceRes: PortraitResource, file: string): boolean {
  return resourceRes.phase === "ready" && resourceRes.assets.includes(file);
}

/** spec 解析结果直接喂给决策（测试里方便构造） */
export function resourceFromSpec(raw: unknown, assets: readonly string[] = [PORTRAIT_BASE_FILE]): PortraitResource {
  const parsed = parsePortraitSpec(raw);
  if (!parsed.ok) {
    return {
      phase: "failed",
      reason: reasonOfSpecIssue(parsed.issue),
      detail: `spec 不可用：${parsed.detail} → 回退 SVG`,
    };
  }
  return { phase: "ready", spec: parsed.spec, assets };
}
