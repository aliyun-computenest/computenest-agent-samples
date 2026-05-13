# Knowledge RAG - 企业知识库智能问答 Agent

基于 **AgentScope** 和 **AgentScope Runtime** 的企业级知识库检索问答智能体，集成阿里云百炼知识库，实现语义检索与自然语言回答。

## 概述

本示例基于 AgentScope 与 AgentScope Runtime 实现，提供企业级知识库智能问答能力。智能体集成阿里云百炼知识库，支持语义检索与相关度排序，能够精准定位企业内部文档、产品手册、FAQ 等知识内容，并通过 ReActAgent 推理链路将检索结果转化为自然语言回答。服务通过 Runtime 提供会话持久化（支持本地 JSON 与 Redis 两种存储）与 SSE 流式接口，适用于企业内部知识问答、客服辅助、文档检索等场景。

## 核心功能

- 集成阿里云百炼知识库，支持语义检索与相关度排序
- 基于 ReActAgent 推理链路，将检索结果转化为自然语言回答
- 使用 Session 维护对话上下文（短期记忆），支持多轮问答
- 通过 AgentScope Runtime 暴露为 HTTP SSE 流式接口

## Agent 能力

```text
用户消息
    ↓
AgentScope Runtime (AgentApp)
    ↓
知识库助手 Agent
    ├── ReActAgent（推理引擎）
    ├── 百炼知识库检索工具（retrieve_from_knowledge_base）
    ├── RedisSession / JSONSession（会话记忆）
    └── 通义千问等模型（LLM）
```

### 核心组件

| 组件 | 描述 |
| - | - |
| **Agent 服务** | [main.py](main.py) - 主应用，定义 AgentApp 与 query 处理逻辑 |
| **RAG 工具** | [tools/rag_tool.py](tools/rag_tool.py) - 百炼知识库检索工具封装 |
| **测试客户端** | [client.py](client.py) - 调用 `/process` 的 SSE 流式客户端 |
| **项目配置** | [pyproject.toml](pyproject.toml) - 依赖管理（可选 uv） |
| **依赖列表** | [requirements.txt](requirements.txt) - 用于 pip 安装 |

### 代码特点

**RAG 工具封装**（[tools/rag_tool.py](tools/rag_tool.py)）：

```python
async def retrieve_from_knowledge_base(query: str) -> ToolResponse:
    """在百练知识库中检索与用户问题相关的文档内容"""
    response = await _get_bailian_client().retrieve_async(
        os.environ["BAILIAN_WORKSPACE_ID"],
        bailian_models.RetrieveRequest(
            index_id=os.environ["BAILIAN_INDEX_ID"],
            query=query,
        ),
    )
    # 格式化并返回检索结果片段...
```

**AgentApp 与 query 定义**（[main.py](main.py)）：

```python
agent_app = AgentApp(
    app_name="KnowledgeRAG",
    app_description="百练知识库检索问答智能体，具备短期记忆能力",
    lifespan=lifespan,
)

@agent_app.query(framework="agentscope")
async def query_func(self, msgs, request: AgentRequest = None, **kwargs):
    # 加载/保存 session 状态，运行 ReActAgent，流式 yield
```

**多轮对话测试**（[client.py](client.py)）：

```python
await send_request("请介绍一下你能回答哪些方面的问题？")
await send_request("你还记得我刚才问了什么吗？")
```

## 目录结构

```text
knowledge_rag/
├── main.py                  # Agent 应用入口（AgentScope + AgentScope Runtime）
├── client.py                # 测试客户端（/process SSE 流式调用）
├── server.sh                # 后台服务控制脚本（start/stop/restart/status）
├── requirements.txt         # Python 依赖
├── pyproject.toml           # 项目配置（uv 等）
├── .env.example             # 环境变量示例
├── tools/
│   ├── __init__.py
│   └── rag_tool.py          # 百炼知识库检索工具
└── README.md                # 本说明
```

## 本地运行

### 前置准备

