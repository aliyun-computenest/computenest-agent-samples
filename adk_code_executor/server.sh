#!/usr/bin/env bash
# ADK Code Executor — 启停脚本
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${SCRIPT_DIR}/.adk.pid"
LOG_FILE="${SCRIPT_DIR}/adk.log"
HOST="${ADK_HOST:-0.0.0.0}"
PORT="${ADK_PORT:-8000}"

cd "$SCRIPT_DIR"

# 自动查找 adk 命令路径
find_adk() {
    if command -v adk &>/dev/null; then
        echo "adk"
    else
        # pip 可能安装到 Python 自身的 bin 目录
        local py_bin
        py_bin="$(python3 -c 'import sys; print(sys.prefix)')/bin/adk"
        if [ -x "$py_bin" ]; then
            echo "$py_bin"
        else
            echo "ERROR: adk command not found. Run: pip install google-adk" >&2
            exit 1
        fi
    fi
}

session_mode_label() {
    if [ -n "${SESSION_REDIS_URL:-}" ]; then
        echo "redis (${SESSION_REDIS_URL})"
    else
        echo "in-memory (ADK default)"
    fi
}

start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "ADK Code Executor is already running (PID $(cat "$PID_FILE"))"
        exit 1
    fi
    local adk_cmd
    adk_cmd="$(find_adk)"
    echo "Starting ADK Code Executor on ${HOST}:${PORT} ..."
    local -a cmd=("$adk_cmd" web --host "$HOST" --port "$PORT" .)
    if [ -n "${SESSION_REDIS_URL:-}" ]; then
        cmd+=(--session_service_uri="$SESSION_REDIS_URL")
    fi
    nohup "${cmd[@]}" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Started (PID $(cat "$PID_FILE")), log: ${LOG_FILE}"
    echo "  Session: $(session_mode_label)"
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "ADK Code Executor is not running (no PID file)"
        exit 1
    fi
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        echo "Stopping ADK Code Executor (PID ${pid}) ..."
        kill "$pid"
        rm -f "$PID_FILE"
        echo "Stopped."
    else
        echo "Process ${pid} not found, removing stale PID file."
        rm -f "$PID_FILE"
    fi
}

restart() {
    stop || true
    sleep 1
    start
}

status() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "ADK Code Executor is running (PID $(cat "$PID_FILE"))"
    else
        echo "ADK Code Executor is not running"
    fi
    echo "Session: $(session_mode_label)"
}

case "${1:-}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
