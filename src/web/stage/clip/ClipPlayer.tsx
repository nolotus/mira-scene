/**
 * ClipPlayer —— 真正的一段媒体片段：canvas 逐帧播放 spritesheet。
 *
 * 为什么不用 SVG：SVG 角色动画没有「资源」可加载、可解码失败、可播放结束。
 * 这条片段有：
 *   · 加载：fetch(→ 404 可测) + Image.decode()（→ 解码失败可测），期间只显示一行轻提示；
 *   · 播放：12fps 从 320×180 的 spritesheet 里逐帧 drawImage，播完自动回落角色；
 *   · 打断：会话换 epoch / 用户打断 / 新一轮开始 → 立刻停帧、隐藏，迟到的异步结果全部丢弃；
 *   · 失败：静默降级为角色画面，同时在诊断区留一条可见记录（不是 console 里悄悄错）。
 *
 * 生命周期全部由 clipState.ts 的纯状态机决定，这里只负责 DOM 与时间。
 * 触发源是「storm 类演出命中」（cue 命中 storm / vfx: lightning），不是定时器。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SceneState } from "../../../shared/protocol";
import { parseDemoFlag } from "../../ui/demo";
import {
  CLIP_DURATION_MS,
  CLIP_FRAME_H,
  CLIP_FRAME_W,
  CLIP_FRAMES,
  CLIP_ID,
  IDLE_CLIP,
  abortReasonLabel,
  clipReducer,
  clipSrcFor,
  clipVisible,
  frameAt,
  isStormShot,
  type AbortReason,
  type ClipState,
} from "./clipState";
import {
  hasPlayedClip,
  markClipPlayed,
  recordClipDiagnostic,
  registerClipAbort,
  subscribeSessionSignal,
} from "./clipBus";
import "./clip.css";

export interface ClipPlayerProps {
  state: SceneState;
  /** 自然播完时回调，恰好一次（状态机的 reports.ended 保证不会重复） */
  onEnded?: () => void;
  /** 静默降级时回调，恰好一次；诊断记录由 clipBus 负责 */
  onFailed?: (message: string) => void;
}

/** 只把当前帧画到 2 倍尺寸的 canvas 上（640×360），缩放交给 CSS */
function drawFrame(canvas: HTMLCanvasElement | null, image: HTMLImageElement, index: number): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    image,
    index * CLIP_FRAME_W,
    0,
    CLIP_FRAME_W,
    CLIP_FRAME_H,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

