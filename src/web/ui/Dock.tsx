import { useCallback, useEffect, useMemo, useRef, type FormEvent, type PointerEvent } from "react";
import { describeDirectorFallback } from "../../shared/director";
import type { CharacterStatus } from "../../shared/protocol";
import type { SessionView } from "../state/store";
import type { SttLang } from "../voice/stt";
import { describeInputMode, type MicNotice, type RuntimeErrorNotice } from "./availability";
import { Diagnostics } from "./Diagnostics";
import type { DemoFlags } from "./demo";
import { ConnectionStrip, MediaErrorStrip } from "./Notices";

const STATUS_LABEL: Record<CharacterStatus, string> = {
  idle: "待机",
  listening: "倾听",
  thinking: "思考",
  speaking: "说话",
};

/** 与 store 无关、只看环境与连线状态的提示（都由 App 算出后传入） */
export interface DockFaultProps {
  /** 麦克风为什么用不了的三种情形之一；null = 一切正常 */
  micNotice: MicNotice | null;
  /** 服务端不可达 */
  offline: boolean;
  /** 掉线后已探测到恢复 */
  recovered: boolean;
  /** 正在重新连接 */
  reconnecting: boolean;
  /** 最近一次探测失败的原因 */
  probeError: string | null;
  onReconnect(): void;
  /** 未捕获错误（渲染 / 媒体 / 朗读） */
  mediaError: RuntimeErrorNotice | null;
  onDismissMedia(): void;
  demo: DemoFlags;
  /** 诊断面板用 */
  diagnostics: {
    online: boolean;
    probes: number;
    secureContext: boolean | undefined;
    speechSupported: boolean;
  };
}

export interface DockProps extends DockFaultProps {
  view: SessionView;
  /** STT 临时结果（边说边显示） */
  interim: string;
  /** 当前正在朗读的那一句（BrowserTTS 按句入队的回声，用于和字幕对齐） */
  speaking: string;
  /** 语音/权限相关的明确提示 */
  note: string | null;
  micLevel: number;
  onDraft(value: string): void;
  onSend(text: string): void;
  onInterrupt(): void;
  onMicToggle(): void;
  onPushToTalkStart(): void;
  onPushToTalkEnd(): void;
  onRetry(): void;
  onLangChange(lang: SttLang): void;
}

function micLabelOf(view: SessionView, notice: MicNotice | null): string {
  if (view.mic === "listening") return "关闭麦克风";
  if (view.mic === "requesting") return "请求麦克风…";
  // 提示里带根因时，按钮上直接写出「为什么不能用」，不用点一下才知道
  if (notice) {
    if (notice.kind === "insecure") return "麦克风需 https";
    if (notice.kind === "unsupported") return "无语音识别";
    if (notice.kind === "stt") return "语音服务不可用";
    return "麦克风被拒";
  }
  return "开启麦克风";
}

