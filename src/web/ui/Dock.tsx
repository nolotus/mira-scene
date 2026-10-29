import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { describeDirectorFallback } from "../../shared/director";
import type { CharacterStatus } from "../../shared/protocol";
import type { SessionView } from "../state/store";
import type { AudioMode } from "../voice/tts";
import type { SttLang } from "../voice/stt";
import { describeInputMode, type MicNotice, type RuntimeErrorNotice } from "./availability";
import { Diagnostics } from "./Diagnostics";
import type { DemoFlags } from "./demo";
import { MoreSheet } from "./MoreSheet";
import { ConnectionStrip, MediaErrorStrip } from "./Notices";

const STATUS_LABEL: Record<CharacterStatus, string> = {
  idle: "待机",
  listening: "倾听",
  thinking: "思考",
  speaking: "说话",
};

// ================================================================ 层级规则（纯函数）
//
// 一句话原则：**说话 / 打字是主操作，打断是情境操作，其余收进「⋯」**。
// 这些判定写成纯函数，是为了让「什么状态显示什么控件」可以被单测钉住 ——
// 否则「打断常驻占位」「语音不可用时还摆一个按不动的麦克风」这类回归只能靠肉眼发现。

export interface DockChip {
  key: string;
  label: string;
  tone?: "ok" | "drop" | "lat";
  title?: string;
}

export interface ChipInput {
  characterStatus: CharacterStatus;
  sessionMode: "live" | "mock" | null;
  fallbackReason: Parameters<typeof describeDirectorFallback>[0];
  audioMode: AudioMode;
  keyless: boolean;
  droppedEvents: number;
  droppedActions: number;
}

/** 状态条候选列表，**顺序即优先级**：前两个常显，其余进抽屉 */
export function dockChipList(input: ChipInput): DockChip[] {
  const list: DockChip[] = [
    { key: "status", label: STATUS_LABEL[input.characterStatus] },
    {
      key: "director",
      label: input.sessionMode === null ? "未连接" : input.sessionMode === "live" ? "真模型" : "Mock 导演",
    },
  ];
  if (input.fallbackReason) {
    list.push({
      key: "fallback",
      label: input.fallbackReason === "forced-mock" ? "已回落：强制 Mock" : "已回落：未配置密钥",
      title: describeDirectorFallback(input.fallbackReason) ?? input.fallbackReason,
    });
  }
  list.push({ key: "audio", label: input.audioMode === "stream" ? "流式音频" : "浏览器 TTS" });
  if (input.keyless) {
    list.push({ key: "keyless", label: "零密钥可跑", tone: "ok", title: "无需任何 API key 即可跑通" });
  }
  if (input.droppedEvents > 0) {
    list.push({
      key: "droppedEvents",
      label: `丢弃迟到事件 ${input.droppedEvents}`,
      tone: "drop",
      title: "被 epoch 护栏丢弃的迟到网络响应（打断后旧轮的事件全部在此计数）",
    });
  }
  if (input.droppedActions > 0) {
    list.push({
      key: "droppedActions",
      label: `场景外动作 ${input.droppedActions}`,
      tone: "drop",
      title: "指令枚举合法、但当前场景容不下（场景适配层按 spec.actions 丢弃）",
    });
  }
  return list;
}

/** 顶部最多常显 `max` 个 chip，其余进抽屉（不是隐藏，是换位置） */
export function splitDockChips(list: readonly DockChip[], max = 2): { visible: DockChip[]; overflow: DockChip[] } {
  const n = Math.max(0, max);
  return { visible: list.slice(0, n), overflow: list.slice(n) };
}

export interface DockVisibilityInput {
  characterStatus: CharacterStatus;
  /**
   * 状态机 + 音频双重判据给出的「现在能不能打断」（来自 SessionView.canInterrupt）。
   * 缺省时退回「角色状态是 speaking」的旧口径，保持对旧调用方兼容。
   */
  canInterrupt?: boolean;
  /** 麦克风不可用的根因；null = 语音路径正常 */
  micNotice: MicNotice | null;
  speechSupported: boolean;
  /** 有错误（banner / 断线 / 媒体错误）—— 决定「重试」是否进抽屉、⋯ 是否带红点 */
  hasError: boolean;
}

