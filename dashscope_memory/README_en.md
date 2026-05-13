# DashScope long-term memory with Runtime

## Overview

This sample uses [**AgentScope**](https://doc.agentscope.io/) and [**AgentScope Runtime**](https://runtime.agentscope.io/) to wire **Alibaba Cloud DashScope (Bailian) long-term memory** into a chat service. On each user request it may **fetch a user profile**, **search memory** with the latest user question, and merge snippets into the system prompt; after the turn it **adds** the last user and assistant utterances to long-term memory (optionally with a profile schema). Tools are **GetUserProfile**, **SearchMemory**, and **AddMemory** from `agentscope_runtime.tools.modelstudio_memory`.

**Chinese documentation**: [README.md](README.md).

## Flow

1. **GetUserProfile** (if `BAILIAN_MEMORY_PROFILE_SCHEMA` is set): format profile fields for the system prompt.
2. **SearchMemory**: embedding search on the last user message, keep up to `top_k` hits with score ≥ `min_score`.
3. **ReActAgent + DashScope model**: load short-term history from Runtime **Session** (JSON or Redis), stream the reply.
4. **AddMemory**: persist the user/assistant pair for this turn (optional `profile_schema`).

The sample fixes the Bailian **end user id** to `demo_user` (`BAILIAN_USER_ID` in `main.py`). In production, map it from your real user or session id.

## Directory layout

```text
dashscope_memory/
├── README.md
├── README_en.md
├── __init__.py
├── main.py               # AgentApp + profile / search / add orchestration
├── client.py             # Test client (/process SSE)
├── server.sh             # start / stop / restart / status
├── requirements.txt
├── .env.example
└── sessions/             # Created when SESSION_TYPE=json
```

## Alibaba Cloud Compute Nest

Deploy this sample on **Compute Nest** without a local Python setup:

1. **Deploy**: Open the [Compute Nest DashScope long-term memory sample page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/DashScopeMemory?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and click deploy.
2. **Create**: Fill in parameters (e.g. `DASHSCOPE_API_KEY`, and optionally `BAILIAN_MEMORY_LIBRARY_ID` / `BAILIAN_MEMORY_PROJECT_ID` / `BAILIAN_MEMORY_PROFILE_SCHEMA`), then create the instance.
3. **Use**: Open the instance page and use the CLI or Web UI to reach the Agent service.

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="Application details" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

Use the Web UI to chat.

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/WeiUI.jpg" alt="Web UI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## Local run

### Prerequisites

**Python 3.10+** recommended.

```bash
cd dashscope_memory
pip install -r requirements.txt
cp .env.example .env
# Edit .env; at minimum set DASHSCOPE_API_KEY
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHSCOPE_API_KEY` | Yes | Bailian key for the chat model and memory APIs |
| `DASHSCOPE_MODEL_NAME` | No | Default `qwen-max` |
| `BAILIAN_MEMORY_LIBRARY_ID` | No | Target memory library; omit for console default |
| `BAILIAN_MEMORY_PROJECT_ID` | No | Project for memory rules in the console |
| `BAILIAN_MEMORY_PROFILE_SCHEMA` | No | Profile schema; if unset, GetUserProfile is skipped and AddMemory has no profile update |
| `SESSION_TYPE` | No | `json` (default) or `redis` |
| `SESSION_REDIS_URL` | When redis | Required if `SESSION_TYPE=redis` |

Enable long-term memory and configure libraries/schemas in the [Bailian console](https://bailian.console.aliyun.com/) per official docs.

### Start the server

```bash
cd dashscope_memory
python main.py
```

Default bind: **`http://0.0.0.0:8090`**. Change `port=` in `main.py` if the port is taken.

Or use the helper script:

```bash
chmod +x server.sh
./server.sh start
./server.sh status
./server.sh stop
```

### Test client

```bash
cd dashscope_memory
python client.py
```

Sends an **SSE** request to `/process`; align `session_id` and `user_id` with `client.py` for multi-turn debugging.

### Tunables (in code)

In `main.py`:

- `SEARCH_TOP_K`, `SEARCH_MIN_SCORE`: retrieval size and minimum similarity (0–1).
- `BAILIAN_USER_ID`: Bailian user id (demo uses `demo_user`).

### Memory HTTPS / SSL issues

If TLS verification fails for the memory API, follow the commented block **before** `import fastapi` in `main.py`: uncomment the whole aiohttp + **certifi** patch (`certifi` is listed in `requirements.txt`).

## References

- [AgentScope](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- Bailian long-term memory: see Alibaba Cloud documentation.
