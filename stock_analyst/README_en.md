# Stock Analyst — Intelligent Stock Analysis Assistant

A stock-analysis sample built on [Google ADK](https://github.com/google/adk-python): Bailian WebSearch MCP + Deep Research system prompt. Output is for reference only and does **NOT** constitute licensed investment advice.

## What This Is

- Multi-round web search: step-by-step search around a ticker's market data, trend discussions, and risk-related information
- Structured report: data analysis, multi-scenario trend assessment, and reference-only investment notes (with disclaimer)
- Official Google ADK API: single port **8000**, with built-in Web UI and `/run_sse` streaming API
- Session persistence: connect to Redis via `SESSION_REDIS_URL`; otherwise use ADK default in-memory sessions
- **One-click deployment on Compute Nest**: in-browser Web UI (port **8000**)

## Directory Structure

```text
stock_analyst/
├── stock_analyst/
│   ├── __init__.py           # Package marker, exposes root_agent
│   └── agent.py              # Agent definition (name="stock_analyst")
├── configs/
│   └── mcp_config.json       # Bailian WebSearch MCP config
├── services.py               # Registers Redis session backend
├── server.sh                 # Start / stop script (local / container)
├── requirements.txt          # Python dependencies
├── .env.example              # Environment variables example
└── .dockerignore             # Excludes .venv / .env / logs from Docker images
```

## Usage

### Compute Nest Deployment

Deploy with one click via Alibaba Cloud Compute Nest — no local environment required:

1. **Deploy Now**: open the [Compute Nest Stock Analyst deployment page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/StockAnalyst?serviceId=service-0682c63593ea443e900c&deployType=ECS&TemplateName=ECS%E7%89%88) and click "Deploy Now".
2. **Fill in & Create**: provide parameters such as `DASHSCOPE_API_KEY` and click "Create Now".
3. **Access the Instance**: on the instance page, check **Application Outputs** for the **WebUI Access URL** (port **8000**) and the **API Call Example**.

After creation, the instance detail page's "Application Outputs" panel shows:

- **WebUI Access URL**: open `http://<instance-ip>:8000` and select the `stock_analyst` app.
- **Code Debug Address** (cluster deployment): `http://<instance-ip>:8080` for online source viewing and debugging.
- **API Call Example**: send an SSE request to `http://<instance-ip>:8000/run_sse` with `app_name=stock_analyst` and `user_id=user`. OpenAPI docs: `http://<instance-ip>:8000/docs`.

**Sessions (ECS)**: the app uses in-memory sessions when `SESSION_REDIS_URL` is unset; for persistence on Compute Nest ECS, pre-fill `SESSION_REDIS_URL=redis://127.0.0.1:6379` in deployment env vars.

**Sessions (cluster)**: a Session connection is required; sessions are persisted to Redis.

### Local Setup

**Requirements**

- Python ≥ 3.12 (`computenest-agent-integrations` requirement)
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- Optional Redis (persistent sessions when `SESSION_REDIS_URL` is set; in-memory otherwise)

**Install & Start**

```bash
cd stock_analyst
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

Open http://127.0.0.1:8000 , select the `stock_analyst` app, and ask for a stock analysis; or verify the service is ready:

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# Expected: ["stock_analyst"]
```

**Example Prompts**

- Search recent one-week public quotes and news for Alibaba (9988.HK / BABA), then output data analysis, trend outlook, and reference investment notes (with risks and disclaimer)

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
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
