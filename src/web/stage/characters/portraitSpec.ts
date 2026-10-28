/**
 * 照片级角色（portrait）的**素材契约**——纯数据，没有 DOM、没有网络。
 *
 * 为什么身份只能靠「同一张图 + 只改局部」：用参考图重生成整张脸（flux-2-dev 的 multipart）
 * 实测保造型不保脸——同一张定妆照生成三张是三个人，换装还会丢。所以照片方案的全部身份
 * 都来自 `portrait.png` 这一张；表情只允许「眼睛 / 嘴巴这两个矩形区域」由 inpainting 变体
 * 覆盖，其余像素一个都不动。
 *
 * 目录结构（全部由人生产后放进 `public/char/`，代码不生成任何图）：
 *
 *   /char/portrait.png       定妆照：已抠图、透明背景、胸像裁切（**唯一必需文件**）
 *   /char/eyes_open.png      眼区域变体（可选；缺了就用 portrait 原样）
 *   /char/eyes_half.png
 *   /char/eyes_closed.png
 *   /char/mouth_closed.png   嘴区域变体（可选）
 *   /char/mouth_half.png
 *   /char/mouth_open.png
 *   /char/spec.json          { version, size, source, anchor, region? }
 *
 * 每个变体 PNG 的**画布就是这个矩形本身**（不是整张定妆照），渲染层按 anchor 算出的
 * 归一化矩形把它贴回原位，所以换一张 1024×1536 或 2048×3072 的定妆照都不用改代码。
 *
 * `anchor` 是归一化坐标（0..1，相对 portrait 画布左上角）：
 *   · `eyeL` / `eyeR`：**左右眼球中心**。两点连线给出眼区域补丁的横向范围
 *     （外扩 `region.eye.padX`），纵向范围取两点 y 的中点（高度 `region.eye.height`）。
 *   · `mouth`：**嘴唇中心**（闭合状态下的唇缝中点）。补丁以它为中心，
 *     大小由 `region.mouth.width/height` 决定。
 *   · `region` 可省略，省略时用下面 `DEFAULT_REGION` 的默认值。
 *
 * 语义都是「相对画布的比例」，所以标定方法很简单（见 README 之外的交付说明）：
 * 在 PS/Figma 里量出像素坐标再除以画布宽高即可。
 */

/** 素材根目录（同源静态资源，不引入任何外部请求域） */
export const PORTRAIT_DIR = "/char";
export const PORTRAIT_SPEC_FILE = "spec.json";
export const PORTRAIT_BASE_FILE = "portrait.png";

/**
 * 契约版本。素材侧（spec.json 的 `version`）与代码侧必须**严格相等**：
 * 不等就整体回退 SVG，不做兼容猜测——猜错的代价是嘴贴在额头上。
 */
export const PORTRAIT_VERSION = 1;

/** 眼变体：睁 / 半 / 闭（顺序即优先级，渲染层按这个顺序叠放） */
export const EYE_VARIANTS = ["open", "half", "closed"] as const;
/** 嘴变体：闭 / 半开 / 张开 */
export const MOUTH_VARIANTS = ["closed", "half", "open"] as const;

export type PortraitPart = "eyes" | "mouth";
export type EyeVariant = (typeof EYE_VARIANTS)[number];
export type MouthVariant = (typeof MOUTH_VARIANTS)[number];

/** 变体名 → 文件名（`eyes` + `half` → `eyes_half.png`） */
export function variantFile(part: PortraitPart, variant: string): string {
  return `${part}_${variant}.png`;
}

/** 某一部分的全部可选文件（顺序稳定，渲染层与诊断都按它遍历） */
export function variantFiles(part: PortraitPart): string[] {
  const list = part === "eyes" ? EYE_VARIANTS : MOUTH_VARIANTS;
  return list.map((v) => variantFile(part, v));
}

/** 全部可选变体文件（不含必需的 portrait.png / spec.json） */
export function allVariantFiles(): string[] {
  return [...variantFiles("eyes"), ...variantFiles("mouth")];
}

// ---------------------------------------------------------------- 数据形状

export interface PortraitSize {
  /** portrait.png 的像素宽（>0 的有限数） */
  w: number;
  /** portrait.png 的像素高 */
  h: number;
}

