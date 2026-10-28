/**
 * 故障相关的三条可见反馈（都放在 dock 里，绝不以浮层遮住角色）：
 *
 *  1. ConnectionStrip —— 服务端不可达（health 探测失败 / SSE 中途断）。非阻塞、常驻，带「重新连接」。
 *  2. MediaErrorStrip —— 未捕获错误 / 资源加载失败 / 朗读失败。可关闭，说明会影响角色表演。
 *  3. DemoBadge —— 角落标注「演示模式：人为故障」，避免人为故障被当成真 bug。
 */

import type { RuntimeErrorNotice } from "./availability";
import type { DemoFlags } from "./demo";

export interface ConnectionStripProps {
  /** 服务端当前是否不可达 */
  offline: boolean;
  /** 掉线后已探测到恢复 */
  recovered: boolean;
  checking: boolean;
  error: string | null;
  onReconnect(): void;
}

export function ConnectionStrip(props: ConnectionStripProps) {
  if (!props.offline) return null;

  const title = props.recovered ? "服务已恢复" : "连不上本地服务";
  const body = props.recovered
    ? "服务已经回来了。点「重新连接」继续聊，刚才的对话和画面都还在。"
    : `GET /api/health 没有响应${props.error ? `（${props.error}）` : ""}。角色仍可预览，画面不会白屏；对话要等服务恢复。`;

  return (
    <div className="mira-strip mira-strip--offline" role="status" data-strip="offline">
      <span className="mira-strip__dot" aria-hidden="true" />
      <span className="mira-strip__text">
        <strong>{title}</strong>
        <span className="mira-strip__body">{body}</span>
      </span>
      <button
        type="button"
        className="mira-strip__action"
        onClick={props.onReconnect}
        disabled={props.checking}
      >
        {props.checking ? "连接中…" : "重新连接"}
      </button>
    </div>
  );
}

export interface MediaErrorStripProps {
  notice: RuntimeErrorNotice | null;
  onDismiss(): void;
}

export function MediaErrorStrip(props: MediaErrorStripProps) {
  if (!props.notice) return null;
  return (
    <div className="mira-strip mira-strip--error" role="alert" data-strip="media">
      <span className="mira-strip__dot" aria-hidden="true" />
      <span className="mira-strip__text">
        <strong>{props.notice.text}</strong>
        <span className="mira-strip__body">{props.notice.detail}</span>
      </span>
      <button
        type="button"
        className="mira-strip__action mira-strip__action--ghost"
        onClick={props.onDismiss}
        aria-label="关闭这条提示"
      >
        知道了
      </button>
    </div>
  );
}

export function DemoBadge({ demo }: { demo: DemoFlags }) {
  if (!demo.active) return null;
  return (
    <div className="mira-demo-badge" title={demo.summary} role="note">
      <span aria-hidden="true">⚠</span> {demo.badge}
    </div>
  );
}
