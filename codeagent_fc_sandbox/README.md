# CodeAgent Sandbox

这是一个把 Claude Code 运行在阿里云 FC Agent Sandbox 中的代码代理原型。每个业务会话对应一个独立 FC 沙箱；Claude 在 `/home/user/workspace` 中创建、修改和运行项目，浏览器负责展示对话、工具过程、文件树、代码和页面预览。

**英文说明**：[README_en.md](README_en.md)。

FC Agent Sandbox 提供 E2B 兼容 API，当前项目只保留这一种运行时，不再兼容旧运行时会话。

## 当前链路

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

核心约束：

- 一个业务会话只绑定一个 FC `sandboxId` 和一个 Claude `agentSessionId`。
- 正常多轮对话复用同一个 Claude Session；后端重启后通过 ACP `session/resume` 恢复原生 Claude 会话。
- 本地事件记录用于界面展示和会话映射，不会拼成提示词回放给新会话。
- 后端短时空闲先释放 SDK/ACP 连接；沙箱仍在有效期内时，FC 可在无请求阶段自动进入透明浅休眠，下一次 connect 或端口流量唤醒后继续恢复原会话。
- 页面应用由 AI 在沙箱内启动并保持根路径 `/`；控制面将 FC 端口映射到每会话独立的 Preview Origin，统一代理页面资源和 HMR WebSocket。

## 目录

```text
src/apps/api/                 Fastify API、会话编排、原生 Claude 恢复
src/apps/web/                 React 前端
packages/core/                业务会话与 sandbox-agent 事件持久化
packages/fc-e2b-provider/     FC E2B SandboxProvider
tools/fc-e2b/                 FC 联通性、恢复和预览验证工具
sandbox_image/                创建沙箱后上传的启动脚本、预览工具和 Claude 指令
data/                         本地业务会话与事件数据，默认不提交 Git
```

## 本地运行

要求：Node.js 22 或更高版本，以及目标地域可用的 FC Agent Sandbox API Key。应用直接使用 FC 内置 `base` 模板，并在创建沙箱后自动安装 `sandbox-agent`、`claude-agent-acp` 和 Claude Code，不要求用户准备 ACR 或模板 ID。

安装依赖。仓库中的 `.npmrc` 已固定 `legacy-peer-deps=true`，用于兼容当前 `@sandbox-agent/react` 的 peer dependency 声明：

```bash
npm ci --registry=https://registry.npmmirror.com
```

复制 `.env.example` 为 `.env.local`，至少填写：

```dotenv
# 最终用户提供
DASHSCOPE_API_KEY=...
DASHSCOPE_MODEL_NAME=qwen3.7-max

# 用户在目标 FC SDX 地域创建
E2B_API_KEY=...
FC_E2B_REGION=cn-beijing
```

OSS 持久化默认关闭。通过计算巢部署时，开启 OSS 后只需选择与 FC Sandbox 同地域的标准存储 Bucket；ROS 会自动创建专用 RAM Role、授予目标 Bucket 读写权限，并生成内网 Endpoint。手工启动时仍需自行配置 `FC_OSS_BUCKET`、`FC_OSS_ENDPOINT` 和 `FC_OSS_ROLE_ARN`。完整的 ECS 与容器部署说明见 [`deploy/README.md`](./deploy/README.md)。

开发模式同时启动 API 和 Vite：

```bash
npm run dev
```

开发界面由 Vite 提供，访问 `http://127.0.0.1:5174/`；Vite 会把 `/api` 和 `/health` 转发到 `http://127.0.0.1:8000`。端口 `8000` 在开发模式下是 API 地址，不保证包含最新前端构建产物。

生产构建与启动：

```bash
npm run build
npm run start
```

完成 `npm run build` 后，Fastify 会从 `src/apps/web/dist` 提供静态前端，此时访问 `http://127.0.0.1:8000/`。健康检查始终为：

```bash
curl http://127.0.0.1:8000/health
```

## 会话恢复

第一次创建业务会话时，后端创建 FC 沙箱，并用 `session/new` 建立 Claude 会话。后续消息直接调用同一个 Session 的 `prompt()`，因此多轮上下文由 Claude 会话维护。

后端重启或 ACP 连接释放后，恢复流程如下：

```text
读取业务 session
  -> 使用 sandboxId 重新连接原 FC 沙箱
  -> 启动或确认 sandbox-agent 可用
  -> 使用 agentSessionId 调用 ACP session/resume
  -> 继续向同一个 Claude 会话发送 prompt
```

如果原沙箱或 Claude 原生会话已经不存在，恢复会明确失败；当前实现不会静默创建新 Claude 会话，也不会用本地历史伪造恢复。

