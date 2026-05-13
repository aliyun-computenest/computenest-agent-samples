# Intelligent travel assistant

## Overview

This sample uses **AgentScope** and **AgentScope Runtime** for intelligent travel planning. The agent integrates **Amap MCP** for LBS and routing, a **local knowledge base** (travel safety and offbeat spots), optional **long-term memory (Mem0)**, plus Runtime session persistence and a streaming API.

## Features

- **Itinerary**: transport, dining, lodging, and sights via Amap MCP.
- **Travel knowledge base**: local RAG (SimpleKnowledge + Markdown) for safety tips and niche recommendations.
- **Long-term memory (optional)**: Mem0 records user preferences for personalization.
- **Session memory**: Runtime session (JSON files or Redis) for the current conversation.

## Directory layout

```text
travel_planner/
├── README.md
├── __init__.py
├── main.py               # AgentScope + Runtime entry
├── server.sh             # start / stop / restart / status
├── client.py             # Test client (/process SSE)
├── requirements.txt
├── configs/
│   └── mcp_config.json   # MCP (Amap, etc.)
├── knowledgebase_docs/   # Knowledge base Markdown
│   ├── general_safety_guide.md
│   └── tourists_recommend.md
├── tools/
│   ├── __init__.py
│   └── mcp_helpers.py    # MCP client registration
└── sessions/             # Default session dir (JSON mode)
```

## Alibaba Cloud Compute Nest

Deploy without a full local setup:

1. Open the [Compute Nest Travel Planner page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/TravelPlanner?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and deploy.
2. Fill parameters (e.g. `DASHSCOPE_API_KEY`) and create the instance.
3. Open the instance page and use CLI or Web UI.

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="Application details" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

Use Web UI to chat.

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/WeiUI.jpg" alt="Web UI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## Local run

### Environment

#### Python

Python 3.10+ recommended.

#### Dependencies

```bash
cd travel_planner
pip install -r requirements.txt
```

#### Environment variables

Copy `travel_planner/.env.example` to `.env` (`cp .env.example .env`), or create `.env` under the repo root / `travel_planner`, or `export` in the shell:

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHSCOPE_API_KEY` | Yes | Alibaba DashScope key; used for the model, knowledge-base / long-term-memory embeddings, and MCP auth (`Authorization: Bearer ${DASHSCOPE_API_KEY}` in `configs/mcp_config.json`) |
| `DASHSCOPE_MODEL_NAME` | No | Chat model, default `qwen-max` |
| `SESSION_TYPE` | No | `json` (default) or `redis` |
| `SESSION_REDIS_URL` | If redis | Required when `SESSION_TYPE=redis`, e.g. `redis://localhost:6379/0` |
| `TRAVEL_PLANNER_USE_LONG_TERM_MEMORY` | No | `1` / `true` / `yes` enables Mem0 (needs DashScope) |

Amap features are provided by Bailian **amap-maps** MCP with the same `DASHSCOPE_API_KEY` — no separate Amap key. **Enable amap-maps in the [Bailian MCP market](https://bailian.console.aliyun.com/cn-beijing/?spm=5176.24779694.console-base_search-panel.dtab-product_sfm.2e9b4d22SkTaYy&tab=app#/mcp-market/detail/amap-maps)** before use.

**MCP config** (`configs/mcp_config.json`):

- **type**: `sse` (URLs often end with `/sse`) or `streamableHttp` (often `/mcp`). The code picks the matching MCP client.
- **baseUrl**: service URL as shown in the Bailian console.
- **headers**: e.g. `Authorization: Bearer ${DASHSCOPE_API_KEY}` (substituted from the environment).

### Run

#### Start server

```bash
cd travel_planner
python main.py
```

Default: `http://0.0.0.0:8090`.

Or use the control script:

```bash
./server.sh start    # background, logs in server.log
./server.sh stop
./server.sh restart
./server.sh status
```

#### Test client

```bash
python client.py
```

Edit `BASE_URL`, `USER_ID`, `SESSION_ID`, and sample prompts in `client.py` as needed.

## Sample prompts

- New Year’s trip to Harbin: 5 days / 4 nights, Ice World, Central Street, Northeastern food.
- Qingming in Hangzhou for 3 days: West Lake, Lingyin, plus one day hiking Xixi wetland — daily plan?
- May Day in Chengdu for 3 days: Kuanzhai Alley, Panda Base, one day Dujiangyan or Qingcheng — how to split days?

## FAQ

- **Amap MCP errors**: enable amap-maps in the Bailian MCP market; ensure `DASHSCOPE_API_KEY` is set.
- **Knowledge base not used**: valid `DASHSCOPE_API_KEY` and `.md` files under `knowledgebase_docs/`.
- **Long-term memory**: set `TRAVEL_PLANNER_USE_LONG_TERM_MEMORY=1` and keep DashScope available.

## References

- [AgentScope docs](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
