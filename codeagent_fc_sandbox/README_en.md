# CodeAgent Sandbox

This sample runs Claude Code inside Alibaba Cloud FC Agent Sandbox. Every business conversation owns one FC sandbox. Claude creates, edits, and runs projects in the sandbox workspace, while the React UI displays messages, tool activity, files, code, and live page previews.

**Chinese documentation**: [README.md](README.md).

FC Agent Sandbox exposes an E2B-compatible API. This sample supports only the FC runtime and does not restore sessions created by the legacy AgentRun provider.

## Architecture

```text
React UI
  -> TypeScript Fastify API
  -> sandbox-agent TypeScript SDK
  -> FcE2BSandboxProvider
  -> FC Agent Sandbox
  -> sandbox-agent server :3001
  -> claude-agent-acp
  -> Claude Code
```

The control-plane image contains no FC or model credential. At deployment time, the customer supplies only an FC SDX API key and region in addition to the model credential. The provider uses the built-in `base` template and installs the pinned CodeAgent runtime after creating each new sandbox. OSS persistence is optional.

## Directory Structure

```text
src/apps/api/                 Fastify API, session orchestration, and Claude resume
src/apps/web/                 React frontend
packages/core/                Business-session and SDK-event persistence
packages/fc-e2b-provider/     FC E2B SandboxProvider
tools/fc-e2b/                 FC connectivity, recovery, and preview smoke tests
sandbox_image/                Runtime files uploaded after sandbox creation
tests/                        Unit and integration-style tests
server.sh                     Local process manager
.env.example                 Environment variable reference
```

## Local Development

Requirements: Node.js 22 or newer and access to the configured FC Agent Sandbox deployment.

```bash
npm ci --registry=https://registry.npmmirror.com
cp .env.example .env.local
```

At minimum, configure:

```dotenv
# Provided by the end user
DASHSCOPE_API_KEY=...
DASHSCOPE_MODEL_NAME=qwen3.7-max

# Created by the customer in the target FC SDX region
E2B_API_KEY=...
FC_E2B_REGION=cn-beijing
```

No ACR repository or custom template ID is required. In Compute Nest, enabling OSS only requires selecting a Standard storage bucket in the FC Sandbox region. ROS creates a dedicated RAM role, grants access to that bucket, and derives the internal endpoint. Manual deployments still provide `FC_OSS_BUCKET`, `FC_OSS_ENDPOINT`, and `FC_OSS_ROLE_ARN` themselves.

Start the API and Vite frontend:

```bash
npm run dev
```

Open `http://127.0.0.1:5174/`. For a production build:

```bash
npm run build
npm run start
```

The production UI and API are served at `http://127.0.0.1:8000/`; the health endpoint is `/health`.

## Session and Sandbox Recovery

The first user message creates a native Claude session with ACP `session/new`. Later messages reuse the same session. After an API restart or ACP reconnect, the control plane reconnects to the sandbox and calls ACP `session/resume` with the persisted Claude session ID.

Each session receives an isolated OSS prefix. The prefix is mounted at `/mnt/codeagent-persist`, with the following sibling directories:

```text
/mnt/codeagent-persist/
├── workspace/
└── .claude/
```

If FC has reclaimed the original sandbox, the control plane creates a replacement sandbox with the same OSS prefix, resumes the native Claude session, and restores the page preview when possible. The control-plane `data/` directory must also remain persistent because it stores the mapping between business sessions, sandbox IDs, Claude session IDs, and UI events.

## Page Preview

The AI starts the project server inside the sandbox and publishes it with:

```bash
codeagent-preview publish \
  --port 5173 \
  --cwd "$PWD" \
  --name "Web Preview" \
  --health-path /
```

The command validates the application and writes the preview manifest. The fixed preview gateway on port `5184` maps each browser to its selected business session and proxies HTTP assets and WebSocket upgrades to the corresponding FC sandbox port.

Vite applications must listen on `0.0.0.0` and accept the dynamic FC Host header. Other frameworks need equivalent settings.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

The control-plane API (`8000`) and Preview Gateway (`5184`) in this demo have no authentication or access control, and the sandbox uses public ports with a tokenless sandbox-agent connection. Do not expose `8000` or `5184` directly to the public internet. Restrict access with security groups or a private network, and place an authenticated, authorization-aware gateway or reverse proxy in front of any production deployment.