export function ClipPlayer({ state, onEnded, onFailed }: ClipPlayerProps) {
  const [clip, setClip] = useState<ClipState>(IDLE_CLIP);
  const [frame, setFrame] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 当前这一次播放的中止入口；外部（会话信号 / 用户打断）都打到它 */
  const abortRef = useRef<((reason: AbortReason) => void) | null>(null);
  const endedFired = useRef(false);

  const callbacks = useRef({ onEnded, onFailed });
  useEffect(() => {
    callbacks.current = { onEnded, onFailed };
  }, [onEnded, onFailed]);

  // ?demo=media → 用一个必定 404 的地址，当场演示「失败 → 静默降级 → 诊断留痕」
  const demo = useMemo(
    () => parseDemoFlag(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const src = useMemo(() => clipSrcFor(demo.faults.includes("media")), [demo]);
  const storm = isStormShot(state);

  // onEnded 恰好一次：reports.ended 由状态机保证最多 1
  useEffect(() => {
    if (clip.reports.ended === 1 && !endedFired.current) {
      endedFired.current = true;
      callbacks.current.onEnded?.();
    }
  }, [clip.reports.ended]);

  // 会话信号（epoch 变化 / 新一轮开始）→ 立刻停帧；本轮结束不算打断
  useEffect(() => subscribeSessionSignal((reason) => abortRef.current?.(reason)), []);

  // 供外部调用（以及未来接到别的打断源）
  useEffect(() => registerClipAbort((reason) => abortRef.current?.(reason)), []);

  /**
   * 开始一次播放。返回中止函数。
   * 关键：所有 await 之后都要再查一次 cancelled —— 打断之后回来的结果一律丢弃，
   * 所以不存在「abort 了又被回调把画面拉回来」的窗口。
   */
  const startPlayback = useCallback((source: string) => {
    let cancelled = false;
    let raf: number | null = null;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    const stopRaf = () => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    };
    const release = () => {
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };

    const abort = (reason: AbortReason = "user") => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      stopRaf();
      release();
      setClip((prev) => clipReducer(prev, { type: "abort", reason }).state);
      recordClipDiagnostic(
        "interrupted",
        CLIP_ID,
        `片段被中止（${abortReasonLabel(reason)}）→ 立刻停帧并回落角色画面`,
        "warn",
      );
    };
    abortRef.current = abort;

    const fail = (message: string, detail: string) => {
      if (cancelled) return;
      cancelled = true;
      stopRaf();
      release();
      // 同一会话不再拿同一条片段反复撞墙
      markClipPlayed(CLIP_ID);
      setClip((prev) => clipReducer(prev, { type: "error", message }).state);
      recordClipDiagnostic("failed", CLIP_ID, detail, "error");
      callbacks.current.onFailed?.(message);
    };

    const run = async () => {
      setClip((prev) => clipReducer(prev, { type: "load", clip: CLIP_ID }).state);
      recordClipDiagnostic("loading", CLIP_ID, `开始加载 ${source}`, "info");
      try {
        const response = await fetch(source, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          fail(`HTTP ${response.status}`, `加载 ${source} 失败（HTTP ${response.status}）→ 已静默降级为角色画面`);
          return;
        }
        const blob = await response.blob();
        if (cancelled) return;

        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.src = objectUrl;
        await image.decode(); // 解码失败会在这里抛，走同一条失败路径
        if (cancelled) return;

        markClipPlayed(CLIP_ID);
        setClip((prev) => clipReducer(prev, { type: "loaded" }).state);
        recordClipDiagnostic("playing", CLIP_ID, `播放中：${CLIP_FRAMES} 帧 @12fps`, "info");

        const startedAt = performance.now();
        const tick = (now: number) => {
          if (cancelled) return;
          const elapsed = now - startedAt;
          const index = frameAt(elapsed);
          drawFrame(canvasRef.current, image, index);
          setFrame(index);
          if (elapsed >= CLIP_DURATION_MS) {
            cancelled = true;
            setClip((prev) => clipReducer(prev, { type: "ended" }).state);
            recordClipDiagnostic(
              "ended",
              CLIP_ID,
              `播放结束（${(elapsed / 1000).toFixed(2)}s）→ 自动回落角色画面`,
              "info",
            );
            release();
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : String(error);
        fail(message, `解码/加载失败（${message}）→ 已静默降级为角色画面`);
      }
    };

    void run();
    return abort;
  }, []);

  // 触发：storm 演出命中时才播，且同一会话同一片段只播一次。
  // 注意这里不把「storm 变回 false」当成中止条件：闪电强度会自然衰减，
  // 片段的生命周期由播放器自己（以及会话打断）负责。
  const stopRef = useRef<((reason?: AbortReason) => void) | null>(null);
  useEffect(() => {
    if (!storm) return;
    if (stopRef.current !== null) return;
    if (hasPlayedClip(CLIP_ID)) return;
    stopRef.current = startPlayback(src);
  }, [storm, src, startPlayback]);

  // 卸载：等价于一次中止（不写诊断，这不是运行时故障）
  useEffect(() => {
    return () => {
      stopRef.current?.("user");
      stopRef.current = null;
    };
  }, []);

  if (!clipVisible(clip)) return null;

  return (
    <div
      className="clip-layer"
      data-phase={clip.phase}
      data-clip={clip.clip ?? "none"}
      data-frame={frame}
    >
      {clip.phase === "loading" ? (
        <p className="clip-loading" role="status">
          片段载入中
        </p>
      ) : null}
      {clip.phase === "playing" ? (
        <div className="clip-screen">
          <canvas
            ref={canvasRef}
            className="clip-canvas"
            width={CLIP_FRAME_W * 2}
            height={CLIP_FRAME_H * 2}
            aria-hidden="true"
          />
          <div className="clip-meter" aria-hidden="true">
            <span style={{ width: `${((frame + 1) / CLIP_FRAMES) * 100}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
