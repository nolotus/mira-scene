# 在 macOS 上测试

Windows/Linux 之外，这个项目在 macOS 上要额外注意几处平台差异。下面按「先做什么」排序。

## 一、跑起来

```bash
# 需要 bun（>= 1.1）。Apple Silicon 用官方安装脚本即可
curl -fsSL https://bun.sh/install | bash

git clone <repo> mira-scene && cd mira-scene
bun install
bun run dev        # 前端 5173 + 服务端 8787
open http://localhost:5173
```

**localhost 是安全上下文**，所以麦克风权限在本地就能弹出来，不需要 HTTPS、不需要部署。

## 二、逐项验收（对应题目六条）

| 项 | 怎么测 | 预期 |
|---|---|---|
| 四种状态 | 输入「你今晚一个人？」，看角色 | 待机→倾听→思考→说话，字幕逐字推进 |
| 对话触发演出 | 输入「外面还在下雨吗？」 | 闪电 + 雨势变大 + 镜头抖 + 她打寒颤 + 望向窗外 |
| 语音回复 | 点麦克风或按住说话 | 有声音，底部「正在朗读：…」与字幕对齐 |
| **打断** | 她说话时点「打断」或按 Esc | 语音立即停、字幕不再增长、状态回倾听 |
| 迟到响应 | DevTools → Network 限速 Slow 4G，说话时打断 | 「丢弃迟到事件 N」自增，画面不回退不重播 |
| 失败降级 | `?demo=timeout` / `?demo=fail` / 杀掉服务端 | 有明确提示与重试，不白屏 |

## 三、macOS 特有的坑（按可能性排序）

1. **语音识别只有 Chrome/Edge 可靠**。Safari 的 `webkitSpeechRecognition` 在 macOS 上存在但行为不稳定（有时不返回 `onresult`）。**验收请在 Chrome 里做**，Safari 只用来验证「不支持时的降级提示」是否出现。
2. **系统声音列表是异步就绪的**。macOS 首次打开页面时 `speechSynthesis.getVoices()` 可能返回空数组，代码里监听了 `voiceschanged` 再挑音色；如果第一句没声音，等 1–2 秒再说一次。中文音色通常是 `Tingting`。
3. **Safari 对 `speechSynthesis` 更严格**：必须在用户手势（点击）内调用，否则静默失败。第一次播放请通过点按钮触发，不要在页面加载时自动朗读。
4. **屏幕高度**：MacBook 默认分辨率下，浏览器窗口如果很矮，Dock 会挤压画面。用 375–430px 宽的窄窗口验证移动端形态最接近真实场景。
5. **防火墙/网络**：语音识别走厂商云端，公司网络或代理下可能报 `network` 错误 —— 这属于已知限制，此时用打字入口。
6. **文件系统大小写**：macOS 默认大小写不敏感。仓库里如果有仅大小写不同的文件名，`git status` 会误报；当前项目没有这种情况，但导入后若出现「已修改但内容没变」，先查这个。

## 四、真模型模式

```bash
DEEPSEEK_API_KEY=<key> DIRECTOR=live bun run dev
```

或指向任意 OpenAI 兼容端点：

```bash
MIRA_LLM_BASE_URL=https://api.deepseek.com \
MIRA_LLM_API_KEY=<key> \
MIRA_LLM_MODEL=deepseek-chat \
DIRECTOR=live bun run dev
```

**不要把 key 写进任何被 git 跟踪的文件**（`.env*` 已在 `.gitignore` 里）。

## 五、如果发现平台差异，怎么报

记下三件事再开 issue/反馈：① 浏览器与版本；② 是 `localhost` 还是部署地址；③ DevTools Console 的原始报错文本（不要转述）。截图或录屏比文字描述省事。
