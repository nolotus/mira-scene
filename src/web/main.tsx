import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html 里缺少 #root");
}

// 刻意不套 StrictMode：会话/SSE/TTS 都是外部副作用，
// 开发期的双次挂载会无谓地创建又取消一轮请求，干扰打断时序的观察。
createRoot(container).render(<App />);
