/**
 * SceneSpec —— 场景 = 数据 + 契约。
 *
 * 目标：新增一个地点只需要加一份 spec 数据，而不是再写一套背景 JSX。
 * 这个文件里没有任何 JSX、没有 DOM、没有时钟：它是纯数据 + 纯函数，
 * 渲染层（StageBackdrop / Character / stage.css）只按这里的字段取参数。
 *
 * 三条自我约束：
 *  1. **标定值** —— 所有「新变量」的默认值都抄自改造前的硬编码值
 *     （`--char-bottom: 30%`、`--char-height: 56%`、`fillColor: #9ec6ec`、
 *     `keyColor: #ffe6bd`、`rimStrength: 1`、`shadowSoftness: 0.62`）。
 *     默认场景必须与改造前逐像素一致，所以这些数字不是「大致像」，是标定出来的。
 *  2. **数据不自相矛盾** —— `actions` 里允许的每个动作/姿势，都要有对应的
 *     `props`（场景里真实存在的物件）作为依据，见 `ACTION_REQUIREMENTS` 与
 *     `missingProps()`。测试会逐个场景 × 逐个允许动作查一遍。
 *  3. **未知场景降级，不抛错** —— `resolveScene()` 遇到不认识的 id 回落到
 *     `DEFAULT_SCENE_ID`，因为渲染期抛错会白屏，丢一个场景比白屏轻得多。
 */

import type { Action, Pose, SceneVariant } from "../../../shared/protocol";

// ---------------------------------------------------------------- 层

/**
 * 景深层 id。前四个是当前咖啡馆用到的层，各自在 StageBackdrop 里有一个渲染器；
 * `sky / sea / shore` 是「海边的天幕 / 海面 / 岸线」三层，
 * 由 seaside_dawn 使用，各自有渲染器（见 StageBackdrop 的 PLANE_RENDERERS）。
 */
export type PlaneId =
  | "room"
  | "window"
  | "warm"
  | "fg"
  | "sky"
  | "sea"
  | "shore"
  | "street"
  | "road"
  | "hotel";

/** 一层景深：有什么层、每层的视差系数、这层里有哪些可见构件 */
export interface DepthPlane {
  id: PlaneId;
  /** 人读的名字（预览面板 / 诊断用） */
  label: string;
  /**
   * 视差系数：镜头推拉或横摇时，这一层相对镜头的位移比例。
   * 0 = 贴死在无限远（不随镜头动），1 = 与镜头同速（最贴脸的一层）。
   * 当前渲染层只把它写成 `--plane-parallax`，真正的位移逻辑还没做。
   */
  parallax: number;
  /**
   * 这一层里真实存在的构件。是 `actions` 的取证来源：
   * 场景允许 `hold_cup`，前提就是某一层声明了 `cup`。
   */
  props: string[];
}

// ---------------------------------------------------------------- 光

/**
 * 光照契约。这些字段全部由渲染层消费（除了 `keyDir` 目前只决定面部明暗面的方向）：
 *  - `keyColor`   → `--key-color`   → 角色手里的杯子被主光照亮的那圈色（mx-muglight）
 *  - `fillColor`  → `--fill-color`  → 轮廓光（mx-rim），窗外冷光填出来的边
 *  - `rimStrength`→ `--rim-strength`→ 轮廓光的强度倍率（乘在 mx-rim 的三个 stop 上）
 *  - `shadowSoftness` → `--shadow-softness` → 面部遮挡渐变衰减到 0 的位置（mx-shade stop offset）
 *  - `keyDir`     → 面部遮挡渐变的方向（mx-shade 的 x2/y2），屏幕坐标、指向光源
 */
export interface LightingSpec {
  /** 主光方向：屏幕坐标系（x 向右、y 向下）、指向光源。标定自现状 mx-shade 的 x2=1 / y2=0.2 */
  keyDir: { x: number; y: number };
  /** 主光颜色（吊灯的暖光）。标定自现状 mx-muglight 的 #ffe6bd */
  keyColor: string;
  /** 补光颜色（窗外雨夜的冷光）。标定自现状 mx-rim 的 #9ec6ec */
  fillColor: string;
  /** 轮廓光强度 0..1。1 = 与改造前逐像素一致 */
  rimStrength: number;
  /** 遮挡阴影的柔和度：遮挡从不透明衰减到 0 的归一化距离。标定自现状 mx-shade 的 stop offset 0.62 */
  shadowSoftness: number;
}

