/**
 * 插图的运行时装配（单例）+ `?gen=…` 开关解析。
 *
 * 开关语义（对齐 ui/demo.ts 的风格：显式值才算关，默认开）：
 *   · 不写 `gen` 或写成 1/on/true → 启用（默认就是启用）
 *   · `?gen=0` / off / false / no → 关闭，整层不渲染、不发请求、不写记录
 *
 * 「服务端可用时启用」不是靠预探测实现的：第一次真请求如果收到 not-configured，
 * 控制器会把 unavailable 置真并**永远不再尝试**，同时只留一行 info 诊断（不是失败样式）。
 * 这样零密钥环境下界面完全安静，也不需要多一次健康探测。
 */

import { useSyncExternalStore } from "react";
import type { IllustrateResponse } from "../../../shared/illustrate.ts";
import { createIllustrationCache } from "./illustrationCache.ts";
import {
  createIllustrationController,
  type IllustrationController,
  type IllustrationRecord,
  type IllustrationTransport,
} from "./illustrationController.ts";
import type { IllustrationState } from "./illustrationState.ts";

/** `?gen=…` → 是否启用。纯函数，输入直接来自 location.search。 */
export function parseIllustrationFlag(search: string): boolean {
  const raw = (new URLSearchParams(search).get("gen") ?? "").trim().toLowerCase();
  if (raw === "") return true;
  return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

function createHttpTransport(): IllustrationTransport {
  return async ({ sessionId, beatId, scene, variant, signal }) => {
    const response = await fetch("/api/illustrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        beatId,
        ...(scene ? { scene } : {}),
        ...(variant ? { variant } : {}),
      }),
      signal,
    });
    // 非 2xx 当作上游失败（控制器会静默回落 + 诊断留一行），不在这里抛给界面
    if (!response.ok) throw new Error(`illustrate HTTP ${response.status}`);
    return (await response.json()) as IllustrateResponse;
  };
}

export interface IllustrationRuntime {
  enabled: boolean;
  controller: IllustrationController;
}

let runtime: IllustrationRuntime | null = null;

export function getIllustrationRuntime(): IllustrationRuntime {
  if (runtime) return runtime;
  const enabled =
    typeof window === "undefined" ? false : parseIllustrationFlag(window.location.search);
  runtime = {
    enabled,
    controller: createIllustrationController({
      transport: createHttpTransport(),
      cache: createIllustrationCache(),
      enabled,
    }),
  };
  return runtime;
}

/** 仅供测试/演示复位（会丢弃当前单例的所有状态） */
export function resetIllustrationRuntime(): void {
  runtime?.controller.dispose();
  runtime = null;
}

export function useIllustrationState(): IllustrationState {
  const controller = getIllustrationRuntime().controller;
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.state,
    () => controller.state,
  );
}

export function useIllustrationRecords(): readonly IllustrationRecord[] {
  const controller = getIllustrationRuntime().controller;
  return useSyncExternalStore(
    controller.subscribe,
    () => controller.records,
    () => controller.records,
  );
}