export interface DockVisibility {
  /** 打断：只在角色说话时出现，其余时刻**不占位** */
  interrupt: boolean;
  /** 圆形麦克风主按钮 */
  mic: boolean;
  /** 麦克风位置换成「打字优先」提示（不是新增控件，只换内容） */
  voiceHint: boolean;
  /** 按住说话：独立按钮，40+，只在语音路径有余量时出现 */
  ptt: boolean;
  /** 识别语言：只在 STT 真能用时出现（抽屉内） */
  lang: boolean;
  /** 重试：只在有错误时出现在抽屉里 */
  retry: boolean;
  /** ⋯ 上的红点 */
  moreDot: boolean;
}

/**
 * 「语音还能不能产出转写」的判定：非安全上下文与不支持 Web Speech 时，
 * 连倾听都没有产出，按住说话也就失去了意义（打断由 Esc / 打断按钮负责）。
 * 权限被拒（denied）不一样 —— 改完权限、刷新即恢复，入口留着。
 */
export function visibleDockControls(input: DockVisibilityInput): DockVisibility {
  const kind = input.micNotice?.kind ?? null;
  const hardBlocked = kind === "insecure" || kind === "unsupported" || kind === "stt";
  return {
    // 用 canInterrupt 而不是 characterStatus：TTS 流式播放时 turn.end 已把状态打回 idle，
    // 但音频还在响，这时按钮不该消失（否则「按钮能打断/不能打断」随状态漂移）
    interrupt: input.canInterrupt ?? input.characterStatus === "speaking",
    mic: !hardBlocked,
    voiceHint: hardBlocked,
    ptt: !hardBlocked,
    lang: input.speechSupported && !hardBlocked,
    retry: input.hasError,
    moreDot: input.hasError,
  };
}

// ================================================================ props

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
  if (view.mic === "requesting") return "正在请求麦克风权限";
  // 提示里带根因时，按钮上直接写出「为什么不能用」，不用点一下才知道
  if (notice) {
    if (notice.kind === "insecure") return "麦克风需 https";
    if (notice.kind === "unsupported") return "无语音识别";
    if (notice.kind === "stt") return "语音服务不可用";
    return "麦克风被拒";
  }
  return "开启麦克风";
}

// ================================================================ Dock