// ---------------------------------------------------------------- 调色板

/**
 * 场景调色板。当前是**声明性**的：它记录这个场景的基色，还没有逐条接进 CSS
 * （背景的渐变仍然写在 stage.css 里，因为一个 gradient 有 3–4 个 stop，
 * 硬塞进单值变量会改观感）。字段含义：
 *  - `base`   墙面/室内主色调
 *  - `depth`  地面与最暗处的颜色
 *  - `sky`    窗外/天幕的颜色
 *  - `accent` 场景自己的主色（吊灯暖光、路灯的橙）
 *  - `key` / `fill` 与 lighting 同源，便于「调色板与光照不同步」这种事一眼看出来
 */
export interface PaletteSpec {
  base: string;
  depth: string;
  sky: string;
  accent: string;
  key: string;
  fill: string;
}

// ---------------------------------------------------------------- 粒子

/** 场景自带的粒子（雨丝 / 水珠 / 热气）。数量与现状常量一致，渲染层据此生成几何 */
export interface ParticleSpec {
  kind: "rain_far" | "rain_near" | "glass_drops" | "steam";
  count: number;
  /** 每层的透明度区间；只有 `rain_*` 用得到 */
  opacity?: readonly [number, number];
}

// ---------------------------------------------------------------- 镜头

export interface CameraSpec {
  /**
   * 地平线：角色脚底所在的水平线，距画面底部的比例（0..1）。
   * 它同时决定角色的站位（`bottom`）与身高（离地平线越近 → 越小）。
   */
  horizonY: number;
  /** 竖直视场角（度）。目前只作为数据：给「同一地平线、不同焦段」预留 */
  fovDeg: number;
}

// ---------------------------------------------------------------- 动作

/**
 * 场景能容纳的角色动作词汇。
 *
 * 注意 `hold_cup` 在协议里是 **Pose** 而不是 `Action`（`Action` 只有 blink /
 * hair_tuck / sigh / shiver / look_back / nod / startle 这七个瞬时动作）。
 * 「场景能不能容下这件事」和「它属于姿势还是瞬时动作」是两个正交的维度，
 * 所以这里的词汇表是两个 union 的合并，过滤时 `action` 与 `pose` 两条指令都要过。
 */
export type SceneAction = Action | Pose;

/**
 * 动作对场景物件的硬要求。一个场景只要**声明**允许某个动作，就必须在某一层的
 * `props` 里声明这些构件 —— 否则 `missingProps()` 会把它报出来。
 * 这样 `actions` 不是随手写的白名单，而是能被机器核对的自洽声明。
 */
export const ACTION_REQUIREMENTS: Partial<Record<SceneAction, readonly string[]>> = {
  hold_cup: ["cup"], // 得有个杯子（桌面上那只 .table-cup）
  glance_window: ["window"], // 得有窗户可看（.sc-window）
};

export function actionRequirements(action: SceneAction): readonly string[] {
  return ACTION_REQUIREMENTS[action] ?? [];
}

// ---------------------------------------------------------------- 场景

export interface SceneSpec {
  id: SceneVariant;
  /** 人读的名字（预览面板 / 诊断） */
  label: string;
  /** 由远及近（也决定 DOM 绘制顺序） */
  depthPlanes: DepthPlane[];
  palette: PaletteSpec;
  lighting: LightingSpec;
  camera: CameraSpec;
  particles?: ParticleSpec[];
  /** 这个场景能容纳的角色动作/姿势（见 SceneAction 的说明） */
  actions: SceneAction[];
}

// ---------------------------------------------------------------- 标定常数

/** 角色的站位标定：地平线在 30% 时，身高占画面 56%、底部偏移 30%（= 改造前的硬编码值） */
export const REFERENCE_HORIZON_Y = 0.3;
/** 见 REFERENCE_HORIZON_Y */
export const CHAR_HEIGHT_AT_REFERENCE = 0.56;

