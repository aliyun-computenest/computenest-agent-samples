# Travel Planner Assistant

A travel planning sample built on [AgentScope Agent Service](https://docs.agentscope.io/v2/deploy/agent-service.md): Amap MCP + local travel knowledge + multi-turn chat.

## What This Is

- Itinerary planning: combines destination knowledge, routes, and POIs to generate daily plans with dining and lodging
- Amap MCP: routing, nearby search, real-time traffic, and other geographic information
- Local knowledge: travel safety guides and off-the-beaten-path attractions under `knowledgebase_docs/`
- **One-click deployment on Compute Nest**: in-browser Web UI (port 5173)

## Directory Structure

```text
travel_planner/
├── main.py                 # Service entry
├── client.py               # Local test: create Session + streaming chat
├── server.sh               # Agent start / stop
├── requirements.txt
├── .env.example
├── configs/mcp_config.json # Amap MCP (Bailian amap-maps)
├── knowledgebase_docs/     # Travel knowledge in Markdown
│   ├── general_safety_guide.md
│   └── tourists_recommend.md
└── tools/
    ├── mcp_helpers.py
    └── prompts.py
```

## Usage

### Compute Nest Deployment

Deploy with one click via Alibaba Cloud Compute Nest — no local environment required:

1. **Deploy Now**: open the [Compute Nest Travel Planner deployment page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/TravelPlanner?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and click "Deploy Now".
2. **Fill in & Create**: provide parameters such as `DASHSCOPE_API_KEY` and click "Create Now".
3. **Access the Instance**: on the instance page, check **Application Outputs** for the **WebUI Access URL** (port **5173**) and the **API Call Example** (`POST /chat/`).

After creation, the instance detail page's "Application Outputs" panel shows:

- **WebUI Access URL**: open `http://<instance-ip>:5173` in your browser, using `demo_user` as Username.
- **API Call Example**: send a message to `http://<instance-ip>:8090/chat/` with header `X-User-ID: demo_user`. The body must contain `agent_id=travel_planner` and `session_id` (visible in the Web UI, or create one via `POST /sessions/`). OpenAPI: `http://<instance-ip>:8090/docs`.

**Redis (ECS)**: uses `SESSION_REDIS_URL` from environment variables; falls back to `redis://127.0.0.1:6379/0` when unset.

**Redis (container cluster)**: `SESSION_REDIS_URL` MUST be configured in environment variables.

### Local Setup

**Requirements**

- Python ≥ 3.11
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- Redis (must configure `SESSION_REDIS_URL`)
- **amap-maps** activated in the [Bailian MCP Marketplace](https://bailian.console.aliyun.com/?tab=app#/mcp-market/detail/amap-maps)

**Install & Start**

```bash
cd travel_planner
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: DASHSCOPE_API_KEY, SESSION_REDIS_URL

chmod +x server.sh
./server.sh start
```

- Service: http://127.0.0.1:8090
- API docs: http://127.0.0.1:8090/docs

**Local Test Chat**

In a separate terminal, run `client.py`: it uses the pre-registered `agent_id=travel_planner` and creates a fresh Session per run.

```bash
source .venv/bin/activate
python client.py
```

### Example Prompts

- Plan a 5-day, 4-night trip to Harbin around New Year, covering Harbin Ice and Snow World, Central Street, and Northeast cuisine.
- For a 3-day Qingming-holiday trip to Hangzhou — beyond West Lake and Lingyin Temple, I want to add a 1-day hike at Xixi Wetland. How should I arrange each day?

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DASHSCOPE_API_KEY` | Bailian (DashScope) API key | Required |
| `DASHSCOPE_MODEL_NAME` | Chat model | `qwen3.7-max` |
| `SESSION_REDIS_URL` | Redis URL | Required; defaults to `redis://127.0.0.1:6379/0` on ECS |
| `HOST` / `PORT` | HTTP listen address | `0.0.0.0` / `8090` |
| `CREATE_DEFAULT_SESSION` | When set to `1`, pre-build a Session named "Default" on startup | `0` (Compute Nest deployment uses `1`) |

Copy and adjust as needed:

```bash
cp .env.example .env
```

## References

- [AgentScope Quickstart](https://docs.agentscope.io/en/v2/quickstart)
- [Agent Service Documentation](https://docs.agentscope.io/v2/deploy/agent-service.md)
