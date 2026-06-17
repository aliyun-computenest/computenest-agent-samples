# Conversation — Multi-turn Chat

A conversation sample built on [Google ADK](https://github.com/google/adk-python): `adk web` loads the `conversation` agent and supports multi-turn sessions.

## What This Is

- Smart chat: polite Chinese replies with multi-turn context support
- Official Google ADK API: single port **8000**, with built-in Web UI and `/run_sse` streaming API
- Session persistence: connect to Redis directly via `SESSION_REDIS_URL`; otherwise use ADK default in-memory sessions (lost on restart)
- **One-click deployment on Compute Nest**: in-browser Web UI (port **8000**)

## Directory Structure

```text
conversation/
├── conversation/
│   ├── __init__.py        # Package marker, exposes root_agent
│   └── agent.py           # Agent definition (name="conversation")
├── services.py            # Registers Redis session backend
├── server.sh              # Start / stop script (local / container)
├── requirements.txt       # Python dependencies
├── .env.example           # Environment variables example
└── .dockerignore          # Excludes .venv / .env / logs from Docker images
```

## Usage

### Compute Nest Deployment

Deploy with one click via Alibaba Cloud Compute Nest — no local environment required:

1. **Deploy Now**: open the [Compute Nest Conversation deployment page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/Conversation?serviceId=service-0682c63593ea443e900c&deployType=ECS&TemplateName=ECS%E7%89%88) and click "Deploy Now".
2. **Fill in & Create**: provide parameters such as `DASHSCOPE_API_KEY` and click "Create Now".
3. **Access the Instance**: on the instance page, check **Application Outputs** for the **WebUI Access URL** (port **8000**) and the **API Call Example**.

After creation, the instance detail page's "Application Outputs" panel shows:

- **WebUI Access URL**: open `http://<instance-ip>:8000` in your browser and select the `conversation` app to chat.
- **Code Debug Address** (cluster deployment): `http://<instance-ip>:8080` for online source viewing and debugging.
- **API Call Example**: send an SSE request to `http://<instance-ip>:8000/run_sse` with `app_name=conversation` and `user_id=user` (matches the ADK Web UI default). OpenAPI docs: `http://<instance-ip>:8000/docs`.

**Sessions (ECS)**: the app uses in-memory sessions when `SESSION_REDIS_URL` is unset; for persistence on Compute Nest ECS, pre-fill `SESSION_REDIS_URL=redis://127.0.0.1:6379` in deployment env vars (host Redis).

**Sessions (cluster)**: a Session connection is required; sessions are persisted to Redis.

### Local Setup

**Requirements**

- Python ≥ 3.11
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- Optional Redis (persistent sessions when `SESSION_REDIS_URL` is set; in-memory otherwise)

**Install & Start**

```bash
cd conversation
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: DASHSCOPE_API_KEY; optionally SESSION_REDIS_URL

chmod +x server.sh
./server.sh start
```

- Service / Web UI: http://127.0.0.1:8000
- API docs: http://127.0.0.1:8000/docs

**Local Test Chat**

Open http://127.0.0.1:8000 in your browser, select the `conversation` app, and chat; or verify the service is ready:

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# Expected: ["conversation"]
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHSCOPE_API_KEY` | Bailian (DashScope) API key | Required |
| `DASHSCOPE_MODEL_NAME` | Chat model | `qwen3.7-max` |
| `SESSION_REDIS_URL` | Redis URL; when unset, in-memory sessions | None (in-memory) |
| `PORT` | HTTP listen port | `8000` |
| `LOG_LEVEL` | Log level | `INFO` |

Copy and adjust as needed:

```bash
cp .env.example .env
```

## References

- [Google ADK Python](https://github.com/google/adk-python)
- [google-adk-redis](https://pypi.org/project/google-adk-redis/)
