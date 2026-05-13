# Conversation — Minimal chat agent

An entry-level conversational agent on **AgentScope** and **AgentScope Runtime**, showing how to build a basic AI agent with short-term memory.

## Overview

This sample is AgentScope’s “Conversation” example: minimal agent construction and HTTP exposure.

## Features

- Simple dialogue agent (no tools)
- Session-based context (short-term memory)
- Multi-turn recall
- HTTP SSE streaming via AgentScope Runtime

## Agent flow

```text
User message
    ↓
AgentScope Runtime (AgentApp)
    ↓
Hello World Agent
    ├── ReActAgent (dialogue engine)
    ├── RedisSession / InMemoryMemory (session memory)
    └── Tongyi Qwen, etc. (LLM)
```

## Core components

| Component | Description |
|-----------|-------------|
| **Agent service** | [main.py](main.py) — `AgentApp` and query handling |
| **Test client** | [client.py](client.py) — SSE client for `/process` |
| **Project config** | [pyproject.toml](pyproject.toml) — dependencies (optional uv) |
| **Requirements** | [requirements.txt](requirements.txt) — pip install |

**`AgentApp` and query** ([main.py](main.py)):

```python
agent_app = AgentApp(
    app_name="conversation",
    app_description="Hello World dialogue agent with short-term memory",
    lifespan=lifespan,
)

@agent_app.query(framework="agentscope")
async def query_func(self, msgs, request: AgentRequest = None, **kwargs):
    # load/save session state, run ReActAgent, stream yield
```

**Multi-turn test** ([client.py](client.py)):

```python
await send_request("My name is AgentScope")
await send_request("Do you remember my name?")
```

## Directory layout

```text
conversation/
├── main.py
├── client.py
├── server.sh
├── requirements.txt
├── pyproject.toml
└── README.md
```

## Alibaba Cloud Compute Nest

One-click deploy (console UI may be in Chinese):

1. Open the [Compute Nest Conversation deploy page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/ConversationSample?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and start deployment.
2. Fill in parameters and create the instance.
3. Use CLI or Web UI on the instance page.

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="Application details" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

Open Web UI and chat.

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/WeiUI.jpg" alt="Web UI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## Local run

### Prerequisites

1. **Model API**: Alibaba Bailian (DashScope / Tongyi Qwen) — set `DASHSCOPE_API_KEY`.
2. Create a key in the [Bailian console](https://bailian.console.aliyun.com/).

### Install

```bash
cd conversation
pip install -r requirements.txt
```

Or with uv:

```bash
uv venv --python 3.12
uv sync --index-url https://pypi.tuna.tsinghua.edu.cn/simple
source .venv/bin/activate
```

### Environment variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DASHSCOPE_API_KEY` | Bailian (Tongyi) API key | Yes | — |
| `SESSION_TYPE` | `json` (local file) or `redis` | No | `json` |
| `SESSION_REDIS_URL` | Redis URL when `SESSION_TYPE=redis` | If redis | — |

- **JSON mode** (default): omit or set `SESSION_TYPE=json`; no extra services.
- **Redis mode**: set `SESSION_TYPE=redis` and `SESSION_REDIS_URL`, e.g. `redis://localhost:6379/0`.

Example:

```bash
export DASHSCOPE_API_KEY="<your API key>"
# export SESSION_TYPE=redis
# export SESSION_REDIS_URL=redis://localhost:6379/0
```

### Start and test

```bash
python main.py   # default http://0.0.0.0:8090
python client.py # another terminal
```

**Sample output**:

```text
[run agent] Sending: My name is AgentScope
...
[run agent] Sending: Do you remember my name?
...
```

## Technical notes

### Short-term memory

- **Storage**: default `JSONSession` (local files); `RedisSession` when `SESSION_TYPE=redis`.
- **Scope**: isolated by `session_id` / `user_id`.
- **Lifecycle**: `load_session_state` / `save_session_state` persist agent state across requests.

### Multi-turn dialogue

- Client sends stable or passed `session_id` and `user_id`.
- Server loads session, runs agent, saves session.
- Agent uses `InMemoryMemory` with loaded history for each reply.

### AgentScope Runtime

- `AgentApp` + `@agent_app.query(framework="agentscope")`.
- `lifespan` initializes `app.state.session` (JSON or Redis) from env.
- Streaming via async generator `yield msg, last` → SSE.

## Sample prompts

**Short-term memory**:

```text
User: My name is AgentScope
Agent: Hello AgentScope! Nice to meet you.

User: Do you remember my name?
Agent: Yes, you are AgentScope.
```

**Fact recall**:

```text
User: I am 25 and I like programming
User: How old am I? What are my hobbies?
Agent: You are 25 and you like programming.
```

## FAQ

- **No `DASHSCOPE_API_KEY`**: set a valid key in the environment.
- **Connection refused**: start `main.py` first; align `BASE_URL` in `client.py` with the server.

## References

- [AgentScope docs](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [Alibaba Bailian / DashScope](https://bailian.console.aliyun.com/)

## License

Same as the repository root (e.g. Apache 2.0).
