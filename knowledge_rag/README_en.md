# Knowledge RAG — Enterprise Knowledge Base Q&A Agent

An enterprise-grade knowledge base Q&A agent built on **AgentScope** and **AgentScope Runtime**, integrating Alibaba Cloud Bailian Knowledge Base for semantic retrieval and natural language answering.

## Overview

This example is built on AgentScope and AgentScope Runtime, delivering enterprise-grade intelligent knowledge base Q&A capabilities. The agent integrates Alibaba Cloud Bailian Knowledge Base for semantic retrieval with relevance ranking, enabling precise lookup across internal documents, product manuals, FAQs, and more. Leveraging the ReActAgent reasoning pipeline, it transforms retrieved content into fluent natural language answers. The service is exposed via Runtime with session persistence (supporting both local JSON and Redis backends) and SSE streaming, making it well-suited for enterprise knowledge Q&A, customer service assistance, and document retrieval scenarios.

## Features

- Alibaba Cloud Bailian Knowledge Base integration with semantic retrieval and relevance ranking
- ReActAgent reasoning pipeline to transform retrieved content into natural language answers
- Session-based context (short-term memory) for multi-turn Q&A
- HTTP SSE streaming via AgentScope Runtime

## Agent flow

```text
User message
    ↓
AgentScope Runtime (AgentApp)
    ↓
Knowledge Base Assistant Agent
    ├── ReActAgent (reasoning engine)
    ├── Bailian Knowledge Base retrieval tool (retrieve_from_knowledge_base)
    ├── RedisSession / JSONSession (session memory)
    └── Tongyi Qwen, etc. (LLM)
```

## Core components

| Component | Description |
|-----------|-------------|
| **Agent service** | [main.py](main.py) — `AgentApp` and query handling |
| **RAG tool** | [tools/rag_tool.py](tools/rag_tool.py) — Bailian knowledge base retrieval tool |
| **MCP helpers** | [tools/mcp_helpers.py](tools/mcp_helpers.py) — MCP client registration |
| **MCP config** | [configs/mcp_config.json](configs/mcp_config.json) — MCP server configuration |
| **Test client** | [client.py](client.py) — SSE client for `/process` |
| **Project config** | [pyproject.toml](pyproject.toml) — dependencies (optional uv) |
| **Requirements** | [requirements.txt](requirements.txt) — pip install |

**RAG tool** ([tools/rag_tool.py](tools/rag_tool.py)):

```python
async def retrieve_from_knowledge_base(query: str) -> ToolResponse:
    """Retrieve relevant documents from Bailian Knowledge Base."""
    response = await _get_bailian_client().retrieve_async(
        os.environ["BAILIAN_WORKSPACE_ID"],
        bailian_models.RetrieveRequest(
            index_id=os.environ["BAILIAN_INDEX_ID"],
            query=query,
        ),
    )
    # Format and return retrieved document chunks...
```

**`AgentApp` and query** ([main.py](main.py)):

```python
agent_app = AgentApp(
    app_name="KnowledgeRAG",
    app_description="Bailian knowledge base Q&A agent with short-term memory",
    lifespan=lifespan,
)

@agent_app.query(framework="agentscope")
async def query_func(self, msgs, request: AgentRequest = None, **kwargs):
    # load/save session state, run ReActAgent, stream yield
```

**Multi-turn test** ([client.py](client.py)):

```python
await send_request("What topics can you answer questions about?")
await send_request("Do you remember what I just asked?")
```

## Directory layout

```text
knowledge_rag/
├── main.py                  # Agent application entry point
├── client.py                # Test client (SSE streaming via /process)
├── server.sh                # Service management script (start/stop/restart/status)
├── requirements.txt         # Python dependencies
├── pyproject.toml           # Project config (uv compatible)
├── .env.example             # Environment variable template
├── configs/
│   └── mcp_config.json      # MCP server configuration
├── tools/
│   ├── __init__.py
│   ├── rag_tool.py          # Bailian knowledge base retrieval tool
│   └── mcp_helpers.py       # MCP client registration helpers
└── README_en.md             # This file
```

## Local run

### Prerequisites

