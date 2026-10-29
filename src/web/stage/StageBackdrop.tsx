/**
 * 场景背景 —— 由 `SceneSpec.depthPlanes` 驱动的多层景深。
 *
 * 改造前这里是硬编码的 4 层 JSX；现在「有哪些层、按什么顺序、每层的视差系数、
 * 每层的粒子数量」全部来自 `scenes/spec.ts` 的数据，本文件只负责
 * 「层 id → 这一层长什么样」（PLANE_RENDERERS）。
 * 加一个地点 = 加一份 spec + （如果需要新的构件）加一个渲染器，
 * 而不是再写一套背景组件。
 *
 * 全部是 CSS 渐变 + 少量内联 SVG 几何，没有任何图片或字体请求。
 * 雨幕用「一整条长带循环下滑」实现：只有一个动画，几十根雨丝一起动，
 * 靠上下两段相同内容保证无缝 —— 比给每根雨丝单独挂动画便宜一个数量级。
 */

import type { CSSProperties, ReactNode } from "react";
import type { SceneVariant } from "../../shared/protocol";
import { specOf, type DepthPlane, type PlaneId, type SceneSpec } from "./scenes/spec";
import { seeded } from "./visuals";

interface Streak {
  left: number;
  height: number;
  width: number;
  opacity: number;
  skew: number;
}

function buildStreaks(count: number, seed: number, minH: number, maxH: number, minW: number, maxW: number, minO: number, maxO: number): Streak[] {
  const rnd = seeded(seed);
  const out: Streak[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      left: rnd() * 118 - 9,
      height: minH + rnd() * (maxH - minH),
      width: minW + rnd() * (maxW - minW),
      opacity: minO + rnd() * (maxO - minO),
      skew: rnd() * 4 - 2,
    });
  }
  return out;
}

/**
 * 每类雨幕的几何口径（种子与尺寸），数量/透明度区间来自 spec 的 `particles`。
 * 种子固定 = 同一份数据每次渲染出同一场雨（也保证截图可复现）。
 */
const RAIN_GEOMETRY = {
  rain_far: { seed: 20261028, minH: 34, maxH: 108, minW: 1.1, maxW: 2.2 },
  rain_near: { seed: 77193, minH: 110, maxH: 300, minW: 1.6, maxW: 3.4 },
} as const;

/** 同一份 spec 反复渲染时复用同一批雨丝（保持引用稳定，避免每帧重算） */
const STREAK_CACHE = new Map<string, Streak[]>();

function streaksFor(spec: SceneSpec, kind: "rain_far" | "rain_near"): Streak[] {
  const particle = spec.particles?.find((p) => p.kind === kind);
  const count = particle?.count ?? 0;
  if (count <= 0) return [];
  const [minO, maxO] = particle?.opacity ?? [0.2, 0.6];
  const key = `${kind}:${count}:${minO}:${maxO}`;
  const cached = STREAK_CACHE.get(key);
  if (cached) return cached;
  const geometry = RAIN_GEOMETRY[kind];
  const built = buildStreaks(
    count,
    geometry.seed,
    geometry.minH,
    geometry.maxH,
    geometry.minW,
    geometry.maxW,
    minO,
    maxO,
  );
  STREAK_CACHE.set(key, built);
  return built;
}

function particleCount(spec: SceneSpec, kind: "glass_drops" | "steam"): number {
  return spec.particles?.find((p) => p.kind === kind)?.count ?? 0;
}

// ---------------------------------------------------------------- 海边场景

/**
 * 「这个构件在这个场景里存在吗」—— 渲染器按 spec 声明的 props 决定画不画，
 * 而不是按场景 id 写分支（那样每加一个地点就得改一遍渲染器）。
 */
export function hasProp(spec: SceneSpec, prop: string): boolean {
  return spec.depthPlanes.some((plane) => plane.props.includes(prop));
}

