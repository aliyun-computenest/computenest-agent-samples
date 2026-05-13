# Opinion deep research assistant

## Overview

This sample uses [**AgentScope**](https://doc.agentscope.io/) and [**AgentScope Runtime**](https://runtime.agentscope.io/) to run **multi-round public web research** on brands, events, or topics, and produce a **structured opinion draft** (background, viewpoints, risks, information gaps, etc.).

The agent is **`OpinionDeepResearchAgent`**: **subtask breakdown → programmatic multi-round Bailian web search → extra search rounds (when needed) → interim summaries → streaming final report**. **`main.py`** registers Runtime, mounts **Web Search MCP** and `execute_python_code`, shares **`DASHSCOPE_API_KEY`**, streams on **`/process`**, and persists sessions to **JSON** or **Redis**.

**Disclaimer**: Reports are AI-synthesized from search snippets; **for learning or internal discussion only** — not legal advice, investment advice, or a formal PR plan. Verify important conclusions against original pages.

## Features

- **Deep search orchestration**: sub-questions and query terms, round-based web search, optional extra queries from results.
- **Public sources**: Bailian **Web Search MCP** for page snippets (enable in console).
- **Auxiliary analysis**: optional `execute_python_code` for simple stats — must `print` output.
- **Session memory**: Runtime session (JSON or Redis) for agent state in the chat.

## Directory layout

```text
opinion_analyst/
├── README.md
├── __init__.py
├── main.py               # Runtime entry (default port below)
├── agent.py              # OpinionDeepResearchAgent: breakdown / search / extra rounds / draft
├── server.sh             # start / stop / restart / status
├── client.py             # Test client (/process SSE)
├── requirements.txt
├── .env.example
├── configs/
│   └── mcp_config.json   # Bailian WebSearch MCP (SSE + Bearer)
├── tools/
│   ├── __init__.py
│   └── mcp_helpers.py
├── workspace/            # Optional intermediate files if file tools are used
└── sessions/             # Default when SESSION_TYPE=json
```

**`main.py` vs `agent.py`**: run `python main.py`; `agent.py` only defines the agent class — **do not run it alone**.

## Alibaba Cloud Compute Nest

1. Open the [Compute Nest Opinion Analyst page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/OpinionAnalyst?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and deploy.
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
cd opinion_analyst
pip install -r requirements.txt
```

#### Environment variables

Copy `opinion_analyst/.env.example` to `.env` (`cp .env.example .env`), or `export`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHSCOPE_API_KEY` | Yes | Bailian key (`sk-...`) for the model and Web Search MCP |
| `DASHSCOPE_MODEL_NAME` | No | Default `qwen-max`; larger context may help complex topics |
| `SESSION_TYPE` | No | `json` (default) or `redis` |
| `SESSION_REDIS_URL` | If redis | Required when using Redis |
| `OPINION_SEARCH_TOOL_NAME` | No | Usually leave empty. Set **only** if auto-selection picks the wrong tool or startup errors say no web-search tool was found: in the Bailian console open **MCP** → **Web Search** (the one you enabled), find the tool’s `function.name` (case-sensitive) in the docs or debug view, and paste it here. Details and an example placeholder are in `.env.example` (comments are in Chinese; meaning is the same). |

#### Enable Bailian “Web Search” MCP

1. [Bailian MCP market](https://bailian.console.aliyun.com/cn-beijing/?tab=app#/mcp-market) — enable **Web Search**.
2. `configs/mcp_config.json` defaults to **SSE**, aligned with [Web Search MCP docs](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan). On **405**, keep SSE or upgrade the client per docs.

#### MCP config (`configs/mcp_config.json`)

Same pattern as other samples in this repo: remote service with `baseUrl` + `type` (default `sse`) + `headers` (`Bearer ${DASHSCOPE_API_KEY}`). Merge other MCPs as needed; `tools/mcp_helpers.py` registers from config.

### Run

#### Start server

```bash
cd opinion_analyst
python main.py
```

Default: **`http://0.0.0.0:8090`**. If the port conflicts, change `agent_app.run` in `main.py` and `BASE_URL` in `client.py`.

Or:

```bash
chmod +x server.sh
./server.sh start
./server.sh status
./server.sh stop
```

#### Test client

```bash
python client.py
```

Edit sample questions and `BASE_URL` / `SESSION_ID` in `client.py` as needed.

## Sample prompts

- For “brand X”, last two weeks of Chinese coverage and discussion: sub-questions, search rounds, and information gaps should be explicit.
- Public event “X”: timeline of known reports, different narratives; note debunking or reversal leads if any.
- Product “X”, last month: focus on after-sales and quality discussions; monitoring hints without absolute claims.

## FAQ

- **Invalid key / no search**: check `.env`, Web Search enabled on Bailian, network to Alibaba Cloud.
- **Too few results**: richer keywords in the prompt, or adjust default orchestration in `agent.py` / try another model.
- **Subtask JSON parse errors**: built-in fallbacks; may fall back to a default search plan.

## References

- [AgentScope docs](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [Bailian Web Search MCP](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan)