`data/` 必须随控制面一起持久化，否则后端会失去 `sandboxId`、`agentSessionId` 和界面事件索引。沙箱文件系统是否还在，则取决于对应 FC 沙箱是否仍然有效。

## 浅休眠

浅休眠是 FC 在沙箱有效期内根据空闲状态自动完成的透明实例状态切换，不需要控制面调用 E2B `pause()`。控制面只负责在 `FC_RUNTIME_IDLE_MS` 内没有租约后 dispose 本地 SDK/ACP；下一次操作重新 connect 同一 `sandboxId`，再用原 `agentSessionId` 执行 ACP `session/resume`。

`FC_E2B_TIMEOUT_MS` 是 E2B 沙箱有效期，不是浅休眠触发时间。当前没有配置 `lifecycle.onTimeout: pause`；沙箱到期后会终止。启用 OSS 时，控制面可用同一会话前缀创建替代沙箱并恢复文件与 Claude 原生会话；关闭 OSS 时则明确失败。

## 页面预览

AI 需要先在沙箱中启动项目自身的开发服务器，例如 Vite 的 `5173` 端口，然后发布端口：

```bash
codeagent-preview publish \
  --port 5173 \
  --cwd "$PWD" \
  --name "Web Preview" \
  --health-path / \
  --start-command "npm run dev -- --host 0.0.0.0 --port 5173"
```

该命令验证页面，并把端口、项目目录和可复用的前台启动命令写入 `/home/user/.codeagent/preview.json`，但不会在发布当下启动项目，也不代理流量。沙箱被替换且 Preview 进程消失后，后端优先在原项目目录重跑该命令并重新发布；直接恢复失败或旧清单没有命令时，才回退给 Claude 识别项目并恢复。公开端口必须位于 `3000–65535`；发布时还会用外部 Host 头探测服务。Vite 项目需要配置 `server.host: "0.0.0.0"` 和 `server.allowedHosts: true`（当前 Demo 不考虑 Host 安全），其他框架也要允许 FC 动态 Host。后端读取清单，通过 FC `getHost(5173)` 得到上游地址并做健康检查。浏览器统一访问固定端口 `5184`；状态请求用浏览器 ID 和递增序号把当前会话写入 cookie 映射，网关再按 `cookie → sessionId → FC target` 转发页面、绝对资源和 WebSocket，并移除 FC 默认响应中的下载头。不同浏览器可同时预览不同会话，不需要通配域名。应用仍按普通根路径运行，不要配置额外代理前缀。

右侧产物区只在观察到 AI 的真实文件操作后自动展开；创建、写入和删除文件会以逐行动画展示。AI 运行期间持续检查预览，运行结束或手动同步后对未就绪状态最多再重试 45 秒，稳定后停止；关闭预览或切换标签会卸载 iframe，避免 HMR 长连接持续阻止浅休眠。

后端重启后不会主动唤醒所有 Preview。前端下一次状态轮询会重新提交浏览器与当前会话的绑定，并按需读取预览清单、恢复 FC 上游。

当前 Demo 的控制面 API（`8000`）和 Preview Gateway（`5184`）均未实现身份认证或访问控制，并使用公开沙箱端口和无令牌的 `sandbox-agent`。不要将 `8000` 或 `5184` 直接开放到公网；部署时至少应通过安全组或私网限制访问来源，生产环境还必须在前方配置具备身份认证和授权能力的网关或反向代理。

## 沙箱 Runtime 初始化

控制面固定通过 `Sandbox.create("base")` 使用 FC 内置模板。每次获得新沙箱后，Provider 检查 `/home/user/.codeagent-runtime/v2/.ready`；缺失时从控制面镜像上传 `sandbox_image/` 中的三个文件，使用 `registry.npmmirror.com` 安装固定版本的 Claude Code、sandbox-agent 和 Claude ACP，再启动 `sandbox-agent :3001`。连接仍存活的沙箱时标记和二进制均存在，跳过安装。

Runtime 位于沙箱本地盘，不写入 OSS。沙箱被回收后，替代沙箱会重新安装 Runtime；可选 OSS 只恢复 workspace 与 `.claude`。

可用以下命令验证模板、恢复和 FC 上游端口：

```bash
npm run fc:e2b:smoke
npm run fc:e2b:recovery-smoke
npm run fc:e2b:api-restart-smoke
npm run fc:e2b:preview-smoke
```

面向使用者的整体说明见 [架构概览](./ARCHITECTURE.md)，接口说明见 [INTERFACES.md](./INTERFACES.md)。
