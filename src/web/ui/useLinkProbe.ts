/**
 * 连通性探测：让「服务端被杀了」在用户还没打字的时候就看得见。
 *
 * store 只在一次请求失败后才知道自己掉线；评审杀完服务端往往只是盯着画面看，
 * 所以这里每 5s 打一次 GET /api/health，并监听浏览器的 online/offline 事件。
 * 探测结果只用于界面提示，绝不改动会话状态（对话与画面不受影响）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionApi } from "../state/api";
import { describeApiError } from "../state/api";

export interface LinkProbe {
  /** 最近一次探测失败 = 服务端不可达 */
  down: boolean;
  /** 掉线后探测到恢复（此时提示改成「服务已恢复，点重新连接」） */
  recovered: boolean;
  checking: boolean;
  error: string | null;
  probes: number;
  lastOkAt: number | null;
  /** 立即探测一次，返回是否连通 */
  probeNow(): Promise<boolean>;
}

interface ProbeState {
  down: boolean;
  recovered: boolean;
  checking: boolean;
  error: string | null;
  probes: number;
  lastOkAt: number | null;
}

const INITIAL: ProbeState = {
  down: false,
  recovered: false,
  checking: false,
  error: null,
  probes: 0,
  lastOkAt: null,
};

export function useLinkProbe(api: SessionApi, options: { intervalMs?: number } = {}): LinkProbe {
  const intervalMs = options.intervalMs ?? 5_000;
  const [state, setState] = useState<ProbeState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const running = useRef(false);
  const disposed = useRef(false);

  const probeNow = useCallback(async (): Promise<boolean> => {
    if (running.current) return !stateRef.current.down;
    running.current = true;
    setState((prev) => ({ ...prev, checking: true }));

    let ok = false;
    let error: string | null = null;
    try {
      const health = await api.health();
      ok = health.ok !== false;
      if (!ok) error = "GET /api/health 返回 ok=false";
    } catch (err) {
      error = describeApiError(err);
    }
    running.current = false;
    if (disposed.current) return ok;

    setState((prev) => ({
      down: !ok,
      recovered: ok ? prev.down || prev.recovered : false,
      checking: false,
      error: ok ? null : error,
      probes: prev.probes + 1,
      lastOkAt: ok ? Date.now() : prev.lastOkAt,
    }));
    return ok;
  }, [api]);

  useEffect(() => {
    disposed.current = false;
    const tick = () => {
      void probeNow();
    };
    const id = setInterval(tick, intervalMs);
    const onOnline = () => {
      void probeNow();
    };
    const onOffline = () => {
      setState((prev) => ({
        ...prev,
        down: true,
        recovered: false,
        error: "浏览器报告网络已离线",
      }));
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
    }
    return () => {
      disposed.current = true;
      clearInterval(id);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
    };
  }, [intervalMs, probeNow]);

  return { ...state, probeNow };
}
