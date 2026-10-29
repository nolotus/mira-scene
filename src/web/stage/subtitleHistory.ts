import type { CharacterStatus, SceneVariant } from "../../shared/protocol";

export interface SubtitleHistory {
  scene: SceneVariant;
  observed: string;
  current: string;
  previous: string;
  /** 完成上一轮后、等待下一句时保留；打断则丢弃。 */
  candidate: string;
}

export function advanceSubtitleHistory(
  history: SubtitleHistory,
  scene: SceneVariant,
  text: string,
  status: CharacterStatus,
): SubtitleHistory {
  const current = text.trim();
  if (history.scene !== scene) {
    return { scene, observed: current, current, previous: "", candidate: "" };
  }
  if (!current) {
    return {
      ...history,
      observed: "",
      candidate: status === "thinking" ? history.observed || history.candidate : "",
    };
  }
  if (current === history.observed) return history;
  // text.delta 累加不是新的一句：避免把每个 token 都变成历史。
  const streaming = !!history.observed && current.startsWith(history.observed);
  const previous = streaming ? history.previous : history.observed || history.candidate;
  return { scene, observed: current, current, previous: previous === current ? "" : previous, candidate: "" };
}
