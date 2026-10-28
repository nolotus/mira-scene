/**
 * IllustrationLayer —— 生成式插图的渲染层。
 *
 * 层级（与 clip.css 同一套策略）：角色(z auto) < cue(2) < 片段(3) < **插图(4)** < 字幕/输入(5)。
 * 满屏 cover：竖屏下 1024² 图铺满整幅，不做 16:9 横带（会把角色拦腰截断）。
 *
 * 三条行为约定：
 *   · 入场淡入，4s 后淡出回落角色 —— 淡出由 CSS 承担（3.52s 起 0.48s），控制器只负责到点卸载；
 *   · 生成期间只有一行轻提示「正在生成这一幕…」，整层 pointer-events: none，
 *     角色照常表演、字幕照常增长、输入框照常可打字；
 *   · 任何时刻 epoch 变化 → 控制器进终态、组件立刻返回 null，**没有淡出动画**（要的就是"立刻消失"）。
 *
 * 触发与片段同源（storm 命中），但**不抢屏**：arm 之后先等片段终态（或 3s grace），
 * 片段让出画面后才请求。同一会话最多一次请求由控制器与状态机双重闩住。
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SceneState } from "../../../shared/protocol";
import {
  getClipPhase,
  getSessionSignal,
  hasPlayedClip,
  subscribeClipPhase,
  subscribeSessionSignal,
} from "../clip/clipBus";
import { CLIP_ID, isStormShot } from "../clip/clipState";
import { illustrationHintVisible, illustrationVisible } from "./illustrationState";
import { getIllustrationRuntime } from "./illustrationRuntime";
import "./illustration.css";

export interface IllustrationLayerProps {
  state: SceneState;
}

export function IllustrationLayer({ state }: IllustrationLayerProps) {
  const runtime = useMemo(() => getIllustrationRuntime(), []);
  const controller = runtime.controller;
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    () => controller.state,
    () => controller.state,
  );

  // 打断源：epoch 变化 / 新一轮 → 立刻进终态。迟到的 resolve 由控制器的 generation 丢弃。
  useEffect(
    () =>
      subscribeSessionSignal((reason) => {
        controller.abort(reason === "epoch" ? "epoch" : "turn");
      }),
    [controller],
  );

  // 片段相位：先让片段占屏（取消 grace），到终态再放行插图
  useEffect(
    () =>
      subscribeClipPhase((phase) => {
        if (phase === "loading" || phase === "playing") {
          controller.clipStarted();
          return;
        }
        if (phase === "ended" || phase === "failed" || phase === "interrupted") {
          controller.release(phase);
        }
      }),
    [controller],
  );

  // 触发：与片段同源（storm 类 beat）
  const storm = isStormShot(state);
  useEffect(() => {
    if (!storm) return;
    controller.arm({
      sessionId: getSessionSignal()?.sessionId ?? null,
      beatId: "storm",
      scene: state.scene,
    });
    // 片段本会话已经播过（不会再占屏）→ 不再等它
    const phase = getClipPhase();
    if (phase === "ended" || phase === "failed" || phase === "interrupted") {
      controller.release(phase);
    } else if (phase === "idle" && hasPlayedClip(CLIP_ID)) {
      controller.release("absent");
    }
  }, [storm, state.scene, controller]);

  // 卸载等价于一次中止（不写诊断：这不是运行时故障）
  useEffect(() => {
    return () => controller.abort("unmount");
  }, [controller]);

  const showing = illustrationVisible(snapshot);
  const hint = illustrationHintVisible(snapshot);
  if (!showing && !hint) return null;

  return (
    <div
      className="illustration-layer"
      data-phase={snapshot.phase}
      data-cached={snapshot.cached ? "1" : "0"}
    >
      {showing ? (
        <img
          className="illustration-image"
          // seq 变化才重新挂载：同一张图重渲染不重播动画
          key={`illus-${snapshot.seq}`}
          src={snapshot.dataUrl ?? ""}
          alt=""
          draggable={false}
          aria-hidden="true"
        />
      ) : null}
      {hint ? (
        <p className="illustration-hint" role="status">
          正在生成这一幕…
        </p>
      ) : null}
    </div>
  );
}
