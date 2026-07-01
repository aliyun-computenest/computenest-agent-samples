# ADK Code Executor — Code Execution Agent

A code-writing and execution sample built on [Google ADK](https://github.com/google/adk-python), supporting both **E2B** and **AgentRun** sandbox backends. It accepts natural-language requests, autonomously writes and runs code inside an isolated sandbox, and supports persistent execution context management.

## What This Is

- **Dual sandbox backends**: automatically selects the backend based on the `TLS_CERT` env var — E2B (ACSSandbox) for private deployments, AgentRun for public cloud
- **Isolated sandbox execution**: each conversation runs in a dedicated sandbox — results are fully isolated and safe
- **Multi-language support**: execute Python / JavaScript code; install any dependency via shell commands
- **Persistent contexts**: create an execution context to share variables and imports across multiple tool calls
- **Full file system**: read/write files and manage directories inside the sandbox
- Official Google ADK API: single port **8000**, with built-in Web UI and `/run_sse` streaming API
- Session persistence: connect to Redis via `SESSION_REDIS_URL`; otherwise use ADK default in-memory sessions
- **One-click deployment on Compute Nest**: in-browser Web UI (port **8000**)

## Directory Structure

```text
adk_code_executor/
├── __init__.py                  # sqlite3 compatibility shim
├── agent.py                     # Agent definition (root_agent, auto-selects backend via sandbox factory)
├── main.py                      # CLI test entry point (local debugging)
├── tools/
│   ├── __init__.py              # Tools package
│   └── sandbox_factory.py       # Sandbox factory (selects E2B or AgentRun based on TLS_CERT)
├── server.sh                    # Start / stop script (local / container)
├── requirements.txt             # Python dependencies
├── .env.example                 # Environment variables example
└── .dockerignore                # Excludes .venv / .env / logs from Docker images
```

## Usage

### Compute Nest Deployment

Deploy with one click via Alibaba Cloud Compute Nest — no local environment required:

1. **Deploy Now**: open the [Compute Nest Code Executor deployment page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/AdjCodeExecutor?serviceId=service-0682c63593ea443e900c&deployType=ECS&TemplateName=ECS%E7%89%88) and click "Deploy Now".
2. **Fill in & Create**: provide parameters based on the sandbox backend you want (E2B mode: `E2B_API_KEY`; AgentRun mode: `ALIBABA_CLOUD_ACCESS_KEY_ID` etc.), then click "Create Now".
3. **Access the Instance**: on the instance page, check **Application Outputs** for the **WebUI Access URL** (port **8000**) and the **API Call Example**.

After creation, the instance detail page's "Application Outputs" panel shows:

- **WebUI Access URL**: open `http://<instance-ip>:8000` and select the `adk_code_executor` app to start using it.
- **Code Debug Address** (cluster deployment): `http://<instance-ip>:8080` for online source viewing and debugging.
- **API Call Example**: send an SSE request to `http://<instance-ip>:8000/run_sse` with `app_name=adk_code_executor` and `user_id=user`. OpenAPI docs: `http://<instance-ip>:8000/docs`.

**Sessions (ECS)**: the app uses in-memory sessions when `SESSION_REDIS_URL` is unset; for persistence on Compute Nest ECS, pre-fill `SESSION_REDIS_URL=redis://127.0.0.1:6379` in deployment env vars.

**Sessions (cluster)**: a Session connection is required; sessions are persisted to Redis.

### Local Setup

**Requirements**

- Python ≥ 3.12
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- Sandbox credentials (choose one):
  - **E2B mode**: [E2B API Key](https://e2b.dev/docs), plus set `TLS_CERT`
  - **AgentRun mode**: Alibaba Cloud Access Key + `AGENTRUN_REGION` + `AGENTRUN_ACCOUNT_ID`
- Optional Redis (persistent sessions when `SESSION_REDIS_URL` is set; in-memory otherwise)

**Install & Start**

```bash
cd adk_code_executor
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: fill in DASHSCOPE_API_KEY and the credentials for your chosen sandbox backend

chmod +x server.sh
./server.sh start
```

- Service / Web UI: http://127.0.0.1:8000
- API docs: http://127.0.0.1:8000/docs

**Local Test Chat**

Open http://127.0.0.1:8000, select the `adk_code_executor` app, and enter a coding request; or verify the service is ready:

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# Expected: ["adk_code_executor"]
```

**Example Prompts**

- Write a Python function to compute the first 20 Fibonacci numbers, execute it in the sandbox, and return the results
- Install pandas in the sandbox, read a sample CSV, and print the first 5 rows with summary statistics
- Implement quicksort in Python, test it with a random array, and show a before/after comparison

## Sandbox Backends

| Backend | Trigger | Required Credentials |
|---------|---------|---------------------|
| **E2B** (ACSSandbox) | `TLS_CERT` env var is non-empty | `E2B_API_KEY`, `E2B_DOMAIN` |
| **AgentRun** | `TLS_CERT` not set (default) | `ALIBABA_CLOUD_ACCESS_KEY_ID`, `ALIBABA_CLOUD_ACCESS_KEY_SECRET`, `AGENTRUN_REGION`, `AGENTRUN_ACCOUNT_ID` |

The selection logic lives in `tools/sandbox_factory.py` and is transparent to `agent.py`.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHSCOPE_API_KEY` | Bailian (DashScope) API key | Required |
| `DASHSCOPE_MODEL_NAME` | Chat model | `qwen3-plus` |
| `TEMPLATE_NAME` | Sandbox template name (shared by E2B and AgentRun) | `code-interpreter` |
| `TLS_CERT` | ACSSandbox TLS certificate; **switches to E2B backend when set** | None |
| `E2B_API_KEY` | E2B sandbox API key (required in E2B mode only) | None |
| `E2B_DOMAIN` | E2B private-deployment domain (E2B mode only) | `agent-vpc.infra` |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | Alibaba Cloud Access Key ID (required in AgentRun mode) | None |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | Alibaba Cloud Access Key Secret (required in AgentRun mode) | None |
| `AGENTRUN_REGION` | AgentRun service region (required in AgentRun mode) | None |
| `AGENTRUN_ACCOUNT_ID` | Alibaba Cloud account ID (required in AgentRun mode) | None |
| `SESSION_REDIS_URL` | Redis URL; when unset, in-memory sessions | None (in-memory) |
| `PORT` | HTTP listen port | `8000` |

Copy and adjust as needed:

```bash
cp .env.example .env
```

## References

- [Google ADK Python](https://github.com/google/adk-python)
- [AgentRun Python SDK](https://github.com/Serverless-Devs/agentrun-sdk-python)
- [E2B Code Interpreter](https://e2b.dev/docs/code-interpreter)
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
