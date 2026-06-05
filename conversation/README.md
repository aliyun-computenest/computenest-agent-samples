# Conversation — 多轮对话

基于 [AgentScope Agent Service](https://docs.agentscope.io/v2/deploy/agent-service.md) 的对话示例：启动服务后自动创建 Credential 与 Agent，可按需预建默认 Session。

## 这是什么

- 智能对话：中文礼貌回复，支持多轮上下文
- 服务启动：配置 `DASHSCOPE_API_KEY` 后自动创建 Credential、Agent
- **计算巢一键开箱部署**：浏览器 Web UI（端口 5173）；默认预建 Session「Default」供开箱聊天


## 目录结构

```text
conversation/
├── main.py            # 服务入口（create Credential / Agent / 可选 Session）
├── client.py          # 本地 API 测试：创建 Session + 发两轮对话
├── server.sh          # Agent 启停
├── requirements.txt   # Python 依赖
├── .env.example       # 环境变量示例
└── .dockerignore      # 打 Docker 镜像时排除 .venv、.env、日志等
```

## 如何使用

### 计算巢部署

通过阿里云计算巢一键部署，无需本地安装环境：

1. **立即部署**：打开 [计算巢 Conversation 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/Conversation?serviceId=service-9503f4817acb4f08b948&deployType=ECS&TemplateName=%E6%A8%A1%E6%9D%BF1)，点击「立即部署」。
2. **填写并创建**：填写 `DASHSCOPE_API_KEY` 等参数，点击「立即创建」。
3. **访问实例**：在实例页「应用输出」查看 **WebUI 访问地址**（端口 **5173**）与 **API 调用示例**（`POST /chat/`）。

创建完成后，在实例详情页的「应用输出」中可看到：

- **WebUI 访问地址**：浏览器打开 `http://<实例IP>:5173`，Username 使用 `demo_user`。
- **API 调用示例**：向 `http://<实例IP>:8090/chat/` 发消息，请求头 `X-User-ID: demo_user`，body 需 `agent_id=conversation` 与 `session_id`（可在 Web UI 查看，或 `POST /sessions/` 创建）。OpenAPI：`http://<实例IP>:8090/docs`。

**Redis（ECS）**：使用环境变量中的 `SESSION_REDIS_URL`；未配置时使用默认 `redis://127.0.0.1:6379/0`。

**Redis（容器集群）**：必须在环境变量中配置 `SESSION_REDIS_URL`。

### 本地运行

**环境要求**

- Python ≥ 3.11
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- Redis（须配置 `SESSION_REDIS_URL`，见下）

**安装与启动**

```bash
cd conversation
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 编辑 .env：DASHSCOPE_API_KEY、SESSION_REDIS_URL

chmod +x server.sh
./server.sh start
```

- 服务：http://127.0.0.1:8090
- API 文档：http://127.0.0.1:8090/docs

本地若无 Redis，可先启动实例再写入 `.env`，例如：

```bash
export SESSION_REDIS_URL=redis://localhost:6379/0
```

**本地测试对话**

另开终端运行 `client.py`：使用预置 `agent_id=conversation`；每次运行会新建 Session（独立 `workspace_id`），并在同一会话内发两轮消息测试多轮记忆。

```bash
source .venv/bin/activate
python client.py
```

本地请使用 `client.py` 测试对话；Web UI 仅在计算巢实例上通过「应用输出」中的地址访问（:5173）。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 百炼 API Key | 必填 |
| `DASHSCOPE_MODEL_NAME` | 对话模型 | `qwen3.7-max` |
| `SESSION_REDIS_URL` | Redis 地址 | 必填；ECS 默认 `redis://127.0.0.1:6379/0` |
| `HOST` / `PORT` | HTTP 监听 | `0.0.0.0` / `8090` |
| `CREATE_DEFAULT_SESSION` | 设为 `1` 时，每次服务启动新建 Session「Default」（id 由系统生成） | `0`（计算巢部署为 `1`） |

复制并按需修改：

```bash
cp .env.example .env
```

## 参考

- [AgentScope 快速开始](https://docs.agentscope.io/zh/v2/quickstart)
- [Agent Service 文档](https://docs.agentscope.io/v2/deploy/agent-service.md)
