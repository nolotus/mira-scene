/**
 * 场景背景 —— 4 层景深（室内墙面 / 窗与街景 / 暖光池 / 前景雨幕与水汽）。
 *
 * 全部是 CSS 渐变 + 少量内联 SVG 几何，没有任何图片或字体请求。
 * 雨幕用「一整条长带循环下滑」实现：只有一个动画，几十根雨丝一起动，
 * 靠上下两段相同内容保证无缝 —— 比给每根雨丝单独挂动画便宜一个数量级。
 */

import type { CSSProperties } from "react";
import type { SceneVariant } from "../../shared/protocol";
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

const FAR_STREAKS = buildStreaks(52, 20261028, 34, 108, 1.1, 2.2, 0.3, 0.8);
const NEAR_STREAKS = buildStreaks(17, 77193, 110, 300, 1.6, 3.4, 0.07, 0.2);

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

export function StageBackdrop({ scene }: { scene: SceneVariant }) {
  return (
    <div className="scene" data-scene={scene}>
      {/* ---- 第 1 层：室内墙面 / 吧台 / 吊灯（背景） */}
      <div className="sc-room">
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
      </div>

      {/* ---- 第 2 层：窗与窗外雨街（中景） */}
      <div className="sc-window">
        <div className="street">
          <div className="sky" />
          <div className="bldg b1" />
          <div className="bldg b2" />
          <div className="bldg b3" />
          <div className="lamp-post" />
          <div className="lamp-halo" />
          <div className="rain-layer rain-far" aria-hidden="true">
            <RainSheet streaks={FAR_STREAKS} />
          </div>
        </div>
        <div className="glass-tint" />
        <div className="glass-drops">
          {DROPS.map((d) => (
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
      </div>

      {/* ---- 第 3 层：暖光池 / 桌面 / 咖啡热气（角色身后） */}
      <div className="sc-warm">
        <div className="warm-pool" />
        <div className="table">
          <span className="table-top" />
          <span className="table-leg" />
          <span className="table-cup" />
        </div>
        <div className="steam">
          <i />
          <i />
          <i />
        </div>
      </div>

      {/* ---- 第 4 层：前景雨幕 / 水汽 / 暗角 / 闪电 */}
      <div className="sc-fg">
        <div className="rain-layer rain-near" aria-hidden="true">
          <RainSheet streaks={NEAR_STREAKS} />
        </div>
        <div className="haze" />
        <div className="vignette" />
        <div className="lightning">
          <span />
        </div>
      </div>
    </div>
  );
}
