#!/usr/bin/env bash
# 可靠的本地服务重启脚本。
# 为什么需要它：pkill -f "node server.js" 会连当前 shell 的进程树一起打，
# 之前踩过两次（shell 被 SIGTERM）。这里改成按端口精确找 PID，再 kill。
#
# 用法: bash restart.sh [PORT] [TOKEN] [SHARE_TOKEN]
set -u
PORT="${1:-8080}"
TOKEN="${2:-wby6sg8pm0}"
SHARE="${3:-guest1234}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# 1) 找占用该端口的进程（只认 LISTEN 状态），精确 kill
PIDS=$(ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
if [ -n "$PIDS" ]; then
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  sleep 1
fi

# 2) 起新进程，脱离当前会话（setsid），日志落 /tmp
cd "$DIR" || exit 1
setsid env PORT="$PORT" TOKEN="$TOKEN" SHARE_TOKEN="$SHARE" \
  node server.js > "/tmp/drop-$PORT.log" 2>&1 < /dev/null &
disown 2>/dev/null || true

# 3) 健康检查（最多等 5 秒）
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.5
  if curl -fsS "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1; then
    echo "服务已就绪: http://127.0.0.1:$PORT  (token=$TOKEN, share=$SHARE)"
    exit 0
  fi
done

echo "启动失败，日志尾部："
tail -20 "/tmp/drop-$PORT.log"
exit 1
