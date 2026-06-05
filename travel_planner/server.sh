#!/usr/bin/env bash
# travel_planner：Agent Service 启停（main.py）
# 须配置 SESSION_REDIS_URL，见 .env.example

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

ensure_redis_url() {
    load_env
    if [[ -z "${SESSION_REDIS_URL:-}" ]]; then
        echo "错误: 未设置 SESSION_REDIS_URL" >&2
        exit 1
    fi
}

find_app_pids() {
    ps -ef 2>/dev/null | awk '/python3/ && /main\.py/ && $0 !~ /awk/ { print $2 }' | sort -u
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
    local pids
    pids=$(find_app_pids || true)
    [[ -n "$pids" ]]
}

stop() {
    local pid killed=0
    if [[ -f "$PID_FILE" ]]; then
        pid=$(cat "$PID_FILE")
        kill "$pid" 2>/dev/null || true
        killed=1
        rm -f "$PID_FILE"
    fi
    while read -r pid; do
        [[ -z "$pid" ]] && continue
        kill "$pid" 2>/dev/null || true
        killed=1
    done < <(find_app_pids)
    [[ "$killed" -eq 1 ]] && echo "已停止" || echo "未在运行"
}

start() {
    if is_running; then
        echo "已在运行 (PID: $(cat "$PID_FILE" 2>/dev/null || find_app_pids))"
        return 1
    fi
    ensure_redis_url
    nohup env SESSION_REDIS_URL="$SESSION_REDIS_URL" python3 main.py >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo "已启动 (PID: $(cat "$PID_FILE")), 日志: $LOG_FILE"
    echo "OpenAPI: http://127.0.0.1:${PORT:-8090}/docs"
}

status() {
    load_env
    if is_running; then
        echo "运行中 (PID: $(cat "$PID_FILE" 2>/dev/null || find_app_pids))"
    else
        echo "未运行"
    fi
    if [[ -n "${SESSION_REDIS_URL:-}" ]]; then
        echo "Redis: $SESSION_REDIS_URL"
    else
        echo "Redis: 未配置"
    fi
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
