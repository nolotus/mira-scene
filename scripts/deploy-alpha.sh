#!/usr/bin/env bash
# 把本地代码发布到 alpha 线（mira.nolo.chat）
#
# 前置：
#   - 本地有 ssh 别名 `alpha-raw`（HostName 144.202.110.59）
#   - alpha 上已有 systemd 单元 `mira-scene.service`（WorkingDirectory=/root/mira-scene）
#   - alpha 的 Caddy 里已有人工追加的 mira.nolo.chat 站点块（见 README 已知问题）
#
# 这个脚本不动 Caddy、不动 DNS，只做：同步代码 → 装依赖 → 构建 → 重启服务 → 自检。
# 不成功就立刻停（set -e），不静默跳过。
set -euo pipefail

HOST="${ALPHA_HOST:-alpha-raw}"
PORT="${MIRA_PORT:-8787}"
PUBLIC_URL="${MIRA_URL:-https://mira.nolo.chat}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> 1/5 同步代码到 $HOST"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git \
  "$LOCAL_DIR/" "$HOST:/root/mira-scene/"

echo "==> 2/5 安装依赖并构建"
ssh "$HOST" 'cd /root/mira-scene && bun install --frozen-lockfile 2>&1 | tail -2 && bun run build 2>&1 | tail -3'

echo "==> 3/5 重启服务"
ssh "$HOST" "sudo systemctl restart mira-scene && sleep 2 && systemctl is-active mira-scene"

echo "==> 4/5 本机回环自检"
ssh "$HOST" "curl -s -m 5 -o /dev/null -w 'loopback=%{http_code}\n' http://127.0.0.1:$PORT/api/health"

echo "==> 5/5 公网自检（含 SSE 是否为真流式）"
curl -s -m 15 -o /dev/null -w "public=%{http_code}\n" "$PUBLIC_URL/api/health"
python3 - "$PUBLIC_URL" <<'PY'
import json, subprocess, sys, time
base = sys.argv[1]
sid = json.loads(subprocess.check_output(["curl","-s","-m","10","-X","POST", base + "/api/session"]))["sessionId"]
body = json.dumps({
    "sessionId": sid, "turnId": "deploy-check", "epoch": 1, "userText": "外面还在下雨吗？",
    "scene": {"scene": "cafe_night", "emotion": "neutral", "pose": "stand", "playedBeats": []},
    "history": [],
})
t0 = time.time()
p = subprocess.Popen(["curl","-sN","-m","30","-X","POST", base + "/api/turn",
                      "-H","Content-Type: application/json","-d",body],
                     stdout=subprocess.PIPE, text=True, bufsize=1)
marks = []
for line in p.stdout:
    line = line.strip()
    if not line.startswith("data: "):
        continue
    try:
        ev = json.loads(line[6:])
    except Exception:
        continue
    marks.append(((time.time()-t0)*1000, ev["type"]))
p.wait()
if not marks:
    print("SSE 没有收到任何事件 —— 部署检查失败")
    sys.exit(1)
spread = marks[-1][0] - marks[0][0]
print(f"SSE 事件 {len(marks)} 条，首末间隔 {spread:.0f}ms -> " + ("流式正常" if spread > 300 else "可疑：疑似被缓存攒块"))
print("最后一条事件:", marks[-1][1], "(应为 turn.end)")
sys.exit(0 if marks[-1][1] == "turn.end" else 1)
PY

echo "==> 完成：$PUBLIC_URL"