/**
 * 海面的几何（固定值 = 同一片海每次都一样，截图可复现）。
 * top 是距画面顶部的百分比，width 是波线的长度占比 —— 越靠下越宽越近（透视）。
 */
const SEA_WAVES = [
  { top: 33.5, width: 26, left: 6, opacity: 0.22, height: 1 },
  { top: 36, width: 34, left: 42, opacity: 0.26, height: 1.1 },
  { top: 39.5, width: 30, left: 14, opacity: 0.3, height: 1.2 },
  { top: 44, width: 44, left: 40, opacity: 0.32, height: 1.4 },
  { top: 49, width: 38, left: 8, opacity: 0.34, height: 1.6 },
  { top: 55, width: 52, left: 34, opacity: 0.3, height: 1.8 },
  { top: 62, width: 46, left: 4, opacity: 0.26, height: 2 },
  { top: 70, width: 62, left: 28, opacity: 0.2, height: 2.4 },
] as const;

/** 海鸥：三只，位置固定，靠 CSS 动画横移（不是随机） */
const GULLS = [
  { top: 12, left: 18, scale: 1, delay: 0, duration: 46 },
  { top: 16, left: 46, scale: 0.72, delay: -12, duration: 58 },
  { top: 9, left: 63, scale: 0.58, delay: -25, duration: 67 },
] as const;

/** 礁石：暗色剪影，压在岸线附近 */
const ROCKS = [
  { left: 4, width: 16, height: 9, bottom: 16 },
  { left: 26, width: 9, height: 5, bottom: 13 },
  { left: 74, width: 20, height: 12, bottom: 18 },
  { left: 93, width: 12, height: 7, bottom: 11 },
] as const;

/** 风力细节：几道掠过画面的细长气流 */
const WIND_LINES = [
  { top: 30, left: 2, width: 34, opacity: 0.16, duration: 17, delay: -3 },
  { top: 36, left: 46, width: 28, opacity: 0.12, duration: 22, delay: -9 },
  { top: 43, left: 18, width: 22, opacity: 0.1, duration: 26, delay: -15 },
] as const;

/** 海雾：前景飘起来的细小水珠 */
const SPRAY_DOTS = [
  { left: 12, size: 2.4, delay: 0, duration: 7.5 },
  { left: 26, size: 1.8, delay: -2.4, duration: 9 },
  { left: 41, size: 2.1, delay: -4.1, duration: 8.2 },
  { left: 58, size: 1.6, delay: -1.2, duration: 10 },
  { left: 73, size: 2.6, delay: -5.3, duration: 7.9 },
  { left: 88, size: 1.9, delay: -3.1, duration: 8.8 },
] as const;

