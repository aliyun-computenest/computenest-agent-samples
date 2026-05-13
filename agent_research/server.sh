#!/usr/bin/env bash
# agent_research 服务统一管理脚本
# 用法：bash server.sh {start|stop|restart|status}
#
#   start     部署并启动前后端所有服务（含依赖安装、构建、启动）
#   stop      停止前后端所有服务
#   restart   重启前后端所有服务
#   status    查看后端服务状态

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/web/starter_webui"
BACKEND_DIR="$SCRIPT_DIR"
PID_FILE="$SCRIPT_DIR/.agent.pid"

# 停止指定 PID 文件对应的进程
stop_process() {
    local name="$1"
    local pid_file="$2"

    if [ ! -f "$pid_file" ]; then
        return 0
    fi

    local pid
    pid=$(cat "$pid_file")

    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        local waited=0
        while kill -0 "$pid" 2>/dev/null && [ $waited -lt 5 ]; do
            sleep 1
            waited=$((waited + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
        echo "$name 已停止 (PID: $pid)"
    fi

    rm -f "$pid_file"
}

stop() {
    stop_process "后端" "$BACKEND_DIR/.agent.pid"
    stop_process "前端" "$FRONTEND_DIR/.frontend.pid"
    echo "agent_research 已停止"
}

start() {
    # 检查必要命令
    for cmd in python3 pip3 node npm; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            echo "错误：未找到命令 $cmd，请先安装后重试"
            exit 1
        fi
    done

    # 后端：安装依赖
    cd "$BACKEND_DIR"

    local venv_dir="$BACKEND_DIR/.venv"
    if [ ! -d "$venv_dir" ]; then
        python3 -m venv "$venv_dir"
    fi

    local pip="$venv_dir/bin/pip"
    local python="$venv_dir/bin/python3"

    "$pip" install --upgrade pip -q
    "$pip" install -r requirements.txt

    # 安装 playwright 浏览器（如果需要）
    if ! "$venv_dir/bin/playwright" show-browsers >/dev/null 2>&1; then
        echo "安装 Playwright 浏览器..."
        "$venv_dir/bin/playwright" install chromium
    fi

    # 前端：安装依赖并构建
    if [ ! -d "$FRONTEND_DIR" ]; then
        echo "错误：前端目录不存在：$FRONTEND_DIR"
        exit 1
    fi

    cd "$FRONTEND_DIR"
    npm install

    # 获取公网 IP 设置 BASE_URL
    local public_ip=""
    public_ip=$(curl -sf --max-time 3 \
        "http://100.100.100.200/latest/meta-data/eipv4" \
        | tr -d '[:space:]') || true

    if [ -z "$public_ip" ]; then
        for ip_service in "http://api.ipify.org" "http://icanhazip.com" "http://ifconfig.me/ip"; do
            public_ip=$(curl -sf --max-time 5 "$ip_service" | tr -d '[:space:]') || true
            [ -n "$public_ip" ] && break
        done
    fi

    if [ -n "$public_ip" ]; then
        export NEXT_PUBLIC_API_URL="http://${public_ip}:8090"
        echo "前端 API 地址：$NEXT_PUBLIC_API_URL"
    fi

    # Next.js 不需要 build，直接用 dev 模式运行
    # npm run build

    # 启动前端开发服务器
    local dev_pid_file="$FRONTEND_DIR/.frontend.pid"
    if [ -f "$dev_pid_file" ]; then
        local old_dev_pid
        old_dev_pid=$(cat "$dev_pid_file")
        kill "$old_dev_pid" 2>/dev/null || true
        rm -f "$dev_pid_file"
        sleep 1
    fi

    nohup npm run dev > "$FRONTEND_DIR/frontend.log" 2>&1 &
    echo $! > "$dev_pid_file"

    # 启动后端
    cd "$BACKEND_DIR"

    if [ -f "$PID_FILE" ]; then
        local old_pid
        old_pid=$(cat "$PID_FILE")
        kill "$old_pid" 2>/dev/null || true
        rm -f "$PID_FILE"
        sleep 1
    fi

    nohup "$python" main.py > "$BACKEND_DIR/logs/backend.log" 2>&1 &
    echo $! > "$PID_FILE"

    echo "agent_research 已启动"
    echo "  后端：http://127.0.0.1:8090"
    echo "  前端：http://localhost:5173"
}

restart() {
    stop
    sleep 1
    start
}

status() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "后端运行中 (PID: $(cat "$PID_FILE"))"
    else
        echo "后端未运行"
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
