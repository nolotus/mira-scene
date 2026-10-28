/**
 * 服务端自持的会话历史 + 进行中 turn 的登记表。
 *
 * 为什么要服务端存一份：客户端可能在打断后重连、也可能刷新页面；
 * 导演需要「上一轮说了什么」才有一致的角色记忆。客户端送来的 history 只作为兜底。
 */

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
}

export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();

  ensure(sessionId: string): SessionRecord {
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
    };
    this.#sessions.set(sessionId, record);
    return record;
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