/** 一段波线：一条起伏的正弦路径（SVG 视口被拉宽成一条细带） */
function WaveLine({ wave }: { wave: (typeof SEA_WAVES)[number] }) {
  return (
    <svg
      className="sea-wave"
      viewBox="0 0 100 4"
      preserveAspectRatio="none"
      style={{
        top: `${wave.top}%`,
        left: `${wave.left}%`,
        width: `${wave.width}%`,
        height: `${wave.height * 1.6}px`,
        opacity: wave.opacity,
      }}
      aria-hidden="true"
    >
      <path
        d="M0,2 q6,-1.7 12,0 t12,0 t12,0 t12,0 t12,0 t12,0 t12,0 t12,0 t12,0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 一只海鸥：两段弧拼出来的剪影（外面套一条全宽的泳道，方便横向漂过画面） */
function Gull({ gull }: { gull: (typeof GULLS)[number] }) {
  return (
    <span className="sea-gull-lane" style={{ top: `${gull.top}%` }} aria-hidden="true">
      <svg
        className="sea-gull"
        viewBox="0 0 16 8"
        style={{
          width: `${14 * gull.scale}px`,
          animationDelay: `${gull.delay}s`,
          animationDuration: `${gull.duration}s`,
        }}
      >
        <path
          d="M0,5 q4,-4.6 8,0 q4,4.6 8,0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

/** 一块礁石：不规则多边形剪影 */
function Rock({ rock }: { rock: (typeof ROCKS)[number] }) {
  return (
    <svg
      className="shore-rock"
      viewBox="0 0 100 60"
      preserveAspectRatio="none"
      style={{
        left: `${rock.left}%`,
        bottom: `${rock.bottom}%`,
        width: `${rock.width}%`,
        height: `${rock.height}%`,
      }}
      aria-hidden="true"
    >
      <path d="M2,60 L14,20 L34,4 L58,14 L78,34 L98,60 Z" fill="currentColor" />
      <path d="M14,20 L34,4 L44,26 L24,40 Z" fill="rgba(255,255,255,0.10)" />
    </svg>
  );
}

function RainSheet({ streaks }: { streaks: Streak[] }) {
  const block = (suffix: string) => (
    <div className={`rain-block ${suffix}`}>
      {streaks.map((s, i) => (
        <i
          key={i}
          className="streak"
          style={
            {
              left: `${s.left}%`,
              height: `${s.height}px`,
              width: `${s.width}px`,
              opacity: s.opacity,
              "--skew": `${s.skew}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
  return (
    <div className="rain-sheet">
      {block("a")}
      {block("b")}
    </div>
  );
}

const DROPS = (() => {
  const rnd = seeded(4412);
  return Array.from({ length: 20 }, (_, i) => ({
    id: i,
    x: 4 + rnd() * 92,
    y: 6 + rnd() * 86,
    r: 1.6 + rnd() * 4.4,
    o: 0.18 + rnd() * 0.4,
    delay: rnd() * 9,
  }));
})();

/**
 * 一层景深的包装。类名 `sc-<id>` 与 stage.css 里的选择器一一对应，
 * 而「有哪些层、什么顺序」由 spec 决定 —— 这一层 DOM 结构改造前后完全一致
 * （一层 = 一个 div），所以观感不变。
 *
 * 注意：这里**不**给层加内联自定义属性（试过 `--plane-parallax`）。
 * `.sc-window` 上有 `transform: scale()` + `filter`，多一个内联自定义属性会让
 * 浏览器按另一条合成路径栅格化，window_rain 的 PSNR 从 inf 掉到 42.9dB。
 * parallax 目前只作为数据（真正的视差位移逻辑还没写），所以不需要落到 DOM。
 */
function Plane({ plane, children }: { plane: DepthPlane; children: ReactNode }) {
  return (
    <div className={`sc-${plane.id}`} data-plane={plane.id}>
      {children}
    </div>
  );
}

/** 层 id → 这一层的内容。没有渲染器的层（示例场景）由 unsupportedPlanes() 报出，不静默 */
export const PLANE_RENDERERS: Partial<Record<PlaneId, (spec: SceneSpec) => ReactNode>> = {
  // ---- 室内墙面 / 吧台 / 吊灯（最远） ----
  room: () => (
    <>
      <div className="wall" />
      <div className="wall-warm" />
      <div className="shelf" />
      <div className="chairs">
        <span className="chair c1" />
        <span className="chair c2" />
        <span className="chair c3" />
      </div>
      <div className="counter" />
      <div className="hang-lamp">
        <span className="cord" />
        <span className="shade" />
        <span className="cone" />
      </div>
      <div className="floor" />
    </>
  ),

  // ---- 窗与窗外雨街（中景） ----
  window: (spec) => (
    <>
      <div className="street">
        <div className="sky" />
        <div className="bldg b1" />
        <div className="bldg b2" />
        <div className="bldg b3" />
        <div className="lamp-post" />
        <div className="lamp-halo" />
        <div className="rain-layer rain-far" aria-hidden="true">
          <RainSheet streaks={streaksFor(spec, "rain_far")} />
        </div>
      </div>
      <div className="glass-tint" />
      <div className="glass-drops">
        {DROPS.slice(0, particleCount(spec, "glass_drops")).map((d) => (
          <i
            key={d.id}
            style={
              {
                left: `${d.x}%`,
                top: `${d.y}%`,
                width: `${d.r * 2}px`,
                height: `${d.r * 2.5}px`,
                opacity: d.o,
                animationDelay: `${d.delay}s`,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="frame" />
      <div className="mullion mv1" />
      <div className="mullion mv2" />
      <div className="mullion mh1" />
    </>
  ),

  // ---- 暖光池 / 桌面 / 咖啡热气（角色身后） ----
  warm: (spec) => (
    <>
      <div className="warm-pool" />
      <div className="table">
        <span className="table-top" />
        <span className="table-leg" />
        <span className="table-saucer" />
        <span className="table-cup" />
      </div>
      <div className="steam">
        {Array.from({ length: particleCount(spec, "steam") }, (_, i) => (
          <i key={i} />
        ))}
      </div>
    </>
  ),

  // ---- 破晓天幕：渐变 + 日晕 + 薄云（最远） ----
  sky: () => (
    <>
      <div className="dawn-sky" />
      <div className="dawn-sun-glow" />
      <div className="dawn-sun" />
      <div className="dawn-cloud c1" />
      <div className="dawn-cloud c2" />
      <div className="dawn-cloud c3" />
    </>
  ),

  // ---- 海面：波线 + 反光 + 海鸥（中景） ----
  sea: () => (
    <>
      <div className="sea-water" />
      <div className="sea-glitter" />
      <div className="sea-waves">
        {SEA_WAVES.map((wave, i) => (
          <WaveLine key={i} wave={wave} />
        ))}
      </div>
      <div className="sea-gulls">
        {GULLS.map((gull, i) => (
          <Gull key={i} gull={gull} />
        ))}
      </div>
    </>
  ),

  // ---- 岸线：沙滩 + 礁石 + 风力细节（近景） ----
  shore: (spec) => (
    <>
      <div className="shore-sand" />
      <div className="shore-wet" />
      <div className="shore-foam" />
      <div className="shore-rocks">
        {ROCKS.map((rock, i) => (
          <Rock key={i} rock={rock} />
        ))}
      </div>
      {hasProp(spec, "wind") && (
        <div className="shore-wind" aria-hidden="true">
          {WIND_LINES.map((line, i) => (
            <span
              key={i}
              style={{
                top: `${line.top}%`,
                left: `${line.left}%`,
                width: `${line.width}%`,
                opacity: line.opacity,
                animationDelay: `${line.delay}s`,
                animationDuration: `${line.duration}s`,
              }}
            />
          ))}
        </div>
      )}
    </>
  ),

  // ---- 前景雨幕 / 水汽 / 暗角 / 闪电 ----
  fg: (spec) => (
    <>
      <div className="rain-layer rain-near" aria-hidden="true">
        <RainSheet streaks={streaksFor(spec, "rain_near")} />
      </div>
      {hasProp(spec, "sea_spray") && (
        <div className="sea-spray" aria-hidden="true">
          {SPRAY_DOTS.map((dot, i) => (
            <i
              key={i}
              style={{
                left: `${dot.left}%`,
                width: `${dot.size}px`,
                height: `${dot.size}px`,
                animationDelay: `${dot.delay}s`,
                animationDuration: `${dot.duration}s`,
              }}
            />
          ))}
        </div>
      )}
      <div className="haze" />
      <div className="vignette" />
      <div className="lightning">
        <span />
      </div>
    </>
  ),
};

export function StageBackdrop({ scene }: { scene: SceneVariant }) {
  const spec = specOf(scene);
  return (
    <div className="scene" data-scene={scene}>
      {spec.depthPlanes.map((plane) => {
        const render = PLANE_RENDERERS[plane.id];
        // 没有渲染器的层不画，但缺口是显式的（unsupportedPlanes / 测试会发现），
        // 不是悄悄少一层背景
        if (!render) return null;
        return (
          <Plane key={plane.id} plane={plane}>
            {render(spec)}
          </Plane>
        );
      })}
    </div>
  );
}
