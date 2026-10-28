/**
 * Stage —— 渲染层唯一出口。
 *
 * 契约：StageProps = { state: SceneState; onBranchPick? }（见 src/shared/protocol.ts，已冻结）。
 * 这里只做「状态 → 画面」的纯映射：
 *   · SceneState 是唯一输入，组件不发请求、不读时钟、不持有剧情；
 *   · 所有瞬时动作（camera / lastBeat / pendingActions）都用「变化即重播」的 key 触发，
 *     同一次状态变化只播一次，不会因为上层重渲染而反复播放；
 *   · 底部 <div id="dock" /> 留给上层注入文字与语音入口，本组件不渲染任何交互逻辑。
 */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { StageProps } from "../../shared/protocol";
import { Character } from "./Character";
import { ClipPlayer } from "./clip/ClipPlayer";
import { Cues } from "./Cues";
import { IllustrationLayer } from "./illustration/IllustrationLayer";
import { StageBackdrop } from "./StageBackdrop";
import { STATUS_LABEL, toneOf, vfxVars } from "./visuals";
import { sceneVars, specOf } from "./scenes/spec";
import "../styles/stage.css";

const vars = (o: Record<string, string>): CSSProperties => o as CSSProperties;

/**
 * 把「值」变成「触发计数」：值变化时计数 +1，且对 StrictMode 的重复 effect 幂等。
 * 返回的 key 与计数用来驱动 CSS 动画（key 变化 = 动画重播，而不是 reset 整棵 DOM）。
 */
function useTrigger(key: string): { key: string; n: number } {
  const [token, setToken] = useState({ key, n: 0 });
  useEffect(() => {
    setToken((prev) => (prev.key === key ? prev : { key, n: prev.n + 1 }));
  }, [key]);
  return token;
}

export function Stage({ state, onBranchPick }: StageProps) {
  const camera = useTrigger(state.camera ?? "none");
  const beat = useTrigger(state.lastBeat ?? "");
  const action = useTrigger(state.pendingActions.join(" "));

  const tone = state.lastBeat ? toneOf(state.lastBeat) : 0;
  const hasSubtitle = state.subtitle.trim().length > 0;

  return (
    <div
      className="stage-root"
      data-scene={state.scene}
      data-emotion={state.emotion}
      data-status={state.characterStatus}
      data-pose={state.pose}
    >
      <div className="stage-canvas" style={vars(vfxVars(state.vfx))}>
        <div
          className="stage-camera"
          data-cam={camera.key}
          data-par={camera.n % 2}
          style={vars(sceneVars(specOf(state.scene)))}
        >
          <StageBackdrop scene={state.scene} />
          <Character state={state} actionNonce={action.n} />
          {/* 由对话触发的显著视觉事件：每次 lastBeat 变化重播一次 */}
          <div className="stage-beat" key={`beat-${beat.n}`} data-tone={tone} aria-hidden="true">
            <span className="beat-sweep" />
            <span className="beat-ring" />
          </div>
          {/* 演出编排层：把这一句触发的离散指令编成一段有时长的演出（角色之上、字幕之下） */}
          <Cues state={state} />
          {/* 真媒体片段（spritesheet）：storm 演出命中时播一次；层级在角色之上、字幕之下 */}
          <ClipPlayer state={state} />
          {/* 生成式插图：与片段同源但排在它之后（片段先播完才请求），层级夹在片段与字幕之间 */}
          <IllustrationLayer state={state} />
        </div>

        <header className="stage-hud" aria-hidden="true">
          <span className="hud-dot" />
          <span className="hud-name">Mira</span>
          <span className="hud-state">{STATUS_LABEL[state.characterStatus]}</span>
        </header>

        <div className="stage-ui">
          {state.branches.length > 0 ? (
            <div className="stage-branches" role="group" aria-label="可选回应">
              {state.branches.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="branch"
                  onClick={() => onBranchPick?.(b.id)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="stage-subtitle" data-empty={hasSubtitle ? "false" : "true"} aria-live="polite">
            <p key={`sub-${beat.n}`} className="sub">
              {state.subtitle}
            </p>
          </div>

          {/* 交互入口的固定挂载槽位：文字 / 语音控件由上层注入，本层只负责位置与安全区 */}
          <div id="dock" className="stage-dock" />
        </div>
      </div>
    </div>
  );
}
