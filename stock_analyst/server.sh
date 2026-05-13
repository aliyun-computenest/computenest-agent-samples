#!/usr/bin/env bash
# stock_analyst 服务 start/stop/restart/status

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE="$SCRIPT_DIR/.agent.pid"
LOG_FILE="$SCRIPT_DIR/server.log"

is_running() {
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    return 1
}

start() {
    if is_running; then
        echo "stock_analyst 已在运行 (PID: $(cat "$PID_FILE"))"
        return 1
    fi
    nohup python3 main.py > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "stock_analyst 已启动 (PID: $(cat "$PID_FILE")), 日志: $LOG_FILE"
}

stop() {
    if ! is_running; then
        echo "stock_analyst 未在运行"
        rm -f "$PID_FILE"
        return 0
    fi
    local pid
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "stock_analyst 已停止 (原 PID: $pid)"
}

restart() {
    stop
    sleep 1
    start
}

status() {
    if is_running; then
        echo "stock_analyst 运行中 (PID: $(cat "$PID_FILE"))"
    else
        echo "stock_analyst 未运行"
    fi
}

case "${1:-}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    *)
        echo "用法: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
