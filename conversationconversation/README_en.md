# Conversation — Multi-turn Chat

A conversation sample built on [AgentScope Agent Service](https://docs.agentscope.io/v2/deploy/agent-service.md): on service startup, a Credential and an Agent are created automatically, and a default Session can be pre-built on demand.

## What This Is

- Smart chat: polite Chinese replies with multi-turn context support
- Service bootstrap: once `DASHSCOPE_API_KEY` is configured, Credential and Agent are created automatically
- **One-click deployment on Compute Nest**: in-browser Web UI (port 5173); a pre-built Session "Default" is provided for out-of-the-box chatting


## Directory Structure

```text
conversation/
├── main.py            # Service entry (creates Credential / Agent / optional Session)
├── client.py          # Local API test: creates a Session and sends two-turn chat
├── server.sh          # Agent start / stop
├── requirements.txt   # Python dependencies
├── .env.example       # Environment variables example
└── .dockerignore      # Excludes .venv / .env / logs from Docker images
```

## Usage

### Compute Nest Deployment

Deploy with one click via Alibaba Cloud Compute Nest — no local environment required:

1. **Deploy Now**: open the [Compute Nest Conversation deployment page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/Conversation?serviceId=service-9503f4817acb4f08b948&deployType=ECS&TemplateName=%E6%A8%A1%E6%9D%BF1) and click "Deploy Now".
2. **Fill in & Create**: provide parameters such as `DASHSCOPE_API_KEY` and click "Create Now".
3. **Access the Instance**: on the instance page, check **Application Outputs** for the **WebUI Access URL** (port **5173**) and the **API Call Example** (`POST /chat/`).

After creation, the instance detail page's "Application Outputs" panel shows:

- **WebUI Access URL**: open `http://<instance-ip>:5173` in your browser, using `demo_user` as Username.
- **API Call Example**: send a message to `http://<instance-ip>:8090/chat/` with header `X-User-ID: demo_user`. The body must contain `agent_id=conversation` and `session_id` (visible in the Web UI, or create one via `POST /sessions/`). OpenAPI: `http://<instance-ip>:8090/docs`.

**Redis (ECS)**: uses `SESSION_REDIS_URL` from environment variables; falls back to `redis://127.0.0.1:6379/0` when unset.

**Redis (container cluster)**: `SESSION_REDIS_URL` MUST be configured in environment variables.

### Local Setup

**Requirements**

- Python ≥ 3.11
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- Redis (must configure `SESSION_REDIS_URL`, see below)

**Install & Start**

```bash
cd conversation
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: DASHSCOPE_API_KEY, SESSION_REDIS_URL

chmod +x server.sh
./server.sh start
```

- Service: http://127.0.0.1:8090
- API docs: http://127.0.0.1:8090/docs

If you do not have Redis locally, start an instance first and write the URL into `.env`, e.g.:

```bash
export SESSION_REDIS_URL=redis://localhost:6379/0
```

**Local Test Chat**

In a separate terminal, run `client.py`: it uses the pre-registered `agent_id=conversation`; each run creates a fresh Session (with its own `workspace_id`) and sends two messages within the same session to test multi-turn memory.

```bash
source .venv/bin/activate
python client.py
```

For local development, use `client.py` to test chat. The Web UI is only accessible on a Compute Nest instance via the address shown in "Application Outputs" (port 5173).

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHSCOPE_API_KEY` | Bailian (DashScope) API key | Required |
| `DASHSCOPE_MODEL_NAME` | Chat model | `qwen3.7-max` |
| `SESSION_REDIS_URL` | Redis URL | Required; defaults to `redis://127.0.0.1:6379/0` on ECS |
| `HOST` / `PORT` | HTTP listen address | `0.0.0.0` / `8090` |
| `CREATE_DEFAULT_SESSION` | When set to `1`, create a Session named "Default" on every service start (id auto-generated) | `0` (Compute Nest deployment uses `1`) |

Copy and adjust as needed:

```bash
cp .env.example .env
```

## References

- [AgentScope Quickstart](https://docs.agentscope.io/en/v2/quickstart)
- [Agent Service Documentation](https://docs.agentscope.io/v2/deploy/agent-service.md)