/** 归一化坐标点（0..1，相对 portrait 画布） */
export interface NormPoint {
  x: number;
  y: number;
}

export interface PortraitAnchor {
  eyeL: NormPoint;
  eyeR: NormPoint;
  mouth: NormPoint;
}

/** 补丁尺寸（归一化）：眼睛是「一段横条」，嘴巴是「一个小方块」 */
export interface RegionSpec {
  eye: {
    /** 眼区域横向外扩，让补丁盖住眼角与睫毛根 */
    padX: number;
    /** 眼区域高度（含上下眼睑与一点皮肤，衔接羽化用） */
    height: number;
  };
  mouth: {
    width: number;
    height: number;
  };
}

export const DEFAULT_REGION: RegionSpec = {
  // 眼睛：两点之间再左右各留 3% 画布宽，高度 11% 画布高（约等于鼻梁到眉毛下沿）
  eye: { padX: 0.03, height: 0.11 },
  // 嘴巴：宽度 16% 画布宽（张口时也够），高度 11% 画布高（含下巴一点皮肤）
  mouth: { width: 0.16, height: 0.11 },
};

export interface PortraitSpec {
  version: number;
  size: PortraitSize;
  /** 素材生产方式，只做留痕（例："flux+inpaint"） */
  source: string;
  anchor: PortraitAnchor;
  /** 已与默认值合并后的区域定义（永远完整） */
  region: RegionSpec;
}

// ---------------------------------------------------------------- 解析与校验

export type PortraitSpecIssue =
  /** 文件为空 / 取不到 */
  | "empty"
  /** 不是合法 JSON */
  | "not_json"
  /** 顶层不是对象 */
  | "not_object"
  /** 版本号缺失或不是整数 */
  | "bad_version"
  /** 版本号合法但与代码侧期望不同 */
  | "version_mismatch"
  /** size 缺失 / 非正 / 非有限数 */
  | "bad_size"
  /** anchor 缺字段、非 0..1、或左右眼顺序反了 */
  | "bad_anchor"
  /** region 给了但值非法 */
  | "bad_region";

export type PortraitSpecResult =
  | { ok: true; spec: PortraitSpec }
  | { ok: false; issue: PortraitSpecIssue; detail: string };

/** 0..1 夹紧（补丁矩形一律夹进画布，绝不产生负宽或越界） */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 归一化坐标的两种写法：`{x,y}` 与 `[x,y]`。
 *
 * 为什么两种都收：素材是人工/工具链产出的，实际随仓库交付的 `public/char/spec.json`
 * 用的就是元组写法（`anchor.eyeL: [0.485, 0.342]`、`size: [793, 800]`）。只认对象写法会让
 * 整份 spec 判成 `spec_invalid` → 照片模式整体回退 SVG，而这不是「脏 anchor」，只是格式差异。
 * 两种写法**校验标准完全相同**（分量必须是 0..1 的有限数），所以兼容不放松任何一条红线。
 */
function components(v: unknown): { x: unknown; y: unknown } | null {
  if (Array.isArray(v) && v.length === 2) return { x: v[0], y: v[1] };
  if (isPlainObject(v)) return { x: v.x, y: v.y };
  return null;
}

/** 归一化点：两种写法都接受，非法返回 null */
export function normalizePoint(v: unknown): NormPoint | null {
  const pair = components(v);
  if (!pair) return null;
  if (!isFiniteNumber(pair.x) || !isFiniteNumber(pair.y)) return null;
  if (pair.x < 0 || pair.x > 1 || pair.y < 0 || pair.y > 1) return null;
  return { x: pair.x, y: pair.y };
}

/** 画布尺寸：`{w,h}` 或 `[w,h]`；必须都是正数 */
export function normalizeSize(v: unknown): PortraitSize | null {
  const pair = Array.isArray(v) && v.length === 2
    ? { w: v[0], h: v[1] }
    : isPlainObject(v)
      ? { w: v.w, h: v.h }
      : null;
  if (!pair) return null;
  if (!isFiniteNumber(pair.w) || !isFiniteNumber(pair.h)) return null;
  if (pair.w <= 0 || pair.h <= 0) return null;
  return { w: pair.w, h: pair.h };
}

