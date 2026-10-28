import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** 下滑关闭的判定距离：太灵敏会在滚动抽屉内容时误关 */
const SWIPE_CLOSE_PX = 72;

interface MoreSheetProps {
  open: boolean;
  onClose(): void;
  /** 关闭后焦点回到的触发按钮（⋯）。只读引用，避免 RefObject 的型变问题 */
  returnFocusRef: { readonly current: HTMLElement | null };
  /** 抽屉里有错误入口时，标题带红点 */
  hasDot: boolean;
  children: ReactNode;
}

/**
 * 「⋯」溢出抽屉：重试 / 识别语言 / 演示状态 / 运行细节 / 诊断。
 *
 * 为什么用 portal 挂到 body：`.mira-dock` 上有 `backdrop-filter`，
 * 它会成为 fixed 后代的包含块，抽屉会被裁剪在底栏里 —— 直挂 body 才真的有遮罩层。
 *
 * 关闭方式四种，互为兜底：显式「关闭」按钮 / 点遮罩 / Esc / 下滑。
 * Esc 在 document 捕获阶段拦下并 stopPropagation —— 否则会顺带触发全局「Esc 打断」。
 */
export function MoreSheet({ open, onClose, returnFocusRef, hasDot, children }: MoreSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ startY: number; dy: number } | null>(null);

  // 打开时把焦点送进抽屉，关闭时还给触发按钮
  useEffect(() => {
    if (!open) return undefined;
    const raf = requestAnimationFrame(() => {
      const target = sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? closeRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      const trigger = returnFocusRef.current;
      if (trigger && typeof trigger.focus === "function") trigger.focus();
    };
  }, [open, returnFocusRef]);

  // Esc 关闭 + Tab 焦点不出抽屉
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  const onGrabDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startY: event.clientY, dy: 0 };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 无指针捕获时下滑仍可用，只是没有跟手感 */
    }
  };

  const onGrabMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.dy = Math.max(0, event.clientY - drag.startY);
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${drag.dy}px)`;
  };

  const onGrabUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (sheetRef.current) sheetRef.current.style.transform = "";
    if (drag && drag.dy >= SWIPE_CLOSE_PX) onClose();
  };

  return createPortal(
    <div className="mira-drawer-root">
      <div className="mira-drawer__scrim" role="presentation" onClick={onClose} />
      <div
        ref={sheetRef}
        className="mira-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="更多操作"
        data-dot={hasDot ? "on" : "off"}
      >
        <div
          className="mira-drawer__grab"
          role="presentation"
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
        >
          <span className="mira-drawer__handle" aria-hidden="true" />
          <div className="mira-drawer__head">
            <h2 className="mira-drawer__heading">
              {hasDot ? <span className="mira-drawer__dot" aria-hidden="true" /> : null}
              更多操作
            </h2>
            <p className="mira-drawer__tip">下滑 / 点空白 / Esc 也可关闭</p>
          </div>
        </div>

        <div className="mira-drawer__body">{children}</div>

        <div className="mira-drawer__foot">
          <button ref={closeRef} type="button" className="mira-btn mira-drawer__close" onClick={onClose} aria-label="关闭更多操作">
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
