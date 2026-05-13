# Conversation - 最简单的聊天 Agent

基于 **AgentScope** 和 **AgentScope Runtime** 的入门级对话智能体，展示如何创建一个具备短期记忆能力的基础 AI Agent。

## 概述

本示例是 AgentScope 的 "Conversation"，展示最基本的 Agent 构建与 HTTP 服务暴露流程。

## 核心功能

- 创建一个简单的对话 Agent（无工具）
- 使用 Session 维护对话上下文（短期记忆）
- 实现多轮对话中的信息记忆
- 通过 AgentScope Runtime 暴露为 HTTP SSE 流式接口

## Agent 能力

```text
用户消息
    ↓
AgentScope Runtime (AgentApp)
    ↓
Hello World Agent
    ├── ReActAgent（对话引擎）
    ├── RedisSession / InMemoryMemory（会话记忆）
    └── 通义千问等模型（LLM）
```

### 核心组件

| 组件 | 描述 |
| - | - |
| **Agent 服务** | [main.py](main.py) - 主应用，定义 AgentApp 与 query 处理逻辑 |
| **测试客户端** | [client.py](client.py) - 调用 `/process` 的 SSE 流式客户端 |
| **项目配置** | [pyproject.toml](pyproject.toml) - 依赖管理（可选 uv） |
| **依赖列表** | [requirements.txt](requirements.txt) - 用于 pip 安装 |

### 代码特点

**AgentApp 与 query 定义**（[main.py](main.py)）： 

```python
agent_app = AgentApp(
    app_name="conversation",
    app_description="Hello World 对话智能体，具备短期记忆能力",
    lifespan=lifespan,
)

@agent_app.query(framework="agentscope")
async def query_func(self, msgs, request: AgentRequest = None, **kwargs):
    # 加载/保存 session 状态，运行 ReActAgent，流式 yield
```

**多轮对话测试**（[client.py](client.py)）：

```python
await send_request("我叫AgentScope")
await send_request("你还记得我叫什么吗？")
```

## 目录结构

```text
hello_world/
├── main.py            # Agent 应用入口（AgentScope + AgentScope Runtime）
├── client.py          # 测试客户端（/process SSE 流式调用）
├── server.sh          # 后台服务控制脚本（start/stop/restart/status）
├── requirements.txt  # Python 依赖
├── pyproject.toml     # 项目配置（uv 等）
└── README.md          # 本说明
```

## 计算巢部署

通过阿里云计算巢可一键部署本示例，无需在本地安装环境：

1. **点击立即部署**：打开 [计算巢 Conversation 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/ConversationSample?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
2. **填写并创建**：按页面提示填写参数，点击「立即创建」。
3. **访问实例**：创建完成后跳转至实例页面，可通过命令行或前端 Web 进入并使用 Agent 服务。

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="应用详情" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>
进入WebUI，直接对话。
<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/WeiUI.jpg" alt="WebUI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## 本地运行

### 前置准备

1. **模型 API**：本示例使用阿里云百炼（DashScope / 通义千问），需配置 `DASHSCOPE_API_KEY`。
2. 在 [阿里云百炼控制台](https://bailian.console.aliyun.com/) 开通并获取 API Key。

### 依赖安装

```bash
cd conversation
```

使用 pip：

```bash
pip install -r requirements.txt
```

或使用 uv：

```bash
uv venv --python 3.12
uv sync --index-url https://pypi.tuna.tsinghua.edu.cn/simple
source .venv/bin/activate
```

### 环境变量

| 变量名 | 说明 | 必填 | 默认值 |
| - | - | - | - |
| `DASHSCOPE_API_KEY` | 阿里云百炼（通义千问）API Key | 是 | - |
| `SESSION_TYPE` | 会话存储类型：`json`（本地文件）或 `redis` | 否 | `json` |
| `SESSION_REDIS_URL` | Redis 连接 URL，仅当 `SESSION_TYPE=redis` 时生效 | 选填 | - |

- **JSON 模式**（默认）：不设置或设置 `SESSION_TYPE=json`，会话数据保存在本地文件，无需额外服务。
- **Redis 模式**：设置 `SESSION_TYPE=redis` 时**必须**同时设置 `SESSION_REDIS_URL`，例如 `redis://localhost:6379/0` 或阿里云 Redis：`redis://:密码@实例ID.redis.rds.aliyuncs.com:6379/0`。

示例（可写入 `.env` 或终端 `export`）：

```bash
export DASHSCOPE_API_KEY="<你的 API Key>"

# 使用默认 JSON 会话（可不写）
# export SESSION_TYPE=json

# 使用 Redis 会话时取消注释并填写
# export SESSION_TYPE=redis
# export SESSION_REDIS_URL=redis://localhost:6379/0
```

### 启动与测试

```bash
# 终端 1：启动 Agent 服务（默认 http://0.0.0.0:8090）
python main.py

# 终端 2：运行测试客户端
python client.py
```

**运行效果示例**：

```text
[run agent] Sending: 我叫AgentScope
[run agent] Event from server:
data: {"sequence_number":0,"object":"response","status":"created",...}
data: {"object":"content","status":"in_progress","text":"你好"...
data: {"object":"content","status":"completed","text":"你好AgentScope！很高兴认识你。"...

[run agent] Sending: 你还记得我叫什么吗？
data: ...
data: {"object":"content","text":"当然记得，你叫AgentScope。"...
```

## 技术要点

### 短期记忆

- **存储方式**：默认 `JSONSession`（本地文件）；设置 `SESSION_TYPE=redis` 时使用 `RedisSession`（需配置 `SESSION_REDIS_URL`）。
- **作用范围**：按 `session_id` / `user_id` 隔离的会话。
- **生命周期**：通过 `load_session_state` / `save_session_state` 在请求间持久化 Agent 状态（含记忆）。

### 多轮对话

- 客户端在请求中固定或传递 `session_id`、`user_id`。
- 服务端每次请求先 `load_session_state`，再执行 Agent，最后 `save_session_state`。
- Agent 使用 `InMemoryMemory`，在单次请求内结合已加载的会话历史进行回复。

### AgentScope Runtime 集成

- 使用 `AgentApp` + `@agent_app.query(framework="agentscope")` 注册处理逻辑。
- 通过 `lifespan` 根据环境变量初始化 `app.state.session`（JSONSession 或 RedisSession）。
- 流式输出通过异步生成器 `yield msg, last` 自动转为 SSE。

## 示例提示词

**测试短期记忆**：

```text
用户：我叫AgentScope
Agent：你好AgentScope！很高兴认识你。

用户：你还记得我叫什么吗？
Agent：当然记得，你叫AgentScope。
```

**测试信息记忆**：

```text
用户：我今年25岁，喜欢编程
用户：我多大了？有什么爱好？
Agent：你今年25岁，喜欢编程。
```

## 常见问题

- **无 DASHSCOPE_API_KEY**：会报错，请在环境变量中配置有效的 API Key。
- **连接被拒**：确认先启动 `main.py`，再运行 `client.py`，且 `client.py` 中 `BASE_URL` 与服务地址一致。

## 参考资料

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime 文档](https://runtime.agentscope.io/)
- [阿里云百炼（通义千问 / DashScope）](https://bailian.console.aliyun.com/)

## 许可

本示例遵循项目根目录所采用的许可证（如 Apache 2.0）。
