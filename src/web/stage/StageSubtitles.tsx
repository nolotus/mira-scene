import { useEffect, useState } from "react";
import type { SceneState } from "../../shared/protocol";
import { advanceSubtitleHistory, type SubtitleHistory } from "./subtitleHistory";

/** 残影不重复播报；读屏只读取当前句。 */
export function SubtitleLines({ current, previous }: Pick<SubtitleHistory, "current" | "previous">) {
  return <>
    {previous ? <p className="sub-history" aria-hidden="true">{previous}</p> : null}
    <p className="sub">{current}</p>
  </>;
}

export function StageSubtitles({ state }: { state: SceneState }) {
  const { scene, subtitle, characterStatus: status } = state;
  const [snapshot, setSnapshot] = useState(() => ({
    scene, subtitle, status,
    history: { scene, observed: subtitle.trim(), current: subtitle.trim(), previous: "", candidate: "" } as SubtitleHistory,
  }));
  let history = snapshot.history;
  if (snapshot.scene !== scene || snapshot.subtitle !== subtitle || snapshot.status !== status) {
    history = advanceSubtitleHistory(history, scene, subtitle, status);
    setSnapshot({ scene, subtitle, status, history });
  }
  const visible = !!subtitle.trim();
  // 清空/打断：先淡出已有文字，之后卸载；新文本到来会取消旧计时器。
  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setSnapshot((s) => ({
      ...s, history: { ...s.history, current: "", previous: "" },
    })), 340);
    return () => clearTimeout(timer);
  }, [visible, scene, status]);

  return <div
    className="stage-subtitle"
    data-empty={visible ? "false" : status === "thinking" ? "thinking" : "true"}
    data-history={history.previous ? "true" : "false"}
  >
    <div className="subtitle-lines" data-visible={visible ? "true" : "false"} aria-live="polite" aria-hidden={!visible}>
      {history.current ? <SubtitleLines current={history.current} previous={history.previous} /> : null}
    </div>
    {!visible && status === "thinking" ? <div className="thinking-cue" role="status" aria-label="Mira 正在思考">
      <span className="thinking-dots" aria-hidden="true">
        <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
      </span>
      <span className="thinking-text">Mira 正在思考…</span>
    </div> : null}
  </div>;
}