export function Dock(props: DockProps) {
  const { view } = props;
  const status = view.scene.characterStatus;
  const inputRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
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

  const hasError = view.banner?.tone === "error" || props.offline || props.mediaError !== null;
  const controls = visibleDockControls({
    characterStatus: status,
    micNotice: props.micNotice,
    speechSupported: props.diagnostics.speechSupported,
    hasError,
    canInterrupt: view.canInterrupt,
  });

  const chips = useMemo(
    () =>
      splitDockChips(
        dockChipList({
          characterStatus: status,
          sessionMode: view.session ? (view.session.mode === "live" ? "live" : "mock") : null,
          fallbackReason: view.session?.fallbackReason ?? null,
          audioMode: view.audioMode,
          keyless: view.session?.keyless ?? true,
          droppedEvents: view.droppedEvents,
          droppedActions: view.droppedActions,
        }),
      ),
    [status, view.session, view.audioMode, view.droppedEvents, view.droppedActions],
  );

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
    <div className="mira-dock" data-more-open={moreOpen ? "on" : "off"}>
      <ConnectionStrip
        offline={props.offline}
        recovered={props.recovered}
        checking={props.reconnecting}
        error={props.probeError}
        onReconnect={props.onReconnect}
      />
      <MediaErrorStrip notice={props.mediaError} onDismiss={props.onDismissMedia} />

      <div className="mira-row mira-row--meta" role="group" aria-label="运行状态">
        {chips.visible.map((chip) => (
          <span
            key={chip.key}
            className={`mira-chip${chip.tone ? ` mira-chip--${chip.tone}` : ""}${
              chip.key === "status" ? ` mira-status mira-status--${status}` : ""
            }`}
            data-status={chip.key === "status" ? status : undefined}
            title={chip.title}
          >
            {chip.key === "status" ? <span className="mira-status__dot" aria-hidden="true" /> : null}
            {chip.label}
          </span>
        ))}
      </div>

      {/* 主行：输入占满剩余宽度 + 发送（≥44×44）。回车发送不变。 */}
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
        <button type="submit" className="mira-btn mira-btn--send" disabled={!view.draft.trim()} aria-label="发送">
          发送
        </button>
      </form>

      {/* 次行：打断（仅说话时）·按住说话 · ⋯ · 麦克风主按钮（靠右，拇指可及） */}
      <div className="mira-row mira-row--actions">
        {controls.interrupt ? (
          <button
            type="button"
            className="mira-btn mira-btn--danger mira-dock__interrupt"
            onClick={props.onInterrupt}
            aria-label="打断（快捷键 Esc）"
            title="立即打断：停止语音、取消上一轮、回到倾听（快捷键 Esc）"
          >
            打断 <kbd>Esc</kbd>
          </button>
        ) : null}

        {controls.ptt ? (
          <PushToTalkButton onStart={props.onPushToTalkStart} onEnd={props.onPushToTalkEnd} />
        ) : null}

        <button
          ref={moreRef}
          type="button"
          className="mira-btn mira-btn--more"
          onClick={() => setMoreOpen(true)}
          aria-label={controls.moreDot ? "更多操作（有错误）" : "更多操作"}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
        >
          <span aria-hidden="true">⋯</span>
          {controls.moreDot ? <span className="mira-btn__dot" aria-hidden="true" /> : null}
        </button>

        {controls.voiceHint ? (
          <p className="mira-voice-hint">
            <span className="mira-voice-hint__lead">打字优先</span>
            <span className="mira-voice-hint__why">
              {props.micNotice?.kind === "insecure" ? "语音需 https" : "这台设备没有语音识别"}
            </span>
          </p>
        ) : (
          <MicButton
            label={micLabel}
            mic={view.mic}
            level={props.micLevel}
            onToggle={props.onMicToggle}
            onFocusInput={focusInput}
          />
        )}
      </div>

      {props.interim ? <p className="mira-dock__interim">「{props.interim}」</p> : null}
      {props.speaking ? (
        <p className="mira-dock__speaking" aria-live="off">
          正在朗读：{props.speaking}
        </p>
      ) : null}
      {props.note ? <p className="mira-dock__note">{props.note}</p> : null}

      {props.micNotice ? <MicNoticeBlock notice={props.micNotice} onFocusInput={focusInput} /> : null}

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} returnFocusRef={moreRef} hasDot={controls.moreDot}>
        {controls.retry ? (
          <button type="button" className="mira-drawer__btn" onClick={props.onRetry} aria-label="重试上一句">
            <span className="mira-drawer__label">
              <span className="mira-drawer__dot" aria-hidden="true" />
              重试
            </span>
            <span className="mira-drawer__hint">重发上一句，旧轮作废</span>
          </button>
        ) : null}

        {controls.lang ? (
          <div className="mira-drawer__section">
            <span className="mira-drawer__title" id="mira-lang-title">
              识别语言
            </span>
            <div className="mira-seg" role="group" aria-labelledby="mira-lang-title">
              <button
                type="button"
                className={`mira-seg__opt${view.sttLang === "zh-CN" ? " mira-seg__opt--on" : ""}`}
                aria-pressed={view.sttLang === "zh-CN"}
                onClick={() => props.onLangChange("zh-CN")}
              >
                中文
              </button>
              <button
                type="button"
                className={`mira-seg__opt${view.sttLang === "en-US" ? " mira-seg__opt--on" : ""}`}
                aria-pressed={view.sttLang === "en-US"}
                onClick={() => props.onLangChange("en-US")}
              >
                English
              </button>
            </div>
          </div>
        ) : null}

        <div className="mira-drawer__section">
          <span className="mira-drawer__title">演示模式</span>
          <p className="mira-drawer__text">
            {props.demo.active ? props.demo.badge : "未开启（地址加 ?demo=fail / timeout / tts 可注入人为故障）"}
          </p>
        </div>

        {chips.overflow.length > 0 ? (
          <div className="mira-drawer__section">
            <span className="mira-drawer__title">运行细节</span>
            <div className="mira-drawer__chips">
              {chips.overflow.map((chip) => (
                <span key={chip.key} className={`mira-chip${chip.tone ? ` mira-chip--${chip.tone}` : ""}`} title={chip.title}>
                  {chip.label}
                </span>
              ))}
            </div>
          </div>
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
      </MoreSheet>
    </div>
  );
}