/** 0.3 → "30"（百分比数值，避免 calc 里的浮点舍入改变布局） */
const pct = (value: number): string => String(Math.round(value * 10000) / 100);
/** 56.00000000000001 → "56"，但保留 3 位有效小数给非标定的地平线 */
const num = (value: number): string => String(Math.round(value * 1000) / 1000);

/**
 * 地平线 → 角色的盒子。
 *
 * 身高的推导：同一个角色站在同一条地平线上时，画面上的身高与「地平线离镜头多远」
 * 成正比，而 horizonY 就是那个距离的代理量。所以
 *   scale = horizonY / REFERENCE_HORIZON_Y
 *   height = CHAR_HEIGHT_AT_REFERENCE * scale
 * 标定场景（horizonY = 0.3）得到 scale 恰好 1、height 恰好 56%，与改造前一致。
 */
export interface CharBox {
  /** CSS 里的 `bottom`，角色脚底落在哪里 */
  bottom: string;
  /** CSS 里的 `height` */
  height: string;
  /** 由地平线推出的缩放倍率（标定场景恒为 1） */
  scale: number;
}

export function charBoxOf(spec: SceneSpec): CharBox {
  const scale = spec.camera.horizonY / REFERENCE_HORIZON_Y;
  return {
    bottom: `${pct(spec.camera.horizonY)}%`,
    height: `${num(CHAR_HEIGHT_AT_REFERENCE * scale * 100)}%`,
    scale,
  };
}

// ---------------------------------------------------------------- 三个现有场景 + 一个示例场景

const CAFE_LIGHTING: LightingSpec = {
  keyDir: { x: 1, y: 0.2 },
  keyColor: "#ffe6bd",
  fillColor: "#9ec6ec",
  rimStrength: 1,
  shadowSoftness: 0.62,
};

/** 三处咖啡馆场景共用同一份「室内 + 窗」的构件清单：它们是同一间店的不同状态 */
const CAFE_ROOM: DepthPlane = {
  id: "room",
  label: "室内墙面 / 吧台 / 吊灯",
  parallax: 0.06,
  props: ["wall", "shelf", "chairs", "counter", "hang_lamp", "floor"],
};

const CAFE_WINDOW: DepthPlane = {
  id: "window",
  label: "窗与窗外雨街",
  parallax: 0.18,
  props: ["window", "sky", "buildings", "lamp_post", "glass_drops", "frame", "mullion"],
};

const CAFE_WARM: DepthPlane = {
  id: "warm",
  label: "暖光池 / 桌面 / 咖啡热气",
  parallax: 0.34,
  props: ["warm_pool", "table", "cup", "steam"],
};

const CAFE_FG: DepthPlane = {
  id: "fg",
  label: "前景雨幕 / 水汽 / 暗角",
  parallax: 0.72,
  props: ["rain_near", "haze", "vignette", "lightning"],
};

/**
 * 咖啡馆里成立的全部动作：
 * - 七种瞬时动作与道具无关，只要求「有身体、有环境刺激」：雨夜冷 → shiver，
 *   窗外打闪 → startle，对面坐着人 → nod / look_back / hair_tuck / sigh / blink；
 * - 五种姿势里 `hold_cup` 靠桌面上那只杯子（`cup`），`glance_window` 靠那扇窗（`window`），
 *   其余三种（站/前倾/侧身）只依赖「有地面、有对话对象」。
 * 三个咖啡馆状态（夜/打烊/窗前雨）都保留吧台、桌面、杯子与窗，所以词汇表相同；
 * 差别只在光照、视线机位与室内景深（见各自的 depthPlanes / palette / lighting）。
 */
const CAFE_ACTIONS: SceneAction[] = [
  "blink",
  "hair_tuck",
  "sigh",
  "shiver",
  "look_back",
  "nod",
  "startle",
  "stand",
  "lean_in",
  "turn_away",
  "hold_cup",
  "glance_window",
];

