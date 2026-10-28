/**
 * 片段 ↔ 会话之间的两条窄通道。
 *
 * 1. 会话信号（epoch / 轮次）
 *    片段播放器不持有会话，Stage 的 props 也已被冻结（只有 SceneState），所以「新一轮 / 打断」
 *    只能从外面推进来。App 在每次 view 变化时上报一次 epoch + 轮次；信号一变，片段立刻中止。
 *
 * 2. 诊断记录
 *    失败必须留痕，而且不能只在 console 里。这里存一条有上限的环形记录，
 *    由 ui/Diagnostics.tsx 通过 useSyncExternalStore 读出来显示在诊断区。
 *
 * 3. 已播集合
 *    同一会话内同一片段只播一次（触发源是 storm 演出，不是定时器）。
 */

import { useSyncExternalStore } from "react";
import type { AbortReason, ClipPhase } from "./clipState";
import { createPlayedClips } from "./clipState";

// ---------------------------------------------------------------- 会话信号

export interface SessionSignal {
  epoch: number;
  turnId: string | null;
  /** 会话 id：插图层要用它发 POST /api/illustrate（Stage 的 props 已冻结，只能走这条窄通道） */
  sessionId: string | null;
}

let signal: SessionSignal | null = null;
const signalListeners = new Set<(reason: "epoch" | "turn") => void>();

/**
 * App 侧上报当前 epoch 与当前轮 id。
 *
 * 为什么不是「轮次数」：轮次计数在 turn.end 才 +1，拿它当信号会在片段播到一半时
 * 把「本轮收尾」误判成打断（实测踩过）。这里只认两件事：
 *   · epoch 变了 → 用户打断 / 换轮，必须中止；
 *   · 出现了一个新的非空 turnId → 新一轮开始，必须中止。
 * 本轮结束（turnId 变 null）不是打断，片段该播完就播完。
 * 首个快照只用来定基线（挂载时不该被当成「变化」而中止任何东西）。
 */
export function reportSessionSignal(
  epoch: number,
  turnId: string | null,
  sessionId: string | null = null,
): void {
  const previous = signal;
  signal = { epoch, turnId, sessionId };
  if (previous === null) return;
  if (previous.epoch === epoch && previous.turnId === turnId) return;

  if (previous.epoch !== epoch) {
    for (const listener of [...signalListeners]) listener("epoch");
    return;
  }
  // 同一 epoch 内：只有「从无到有的新一轮」才算打断
  if (turnId !== null && previous.turnId !== turnId) {
    for (const listener of [...signalListeners]) listener("turn");
  }
}

export function getSessionSignal(): SessionSignal | null {
  return signal;
}

export function subscribeSessionSignal(
  listener: (reason: "epoch" | "turn") => void,
): () => void {
  signalListeners.add(listener);
  return () => {
    signalListeners.delete(listener);
  };
}

/** 仅供测试/演示复位（不改变运行时语义） */
export function resetSessionSignal(): void {
  signal = null;
}

// ---------------------------------------------------------------- 片段相位（插图用）

let clipPhase: ClipPhase = "idle";
const phaseListeners = new Set<(phase: ClipPhase) => void>();

/**
 * 片段把自己的相位广播出去 —— **单向、只读**。
 * 插图层据此判断「片段让出画面了吗」，反过来永远不驱动片段：
 * 「片段先播、插图后上」的秩序只能从片段流向插图，不能倒过来。
 */
export function reportClipPhase(phase: ClipPhase): void {
  if (clipPhase === phase) return;
  clipPhase = phase;
  for (const listener of [...phaseListeners]) listener(phase);
}

export function getClipPhase(): ClipPhase {
  return clipPhase;
}

export function subscribeClipPhase(listener: (phase: ClipPhase) => void): () => void {
  phaseListeners.add(listener);
  return () => {
    phaseListeners.delete(listener);
  };
}

/** 仅供测试/演示复位 */
export function resetClipPhase(): void {
  clipPhase = "idle";
  phaseListeners.clear();
}

// ---------------------------------------------------------------- 外部中止入口

type AbortHandler = (reason: AbortReason) => void;
let abortHandler: AbortHandler | null = null;

/**
 * 播放器注册自己的中止函数；外部（会话换 epoch / 用户打断 / 测试）用 requestClipAbort 触发。
 * 返回注销函数：卸载后外部再调也不会打到已消失的播放器。
 */
export function registerClipAbort(handler: AbortHandler): () => void {
  abortHandler = handler;
  return () => {
    if (abortHandler === handler) abortHandler = null;
  };
}

export function requestClipAbort(reason: AbortReason = "user"): void {
  abortHandler?.(reason);
}

// ---------------------------------------------------------------- 已播集合

const played = createPlayedClips();

export function hasPlayedClip(id: string): boolean {
  return played.has(id);
}

export function markClipPlayed(id: string): void {
  played.add(id);
}

export function resetPlayedClips(): void {
  played.clear();
}

export function playedClipCount(): number {
  return played.size;
}

// ---------------------------------------------------------------- 诊断记录

export type ClipDiagnosticTone = "info" | "warn" | "error";

export interface ClipDiagnosticRecord {
  id: number;
  at: number;
  phase: ClipPhase;
  clip: string;
  detail: string;
  tone: ClipDiagnosticTone;
}

const MAX_RECORDS = 8;
let records: readonly ClipDiagnosticRecord[] = [];
let recordSeq = 0;
const diagListeners = new Set<() => void>();

/** 记一条。失败（tone="error"）会同时进诊断区的固定行，不会只落在 console。 */
export function recordClipDiagnostic(
  phase: ClipPhase,
  clip: string,
  detail: string,
  tone: ClipDiagnosticTone = "info",
): void {
  recordSeq += 1;
  const next: ClipDiagnosticRecord = {
    id: recordSeq,
    at: Date.now(),
    phase,
    clip,
    detail,
    tone,
  };
  const list = [...records, next];
  records = list.length > MAX_RECORDS ? list.slice(list.length - MAX_RECORDS) : list;
  for (const listener of [...diagListeners]) listener();
}

export function getClipDiagnostics(): readonly ClipDiagnosticRecord[] {
  return records;
}

export function subscribeClipDiagnostics(listener: () => void): () => void {
  diagListeners.add(listener);
  return () => {
    diagListeners.delete(listener);
  };
}

export function clearClipDiagnostics(): void {
  if (records.length === 0) return;
  records = [];
  for (const listener of [...diagListeners]) listener();
}

/** 最新一条记录（诊断区固定行用它） */
export function latestClipDiagnostic(
  list: readonly ClipDiagnosticRecord[] = records,
): ClipDiagnosticRecord | null {
  return list.length === 0 ? null : list[list.length - 1]!;
}

export function useClipDiagnostics(): readonly ClipDiagnosticRecord[] {
  return useSyncExternalStore(subscribeClipDiagnostics, getClipDiagnostics, getClipDiagnostics);
}
