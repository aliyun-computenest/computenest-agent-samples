#!/usr/bin/env bash
# knowledge_rag 本地启停（ADK）
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

start() {
    if is_running; then
        echo "已在运行 (PID: $(running_pid))"
        return 1
    fi
    load_env
    : "${DASHSCOPE_API_KEY:?需要设置 DASHSCOPE_API_KEY}"
    : "${DASHSCOPE_MODEL_NAME:?需要设置 DASHSCOPE_MODEL_NAME}"
    : "${BAILIAN_WORKSPACE_ID:?需要设置 BAILIAN_WORKSPACE_ID}"
    : "${BAILIAN_INDEX_ID:?需要设置 BAILIAN_INDEX_ID}"
    : "${ALIBABA_CLOUD_ACCESS_KEY_ID:?需要设置 ALIBABA_CLOUD_ACCESS_KEY_ID}"
    : "${ALIBABA_CLOUD_ACCESS_KEY_SECRET:?需要设置 ALIBABA_CLOUD_ACCESS_KEY_SECRET}"
    export BAILIAN_REGION_ID="${BAILIAN_REGION_ID:-cn-beijing}"

    local port="${PORT:-8000}"
    local -a cmd=(adk web . --host 0.0.0.0 --port "$port")
    if [[ -n "${SESSION_REDIS_URL:-}" ]]; then
        cmd+=(--session_service_uri="$SESSION_REDIS_URL")
    fi

    nohup "${cmd[@]}" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo "[knowledge_rag] 已启动 (PID: $(cat "$PID_FILE"))"
    echo "  Session: $(session_mode_label)"
    echo "  WebUI: http://0.0.0.0:${port}"
    echo "  日志:  $LOG_FILE"
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

status() {
    load_env
    if is_running; then
        echo "运行中 (PID: $(running_pid))"
    else
        echo "未运行"
    fi
    echo "Session: $(session_mode_label)"
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