export const SCENE_SPECS: Record<SceneVariant, SceneSpec> = {
  cafe_night: {
    id: "cafe_night",
    label: "雨夜咖啡馆",
    depthPlanes: [CAFE_ROOM, CAFE_WINDOW, CAFE_WARM, CAFE_FG],
    palette: {
      base: "#29190f",
      depth: "#0b0605",
      sky: "#08111d",
      accent: "#ffc276",
      key: "#ffe6bd",
      fill: "#9ec6ec",
    },
    lighting: CAFE_LIGHTING,
    camera: { horizonY: 0.3, fovDeg: 38 },
    particles: [
      { kind: "rain_far", count: 52, opacity: [0.3, 0.8] },
      { kind: "rain_near", count: 17, opacity: [0.07, 0.2] },
      { kind: "glass_drops", count: 20 },
      { kind: "steam", count: 3 },
    ],
    actions: CAFE_ACTIONS,
  },

  cafe_closing: {
    id: "cafe_closing",
    label: "打烊中",
    depthPlanes: [CAFE_ROOM, CAFE_WINDOW, CAFE_WARM, CAFE_FG],
    palette: {
      // 打烊：墙面只剩吊灯那一点余光，街道更蓝更冷
      base: "#150c07",
      depth: "#0a0605",
      sky: "#050c16",
      accent: "#8a6238",
      key: "#ffe6bd",
      fill: "#9ec6ec",
    },
    // 打烊时吊灯被关掉一半（.cone opacity .22 / .shade brightness .55），但那是
    // stage.css 里按场景调的光源强度，不是角色身上的光照契约；角色的 key/fill/rim
    // 在这一帧没有变，所以这里必须与 cafe_night 取同一组值（改一个数字就会改观感）。
    lighting: CAFE_LIGHTING,
    camera: { horizonY: 0.3, fovDeg: 38 },
    // 与 cafe_night 同一套粒子：三个咖啡馆状态**渲染同一份 DOM**，差别全在 CSS 里
    // （改这里的数量就等于改观感 —— 打烊场曾经少了 steam 与 rain_near，PSNR 立刻掉到 50dB）
    particles: [
      { kind: "rain_far", count: 52, opacity: [0.3, 0.8] },
      { kind: "rain_near", count: 17, opacity: [0.07, 0.2] },
      { kind: "glass_drops", count: 20 },
      { kind: "steam", count: 3 },
    ],
    actions: CAFE_ACTIONS,
  },

  window_rain: {
    id: "window_rain",
    label: "窗前落雨",
    depthPlanes: [CAFE_ROOM, CAFE_WINDOW, CAFE_WARM, CAFE_FG],
    palette: {
      base: "#29190f",
      depth: "#0b0605",
      sky: "#08111d",
      accent: "#ffc276",
      key: "#ffe6bd",
      fill: "#9ec6ec",
    },
    lighting: CAFE_LIGHTING,
    camera: { horizonY: 0.3, fovDeg: 38 },
    particles: [
      { kind: "rain_far", count: 52, opacity: [0.3, 0.8] },
      { kind: "rain_near", count: 17, opacity: [0.07, 0.2] },
      { kind: "glass_drops", count: 20 },
      { kind: "steam", count: 3 },
    ],
    actions: CAFE_ACTIONS,
  },

  /**
   * 示例场景（**不进 UI**，没有渲染器）：用来证明「加一个地点 = 加一份数据」，
   * 同时当反例 —— 海边没有杯子、也没有那扇窗，所以 `hold_cup` 与 `glance_window`
   * 在这里不成立。它同时说明 actions 白名单不是随手写的。
   */
  seaside_dawn: {
    id: "seaside_dawn",
    label: "海边破晓（示例）",
    depthPlanes: [
      { id: "sky", label: "破晓天幕", parallax: 0.02, props: ["sky", "sun_glow"] },
      { id: "sea", label: "海面与浪线", parallax: 0.1, props: ["sea", "wave_line", "gulls"] },
      { id: "shore", label: "礁石与沙滩", parallax: 0.28, props: ["shore", "rocks", "wind"] },
      { id: "fg", label: "海风 / 水雾 / 暗角", parallax: 0.72, props: ["sea_spray", "haze", "vignette"] },
    ],
    palette: {
      base: "#3a4f5e",
      depth: "#1b2b36",
      sky: "#8fb6cf",
      accent: "#f2c9a0",
      key: "#f7cfa6",
      fill: "#bcd6e8",
    },
    lighting: {
      // 破晓的低角度侧逆光：光从右上低处来，轮廓光很硬，阴影边缘很软
      keyDir: { x: 0.8, y: -0.6 },
      keyColor: "#f7cfa6",
      fillColor: "#bcd6e8",
      rimStrength: 1.15,
      shadowSoftness: 0.78,
    },
    camera: { horizonY: 0.22, fovDeg: 52 },
    // 没有 particles：海边不下雨、没有玻璃水珠、也没有热饮的热气
    actions: [
      "blink",
      "hair_tuck",
      "sigh",
      "shiver",
      "look_back",
      "nod",
      "startle",
      "stand",
      "lean_in",
      "turn_away",
      // 没有 hold_cup：这里没有杯子（也没有桌子）
      // 没有 glance_window：这是开放海面，没有窗框/玻璃可望
    ],
  },

  /**
   * 雨夜街道：站在人行道上的那一刻。
   * 深度层：street（夜空 + 楼体剪影 + 街灯 + 招牌）→ road（透视湿路面、积水与倒影）
   * → fg（前景雨幕 / 水汽 / 暗角）。
   * 白名单里**没有** hold_cup（街上没有杯子）与 glance_window（没有窗框可望），
   * 所以站在街上只能抖、只能回头看。
   */
  street_night: {
    id: "street_night",
    label: "雨夜街道",
    depthPlanes: [
      {
        id: "street",
        label: "夜空 / 楼体剪影 / 街灯 / 招牌",
        parallax: 0.08,
        props: ["sky", "buildings", "lamp_post", "signs", "storefront"],
      },
      {
        id: "road",
        label: "透视湿路面 / 积水 / 灯影倒影",
        parallax: 0.3,
        props: ["road", "puddle", "reflection", "kerb"],
      },
      {
        id: "fg",
        label: "前景雨幕 / 水汽 / 暗角",
        parallax: 0.72,
        props: ["rain_near", "haze", "vignette"],
      },
    ],
    palette: {
      base: "#1a2432",
      depth: "#080d14",
      sky: "#0b1524",
      accent: "#ffb45c",
      key: "#ffd9a8",
      fill: "#8fb6d8",
    },
    lighting: {
      // 街灯从右上斜打下来：轮廓光偏冷（雨幕与水汽），主光是路灯的橙
      keyDir: { x: 0.9, y: -0.3 },
      keyColor: "#ffd9a8",
      fillColor: "#8fb6d8",
      rimStrength: 1.1,
      shadowSoftness: 0.7,
    },
    camera: { horizonY: 0.34, fovDeg: 46 },
    particles: [
      { kind: "rain_far", count: 44, opacity: [0.25, 0.7] },
      { kind: "rain_near", count: 15, opacity: [0.06, 0.18] },
    ],
    actions: [
      "blink",
      "hair_tuck",
      "sigh",
      "shiver",
      "look_back",
      "nod",
      "startle",
      "stand",
      "lean_in",
      "turn_away",
      // 没有 hold_cup：街上没有杯子（也没有桌子）
      // 没有 glance_window：这是开放街道，没有窗框/玻璃可望
    ],
  },

  /**
   * 酒店楼下门廊：雨棚下等人的那一刻。
   * 深度层：hotel（门廊立面 / 雨棚 / 暖光溢出 / 台阶）→ fg（前景雨幕 / 水汽 / 暗角）。
   * 白名单与街道同理：门廊里**没有**杯子，也没有可望的窗（暖光从门里溢出来，但不是窗）。
   */
  hotel_entrance: {
    id: "hotel_entrance",
    label: "酒店楼下门廊",
    depthPlanes: [
      {
        id: "hotel",
        label: "门廊立面 / 雨棚 / 暖光溢出 / 台阶",
        parallax: 0.1,
        props: ["facade", "entrance", "canopy", "warm_glow", "sign", "steps"],
      },
      {
        id: "fg",
        label: "前景雨幕 / 水汽 / 暗角",
        parallax: 0.72,
        props: ["rain_near", "haze", "vignette"],
      },
    ],
    palette: {
      base: "#241d24",
      depth: "#0d0a10",
      sky: "#0a1220",
      accent: "#ffc276",
      key: "#ffe0b0",
      fill: "#93b6d4",
    },
    lighting: {
      // 门廊的暖光从正面偏下往上照：主光暖、轮廓是雨夜的冷蓝
      keyDir: { x: -0.2, y: 0.4 },
      keyColor: "#ffe0b0",
      fillColor: "#93b6d4",
      rimStrength: 1.05,
      shadowSoftness: 0.66,
    },
    camera: { horizonY: 0.3, fovDeg: 42 },
    particles: [
      { kind: "rain_far", count: 40, opacity: [0.22, 0.62] },
      { kind: "rain_near", count: 13, opacity: [0.05, 0.16] },
    ],
    actions: [
      "blink",
      "hair_tuck",
      "sigh",
      "shiver",
      "look_back",
      "nod",
      "startle",
      "stand",
      "lean_in",
      "turn_away",
      // 没有 hold_cup：门廊里没有杯子
      // 没有 glance_window：暖光来自门里，不是可倚的窗
    ],
  },
};

