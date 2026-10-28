/**
 * 画面错误边界：角色/场景是程序化渲染（Canvas/DOM 动画），一旦渲染期抛错，
 * React 会卸载整棵树 —— 那才是真正的「白屏」。这里把它兜住：
 * 画面区退化成一个说明块，dock（输入框、重试、诊断）仍然活着，用户可以继续打字。
 *
 * 注意：错误边界只能捕获渲染期错误；事件回调与异步错误由
 * availability.ts 的 attachRuntimeErrorWatcher（window error / unhandledrejection）兜底。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onError(error: Error, info: ErrorInfo): void;
}

interface State {
  failed: boolean;
}

export class StageBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError(error, info);
  }

  private retry = (): void => {
    this.setState({ failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mira-stage-fallback" role="alert" data-stage="failed">
        <p className="mira-stage-fallback__title">画面渲染中断了</p>
        <p className="mira-stage-fallback__body">
          角色的表演脚本抛了错，所以这里停住了（不是白屏，也不影响对话）。文字输入和打断仍然可用。
        </p>
        <button type="button" className="mira-btn" onClick={this.retry}>
          重新渲染画面
        </button>
      </div>
    );
  }
}
