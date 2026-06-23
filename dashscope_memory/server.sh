#!/usr/bin/env bash
# dashscope_memory 本地启停（ADK）
# 用法: ./server.sh {start|stop|restart|status}
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.agent.pid"
LOG_FILE="$SCRIPT_DIR/server.log"

load_env() {
    if [[ -f "$SCRIPT_DIR/.env" ]]; then
        set -a
        # shellcheck disable=SC1091
        source "$SCRIPT_DIR/.env"
        set +a
    fi
}

session_mode_label() {
    if [[ -n "${SESSION_REDIS_URL:-}" ]]; then
        echo "redis (${SESSION_REDIS_URL})"
    else
        echo "in-memory (ADK default)"
    fi
}

find_app_pids() {
    ps -ef 2>/dev/null | awk -v dir="$SCRIPT_DIR" '
        /adk/ && /web/ && index($0, dir) && $0 !~ /awk/ { print $2 }
    ' | sort -u
}

is_running() {
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    [[ -n "$(find_app_pids || true)" ]]
}

running_pid() {
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return
        fi
    fi
    find_app_pids | head -1
}

stop() {
    local pid killed=0

    if [[ -f "$PID_FILE" ]]; then
        pid=$(cat "$PID_FILE")
        rm -f "$PID_FILE"
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            echo "已停止"
            return 0
        fi
    fi

    while read -r pid; do
        [[ -z "$pid" ]] && continue
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            killed=1
        fi
    done < <(find_app_pids)

    [[ "$killed" -eq 1 ]] && echo "已停止" || echo "未在运行"
}

start() {
    if is_running; then
        echo "已在运行 (PID: $(running_pid))"
        return 1
    fi
    load_env
    : "${DASHSCOPE_API_KEY:?需要设置 DASHSCOPE_API_KEY}"
    : "${BAILIAN_MEMORY_LIBRARY_ID:?需要设置 BAILIAN_MEMORY_LIBRARY_ID}"

    local port="${PORT:-8000}"
    local memory_uri="${MEMORY_SERVICE_URI:-bailian://memory}"
    local -a cmd=(
        adk web . --host 0.0.0.0 --port "$port"
        --memory_service_uri="$memory_uri"
    )
    if [[ -n "${SESSION_REDIS_URL:-}" ]]; then
        cmd+=(--session_service_uri="$SESSION_REDIS_URL")
    fi

    nohup "${cmd[@]}" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo "[dashscope_memory] 已启动 (PID: $(cat "$PID_FILE"))"
    echo "  Session: $(session_mode_label)"
    echo "  Memory: $memory_uri"
    echo "  WebUI:  http://0.0.0.0:${port}"
    echo "  日志:   $LOG_FILE"
}

status() {
    load_env
    if is_running; then
        echo "运行中 (PID: $(running_pid))"
    else
        echo "未运行"
    fi
    echo "Session: $(session_mode_label)"
    echo "Memory: ${MEMORY_SERVICE_URI:-bailian://memory}"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop; sleep 1; start ;;
    status) status ;;
    *)
        echo "用法: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