/** 归一化区间内的点：两个分量都必须是 0..1 的有限数 */
export function isNormPoint(v: unknown): v is NormPoint {
  return normalizePoint(v) !== null;
}

/**
 * 解析 spec.json 的**文本**（JSON 语法错误在这里就被拦掉）。
 * 缺文件 / 空文件 → "empty"，交由调用方按「素材缺失」处理。
 */
export function parseSpecJson(text: string, expectedVersion = PORTRAIT_VERSION): PortraitSpecResult {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, issue: "empty", detail: "spec.json 为空或未取到" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, issue: "not_json", detail: `spec.json 不是合法 JSON：${reason}` };
  }
  return parsePortraitSpec(raw, expectedVersion);
}

/**
 * 校验并补全 spec。
 *
 * 这里刻意**不做宽松兼容**：字段脏了就整体拒绝（调用方回退 SVG），因为脏 anchor 的后果
 * 不是「图丑一点」，而是嘴眼睛贴到额头/下巴上——那种画面比没有照片更糟。
 */
export function parsePortraitSpec(raw: unknown, expectedVersion = PORTRAIT_VERSION): PortraitSpecResult {
  if (!isPlainObject(raw)) {
    return { ok: false, issue: "not_object", detail: "spec.json 顶层不是对象" };
  }

  const version = raw.version;
  if (!isFiniteNumber(version) || !Number.isInteger(version) || version < 0) {
    return { ok: false, issue: "bad_version", detail: `version 必须是整数，收到 ${String(version)}` };
  }
  if (version !== expectedVersion) {
    return {
      ok: false,
      issue: "version_mismatch",
      detail: `spec 版本 ${version} ≠ 代码期望 ${expectedVersion}`,
    };
  }

  const size = normalizeSize(raw.size);
  if (!size) {
    return { ok: false, issue: "bad_size", detail: "size 必须是正数（portrait.png 的像素尺寸）" };
  }

  const anchorRaw = raw.anchor;
  if (!isPlainObject(anchorRaw)) {
    return { ok: false, issue: "bad_anchor", detail: "anchor 缺失或不是对象" };
  }
  const { eyeL, eyeR, mouth } = anchorRaw as Record<string, unknown>;
  for (const [name, point] of [
    ["anchor.eyeL", eyeL],
    ["anchor.eyeR", eyeR],
    ["anchor.mouth", mouth],
  ] as const) {
    if (!isNormPoint(point)) {
      return { ok: false, issue: "bad_anchor", detail: `${name} 必须是 {x,y} 或 [x,y] 且都在 0..1` };
    }
  }
  const anchor: PortraitAnchor = {
    eyeL: normalizePoint(eyeL)!,
    eyeR: normalizePoint(eyeR)!,
    mouth: normalizePoint(mouth)!,
  };
  // 左右眼写反在纸面上看不出来，但会让补丁宽度为负——这里直接拒
  if (anchor.eyeR.x - anchor.eyeL.x < 0.02) {
    return {
      ok: false,
      issue: "bad_anchor",
      detail: `eyeL.x(${anchor.eyeL.x}) 应在 eyeR.x(${anchor.eyeR.x}) 左侧，且两点相距 ≥0.02`,
    };
  }

  const region = mergeRegion(raw.region);
  if (!region.ok) return region;

  const source = typeof raw.source === "string" && raw.source.trim() !== "" ? raw.source.trim() : "unknown";

  return { ok: true, spec: { version, size, source, anchor, region: region.region } };
}

type RegionResult = { ok: true; region: RegionSpec } | Extract<PortraitSpecResult, { ok: false }>;

