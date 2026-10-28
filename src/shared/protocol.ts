/**
 * 会话协议 —— 前后端唯一契约。
 *
 * 设计要点（对应题目「打断」与「迟到响应」硬要求）：
 * 1. 每个 turn 携带 epoch。epoch 由客户端维护并单调递增，每次「打断」+1。
 * 2. 服务端把 epoch 原样回显到每一条事件上。
 * 3. 客户端只接受 epoch === currentEpoch 的事件，其余全部丢弃。
 *    → 上一轮迟到的网络响应无法覆盖当前状态、无法重新开始播放。
 * 4. 音频按 seq 递增分片；播放器在 epoch 变化时立即 stop + 清空队列。
 *
 * 设计要点（对应「角色驱动画面」要求）：
 * 5. 模型不直接改 DOM，只产出 Directive 数组；渲染层是纯函数：
 *    SceneState + Directive → SceneState。
 *    这样 Mock 导演、真 LLM 导演、回放导演共用同一条渲染路径。
 */

import type { DirectorFallbackReason } from "./director";

// ---------------------------------------------------------------- 视觉词汇表

/** 情绪（题目要求至少 3 种可辨认） */
export type Emotion =
  | "neutral"
  | "curious"
  | "warm"
  | "amused"
  | "anxious"
  | "sad"
  | "surprised";

/** 姿势/非说话视觉状态（题目要求至少 2 种） */
export type Pose =
  | "stand"
  | "lean_in" // 前倾靠近
  | "turn_away" // 侧身避开视线
  | "hold_cup" // 双手握杯
  | "glance_window"; // 望向窗外

/** 一次性动作（与姿势互补：姿势是持续态，动作是瞬时事件） */
export type Action =
  | "blink"
  | "hair_tuck" // 别头发（星星发夹）
  | "sigh"
  | "shiver"
  | "look_back"
  | "nod"
  | "startle";

/** 镜头 */
export type CameraMove = "push_in" | "pull_back" | "whip_pan" | "shake" | "settle";

/** 环境/特效 */
export type Vfx =
  | "lightning" // 闪电一次
  | "rain_heavy" // 雨势加大（持续态）
  | "rain_light"
  | "warm_glow" // 暖光
  | "lights_dim" // 灯光变暗（打烊）
  | "steam_wisp"; // 咖啡热气

/**
 * 场景/环境变化（题目要求至少 1 次背景、镜头或环境变化）
 *
 * 客户端认识四种 id，其中 `seaside_dawn` 是**示例场景**：它在 `scenes/spec.ts` 里有
 * 完整的数据（用来证明「加地点 = 加数据」），但还没有渲染器、也不进任何选择器 UI。
 * 服务端的场景白名单（src/server/scene/validate.ts）**故意不放行它**：
 * 那是枚举合法性层，这里多一个 id 不会让模型凭空切到没有渲染器的场景。
 */
export type SceneVariant = "cafe_night" | "cafe_closing" | "window_rain" | "seaside_dawn";

/** 剧情分支选项（可选，非必须项） */
export interface Branch {
  id: string;
  label: string;
}

// ------------------------------------------------------------------ 指令

export type Directive =
  | { kind: "emotion"; emotion: Emotion }
  | { kind: "pose"; pose: Pose }
  | { kind: "action"; action: Action }
  | { kind: "camera"; move: CameraMove }
  | { kind: "vfx"; vfx: Vfx }
  | { kind: "scene"; scene: SceneVariant }
  | { kind: "branch"; options: Branch[] };

/** 角色在画面上的状态（题目要求：待机、倾听、思考、说话） */
export type CharacterStatus = "idle" | "listening" | "thinking" | "speaking";

// ------------------------------------------------------------------ 事件

export type SessionEvent =
  | { type: "turn.start"; turnId: string; epoch: number; at: number }
  | { type: "text.delta"; turnId: string; epoch: number; text: string }
  | { type: "directive"; turnId: string; epoch: number; directive: Directive }
  /** 音频分片：dataUrl 为 base64 编码的音频；Mock 模式不产生此事件（改用浏览器 TTS） */
  | {
      type: "audio.chunk";
      turnId: string;
      epoch: number;
      seq: number;
      dataUrl: string;
      mime: string;
    }
  | { type: "audio.end"; turnId: string; epoch: number }
  | {
      type: "turn.end";
      turnId: string;
      epoch: number;
      interrupted: boolean;
      /** 关键阶段耗时（毫秒），用于观测页与 README 延迟说明 */
      timings?: Record<string, number>;
    }
  | { type: "error"; turnId: string; epoch: number; message: string; recoverable: boolean };

// ------------------------------------------------------------------ 请求

export interface TurnRequest {
  sessionId: string;
  turnId: string;
  epoch: number;
  /** 用户这一轮的输入（文字，或由语音转写而来） */
  userText: string;
  /** 客户端当前画面状态，供导演参考（保持角色一致性） */
  scene: SceneSnapshot;
  /** 本轮之前的历史（服务端也会自持一份，这里用于回放/无状态模式） */
  history: Array<{ role: "user" | "character"; text: string }>;
}

export interface SceneSnapshot {
  scene: SceneVariant;
  emotion: Emotion;
  pose: Pose;
  /** 已播放过的显著视觉事件，避免重复触发 */
  playedBeats: string[];
}

// ------------------------------------------------------------------ 渲染层契约

/** 渲染层唯一输入：纯状态，不含网络/时钟逻辑 */
export interface SceneState {
  scene: SceneVariant;
  emotion: Emotion;
  pose: Pose;
  camera: CameraMove | null;
  vfx: Partial<Record<Vfx, number>>; // vfx → 剩余强度 0..1
  characterStatus: CharacterStatus;
  /** 瞬时动作队列（渲染层消化后应自行清空） */
  pendingActions: Action[];
  /** 当前显示的字幕 */
  subtitle: string;
  branches: Branch[];
  /** 由当前对话触发的显著视觉事件 id（题目要求：不能只按定时器播放） */
  lastBeat: string | null;
}

/** 给渲染组件的 props —— 渲染组件必须是纯展示，不自己发请求 */
export interface StageProps {
  state: SceneState;
  onBranchPick?: (id: string) => void;
}

// ------------------------------------------------------------------ 导演

export interface DirectorInput {
  userText: string;
  scene: SceneSnapshot;
  history: Array<{ role: "user" | "character"; text: string }>;
  turnId: string;
  epoch: number;
}

/**
 * 导演 = 产出结构化指令的流。Mock 导演、真模型导演、回放导演都实现它。
 * 必须响应 signal 中止（打断时服务端要停止产出与推送）。
 */
export interface Director {
  readonly name: string;
  stream(input: DirectorInput, signal: AbortSignal): AsyncIterable<SessionEvent>;
}

// ------------------------------------------------------------------ 会话

export interface SessionInfo {
  sessionId: string;
  mode: "mock" | "live";
  directorName: string;
  /** 零密钥可跑标志：true 表示无需任何私钥即可体验完整流程 */
  keyless: boolean;
  /**
   * 请求了真模型却被会话回落成 Mock 的原因（没回落时为 null / 缺省）。
   * 界面必须把原因显示出来，不许静默：`DIRECTOR=mock` 强制、或服务端没配密钥。
   */
  fallbackReason?: DirectorFallbackReason | null;
}

/** POST /api/turn/:turnId/cancel 的返回值 */
export interface CancelResult {
  cancelled: boolean;
  epoch: number;
}