export function Dock(props: DockProps) {
  const { view } = props;
  const status = view.scene.characterStatus;
  const inputRef = useRef<HTMLInputElement>(null);
  const micLabel = micLabelOf(view, props.micNotice);

  // 语音识别不可用（例如 iOS Safari 没有 Web Speech STT）时：文字输入直接当主入口 ——
  // 聚焦 + 改 placeholder + 一句「这台设备只能打字」，而不是只丢一句「不支持」。
  const inputMode = useMemo(
    () =>
      describeInputMode({
        speechSupported: props.diagnostics.speechSupported,
        userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      }),
    [props.diagnostics.speechSupported],
  );

  useEffect(() => {
    if (inputMode.focusInput) inputRef.current?.focus();
  }, [inputMode.focusInput]);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      props.onSend(view.draft);
    },
    [props, view.draft],
  );

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="mira-dock">
      <ConnectionStrip
        offline={props.offline}
        recovered={props.recovered}
        checking={props.reconnecting}
        error={props.probeError}
        onReconnect={props.onReconnect}
      />
      <MediaErrorStrip notice={props.mediaError} onDismiss={props.onDismissMedia} />

      <div className="mira-row mira-row--meta">
        <span className={`mira-chip mira-status mira-status--${status}`} data-status={status}>
          <span className="mira-status__dot" />
          {STATUS_LABEL[status]}
        </span>
        <span className="mira-chip">
          {view.session ? (view.session.mode === "live" ? "真模型" : "Mock 导演") : "未连接"}
        </span>
        {view.session?.fallbackReason ? (
          <span
            className="mira-chip"
            title={describeDirectorFallback(view.session.fallbackReason) ?? view.session.fallbackReason}
          >
            {view.session.fallbackReason === "forced-mock" ? "已回落：强制 Mock" : "已回落：未配置密钥"}
          </span>
        ) : null}
        <span className="mira-chip">{view.audioMode === "stream" ? "流式音频" : "浏览器 TTS"}</span>
        {(view.session?.keyless ?? true) ? (
          <span className="mira-chip mira-chip--ok" title="无需任何 API key 即可跑通">
            零密钥可跑
          </span>
        ) : null}
        {view.droppedEvents > 0 ? (
          <span
            className="mira-chip mira-chip--drop"
            title="被 epoch 护栏丢弃的迟到网络响应（打断后旧轮的事件全部在此计数）"
          >
            丢弃迟到事件 {view.droppedEvents}
          </span>
        ) : null}
        {view.droppedActions > 0 ? (
          <span
            className="mira-chip mira-chip--drop"
            title="指令枚举合法、但当前场景容不下（场景适配层按 spec.actions 丢弃）"
          >
            场景外动作 {view.droppedActions}
          </span>
        ) : null}
      </div>

      <form className="mira-row mira-row--input" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          className="mira-input"
          value={view.draft}
          onChange={(event) => props.onDraft(event.target.value)}
          placeholder={status === "speaking" ? "直接打字会打断她…" : inputMode.placeholder}
          aria-label={inputMode.primary === "text" ? "输入框（这台设备只能打字）" : "输入框"}
          autoComplete="off"
        />
        <button type="submit" className="mira-btn mira-btn--send" disabled={!view.draft.trim()}>
          发送
        </button>
      </form>

      <div className="mira-row mira-row--actions">
        <button
          type="button"
          className={`mira-btn ${view.mic === "listening" ? "mira-btn--active" : ""}`}
          onClick={props.onMicToggle}
          disabled={view.mic === "requesting"}
          title="开启后自动检测你开口（VAD）并做语音转写；不可用时请用「按住说话」"
        >
          {micLabel}
          {view.mic === "listening" ? (
            <span className="mira-level" style={{ transform: `scaleX(${Math.min(1, props.micLevel * 12)})` }} />
          ) : null}
        </button>

        <PushToTalkButton onStart={props.onPushToTalkStart} onEnd={props.onPushToTalkEnd} />

        <button
          type="button"
          className="mira-btn mira-btn--danger"
          onClick={props.onInterrupt}
          disabled={!view.canInterrupt}
          title="立即打断：停止语音、取消上一轮、回到倾听（快捷键 Esc）"
        >
          打断 <kbd>Esc</kbd>
        </button>

        <button
          type="button"
          className="mira-btn"
          onClick={props.onRetry}
          title="重发上一句（会拿到新的 epoch，旧轮彻底作废）"
        >
          重试
        </button>

        <label className="mira-lang">
          识别
          <select
            value={view.sttLang}
            onChange={(event) => props.onLangChange(event.target.value === "en-US" ? "en-US" : "zh-CN")}
          >
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
      </div>

      {props.interim ? <p className="mira-dock__interim">「{props.interim}」</p> : null}
      {props.speaking ? (
        <p className="mira-dock__speaking" aria-live="off">
          正在朗读：{props.speaking}
        </p>
      ) : null}
      {props.note ? <p className="mira-dock__note">{props.note}</p> : null}

      {props.micNotice ? (
        <MicNoticeBlock notice={props.micNotice} onFocusInput={focusInput} />
      ) : null}

      <Diagnostics
        view={view}
        demo={props.demo}
        online={props.diagnostics.online}
        probes={props.diagnostics.probes}
        probeError={props.probeError}
        secureContext={props.diagnostics.secureContext}
        speechSupported={props.diagnostics.speechSupported}
      />
    </div>
  );
}

/**
 * 麦克风不可用时的三选一说明（权限拒绝 / 不支持 / 非安全上下文，文案在 availability.ts 里选）。
 * 「去打字」按钮直接把焦点送进输入框 —— 替代入口必须是能立刻用上的，不能只是一句建议。
 */
function MicNoticeBlock({
  notice,
  onFocusInput,
}: {
  notice: MicNotice;
  onFocusInput(): void;
}) {
  return (
    <div className="mira-notice" data-mic-notice={notice.kind} role="status">
      <div className="mira-notice__head">
        <span className="mira-notice__title">
          <span aria-hidden="true">🎙</span> {notice.title}
        </span>
        <button type="button" className="mira-btn mira-btn--tiny" onClick={onFocusInput}>
          {notice.primaryAction}
        </button>
      </div>
      {/* 替代入口常驻可见：不能只说「不可用」，要给出此刻就能走的路 */}
      <p className="mira-notice__fallback">
        替代入口：在输入框打字 · 「按住说话」可打断并进入倾听，两者都不需要麦克风权限
      </p>
      <details className="mira-notice__more">
        <summary>为什么、怎么恢复</summary>
        <p className="mira-notice__reason">{notice.reason}</p>
        <ul className="mira-notice__actions">
          {notice.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

interface PushToTalkProps {
  onStart(): void;
  onEnd(): void;
}

/**
 * 按住说话：麦克风权限不可用时的明确替代交互。
 * 按下 = 打断 + 进入倾听；松开 = 结束识别（有转写就自动发送）。
 */
function PushToTalkButton({ onStart, onEnd }: PushToTalkProps) {
  const holdingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (holdingRef.current) {
        holdingRef.current = false;
        onEnd();
      }
    };
  }, [onEnd]);

  const start = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (holdingRef.current) return;
    holdingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 某些环境不支持指针捕获，忽略 */
    }
    onStart();
  };

  const end = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    onEnd();
  };

  return (
    <button
      type="button"
      className="mira-btn mira-btn--ptt"
      onPointerDown={start}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
      onContextMenu={(event) => event.preventDefault()}
      title="按住说话：按下即打断并进入倾听，松开结束"
    >
      按住说话
    </button>
  );
}
