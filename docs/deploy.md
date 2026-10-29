# 部署与本地语音测试

> 这份文档是为了「换一台机器也能把项目跑起来、能对着麦克风测、能发上线」。
> 具体主机地址、密钥、Caddy 配置**不入库**（仓库是公开的）——本文只写流程与判据，
> 值放在你自己的 `.env.local` / ssh config / 服务器上。

---

## 一、拓扑（先搞清楚线上到底跑了什么）

```
浏览器 ──https──▶ Caddy ──反代──▶ bun server (:8787)
                                    ├─ /api/*      业务接口（SSE / TTS / 插图 / 健康检查）
                                    ├─ /api/stt    WebSocket 升级（服务端代理 Deepgram）
                                    └─ /*          生产模式下直接从 dist/ 出静态文件 + SPA fallback
```

两个含义，部署时容易踩：

- **服务端自己 serve 静态文件**（`src/server/app.ts` 的 `DIST_DIR`），所以 Caddy 只需要反代到
  `:8787`，不需要单独配静态目录。
- **Caddy 里的站点块是手工加的**，没进自动化流程。如果哪天站点整体 502 但 `curl 127.0.0.1:8787/api/health`
  是 200，先去看 Caddy 的配置还在不在。

---

## 二、在一台新机器上本地跑起来（Mac 上做语音测试走这条）

### 1. 前置

| 需要 | 为什么 | 检查 |
|---|---|---|
| Bun | 运行时 | `bun --version` |
| Chrome | 麦克风 + `webkitSpeechRecognition` 回退 + AEC | — |
| edge-tts（可选回退） | 中文 TTS 三级链是 **原生 WS → `edge-tts` CLI → 浏览器 TTS**：不装 CLI 一般也能出声（原生 WS 走热连接，实测 287ms），只有原生那条挂了才会用到它 | `edge-tts --version`（没有也能跑） |
| Deepgram key | 中文语音识别（`nova-2`） | 见下 |

装 edge-tts（可选回退，Mac）：

```bash
pip3 install --user edge-tts      # 通常落在 ~/Library/Python/3.x/bin/edge-tts
```

找不到命令时用 `ETTS_BIN` 指绝对路径。

### 2. 配置

```bash
cp .env.example .env.local
```

`.env.local` 里至少填这些（其余留空就走 Mock，零密钥也能跑完整流程）：

```ini
DEEPGRAM_API_KEY=...            # 不填 → STT 回退浏览器 Web Speech，中文效果更差
ETTS_BIN=/绝对路径/edge-tts      # 只有 edge-tts 不在 PATH 时才需要
```

### 3. 启动

```bash
bun install
bun run dev          # vite :5173 + api :8787（vite 把 /api 代理到 8787）
```

打开 `http://localhost:5173`。

**必须是 `localhost` 或 `https`**：`getUserMedia` 只在 secure context 下存在，
用 `http://192.168.x.x:5173` 打开会拿不到麦克风，输入框会退化成纯打字（界面会明说原因）。

### 4. 对着麦克风测什么、怎么看证据

URL 开关（可以组合）：

| 开关 | 作用 |
|---|---|
| `?trace=1` | 毫秒时间线打进 console（`[barge-in] ...`），打断链路、状态迁移都在这 |
| `?obs=1` | 顶部观测抽屉：首事件 / 模型首字 / 首个音频 / 真正出声 / 整轮，含 p50·p95 |
| `?stt=fake` | 用脚本化假上游顶替 Deepgram：`+300ms speech_started`、`+500ms interim`、`+800ms final`。**不耗 key、不需要真人说话**就能验打断链路 |
| `?aec=on\|off\|unknown` | 强制麦克风的 AEC 实测值（只与 `?stt=fake` 一起用） |
| `?bargeIn=off` | 关掉自动语音打断（只留 Esc / 按钮） |
| `?director=live` | 这一会话走真模型（要服务端配了 LLM key，按 token 计费） |

**验证语音打断（不花钱）**：

```
http://localhost:5173/?stt=fake&aec=on&trace=1
```

发一条消息 → 她开始说话 → 假上游会在 +300ms 报 `speech_started`。
console 里应看到 `speech_started → interrupt:begin → audio:stopped → interrupt:done`，
真浏览器实测是 200ms 量级。

**验证真人外放打断（这台机器能不能做）**：

1. 打开页面后，在 console 里跑一次麦克风权限，读 `getSettings()`：
   ```js
   const s = await navigator.mediaDevices.getUserMedia({ audio: true });
   s.getAudioTracks()[0].getSettings().echoCancellation
   ```
2. 返回 `true` 才能做外放打断。返回 `undefined` → 客户端按保守策略把
   `barge-in source` 判成 `none`，**自动语音打断整体关闭**（只剩 Esc / 按钮）。
   这是刻意的：读不到 AEC 就不放行，避免她自己的声音被判成用户开口。

### 5. 本地不花 API 费用的边界

- 默认 `DIRECTOR=mock`，不调模型
- 不填 `DEEPGRAM_API_KEY` → `/api/stt` 明确 503，客户端回退浏览器语音识别
- `?illustrate` 相关不配 `CF_AI_TOKEN` 时返回 `not-configured`，客户端静默降级
- 只有 `?director=live` 且服务端配了 key 的会话才按 token 计费

