import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const DOCK_ID = "dock";

/**
 * 把控件挂到 Stage 底部的 `#dock` 槽里。
 * Stage 是本仓库里另一个模块，可能比我们晚一拍挂载 `#dock`：
 *  - 先同步 getElementById 试一次
 *  - 不在就 MutationObserver 等它出现，另有 1 次 rAF 兜底
 *  - 始终找不到就退化渲染在自己的容器里（绝不因为槽位缺失而丢控件）
 */
export function DockPortal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let disposed = false;

    const check = (): boolean => {
      const node = document.getElementById(DOCK_ID);
      if (!node || disposed) return false;
      setHost(node);
      return true;
    };

    if (check()) return undefined;

    const observer = new MutationObserver(() => {
      if (check()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => {
            if (check()) observer.disconnect();
          })
        : null;

    return () => {
      disposed = true;
      observer.disconnect();
      if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    };
  }, []);

  if (host) {
    return createPortal(<div className="mira-dock-host">{children}</div>, host);
  }
  return <div className="mira-dock-host mira-dock-host--fallback">{children}</div>;
}
