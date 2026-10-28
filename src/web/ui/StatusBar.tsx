import type { StatusBanner } from "../state/store";

interface StatusBarProps {
  banner: StatusBanner | null;
  onRetry(): void;
  onDismiss(): void;
}

/** 短暂状态条：超时、断线、SSE error 的可见反馈 + 重试入口 */
export function StatusBar({ banner, onRetry, onDismiss }: StatusBarProps) {
  if (!banner) return null;
  return (
    <div className={`mira-banner mira-banner--${banner.tone}`} role="status" data-banner-id={banner.id}>
      <span className="mira-banner__text">{banner.text}</span>
      {banner.retryable ? (
        <button type="button" className="mira-banner__action" onClick={onRetry}>
          重试
        </button>
      ) : null}
      <button
        type="button"
        className="mira-banner__close"
        onClick={onDismiss}
        aria-label="关闭提示"
      >
        ×
      </button>
    </div>
  );
}
