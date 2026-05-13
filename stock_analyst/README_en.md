# Stock analysis assistant

## Overview

This sample is a **stock analysis assistant** focused on **tradable symbols** (stocks, ETFs, indices): multi-round web search and orchestration produce a structured final answer with **(1) data analysis**, **(2) scenario-based trend views**, and **(3) reference investment ideas** (with risks and disclaimers)—not a long generic “company profile”.

**`StockDeepResearchAgent`** runs **decomposition → programmatic Bailian web search → extra search rounds (when needed) → intermediate summary → streaming final report**. `main.py` mounts **Web Search MCP**, **`execute_python_code`**, **`write_text_file`**, **`view_text_file`**, uses **`DASHSCOPE_API_KEY`**, sessions in **JSON** or **Redis**.

**Disclaimer**: **Not licensed investment advice**; no return guarantee; for learning and demo; you are responsible for decisions—verify primary sources and consult licensed professionals where required.

## Features

- **1. Stock data analysis**: Summarize price, change, volume, valuation, etc. from search; optional `execute_python_code` on user-pasted or extracted series (`print` required).
- **2. Trend / outlook**: Multi-scenario discussion with evidence and invalidation conditions; no “guaranteed up/down” claims.
- **3. Investment reference**: Actionable-style guidance (e.g. sizing, stop-loss *ideas*) with counter-arguments and **non-advisor disclaimers**.
- **Deep retrieval**: Queries bias toward quotes, technical views, targets/ratings, and risks—not encyclopedic company narratives.
- **Session memory**: JSON or Redis.

## Directory layout

```text
stock_analyst/
├── README.md
├── __init__.py
├── main.py               # AgentScope + Runtime entry
├── agent.py              # StockDeepResearchAgent: decompose / search / extra rounds / final
├── server.sh             # start / stop / restart / status
├── client.py             # Test client (/process SSE)
├── requirements.txt
├── .env.example
├── configs/
│   └── mcp_config.json   # Bailian WebSearch MCP (SSE + Bearer)
├── tools/
│   ├── __init__.py
│   └── mcp_helpers.py
├── workspace/            # Optional notes when using file tools
└── sessions/             # Default when SESSION_TYPE=json
```

**`main.py` and `agent.py`**: run the server with `python main.py`; `agent.py` defines the agent class only.

## Alibaba Cloud Compute Nest

1. Open the [Compute Nest Stock Analyst page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/StockAnalyst?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and deploy.
2. Fill parameters (e.g. `DASHSCOPE_API_KEY`) and create.
3. Use CLI or Web UI on the instance.

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
cd stock_analyst
pip install -r requirements.txt
```

#### Environment variables

Copy `stock_analyst/.env.example` to `.env` (`cp .env.example .env`), or `export` in the shell:

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHSCOPE_API_KEY` | Yes | Bailian key (`sk-...`) for the chat model and MCP `Authorization: Bearer` |
| `DASHSCOPE_MODEL_NAME` | No | Default `qwen-max`; larger context helps long research |
| `STOCK_SEARCH_TOOL_NAME` | No | Force the web-search MCP tool `function.name`; leave empty for auto-pick |
| `SESSION_TYPE` | No | `json` (default) or `redis` |
| `SESSION_REDIS_URL` | If redis | Required when using Redis |

### Enable Bailian “Web Search” MCP

Default SSE endpoint in `configs/mcp_config.json`:

`https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/sse`

Enable **Web Search** in the [Bailian MCP market](https://bailian.console.aliyun.com/cn-beijing/?tab=app#/mcp-market). If the console suggests Streamable HTTP, follow the guide; **SSE often still works**. See [Web Search MCP docs](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan).

### MCP config (`configs/mcp_config.json`)

`tools/mcp_helpers.py` supports typical setups:

- **Remote**: `baseUrl` + `type` (this sample defaults to `sse`) + `headers` (`Bearer ${DASHSCOPE_API_KEY}`).
- For Streamable HTTP, you may set `type` to `streamableHttp` and `baseUrl` to `https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp`. On **`405 Method Not Allowed`**, revert to **SSE** or try `pip install -U mcp httpx httpx-sse agentscope`.
- You can merge other MCPs; registration follows the config.

### Start server

```bash
cd stock_analyst
python main.py
```

Default: **`http://0.0.0.0:8090`**. If port **8090** is busy, change `main.py` or free the port.

Or:

```bash
chmod +x server.sh
./server.sh start
./server.sh status
./server.sh stop
```

### Test client

```bash
python client.py
```

Adjust `BASE_URL`, `USER_ID`, `SESSION_ID`, and sample questions in `client.py`.

## Sample prompts

- Analyze **TICKER**: **data analysis**, **multi-scenario outlook**, **reference ideas** (risks + disclaimers).
- An ETF is volatile lately: summarize public data, scenario outlook, and **reference** risk/positioning notes (no performance guarantee).
- User will paste 20 daily closes: enrich with latest quote from search, simple stats in code, then outlook and **reference** guidance.

## FAQ

- **Web Search MCP fails**: enable Web Search; default is `.../WebSearch/sse`. **405** on `.../WebSearch/mcp` often means client/gateway mismatch — **use this repo’s SSE config**.
- **`DeprecationWarning: Use streamable_http_client`**: usually harmless for SSE; for `/mcp`, upgrade `mcp`, `agentscope`, etc.
- **API key**: general Bailian `sk-` key per [official docs](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan).
- **Wrong search tool picked**: set `STOCK_SEARCH_TOOL_NAME` to the actual tool name from the console.
- **No code output**: `execute_python_code` needs `print()`.
- **Port conflict**: default **8090**; change `main.py` and `client.py` `BASE_URL` if needed.

## References

- [AgentScope docs](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [Bailian Web Search MCP](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan)
