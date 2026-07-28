#!/usr/bin/env bash
# CodeAgent FC Sandbox 本地启停（生产构建，默认端口 8000）。
# 用法：./server.sh {start|stop|restart|status}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.agent.pid"
LOG_FILE="$SCRIPT_DIR/server.log"
cd "$SCRIPT_DIR"

load_env() {
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
  fi
  if [[ -f "$SCRIPT_DIR/.env.local" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env.local"
    set +a
  fi
}

is_running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null
}

start() {
  load_env
  : "${DASHSCOPE_API_KEY:?需要设置 DASHSCOPE_API_KEY}"
  : "${E2B_API_KEY:?需要设置 E2B_API_KEY}"
  if is_running; then
    echo "已在运行 (PID: $(<"$PID_FILE"))"
    return 1
  fi
  npm run build
  nohup npm run start >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "已启动 (PID: $(<"$PID_FILE"), http://127.0.0.1:${PORT:-8000})"
}

stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "未在运行"
    return
  fi
  kill "$(<"$PID_FILE")"
  rm -f "$PID_FILE"
  echo "已停止"
}

status() {
  if is_running; then
    echo "运行中 (PID: $(<"$PID_FILE"))"
  else
    echo "未运行"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
esac
