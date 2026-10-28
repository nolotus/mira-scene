/**
 * Cues —— 演出编排层的渲染端。
 *
 * 职责边界：
 *   · 编排（谁先谁后、多长、多强）全在 cues.ts 的纯函数里；
 *   · 这里只做两件事：把 Cue 的各层时间线写成 **CSS 变量**，把 Cue 的生命周期
 *     （running / fading）写成 **data 属性**；之后画面全靠 CSS 动画推进。
 *
 * 性能红线：**不在 60fps 里 setState**。
 *   SceneState 每帧都在变（vfx 衰减），所以这里用 cueSignature() 做闸门：
 *   只有 beat / 镜头 / 命中类型变化时才跑一次调度；调度结果没变化时 React 收到的是
 *   同一个对象引用，直接跳过重渲染。整条时间线由 animation-delay + animation-duration
 *   表达，浏览器合成器自己跑，主线程零负担。
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SceneState } from "../../shared/protocol";
import type { Cue, CueLayer, CueScheduler, CueState, CueTarget } from "./cues.ts";
import {
  FADE_OUT_MS,
  createCueScheduler,
  cueSignature,
  nextBoundaryAt,
} from "./cues.ts";
import "../styles/cues.css";

const vars = (o: Record<string, string>): CSSProperties => o as CSSProperties;

const layerOf = (cue: Cue, target: CueTarget): CueLayer | null =>
  cue.layers.find((l) => l.target === target) ?? null;

/** 一层的时间线 → CSS 变量（一次写入，之后由 CSS 动画消费） */
function layerVars(layer: CueLayer): Record<string, string> {
  return {
    "--cue-from": String(layer.from),
    "--cue-to": String(layer.to),
    "--cue-at": `${layer.atMs}ms`,
    "--cue-dur": `${layer.durationMs}ms`,
  };
}

/**
 * 一条 cue 的视觉层。DOM 顺序 = 绘制顺序：
 * 雨幕 → 暖光 → 角色补光 → 闪电爆闪 → 压暗。
 * `pointer-events: none` 由 cues.css 统一保证，这里不渲染任何可交互元素。
 */
function CueStage({
  cue,
  fading,
  fadeMs,
}: {
  cue: Cue;
  fading: boolean;
  fadeMs: number;
}) {
  const rain = layerOf(cue, "rain");
  const glow = layerOf(cue, "glow");
  const char = layerOf(cue, "char");
  const flash = layerOf(cue, "lightning");
  const camera = layerOf(cue, "camera");

  const stageVars: Record<string, string> = {
    "--cue-i": String(cue.intensity),
    "--cue-dur": `${cue.durationMs}ms`,
    "--cue-fade": `${fadeMs}ms`,
  };
  if (camera) {
    stageVars["--cue-cam-at"] = `${camera.atMs}ms`;
    stageVars["--cue-cam-dur"] = `${camera.durationMs}ms`;
    stageVars["--cue-cam-amp"] = String(camera.from);
  }

  return (
    <div
      className="cue-stage"
      data-kind={cue.kind}
      data-state={fading ? "fading" : "running"}
      data-cam={camera ? "on" : "off"}
      style={vars(stageVars)}
      aria-hidden="true"
    >
      {rain ? <div className="cue-layer cue-rain" style={vars(layerVars(rain))} /> : null}
      {glow ? <div className="cue-layer cue-glow" style={vars(layerVars(glow))} /> : null}
      {char ? <div className="cue-layer cue-char" style={vars(layerVars(char))} /> : null}
      {flash ? <div className="cue-layer cue-flash" style={vars(layerVars(flash))} /> : null}
      <div className="cue-layer cue-dim" />
    </div>
  );
}

export interface CuesProps {
  state: SceneState;
}

export function Cues({ state }: CuesProps) {
  const schedulerRef = useRef<CueScheduler | null>(null);
  if (schedulerRef.current === null) schedulerRef.current = createCueScheduler();
  const scheduler = schedulerRef.current;

  const [snapshot, setSnapshot] = useState<CueState>(() => scheduler.state());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneState>(state);
  sceneRef.current = state;
  const sigRef = useRef<string>("");

  // 1) 闸门：内容指纹变了才跑一次调度；vfx 逐帧衰减进不来
  useEffect(() => {
    const sig = cueSignature(sceneRef.current);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    // 引用没变时 React 会跳过重渲染，所以这里不额外判断
    setSnapshot(scheduler.update(sceneRef.current));
  }, [scheduler, state]);

  // 2) 只在「边界时刻」唤醒一次（cue 演完 / 淡出结束），不是逐帧轮询
  useEffect(() => {
    let stopped = false;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      const boundary = nextBoundaryAt(scheduler.state());
      if (boundary === null) return;
      const wait = Math.max(16, boundary - scheduler.now());
      handle = setTimeout(() => {
        if (stopped) return;
        setSnapshot(scheduler.update(sceneRef.current));
        arm();
      }, wait);
    };
    arm();
    return () => {
      stopped = true;
      if (handle !== null) clearTimeout(handle);
    };
  }, [scheduler, snapshot.version]);

  const active = snapshot.active;
  const fadingCue = snapshot.fadeOut;

  if (!active && !fadingCue) return null;

  return (
    <div className="cue-root" ref={rootRef} aria-hidden="true">
      {/* 旧 cue 不消失，只是淡出——硬切会让「一段演出」变成两次闪断 */}
      {fadingCue ? (
        <CueStage
          key={fadingCue.cue.id}
          cue={fadingCue.cue}
          fading
          fadeMs={fadingCue.durationMs}
        />
      ) : null}
      {active ? (
        <CueStage key={active.id} cue={active} fading={false} fadeMs={FADE_OUT_MS} />
      ) : null}
    </div>
  );
}