/** 未知场景的回落目标。降级到这里而不是抛错：渲染期抛错等于白屏 */
export const DEFAULT_SCENE_ID: SceneVariant = "cafe_night";

export function isKnownSceneId(id: string): id is SceneVariant {
  return Object.prototype.hasOwnProperty.call(SCENE_SPECS, id);
}

/**
 * id → spec。**未知 id 不抛错**，回落到 DEFAULT_SCENE_ID（见文件头的约束 3）。
 * 想区分「认识」与「回落」用 `isKnownSceneId()`。
 */
export function resolveScene(id: string): SceneSpec {
  return SCENE_SPECS[id as SceneVariant] ?? SCENE_SPECS[DEFAULT_SCENE_ID];
}

/** SceneVariant → spec（语义化的别名，读起来更贴近调用处） */
export function specOf(scene: SceneVariant): SceneSpec {
  return resolveScene(scene);
}

/**
 * 这个场景能不能容纳这个动作/姿势。
 * 高层的职责分工（另见 session.ts 的注释）：
 *  - 服务端白名单管**枚举合法性**（`blink` 是不是一个已知的 Action）；
 *  - 这里的 `actions` 管**场景适配**（这个场景里做这件事成立吗）。
 */
export function isActionAllowed(scene: SceneVariant | string, action: SceneAction): boolean {
  return resolveScene(scene).actions.includes(action);
}

