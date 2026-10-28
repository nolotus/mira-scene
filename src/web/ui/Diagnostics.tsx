/**
 * 诊断面板：只读、默认收起。
 *
 * 主界面只留「出了什么事」的可见反馈；延迟/模式这类数字塞进这里，
 * 需要时展开（录屏时用来证明 8s 超时、打断丢事件是真的发生过的），不需要时不占地方。
 *
 * 「媒体片段」这一行是片段的失败留痕：失败会静默降级为角色画面，但绝不允许只在 console 里
 * 悄悄错 —— 最新状态写进固定行，最近几条生命周期写进下面的列表，失败时 summary 上带红字。
 */

import type { SessionView } from "../state/store";
import { latestClipDiagnostic, useClipDiagnostics } from "../stage/clip/clipBus";
import { clipPhaseLabel } from "../stage/clip/clipState";
import type { DemoFlags } from "./demo";

export interface DiagnosticsProps {
  view: SessionView;
  demo: DemoFlags;
  /** 合并后的连通性（health 探测 + store 连接态） */
  online: boolean;
  probes: number;
  probeError: string | null;
  secureContext: boolean | undefined;
  speechSupported: boolean;
}

function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${(value / 1000).toFixed(2)}s`;
}

const MIC_LABEL: Record<SessionView["mic"], string> = {
  idle: "未开启",
  requesting: "授权中",
  listening: "倾听中",
  denied: "权限被拒绝",
  unsupported: "不支持",
};

export function Diagnostics(props: DiagnosticsProps) {
  const { view } = props;
  const clipRecords = useClipDiagnostics();
  const clipLatest = latestClipDiagnostic(clipRecords);
  const clipFailed = clipLatest?.phase === "failed";
  const rows: Array<[string, string, string?]> = [
    [
      "首字延迟",
      view.latency?.firstEventMs != null ? fmtMs(view.latency.firstEventMs) : view.busy ? "等待首字…" : "—",
      "请求发出到第一条 SSE 事件",
    ],
    ["本轮总耗时", fmtMs(view.latency?.totalMs), "请求发出到 turn.end"],
    ["丢弃迟到事件", String(view.droppedEvents), "epoch 护栏拦下的旧轮事件（打断链路证据）"],
    [
      "当前模式",
      view.session ? (view.session.mode === "live" ? "真模型" : "Mock 导演") : "未连接",
      view.session?.directorName ?? "—",
    ],
    ["音频通道", `${view.audioMode === "stream" ? "流式音频" : "浏览器 TTS"}（${view.ttsName}）`],
    ["是否 keyless", view.session ? (view.session.keyless ? "是（零密钥可跑）" : "否") : "—"],
    ["连接", props.online ? "online" : "offline", `健康探测 ${props.probes} 次`],
    ["麦克风", MIC_LABEL[view.mic]],
    ["安全上下文", props.secureContext === false ? "否（http，麦克风必失败）" : "是"],
    ["语音识别", props.speechSupported ? "可用" : "不支持"],
    ["演示模式", props.demo.active ? `开（?demo=${props.demo.raw}）` : "关"],
    ["轮次", String(view.turns)],
    [
      "媒体片段",
      clipLatest ? clipPhaseLabel(clipLatest.phase) : "未播放",
      "storm 演出触发的 spritesheet 片段（12 帧 @12fps）",
    ],
  ];

  return (
    <details className="mira-diag" data-demo={props.demo.active ? "on" : "off"}>
      <summary className="mira-diag__summary">
        诊断
        {clipFailed ? <span className="mira-diag__alert">片段失败</span> : null}
      </summary>
      <dl className="mira-diag__grid">
        {rows.map(([label, value, hint]) => (
          <div className="mira-diag__row" key={label}>
            <dt>{label}</dt>
            <dd title={hint ?? undefined}>{value}</dd>
          </div>
        ))}
      </dl>
      {props.probeError ? <p className="mira-diag__err">最近一次健康探测：{props.probeError}</p> : null}
      {clipRecords.length > 0 ? (
        <ul className="mira-diag__clip" data-clip-phase={clipLatest?.phase ?? "idle"}>
          {clipRecords.slice(-3).map((record) => (
            <li key={record.id} data-tone={record.tone}>
              {record.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
