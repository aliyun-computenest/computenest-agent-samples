# Knowledge RAG - Enterprise Knowledge Base Q&A Agent

This sample uses **Google ADK** and `computenest-agent-integrations` to build an enterprise knowledge-base Q&A agent. It retrieves relevant chunks from Alibaba Cloud Bailian Knowledge Base through `retrieve_from_knowledge_base`, then answers with Qwen based on the retrieved content.

## Features

- Alibaba Cloud Bailian Knowledge Base retrieval with relevance scoring
- ADK tool integration through `BailianRagTool`
- Session persistence: connect to Redis directly via `SESSION_REDIS_URL`; otherwise use ADK default in-memory sessions
- WebUI and API served by `adk web`

## Layout

```text
knowledge_rag/
├── knowledge_rag/
│   ├── __init__.py
│   └── agent.py          # ADK root_agent
├── bailian_price.md      # Sample document; upload it to Bailian manually if needed
├── server.sh             # Local service script
├── requirements.txt
├── .env.example
└── README_en.md
```

## Environment Variables

| Variable | Description | Required | Default |
| - | - | - | - |
| `DASHSCOPE_API_KEY` | DashScope / Qwen API key | Yes | - |
| `DASHSCOPE_MODEL_NAME` | Model name | Yes | - |
| `BAILIAN_WORKSPACE_ID` | Bailian workspace ID | Yes | - |
| `BAILIAN_INDEX_ID` | Bailian knowledge-base index ID | Yes | - |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | Alibaba Cloud Access Key ID | Yes | - |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | Alibaba Cloud Access Key Secret | Yes | - |
| `SESSION_REDIS_URL` | Redis URL; when unset, in-memory sessions | No | None (in-memory) |

The Bailian region defaults to `cn-beijing`.

## Local Run

```bash
cd samples/knowledge_rag
pip install -r requirements.txt
cp .env.example .env
# Edit .env with real values.
./server.sh start
```

Default URL:

```text
http://0.0.0.0:8000
```

Service commands:

```bash
./server.sh status
./server.sh restart
./server.sh stop
```

## Usage

Open ADK Web and select `knowledge_rag`, then ask a knowledge-base question such as:

```text
What is the token price of qwen3-max?
```

The agent calls `retrieve_from_knowledge_base` first and answers from the returned chunks. If no relevant content is found, it says that the knowledge base has no matching answer.

## Notes

- The sample no longer uploads `bailian_price.md` automatically. Upload it manually in the Bailian console if you want to use it as demo content.
- When `SESSION_REDIS_URL` is configured, sessions are persisted through `google-adk-redis`; otherwise ADK's default in-memory session service is used.

## References

- [Google ADK](https://google.github.io/adk-docs/)
- [Alibaba Cloud Bailian console](https://bailian.console.aliyun.com/)
- [Bailian Knowledge Base docs](https://help.aliyun.com/zh/model-studio/user-guide/rag)
