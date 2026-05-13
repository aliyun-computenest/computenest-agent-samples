# Browser Use - Intelligent Web Browsing Assistant

## Overview

This example implements an **Intelligent Web Browsing Assistant** based on [**AgentScope**](https://doc.agentscope.io/) and [**AgentScope Runtime**](https://runtime.agentscope.io/). It takes **natural language instructions** as input and drives a real browser via **Playwright MCP** to accomplish **① web navigation & information extraction ② form filling & page interaction ③ multi-step automation tasks** — letting AI operate a browser just like a human.

The agent is **`BrowserAgent`**: **ReAct loop reasoning → page snapshot perception → browser tool invocation → memory trimming → streaming final response**. `main.py` mounts **Playwright MCP** (via AgentRun cloud sandbox), shares **`DASHSCOPE_API_KEY`**, supports **JSON** or **Redis** session storage, and delivers sandbox CDP/VNC URLs with the first message for real-time frontend preview.

## Core Features

- **Feature 1: Web Navigation & Information Extraction**: Visit specified URLs based on user instructions, read page content, and extract structured information (text, links, data, etc.).
- **Feature 2: Form Filling & Page Interaction**: Automatically identify and operate page elements, including clicking buttons, filling forms, dropdown selection, scrolling, and more.
- **Feature 3: Multi-step Automation Tasks**: Break down complex browser operations into sub-steps, execute them iteratively within the ReAct loop, supporting up to 50 iterations.
- **Page Snapshot Perception**: Before each reasoning step, automatically calls `browser_snapshot` to capture a text snapshot of the current page (up to 20,000 characters), injected into the reasoning context to ensure the Agent always perceives the latest page state.
- **Automatic Memory Trimming**: Retains the first user task message + the most recent N messages to prevent long tasks from overflowing the model context window.
- **Cloud Sandbox Isolation**: Each session has its own dedicated AgentRun browser sandbox connected via CDP protocol, with VNC real-time preview support; sandboxes are automatically reclaimed after 600 seconds of idle time.
- **Session Memory**: Runtime Session (JSON or Redis) persists Agent state across requests.

## Directory Structure

```text
browser_use/
├── README.md
├── main.py                    # AgentScope + Runtime entry point (default port 8090)
├── client.py                  # Test client (/process SSE)
├── server.sh                  # start / stop / restart / status
├── deploy.sh                  # One-click frontend + backend deployment
├── stop.sh                    # One-click stop all services
├── requirements.txt
├── .env.example
├── agents/
│   └── browser_agent.py       # BrowserAgent: ReAct + page snapshot + memory trimming
├── configs/
│   └── mcp_config.json        # MCP configuration (optional additional MCPs)
├── tools/
│   ├── mcp_helpers.py         # MCP Toolkit registration helper
│   └── sandbox_manager.py     # AgentRun Sandbox lifecycle management
├── logs/                      # Service runtime logs
└── sessions/                  # Default session directory when SESSION_TYPE=json
```

**`main.py` and `agents/browser_agent.py`**: `main.py` is the service entry point (`python main.py`); `browser_agent.py` only provides the agent class, referenced by `main.py` and **does not need to be executed independently**.

## Agent Architecture

```text
User Natural Language Instruction
    ↓
AgentScope Runtime (AgentApp "Friday")
    ↓
BrowserAgent (extends ReActAgent)
    ├── Page Snapshot Perception (pre_reasoning hook → browser_snapshot)
    ├── ReAct Reasoning Loop (up to 50 iterations)
    │   ├── Reason: plan next action based on snapshot + memory
    │   └── Act: call Playwright MCP tools (navigate/click/fill/screenshot, etc.)
    ├── Memory Trimming (keep first task + most recent N messages, prevent context overflow)
    ├── AgentRun Sandbox (cloud Chrome instance, CDP + VNC)
    └── InMemoryMemory + JSONSession / RedisSession (session persistence)
```

## Alibaba Cloud Compute Nest Deployment

Deploy this example with one click via Alibaba Cloud Compute Nest — no local environment setup required:

1. **Click Deploy**: Open the [Compute Nest Browser Use Deployment Page](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/BrowserUse?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF) and click "Deploy Now".
2. **Fill in Parameters**: Follow the page prompts to fill in parameters (e.g., `DASHSCOPE_API_KEY`, `AGENTRUN_ACCOUNT_ID`, etc.) and click "Create Now".
3. **Access the Instance**: After creation, you will be redirected to the instance page where you can access and use the Agent service via CLI or the frontend Web UI.

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="Application Details" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>
Open the WebUI and start chatting. The frontend can display a real-time browser preview (VNC stream).
<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/browseruse.png" alt="WebUI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## Local Setup

### Environment Preparation

#### 1. Python

Python 3.10+ is recommended.

#### 2. Install Dependencies

```bash
cd browser_use
pip install -r requirements.txt
```

#### 3. Environment Variables

Copy `browser_use/.env.example` to `.env` (`cp .env.example .env`) or `export` in your shell:

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHSCOPE_API_KEY` | Yes | DashScope API Key (starts with `sk-`), used for the chat model |
| `DASHSCOPE_MODEL_NAME` | No | Defaults to `qwen-max`; use a longer-context model for complex tasks |
| `AGENTRUN_ACCOUNT_ID` | Yes | AgentRun account ID, used to construct CDP / VNC URLs |
| `AGENTRUN_REGION` | No | AgentRun service region, defaults to `cn-hangzhou` |
| `AGENTRUN_TEMPLATE_ID` | No | Sandbox template name, e.g. `sandbox-browser-xxxx` |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | Yes | Alibaba Cloud AccessKey ID, used for AgentRun SDK authentication |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | Yes | Alibaba Cloud AccessKey Secret |
| `SESSION_TYPE` | No | `json` (default) or `redis` |
| `SESSION_REDIS_URL` | Conditional | Required when `SESSION_TYPE=redis` |

#### 4. AgentRun Sandbox

This example uses the cloud browser sandbox provided by **AgentRun**, with each session having its own isolated Chrome instance:

- **CDP URL**: `wss://{AGENTRUN_ACCOUNT_ID}.agentrun-data.{REGION}.aliyuncs.com/sandboxes/{sandbox_id}/ws/automation` — used by Playwright MCP to connect and control the browser via CDP protocol.
- **VNC URL**: `wss://{AGENTRUN_ACCOUNT_ID}.agentrun-data.{REGION}.aliyuncs.com/sandboxes/{sandbox_id}/ws/livestream` — used by the frontend for real-time browser preview.
- **Lifecycle**: Sandboxes are created on the first request of a session, automatically reclaimed after **600 seconds** of idle time, and all active sandboxes are destroyed when the service shuts down.
- **Session Reuse**: Subsequent requests with the same `session_id` reuse the existing sandbox; the browser stays on the last visited page without re-navigation.

Please enable AgentRun service and create a Sandbox template in the [AgentRun Console](https://functionai.console.aliyun.com/cn-hangzhou).

### Starting the Service

#### One-Click Deployment (Recommended)

`deploy.sh` automatically handles: Python virtual environment creation, backend dependency installation, frontend npm dependency installation and build, background startup of both frontend and backend services, and automatic public IP detection for frontend `BASE_URL` configuration.

```bash
cd browser_use
chmod +x deploy.sh stop.sh server.sh
bash deploy.sh
```

After deployment:

| Service | Address |
|---------|---------|
| **Frontend WebUI** | `http://localhost:5173` |
| **Backend API** | `http://0.0.0.0:8090` |

All logs are stored in the `logs/` directory:

| Log File | Description |
|----------|-------------|
| `logs/deploy.log` | Deployment process log |
| `logs/backend.log` | Backend runtime log |
| `logs/frontend.log` | Frontend service log |

**Optional flags:**

```bash
# Deploy backend only (skip frontend build)
bash deploy.sh --skip-frontend

# Deploy frontend only (skip backend)
bash deploy.sh --skip-backend

# Start frontend in development mode (vite dev, with hot reload)
bash deploy.sh --dev
```

#### Stopping the Service

```bash
# Stop all services (frontend + backend)
bash stop.sh

# Stop backend only
bash stop.sh --backend-only

# Stop frontend only
bash stop.sh --frontend-only
```

#### Backend-Only Management

To control only the backend process, use `server.sh`:

```bash
./server.sh start    # Start backend
./server.sh stop     # Stop backend
./server.sh restart  # Restart backend
./server.sh status   # Check status
```

#### Manual Start (Development / Debugging)

```bash
cd browser_use
python main.py
```

The backend listens on **`http://0.0.0.0:8090`** by default. If the port is already in use, modify the port number in `main.py`.

### Test Client

```bash
python client.py
```

You can modify `BASE_URL`, `USER_ID`, `SESSION_ID`, and the example instructions in `main()` within `client.py`.

## Example Prompts

- Visit **Baidu**, search for "AgentScope", and tell me the titles and links of the top three search results.
- Open **GitHub**, search for the `agentscope` repository, find the one with the most stars, and tell me its description and the time of the latest commit.
- Visit a **weather website**, look up the weather forecast for Beijing for today and the next three days, and return the results as a table.
- Search for "mechanical keyboard" on an e-commerce website, sort by sales volume, and return the names and prices of the top five items.
- Open a specified webpage, find the contact form, fill in the name "John Doe" and email "test@example.com", then take a screenshot to confirm.

## FAQ

- **AgentRun sandbox creation fails**: Confirm that `AGENTRUN_ACCOUNT_ID`, `ALIBABA_CLOUD_ACCESS_KEY_ID`, and `ALIBABA_CLOUD_ACCESS_KEY_SECRET` are correctly configured and that the AgentRun service has been enabled in the console.
- **CDP connection timeout**: Sandbox startup takes a few seconds. If the first request times out immediately, increase the client timeout (`timeout=120.0` in `client.py`).
- **VNC preview not working**: Confirm the frontend WebSocket connection URL uses the `/ws/livestream` path. If the URL ends with `/vnc`, replace it with `/ws/livestream`.
- **Page snapshot too large causing model errors**: Snapshots are already capped at 20,000 characters. If still too large, reduce `max_snapshot_chars` in `browser_agent.py`.
- **Agent stuck in loop or exceeds iteration limit**: The default maximum is 50 ReAct iterations. Adjust `max_iters` in `main.py` or break the task into smaller sub-tasks.
- **Session sandbox unexpectedly reclaimed**: The sandbox idle timeout defaults to 600 seconds. After a long period of inactivity, a new sandbox will be automatically created and navigate to the Baidu homepage on the next request.
- **Invalid API Key**: Must be a DashScope general-purpose `sk-` key. See the [official documentation](https://help.aliyun.com/zh/model-studio/).
- **Port conflict**: Default port is **8090**. If it conflicts with another local service, update the port in `main.py` (and `BASE_URL` in `client.py`).

## References

- [AgentScope Documentation](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [AgentRun Console](https://functionai.console.aliyun.com/cn-hangzhou)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Alibaba Cloud DashScope (Bailian)](https://bailian.console.aliyun.com/)
