# ADK Browser Use — Browser Automation Agent

A browser automation sample built on [Google ADK](https://github.com/google/adk-python), supporting both **E2B** and **AgentRun** sandbox backends. It accepts natural-language instructions and autonomously performs web navigation, form filling, information extraction, and more inside an isolated browser sandbox.

## What This Is

- **Dual sandbox backends**: automatically selects the backend based on environment variables — E2B (ACSSandbox) for private deployments, AgentRun for public cloud
- **Isolated browser sandbox**: each conversation runs in a dedicated browser sandbox — operations are fully isolated and safe
- **Full browser capabilities**: page navigation, element clicking, form filling, screenshots, JavaScript execution, and more
- **Playwright-powered**: connects to a Chrome instance in the sandbox via CDP protocol using Playwright for browser automation
- Official Google ADK API: single port **8000**, with built-in Web UI and `/run_sse` streaming API
- Session persistence: connect to Redis via `SESSION_REDIS_URL`; otherwise use ADK default in-memory sessions
- **One-click deployment on Compute Nest**: in-browser Web UI (port **8000**)

## Directory Structure

```text
adk_browser_use/
├── __init__.py                  # sqlite3 compatibility shim
├── browser_use/
│   ├── __init__.py              # Package init (expose root_agent)
│   └── agent.py                 # Agent definition (root_agent, auto-selects backend via sandbox factory)
├── services.py                  # Redis session service registration
├── server.sh                    # Start / stop script (local / container)
├── requirements.txt             # Python dependencies
├── .env.example                 # Environment variables example
└── .dockerignore                # Excludes .venv / .env / logs from Docker images
```

## Usage

### Compute Nest Deployment

Deploy with one click via Alibaba Cloud Compute Nest — no local environment required:

1. **Deploy Now**: open the Compute Nest deployment page and click "Deploy Now".
2. **Fill in & Create**: provide parameters based on the sandbox backend you want (E2B mode: `E2B_API_KEY`; AgentRun mode: `ALIBABA_CLOUD_ACCESS_KEY_ID` etc.), then click "Create Now".
3. **Access the Instance**: on the instance page, check **Application Outputs** for the **WebUI Access URL** (port **8000**) and the **API Call Example**.

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
cd adk_browser_use
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

Open http://127.0.0.1:8000, select the `adk_browser_use` app, and enter a browser task; or verify the service is ready:

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# Expected: ["adk_browser_use"]
```

**Example Prompts**

- Open Baidu, search for "AgentScope", and tell me the titles and links of the top three search results
- Visit GitHub, search for the `agentscope` repository, find the one with the most stars, and take a screenshot
- Open a weather website, look up today's weather in Beijing, and organize the results into a table
- Open a specified webpage, find the contact form, fill in the name "John Doe" and email "test@example.com"

## Sandbox Backends

| Backend | Trigger | Required Credentials |
|---------|---------|---------------------|
| **E2B** (ACSSandbox) | `E2B_API_KEY` env var is non-empty | `E2B_API_KEY`, `E2B_DOMAIN`, `TLS_CERT` |
| **AgentRun** | `AGENTRUN_ACCOUNT_ID` env var is non-empty | `ALIBABA_CLOUD_ACCESS_KEY_ID`, `ALIBABA_CLOUD_ACCESS_KEY_SECRET`, `AGENTRUN_REGION`, `AGENTRUN_ACCOUNT_ID` |

The selection logic lives in `computenest-agent-integrations`'s `sandbox_factory` and is transparent to `agent.py`.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHSCOPE_API_KEY` | Bailian (DashScope) API key | Required |
| `DASHSCOPE_MODEL_NAME` | Chat model | `qwen3-plus` |
| `TEMPLATE_NAME` | Sandbox template name (shared by E2B and AgentRun) | `browser` |
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
- [E2B Sandbox](https://e2b.dev/docs)
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
- [Playwright](https://playwright.dev/)