1. **Model API**: Alibaba Bailian (DashScope / Tongyi Qwen) — set `DASHSCOPE_API_KEY`. Create a key in the [Bailian console](https://bailian.console.aliyun.com/).
2. **Bailian Knowledge Base**: Create a knowledge base in the Bailian console, upload documents, and obtain `BAILIAN_WORKSPACE_ID` and `BAILIAN_INDEX_ID`.
3. **Alibaba Cloud AK/SK**: Required for calling the Bailian retrieval API — set `ALIBABA_CLOUD_ACCESS_KEY_ID` and `ALIBABA_CLOUD_ACCESS_KEY_SECRET`.

### Install

```bash
cd knowledge_rag
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
| `DASHSCOPE_API_KEY` | Bailian (Tongyi Qwen) API key | Yes | — |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | Alibaba Cloud Access Key ID | Yes | — |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | Alibaba Cloud Access Key Secret | Yes | — |
| `BAILIAN_WORKSPACE_ID` | Bailian workspace ID | Yes | — |
| `BAILIAN_INDEX_ID` | Knowledge base index ID | Yes | — |
| `BAILIAN_REGION_ID` | Bailian workspace region | No | `cn-beijing` |
| `SESSION_TYPE` | `json` (local file) or `redis` | No | `json` |
| `SESSION_REDIS_URL` | Redis URL when `SESSION_TYPE=redis` | If redis | — |

- **JSON mode** (default): omit or set `SESSION_TYPE=json`; session data saved locally, no extra services needed.
- **Redis mode**: set `SESSION_TYPE=redis` and `SESSION_REDIS_URL`, e.g. `redis://localhost:6379/0`.

Example:

```bash
export DASHSCOPE_API_KEY="<your DashScope API key>"
export ALIBABA_CLOUD_ACCESS_KEY_ID="<your Access Key ID>"
export ALIBABA_CLOUD_ACCESS_KEY_SECRET="<your Access Key Secret>"
export BAILIAN_WORKSPACE_ID="<your workspace ID>"
export BAILIAN_INDEX_ID="<your index ID>"
export BAILIAN_REGION_ID="cn-beijing"

# export SESSION_TYPE=redis
# export SESSION_REDIS_URL=redis://localhost:6379/0
```

### Start and test

```bash
# Terminal 1: start the agent service (default http://0.0.0.0:8091)
python main.py

# Terminal 2: run the test client
python client.py
```

**Sample output**:

```text
[run agent] Sending: What topics can you answer questions about?
[run agent] Event from server:
data: {"sequence_number":0,"object":"response","status":"created",...}
data: {"object":"content","status":"completed","text":"I can answer questions about..."...}

[run agent] Sending: Do you remember what I just asked?
data: ...
data: {"object":"content","text":"You just asked what topics I can answer questions about."...}
```

### Manage with server.sh

```bash
chmod +x server.sh

./server.sh start    # start in background
./server.sh status   # check status
./server.sh stop     # stop service
./server.sh restart  # restart service
```

## Technical notes

### Knowledge base retrieval

- **Retrieval**: calls Bailian `retrieve` API with semantic similarity search.
- **Result format**: returns document chunks with relevance scores for agent reasoning.
- **Tool encapsulation**: retrieval logic is in `tools/rag_tool.py`, registered as an agent tool via `Toolkit`.

### Short-term memory

- **Storage**: default `JSONSession` (local files); `RedisSession` when `SESSION_TYPE=redis`.
- **Scope**: isolated by `session_id` / `user_id`.
- **Lifecycle**: `load_session_state` / `save_session_state` persist agent state across requests.

### AgentScope Runtime

- `AgentApp` + `@agent_app.query(framework="agentscope")`.
- `lifespan` initializes `app.state.session` (JSON or Redis) from env.
- Streaming via async generator `yield msg, last` → SSE.

## Sample prompts

**Enterprise document query**:

```text
User: What is our company's annual leave policy?
Agent: [retrieves from knowledge base] According to the knowledge base, the annual leave policy is...

User: What about sick leave?
Agent: [retrieves from knowledge base] Regarding sick leave policy...
```

**Product manual query**:

```text
User: What are the installation steps for Product A?
Agent: [retrieves from knowledge base] The installation steps for Product A are: 1. ...

User: What should I do if I encounter an error during installation?
Agent: [retrieves from knowledge base] Common installation errors and solutions...
```

## FAQ

- **No `DASHSCOPE_API_KEY`**: set a valid key in the environment.
- **No `ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET`**: Bailian retrieval API calls will fail; ensure AK/SK are correctly configured.
- **Wrong `BAILIAN_WORKSPACE_ID` or `BAILIAN_INDEX_ID`**: retrieval will return errors; verify the correct IDs in the Bailian console.
- **Connection refused**: start `main.py` first; align `BASE_URL` in `client.py` with the server address.

## References

- [AgentScope docs](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [Alibaba Cloud Bailian console](https://bailian.console.aliyun.com/)
- [Bailian Knowledge Base docs](https://help.aliyun.com/zh/model-studio/user-guide/rag)

## License

Same as the repository root (e.g. Apache 2.0).