// ================================================================ 麦克风主按钮

interface MicButtonProps {
  label: string;
  mic: SessionView["mic"];
  level: number;
  onToggle(): void;
  onFocusInput(): void;
}

/**
 * 圆形麦克风：关闭 / 请求中 / 监听中 / 不可用 四态靠**颜色 + 动效 + 图标**分辨。
 * 权限被拒时点它不会静默失败 —— 直接把焦点送到输入框（此刻打字是唯一可用入口）。
 */
function MicButton({ label, mic, level, onToggle, onFocusInput }: MicButtonProps) {
  const listening = mic === "listening";
  const requesting = mic === "requesting";
  const state = listening ? "listening" : requesting ? "requesting" : "off";
  const click = () => {
    if (mic === "denied" || mic === "unsupported") {
      onFocusInput();
      return;
    }
    onToggle();
  };
  return (
    <button
      type="button"
      className={`mira-mic mira-mic--${state}${mic === "denied" || mic === "unsupported" ? " mira-mic--blocked" : ""}`}
      onClick={click}
      aria-label={label}
      aria-pressed={listening}
      title={label}
      data-mic={mic}
    >
      <span
        className="mira-mic__ring"
        aria-hidden="true"
        style={listening ? { transform: `scale(${1 + Math.min(0.35, level * 4)})` } : undefined}
      />
      <svg className="mira-mic__icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
        <path d="M12 3.2a3.1 3.1 0 0 1 3.1 3.1v5.9a3.1 3.1 0 0 1-6.2 0V6.3A3.1 3.1 0 0 1 12 3.2Z" fill="currentColor" />
        <path
          d="M5.6 11.4a6.4 6.4 0 0 0 12.8 0M12 17.8V21M9 21h6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        {listening || requesting ? null : <path d="M4.6 19.4 19.4 4.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
      </svg>
    </button>
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
      <p className="mira-notice__fallback">替代入口：在输入框打字；打断用 Esc 或「打断」按钮</p>
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

// ================================================================ 按住说话

interface PushToTalkProps {
  onStart(): void;
  onEnd(): void;
}

/**
 * 按住说话：麦克风权限不可用时的明确替代交互。
 * 按下 = 打断 + 进入倾听；松开 = 结束识别（有转写就自动发送）。
 *
 * 为什么没并进麦克风按钮（短按切换 / 长按按住说话）：
 *  · 两者语义相反 —— 短按是「持久模式」，长按是「瞬时打断 + 倾听」，误判代价是"想开麦却打断了她"；
 *  · 220ms 阈值与 iOS 的系统长按（callout / 选择 / 拖拽）叠在一起，`touch-action:none` 只能降低概率；
 *  · 键盘和读屏拿不到"长按"，合并等于把这半个功能从无障碍通道里删掉。
 * 拆掉「重试 / 诊断 / 语言」之后横向空间并不紧张，所以独立按钮是更划算的一边。
 */
function PushToTalkButton({ onStart, onEnd }: PushToTalkProps) {
  const holdingRef = useRef(false);
  /** 按下期间用于视觉反馈：没有它用户不知道到底开没开始录 */
  const [holding, setHolding] = useState(false);

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
    setHolding(true);
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
    setHolding(false);
    onEnd();
  };

  return (
    <button
      type="button"
      className="mira-btn mira-btn--ptt"
      data-holding={holding ? "true" : "false"}
      onPointerDown={start}
      onPointerUp={end}
      onPointerCancel={end}
      // 浏览器丢失指针捕获时不一定会补发 pointerup；没有这条，录音会永久「按住」
      onLostPointerCapture={end}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        // 键盘可达：空格/回车按下即开始，抬起即结束（读屏与键盘用户此前只能看到按钮但按了没反应）
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          start(event as unknown as PointerEvent<HTMLButtonElement>);
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          end();
        }
      }}
      aria-label="按住说话：按下即打断并进入倾听，松开结束"
      title="按住说话：按下即打断并进入倾听，松开结束"
    >
      按住说话
    </button>
  );
}
