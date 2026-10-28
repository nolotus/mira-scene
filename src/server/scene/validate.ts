/**
 * Directive 白名单校验。
 *
 * 任何来自“不可信来源”（真模型输出、未来可能加的回放器/插件）的指令，都必须先过这里：
 * 枚举值不在白名单、结构不对、缺少字段 —— 一律丢弃，绝不把脏数据推给渲染层。
 * 渲染层因此可以假定「拿到的 Directive 一定合法」。
 */
import type {
  Action,
  Branch,
  CameraMove,
  Directive,
  Emotion,
  Pose,
  SceneVariant,
  Vfx,
} from "../../shared/protocol.ts";

/** 词汇表以 protocol.ts 为准，这里只是可运行的白名单副本 */
export const EMOTIONS = [
  "neutral",
  "curious",
  "warm",
  "amused",
  "anxious",
  "sad",
  "surprised",
] as const satisfies readonly Emotion[];

export const POSES = ["stand", "lean_in", "turn_away", "hold_cup", "glance_window"] as const satisfies readonly Pose[];

export const ACTIONS = [
  "blink",
  "hair_tuck",
  "sigh",
  "shiver",
  "look_back",
  "nod",
  "startle",
] as const satisfies readonly Action[];

export const CAMERA_MOVES = ["push_in", "pull_back", "whip_pan", "shake", "settle"] as const satisfies readonly CameraMove[];

export const VFX = [
  "lightning",
  "rain_heavy",
  "rain_light",
  "warm_glow",
  "lights_dim",
  "steam_wisp",
] as const satisfies readonly Vfx[];

export const SCENES = ["cafe_night", "cafe_closing", "window_rain"] as const satisfies readonly SceneVariant[];

/** 指令词汇表（也用于给真模型拼 system prompt） */
export const DIRECTIVE_VOCAB: Record<string, readonly string[]> = {
  emotion: EMOTIONS,
  pose: POSES,
  action: ACTIONS,
  camera: CAMERA_MOVES,
  vfx: VFX,
  scene: SCENES,
};

const emotionSet: ReadonlySet<string> = new Set(EMOTIONS);
const poseSet: ReadonlySet<string> = new Set(POSES);
const actionSet: ReadonlySet<string> = new Set(ACTIONS);
const cameraSet: ReadonlySet<string> = new Set(CAMERA_MOVES);
const vfxSet: ReadonlySet<string> = new Set(VFX);
const sceneSet: ReadonlySet<string> = new Set(SCENES);

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === "string" && emotionSet.has(value);
}

export function isPose(value: unknown): value is Pose {
  return typeof value === "string" && poseSet.has(value);
}

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && actionSet.has(value);
}

export function isCameraMove(value: unknown): value is CameraMove {
  return typeof value === "string" && cameraSet.has(value);
}

export function isVfx(value: unknown): value is Vfx {
  return typeof value === "string" && vfxSet.has(value);
}

export function isSceneVariant(value: unknown): value is SceneVariant {
  return typeof value === "string" && sceneSet.has(value);
}

/** 分支选项：最多 4 个，id/label 非空、id 去重，超长截断 */
export function validateBranches(raw: unknown): Branch[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const options: Branch[] = [];
  for (const item of raw) {
    if (options.length >= 4) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim().slice(0, 32) : "";
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 40) : "";
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label });
  }
  return options;
}

/**
 * 校验单条指令：合法则返回「重建后的干净对象」，非法返回 null。
 * 注意返回值是新对象而不是原对象，避免调用方把多余字段带给渲染层。
 */
export function validateDirective(raw: unknown): Directive | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  // 兼容模型偶尔写成 type 的情况
  const kind = record.kind ?? record.type;

  switch (kind) {
    case "emotion":
      return isEmotion(record.emotion) ? { kind: "emotion", emotion: record.emotion } : null;
    case "pose":
      return isPose(record.pose) ? { kind: "pose", pose: record.pose } : null;
    case "action":
      return isAction(record.action) ? { kind: "action", action: record.action } : null;
    case "camera":
      return isCameraMove(record.move) ? { kind: "camera", move: record.move } : null;
    case "vfx":
      return isVfx(record.vfx) ? { kind: "vfx", vfx: record.vfx } : null;
    case "scene":
      return isSceneVariant(record.scene) ? { kind: "scene", scene: record.scene } : null;
    case "branch": {
      const options = validateBranches(record.options);
      return options.length > 0 ? { kind: "branch", options } : null;
    }
    default:
      return null;
  }
}

/** 批量校验：非数组返回空数组，逐条丢弃非法项 */
export function validateDirectives(raw: unknown): Directive[] {
  if (!Array.isArray(raw)) return [];
  const directives: Directive[] = [];
  for (const item of raw) {
    const directive = validateDirective(item);
    if (directive) directives.push(directive);
  }
  return directives;
}
