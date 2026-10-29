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
import { useIllustrationRecords, useIllustrationState } from "../stage/illustration/illustrationRuntime";
import { illustrationPhaseLabel } from "../stage/illustration/illustrationState";
import { useVoiceChannel } from "../voice/voiceDiag";
import { sttChannelLabel, ttsTierLabel, ttsZhLabel } from "../voice/voiceStatus";
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
  const voice = useVoiceChannel();
  const clipLatest = latestClipDiagnostic(clipRecords);
  const clipFailed = clipLatest?.phase === "failed";
  // 生成式插图：未配置 / 超配额一律 info（不染色），只有上游失败那行是 error 才红标
  const illustration = useIllustrationState();
  const illustrationRecords = useIllustrationRecords();
  const illustrationLatest = illustrationRecords.length > 0 ? illustrationRecords[illustrationRecords.length - 1]! : null;
  const illustrationFailed = illustrationLatest?.tone === "error";
  // 角色渲染只有 SVG 一条路（照片版 2026-10-29 整条删除），这行如实写死
  const portraitValue = "SVG";
  const rows: Array<[string, string, string?]> = [
    ["角色渲染", portraitValue, "SVG 分层版（照片级角色已下线）"],
    [
      "首字延迟",
      view.latency?.firstEventMs != null ? fmtMs(view.latency.firstEventMs) : view.busy ? "等待首字…" : "—",
      "请求发出到第一条 SSE 事件",
    ],
    ["本轮总耗时", fmtMs(view.latency?.totalMs), "请求发出到 turn.end"],
    ["丢弃迟到事件", String(view.droppedEvents), "epoch 护栏拦下的旧轮事件（打断链路证据）"],
    [
      "场景外动作",
      String(view.droppedActions),
      "指令枚举合法、但当前场景的 spec.actions 里没有这个词（客户端按场景丢弃；服务端白名单只管枚举合法性）",
    ],
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
    [
      "语音通道",
      `STT=${sttChannelLabel(voice.stt)} · TTS(中文)=${ttsZhLabel(voice.ttsZh)} · TTS(英文)=${ttsTierLabel(voice.tts)}`,
      voice.ttsNote
        ? `中文：${voice.ttsNote}`
        : voice.reason
          ? `已回退：${voice.reason}`
          : "中文走本机 Edge（角色音色，首次出声约 1.7–2s）；英文经服务端代理 Deepgram Aura；不可用时回退浏览器合成音",
    ],
    ["演示模式", props.demo.active ? `开（?demo=${props.demo.raw}）` : "关"],
    ["轮次", String(view.turns)],
    [
      "媒体片段",
      clipLatest ? clipPhaseLabel(clipLatest.phase) : "未播放",
      "storm 演出触发的 spritesheet 片段（12 帧 @12fps）",
    ],
    [
      "生成式插图",
      illustrationPhaseLabel(illustration.phase),
      illustrationLatest?.detail ?? "storm 命中 + 片段结束后触发；未配置/超配额静默回落",
    ],
  ];

  return (
    <details className="mira-diag" data-demo={props.demo.active ? "on" : "off"}>
      <summary className="mira-diag__summary">
        诊断
        {clipFailed ? <span className="mira-diag__alert">片段失败</span> : null}
        {illustrationFailed ? <span className="mira-diag__alert">插图失败</span> : null}
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
      {illustrationRecords.length > 0 ? (
        <ul className="mira-diag__illus" data-illus-phase={illustration.phase}>
          {illustrationRecords.slice(-3).map((record) => (
            <li key={record.id} data-tone={record.tone}>
              {record.detail}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
