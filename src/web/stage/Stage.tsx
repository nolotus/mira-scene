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

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { StageProps } from "../../shared/protocol";
import { describePresence, type Presence } from "../state/presence";
import { Character } from "./Character";
import { prefetchLine, prefetchSnapshot, startPrefetchAfterLoad, subscribePrefetch } from "./preload";
import { ClipPlayer } from "./clip/ClipPlayer";
// 显式扩展名：本目录同时存在 cues.ts（数据层）与 Cues.tsx（渲染层），
// 在大小写不敏感的文件系统（macOS 默认 APFS）上裸写 "./Cues" 会先命中 cues.ts。
import { Cues } from "./Cues.tsx";
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

export function Stage({
  state,
  onBranchPick,
  presence,
  presenceDebug,
  mouthPhase,
}: StageProps & {
  /**
   * 在场状态（只读消费）：渲染层不推导它，只照着画。
   * 缺省（未接线 / preview 页）时口型退回原行为，三条像素验收路径不受影响。
   */
  presence?: Presence;
  mouthPhase?: number;
  /** `?trace=1`：HUD 多一行 `在场状态：speaking ← tts:playing`，用于对拍与录屏取证 */
  presenceDebug?: boolean;
}) {
  const camera = useTrigger(state.camera ?? "none");
  const beat = useTrigger(state.lastBeat ?? "");
  const action = useTrigger(state.pendingActions.join(" "));

  const tone = state.lastBeat ? toneOf(state.lastBeat) : 0;
  const hasSubtitle = state.subtitle.trim().length > 0;

  /**
   * 素材预取：load 之后 300ms（或空闲回调）才启动，省流模式整轮跳过。
   * 失败只记诊断，不阻塞任何渲染 —— 首帧永远不等它。
   */
  const prefetch = useSyncExternalStore(subscribePrefetch, prefetchSnapshot, prefetchSnapshot);
  useEffect(() => {
    startPrefetchAfterLoad();
  }, []);
  /** `?trace=1`：把预取时间线放到 HUD 上，截图脚本与录屏都能直接读到 */
  const trace = useMemo(
    () => (typeof window === "undefined" ? false : new URLSearchParams(window.location.search).get("trace") === "1"),
    [],
  );

  return (
    <div
      className="stage-root"
      data-scene={state.scene}
      data-emotion={state.emotion}
      data-status={state.characterStatus}
      data-presence={presence?.status ?? undefined}
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
          <Character state={state} actionNonce={action.n} mouthDrive={presence?.mouthDrive} mouthPhase={mouthPhase} />
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
          {presenceDebug && presence ? (
            <span
              className="hud-state"
              data-presence-reason={presence.reason}
              style={{ opacity: 0.62 }}
            >
              {`在场状态：${describePresence(presence)}`}
            </span>
          ) : null}
          {trace ? (
            <span
              className="hud-state"
              data-prefetch={prefetch.skipped ? "skipped" : prefetch.entries.map((e) => `${e.name}:${e.state}`).join(",")}
              data-prefetch-started-at={prefetch.scheduledAt ?? ""}
              style={{ opacity: 0.62 }}
            >
              {prefetchLine(prefetch)}
            </span>
          ) : null}
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

          <div
            className="stage-subtitle"
            data-empty={hasSubtitle ? "false" : state.characterStatus === "thinking" ? "thinking" : "true"}
            aria-live="polite"
          >
            {hasSubtitle ? (
              <p key={`sub-${beat.n}`} className="sub">
                {state.subtitle}
              </p>
            ) : state.characterStatus === "thinking" ? (
              <div className="thinking-cue" role="status" aria-label="Mira 正在思考">
                <span className="thinking-dots" aria-hidden="true">
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                  <span className="thinking-dot" />
                </span>
                <span className="thinking-text">Mira 正在思考…</span>
              </div>
            ) : null}
          </div>

          {/* 交互入口的固定挂载槽位：文字 / 语音控件由上层注入，本层只负责位置与安全区 */}
          <div id="dock" className="stage-dock" />
        </div>
      </div>
    </div>
  );
}