---

## 三、部署到线上

### 前置（一次性）

- 本机 ssh config 里有一个别名（下文用 `$ALPHA_HOST` 指代）
- 服务器上有 systemd 单元 `mira-scene.service`，`WorkingDirectory` 指向项目目录
- 服务器上已装 bun、edge-tts
- Caddy 里有站点块把域名反代到 `:8787`（**手工维护**）

### 发布脚本（复制到本地用，不要提交含主机信息的版本）

```bash
#!/usr/bin/env bash
# 同步代码 → 装依赖 → 构建 → 重启 → 自检。失败即停，不静默跳过。
set -euo pipefail

HOST="${ALPHA_HOST:?请设置 ALPHA_HOST}"
PORT="${MIRA_PORT:-8787}"
PUBLIC_URL="${MIRA_URL:?请设置 MIRA_URL}"
REMOTE_DIR="${REMOTE_DIR:?请设置 REMOTE_DIR}"

echo "==> 1/5 同步代码"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git --exclude '.env*' \
  "./" "$HOST:$REMOTE_DIR/"

echo "==> 2/5 安装依赖并构建"
ssh "$HOST" "cd $REMOTE_DIR && bun install --frozen-lockfile 2>&1 | tail -2 && bun run build 2>&1 | tail -3"

echo "==> 3/5 重启服务"
ssh "$HOST" "sudo systemctl restart mira-scene && sleep 2 && systemctl is-active mira-scene"

# Caddy 的站点块由 bun-nolo 的 scripts/release/configureCaddyProxy.sh 生成，
# 那个脚本重写 /etc/caddy/Caddyfile 时**不包含 mira 块** —— 2026-10-29 实测，
# 它被别的部署跑过一次之后 mira.nolo.chat 整站 000（服务自己还是好的）。
# 所以每次部署都先自检，缺了就补回来再 reload。
echo "==> 3.5/5 确保 Caddy 有 mira 站点块"
ssh "$HOST" 'grep -q "mira.nolo.chat" /etc/caddy/Caddyfile || {
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-mira-$(date +%s)
  printf "\nmira.nolo.chat {\n\treverse_proxy 127.0.0.1:8787\n}\n" >> /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && systemctl reload caddy
}'

echo "==> 4/5 回环自检"
ssh "$HOST" "curl -s -m 5 -o /dev/null -w 'loopback=%{http_code}\n' http://127.0.0.1:$PORT/api/health"

echo "==> 5/5 公网自检"
curl -s -m 15 -o /dev/null -w "public=%{http_code}\n" "$PUBLIC_URL/api/health"
```

### `rsync --delete` 的安全习惯

**先干跑，看会删什么，再真跑**：

```bash
rsync -an --delete --itemize-changes \
  --exclude node_modules --exclude dist --exclude .git --exclude '.env*' \
  "./" "$HOST:$REMOTE_DIR/" | grep '^\*deleting'
```

- 输出为空 → 服务器上没有多余文件，可以放心同步
- 有输出 → 逐条看。尤其确认 `.env*` 已被 `--exclude` 挡住（服务器的环境变量文件
  不该被本地的一次同步删掉）

### 部署成功的判据（四条，缺一不算成功）

1. `systemctl is-active mira-scene` → `active`
2. `loopback=200`
3. `public=200`
4. **SSE 是真流式**：POST `/api/turn` 收事件流，首末事件间隔 > 300ms 且最后一条是
   `turn.end`。间隔接近 0 说明被反代/压缩攒成一块了，吐字会变成"憋一下全吐出来"

### 回滚

```bash
# 服务器上
cd "$REMOTE_DIR" && git checkout <上一个已知good的sha>   # 或重新 rsync 上一版代码
bun install --frozen-lockfile && bun run build
sudo systemctl restart mira-scene
```

回滚后同样跑一遍四条的判据。`dist/` 每次 build 都重写，不要指望"保留旧 dist"来回滚。

---

## 四、已知的坑（都是实测踩过的）

| 现象 | 原因 | 处置 |
|---|---|---|
| 站点整体 502，但回环 200 | Caddy 站点块丢了（手工配置） | 补回反代配置 |
| 首句声音要等 1–1.5s，后面就快了 | Edge WebSocket 空闲 15s 自动关闭（`WS_IDLE_CLOSE_MS`），每次重连要重新握手 | 已知待优化项；用 `?obs=1` 看 `TTS TTFB` |
| 说话时她不打断 | 读不到 AEC → `source=none` | 换一台能上报 `echoCancellation: true` 的机器外放 |
| 说完到出终稿约 1.1s | Deepgram `endpointing` 300ms + 上游缓冲 | 已知项，字幕会停在最后一条 interim |
| 部署后第一句话走系统音 | 原生 WS 没成（握手失败 / 未配置）→ 先退 `edge-tts` CLI，CLI 也没有或也失败才回浏览器 TTS；旧版还叠加 `edge-tts --version` 探测耗时 | 看 `?obs=1` 的 `status:ready` 与 `/api/voice/status` 里的 `ttsNative.offReason` |
| 重连后会话 id 变成孤儿 | 重连会新建会话，旧 sessionId 不再使用 | 已知副作用，见 README 已知问题 |