1. **模型 API**：本示例使用阿里云百炼（DashScope / 通义千问），需配置 `DASHSCOPE_API_KEY`。在 [阿里云百炼控制台](https://bailian.console.aliyun.com/) 开通并获取 API Key。
2. **百炼知识库**：需在百炼控制台创建知识库并上传文档，获取 `BAILIAN_WORKSPACE_ID` 和 `BAILIAN_INDEX_ID`。
3. **阿里云 AK/SK**：用于调用百炼知识库检索 API，需配置 `ALIBABA_CLOUD_ACCESS_KEY_ID` 和 `ALIBABA_CLOUD_ACCESS_KEY_SECRET`。

### 依赖安装

```bash
cd knowledge_rag
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
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 阿里云 Access Key ID | 是 | - |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 阿里云 Access Key Secret | 是 | - |
| `BAILIAN_WORKSPACE_ID` | 百炼工作空间 ID | 是 | - |
| `BAILIAN_INDEX_ID` | 知识库索引 ID | 是 | - |
| `BAILIAN_REGION_ID` | 百炼工作空间地域 | 否 | `cn-beijing` |
| `SESSION_TYPE` | 会话存储类型：`json` 或 `redis` | 否 | `json` |
| `SESSION_REDIS_URL` | Redis 连接 URL，仅当 `SESSION_TYPE=redis` 时生效 | 选填 | - |

- **JSON 模式**（默认）：不设置或设置 `SESSION_TYPE=json`，会话数据保存在本地文件，无需额外服务。
- **Redis 模式**：设置 `SESSION_TYPE=redis` 时**必须**同时设置 `SESSION_REDIS_URL`，例如 `redis://localhost:6379/0` 或阿里云 Redis：`redis://:密码@实例ID.redis.rds.aliyuncs.com:6379/0`。

示例（可写入 `.env` 或终端 `export`）：

```bash
export DASHSCOPE_API_KEY="<你的 DashScope API Key>"
export ALIBABA_CLOUD_ACCESS_KEY_ID="<你的 Access Key ID>"
export ALIBABA_CLOUD_ACCESS_KEY_SECRET="<你的 Access Key Secret>"
export BAILIAN_WORKSPACE_ID="<你的工作空间 ID>"
export BAILIAN_INDEX_ID="<你的知识库索引 ID>"
export BAILIAN_REGION_ID="cn-beijing"

# 使用默认 JSON 会话（可不写）
# export SESSION_TYPE=json

# 使用 Redis 会话时取消注释并填写
# export SESSION_TYPE=redis
# export SESSION_REDIS_URL=redis://localhost:6379/0
```

### 启动与测试

```bash
# 终端 1：启动 Agent 服务（默认 http://0.0.0.0:8091）
python main.py

# 终端 2：运行测试客户端
python client.py
```

**运行效果示例**：

```text
[run agent] Sending: 请介绍一下你能回答哪些方面的问题？
[run agent] Event from server:
data: {"sequence_number":0,"object":"response","status":"created",...}
data: {"object":"content","status":"in_progress","text":"我可以"...}
data: {"object":"content","status":"completed","text":"我可以根据知识库内容回答您关于..."...}

[run agent] Sending: 你还记得我刚才问了什么吗？
data: ...
data: {"object":"content","text":"您刚才询问了我能回答哪些方面的问题。"...}
```

### 使用 server.sh 管理服务

```bash
chmod +x server.sh

./server.sh start    # 后台启动服务
./server.sh status   # 查看运行状态
./server.sh stop     # 停止服务
./server.sh restart  # 重启服务
```

## 技术要点

### 知识库检索

- **检索方式**：调用百炼知识库 `retrieve` 接口，基于语义相似度检索相关文档片段。
- **结果格式**：返回带相关度评分的文档片段列表，供 Agent 推理使用。
- **工具封装**：检索逻辑封装在 `tools/rag_tool.py`，通过 `Toolkit` 注册为 Agent 工具。

### 短期记忆

- **存储方式**：默认 `JSONSession`（本地文件）；设置 `SESSION_TYPE=redis` 时使用 `RedisSession`。
- **作用范围**：按 `session_id` / `user_id` 隔离的会话。
- **生命周期**：通过 `load_session_state` / `save_session_state` 在请求间持久化 Agent 状态。

### AgentScope Runtime 集成

- 使用 `AgentApp` + `@agent_app.query(framework="agentscope")` 注册处理逻辑。
- 通过 `lifespan` 根据环境变量初始化 `app.state.session`（JSONSession 或 RedisSession）。
- 流式输出通过异步生成器 `yield msg, last` 自动转为 SSE。

## 示例提示词

**企业文档查询**：

```text
用户：我们公司的年假政策是怎样的？
Agent：[调用知识库检索] 根据知识库内容，您公司的年假政策为...

用户：那病假呢？
Agent：[调用知识库检索] 关于病假政策...
```

**产品手册查询**：

```text
用户：产品 A 的安装步骤是什么？
Agent：[调用知识库检索] 产品 A 的安装步骤如下：1. ...

用户：安装过程中遇到报错怎么办？
Agent：[调用知识库检索] 常见安装报错及解决方案...
```

## 常见问题

- **无 `DASHSCOPE_API_KEY`**：会报错，请在环境变量中配置有效的 API Key。
- **无 `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`**：百炼检索 API 调用会失败，请确保 AK/SK 已正确配置。
- **`BAILIAN_WORKSPACE_ID` 或 `BAILIAN_INDEX_ID` 错误**：检索会返回失败，请在百炼控制台确认正确的 ID。
- **连接被拒**：确认先启动 `main.py`，再运行 `client.py`，且 `client.py` 中 `BASE_URL` 与服务地址一致。

## 参考资料

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime 文档](https://runtime.agentscope.io/)
- [阿里云百炼控制台](https://bailian.console.aliyun.com/)
- [阿里云百炼知识库文档](https://help.aliyun.com/zh/model-studio/user-guide/rag)

## 许可

本示例遵循项目根目录所采用的许可证（如 Apache 2.0）。