/** 区域定义：缺省 → 默认值；给了就必须是正数（允许部分覆盖） */
export function mergeRegion(raw: unknown): RegionResult {
  if (raw === undefined || raw === null) return { ok: true, region: DEFAULT_REGION };
  if (!isPlainObject(raw)) {
    return { ok: false, issue: "bad_region", detail: "region 必须是对象" };
  }
  const eyeRaw = isPlainObject(raw.eye) ? raw.eye : {};
  const mouthRaw = isPlainObject(raw.mouth) ? raw.mouth : {};
  const pickNum = (v: unknown, fallback: number): number | null => {
    if (v === undefined || v === null) return fallback;
    if (!isFiniteNumber(v) || v <= 0 || v > 1) return null;
    return v;
  };
  const padX = pickNum(eyeRaw.padX, DEFAULT_REGION.eye.padX);
  const eyeH = pickNum(eyeRaw.height, DEFAULT_REGION.eye.height);
  const mouthW = pickNum(mouthRaw.width, DEFAULT_REGION.mouth.width);
  const mouthH = pickNum(mouthRaw.height, DEFAULT_REGION.mouth.height);
  if (padX === null || eyeH === null || mouthW === null || mouthH === null) {
    return { ok: false, issue: "bad_region", detail: "region 各字段必须是 (0,1] 内的数" };
  }
  return {
    ok: true,
    region: { eye: { padX, height: eyeH }, mouth: { width: mouthW, height: mouthH } },
  };
}

// ---------------------------------------------------------------- anchor → 像素

/** 归一化补丁矩形（相对 portrait 画布，0..1） */
export interface PatchRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 眼区域补丁：横向从 eyeL 外扩到 eyeR 外扩，纵向以两眼 y 的中点为中心 */
export function eyePatchRect(spec: PortraitSpec): PatchRect {
  const { eyeL, eyeR } = spec.anchor;
  const { padX, height } = spec.region.eye;
  const left = clamp01(Math.min(eyeL.x, eyeR.x) - padX);
  const right = clamp01(Math.max(eyeL.x, eyeR.x) + padX);
  const cy = (eyeL.y + eyeR.y) / 2;
  const top = clamp01(cy - height / 2);
  const bottom = clamp01(cy + height / 2);
  return { left, top, width: right - left, height: bottom - top };
}

/** 嘴区域补丁：以 anchor.mouth 为中心的正方形（可按 spec 拉成横向长条） */
export function mouthPatchRect(spec: PortraitSpec): PatchRect {
  const { mouth } = spec.anchor;
  const { width, height } = spec.region.mouth;
  const left = clamp01(mouth.x - width / 2);
  const right = clamp01(mouth.x + width / 2);
  const top = clamp01(mouth.y - height / 2);
  const bottom = clamp01(mouth.y + height / 2);
  return { left, top, width: right - left, height: bottom - top };
}

/** 归一化矩形 → portrait.png 上的像素矩形（四舍五入，取整避免亚像素模糊） */
export function rectToPx(rect: PatchRect, size: PortraitSize): PatchRect {
  return {
    left: Math.round(rect.left * size.w),
    top: Math.round(rect.top * size.h),
    width: Math.max(1, Math.round(rect.width * size.w)),
    height: Math.max(1, Math.round(rect.height * size.h)),
  };
}

/** 归一化矩形 → CSS 百分比（渲染层直接贴在图上的写法：与画布尺寸解耦） */
export function rectToPct(rect: PatchRect): { left: string; top: string; width: string; height: string } {
  const p = (v: number) => `${(v * 100).toFixed(3)}%`;
  return { left: p(rect.left), top: p(rect.top), width: p(rect.width), height: p(rect.height) };
}

/** 一部分的补丁矩形（渲染层/测试共用同一入口，避免两处算两套） */
export function patchRectOf(spec: PortraitSpec, part: PortraitPart): PatchRect {
  return part === "eyes" ? eyePatchRect(spec) : mouthPatchRect(spec);
}

/**
 * 素材清单（人生产时对照用；也是诊断文案里「缺哪几个变体」的依据）。
 * 只描述**应该存在**的文件，不判断是否存在。
 */
export interface PortraitManifest {
  dir: string;
  version: number;
  required: string[];
  optional: string[];
  spec: string;
}

export function portraitManifest(): PortraitManifest {
  return {
    dir: PORTRAIT_DIR,
    version: PORTRAIT_VERSION,
    spec: PORTRAIT_SPEC_FILE,
    required: [PORTRAIT_BASE_FILE],
    optional: allVariantFiles(),
  };
}

/** 静态资源 URL（统一从这里拼，方便将来换目录） */
export function portraitUrl(file: string, base = PORTRAIT_DIR): string {
  return `${base.replace(/\/$/, "")}/${file}`;
}