/** 场景声明允许某个动作、但缺少它需要的构件时，返回缺的那些（用于测试与诊断） */
export function missingProps(spec: SceneSpec, action: SceneAction): string[] {
  const required = actionRequirements(action);
  if (required.length === 0) return [];
  const declared = new Set(spec.depthPlanes.flatMap((plane) => plane.props));
  return required.filter((prop) => !declared.has(prop));
}

/** 有渲染器的层。渲染层画的层必须都在这里，否则会渲染成一块空背景 */
export const RENDERABLE_PLANES: readonly PlaneId[] = [
  "room",
  "window",
  "warm",
  "fg",
  "sky",
  "sea",
  "shore",
  "street",
  "road",
  "hotel",
];

/** 这份 spec 里没有渲染器的层（现在生产场景与 seaside_dawn 都不该命中） */
export function unsupportedPlanes(spec: SceneSpec): PlaneId[] {
  return spec.depthPlanes.map((p) => p.id).filter((id) => !RENDERABLE_PLANES.includes(id));
}

/**
 * spec → 一组 CSS 变量。这是「数据」和「皮肤」之间唯一的接口：
 * 渲染层不读 spec 对象的字段，只读这些变量（默认值写在 stage.css 里，
 * 与改造前的硬编码值逐字相同，所以默认场景的观感不变）。
 *
 * 不走变量的两个字段（由 Character 直接读 spec）：
 *  - `shadowSoftness` → 渐变 stop 的 offset
 *  - `keyDir`         → 渐变的方向向量 x2/y2
 * SVG 的渐变几何只能写在属性上，属性值不接受 var()，所以这两个字段没有变量形态。
 */
export function sceneVars(spec: SceneSpec): Record<string, string> {
  const box = charBoxOf(spec);
  return {
    "--key-color": spec.lighting.keyColor,
    "--fill-color": spec.lighting.fillColor,
    "--rim-strength": `${spec.lighting.rimStrength}`,
    "--char-bottom": box.bottom,
    "--char-height": box.height,
    // 地平线（角色脚下那条线）在画面底部的比例 —— 岸线层用它决定沙滩有多高
    "--horizon-y": `${pct(spec.camera.horizonY)}%`,
  };
}
