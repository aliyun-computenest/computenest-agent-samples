# DashScope Long-Term Memory - ADK Version

This sample uses [Google ADK](https://github.com/google/adk-python) and `computenest-agent-integrations` to build a Chinese chat agent with Alibaba Cloud Bailian long-term memory. It runs with `adk web`, preloads relevant memory before each model call, and writes the finished turn back to Bailian memory.

**Chinese documentation**: [README.md](README.md).

## What It Does

- Google ADK agent: one **8000** port with built-in Web UI and `/run_sse`
- Bailian long-term memory: powered by `BailianLongTermMemoryService`
- Memory preload: ADK `preload_memory_tool` searches related memories before the model call
- User profile injection: when a profile schema is configured, the agent loads the profile before answering
- Memory writeback: an ADK callback saves the completed session turn to memory
- Session persistence: connect to Redis directly via `SESSION_REDIS_URL`; otherwise use ADK default in-memory sessions

## Directory Layout

```text
dashscope_memory/
├── dashscope_memory/
│   ├── __init__.py        # Package marker for ADK discovery
│   └── agent.py           # Agent definition (name="dashscope_memory")
├── services.py            # Registers the Bailian Memory service
├── server.sh              # Local/container lifecycle script
├── requirements.txt
├── .env.example
├── .dockerignore
├── README.md
└── README_en.md
```

## Local Run

**Requirements**

- Python >= 3.12
- DashScope API key
- A Bailian memory library ID

```bash
cd samples/dashscope_memory
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: set DASHSCOPE_API_KEY and BAILIAN_MEMORY_LIBRARY_ID

chmod +x server.sh
./server.sh start
```

- Web UI: http://127.0.0.1:8000
- API docs: http://127.0.0.1:8000/docs

Check app discovery:

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# Expected: ["dashscope_memory"]
```

## Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `DASHSCOPE_API_KEY` | Yes | Bailian API key for model and memory APIs | none |
| `BAILIAN_MEMORY_LIBRARY_ID` | Yes | Bailian memory library ID | none |
| `DASHSCOPE_MODEL_NAME` | No | Chat model | `qwen-max` |
| `BAILIAN_MEMORY_PROJECT_ID` | No | Project ID attached to memory writes | none |
| `BAILIAN_MEMORY_SEARCH_PROJECT_IDS` | No | Comma-separated project IDs for memory search | `BAILIAN_MEMORY_PROJECT_ID` |
| `BAILIAN_MEMORY_PROFILE_SCHEMA` | No | Bailian user-profile schema ID; enables profile updates on write and profile loading before answers | none |
| `BAILIAN_MEMORY_TOP_K` | No | Number of memory hits | `8` |
| `BAILIAN_MEMORY_MIN_SCORE` | No | Minimum memory search score | `0.25` |
| `BAILIAN_MEMORY_ENDPOINT` | No | Bailian memory API endpoint | `https://dashscope.aliyuncs.com/api/v2/apps/memory` |
| `PORT` | No | HTTP port | `8000` |
| `LOG_LEVEL` | No | Log level | `INFO` |
| `SESSION_REDIS_URL` | No | Redis URL; when unset, in-memory sessions | None (in-memory) |


## Alibaba Cloud Compute Nest

You can deploy this sample on Compute Nest:

1. Open the [Compute Nest DashScope Memory sample page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/DashScopeMemory?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and deploy.
2. Set `DASHSCOPE_API_KEY`, `BAILIAN_MEMORY_LIBRARY_ID`, and optional memory parameters.
3. Use the Web UI and API examples from the instance outputs.

## References

- [Google ADK Python](https://github.com/google/adk-python)
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
- Bailian long-term memory: see Alibaba Cloud documentation.
