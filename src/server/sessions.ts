/**
 * 服务端自持的会话历史 + 进行中 turn 的登记表。
 *
 * 为什么要服务端存一份：客户端可能在打断后重连、也可能刷新页面；
 * 导演需要「上一轮说了什么」才有一致的角色记忆。客户端送来的 history 只作为兜底。
 */

import type { DirectorFallbackReason, DirectorMode } from "../shared/director.ts";

export interface SessionMessage {
  role: "user" | "character";
  text: string;
  at: number;
}

export interface SessionRecord {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
  /** 本轮之前已演出过的显著 beat（供导演避免重复放同一个高光事件） */
  playedBeats: string[];
  turns: number;
  /**
   * 这个会话用哪个导演 —— 会话创建时定下，之后每轮 turn 都沿用它。
   * 轮内不再重读 URL / 环境变量：会话中途换档会让同一次对话的上下文对不上。
   */
  director: SessionDirector;
}

/** 会话维度上的导演选择结果（= server/director/resolve.ts 的 DirectorResolution） */
export interface SessionDirector {
  mode: DirectorMode;
  reason: DirectorFallbackReason | null;
}

const DEFAULT_SESSION_DIRECTOR: SessionDirector = { mode: "mock", reason: null };

export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  /**
   * 取会话；不存在则用给定的导演选择创建。
   * 已存在的会话**保留**原导演（ensure 不是「重置」）——这是「档位跟着会话走」的落点。
   */
  ensure(sessionId: string, director: SessionDirector = DEFAULT_SESSION_DIRECTOR): SessionRecord {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const now = Date.now();
    const record: SessionRecord = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      playedBeats: [],
      turns: 0,
      director: { mode: director.mode, reason: director.reason },
    };
    this.#sessions.set(sessionId, record);
    return record;
  }

  /** 会话的导演选择；会话不存在时返回 undefined（调用方按默认档位处理） */
  directorOf(sessionId: string): SessionDirector | undefined {
    return this.#sessions.get(sessionId)?.director;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  /** 给导演用的历史（不含时间戳，形状对齐 DirectorInput.history） */
  history(sessionId: string): Array<{ role: "user" | "character"; text: string }> {
    const record = this.#sessions.get(sessionId);
    if (!record) return [];
    return record.messages.map((message) => ({ role: message.role, text: message.text }));
  }

  append(sessionId: string, role: SessionMessage["role"], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const record = this.ensure(sessionId);
    record.messages.push({ role, text: trimmed, at: Date.now() });
    record.updatedAt = Date.now();
    if (role === "user") record.turns += 1;
  }

  noteBeat(sessionId: string, beatId: string): void {
    const record = this.ensure(sessionId);
    if (!record.playedBeats.includes(beatId)) record.playedBeats.push(beatId);
  }
}

export interface TurnHandle {
  turnId: string;
  sessionId: string;
  epoch: number;
  controller: AbortController;
}

/**
 * 进行中 turn 的登记表。
 * 同一个 session 开新 turn 时，上一轮会被主动打断 —— 这就是「打断」在服务端的落点。
 */
export class TurnRegistry {
  readonly #active = new Map<string, TurnHandle>();

  begin(params: { turnId: string; sessionId: string; epoch: number }): TurnHandle {
    this.interruptSession(params.sessionId);
    const handle: TurnHandle = {
      turnId: params.turnId,
      sessionId: params.sessionId,
      epoch: params.epoch,
      controller: new AbortController(),
    };
    this.#active.set(params.turnId, handle);
    return handle;
  }

  get(turnId: string): TurnHandle | undefined {
    return this.#active.get(turnId);
  }

  cancel(turnId: string): { cancelled: boolean; epoch: number } {
    const handle = this.#active.get(turnId);
    if (!handle) return { cancelled: false, epoch: 0 };
    if (!handle.controller.signal.aborted) handle.controller.abort(new Error("cancelled by client"));
    return { cancelled: true, epoch: handle.epoch };
  }

  /** 打断某个会话里所有在跑的 turn（同会话新 turn 抢占） */
  interruptSession(sessionId: string): void {
    for (const handle of this.#active.values()) {
      if (handle.sessionId !== sessionId) continue;
      if (!handle.controller.signal.aborted) handle.controller.abort(new Error("superseded by newer turn"));
    }
  }

  finish(turnId: string): void {
    this.#active.delete(turnId);
  }

  /** 仅用于诊断/测试 */
  get size(): number {
    return this.#active.size;
  }
}
