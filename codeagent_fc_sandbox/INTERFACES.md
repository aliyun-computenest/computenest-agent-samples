# CodeAgent FC Sandbox 接口说明

本文描述当前 FC-only 版本的 HTTP API、运行时接口、持久化模型和沙箱内约定。示例中的业务会话 ID 为 `sess_abc123`。

## 1. HTTP API

默认控制面地址为 `http://127.0.0.1:8000`。除文件内容读取外，JSON 接口统一返回 `application/json`。

### `GET /health`

返回控制面和 FC 配置摘要，不返回密钥。

```json
{
  "status": "ok",
  "stack": "typescript",
  "provider": "fc-e2b",
  "template": "base",
  "region": "cn-beijing",
  "apiUrl": "https://api.cn-beijing.e2b.fc.aliyuncs.com"
}
```

### `GET /api/sessions`

列出未删除的 FC 业务会话。旧运行时记录不会返回。

### `POST /api/sessions`

创建业务会话，并在后台准备 FC 沙箱与 Claude 会话。

请求：

```json
{
  "userId": "user-1",
  "projectId": "project-1",
  "title": "我的页面"
}
```

`userId` 和 `projectId` 可省略。成功返回 `202` 和刚创建的业务记录；此时状态通常为 `creating`。

### `GET /api/sessions/:sessionId`

返回单个业务会话。不存在、已删除或非 FC 记录返回 `404`。

业务会话结构：

```ts
interface BusinessSession {
  id: string;
  runtimeProvider: "fc-e2b";
  userId: string;
  projectId: string;
  title: string;
  status: "creating" | "ready" | "running" | "failed" | "terminated" | "deleted";
  sandboxId?: string;
  sandboxProviderId?: string;
  agentSessionId?: string;
  templateName: string;
  workspaceRoot: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

### `POST /api/sessions/:sessionId/messages`

向现有 Claude 会话发送一条用户消息。

```json
{ "content": "创建一个 React 页面并启动预览" }
```

成功入队返回 `202 { "ok": true }`。同一会话已有 prompt 运行时会拒绝并发消息。prompt 完成后状态变为 `ready`，失败则变为 `failed` 并记录 `error`。

### `GET /api/sessions/:sessionId/events`

返回 Server-Sent Events 流。可通过查询参数 `offset` 或请求头 `Last-Event-ID` 从指定 `eventIndex` 后继续读取。

```text
id: 42
data: {"id":"...","eventIndex":42,"sessionId":"sess_abc123",...}
```

服务端每 15 秒发送一次注释心跳。建立连接后先补发本地尚未消费的事件，再订阅实时事件。

事件结构：

```ts
interface SessionEvent {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: "client" | "agent";
  payload: Record<string, unknown>;
}
```

### `GET /api/sessions/:sessionId/files?path=<relativePath>`

列出工作区目录。空路径表示 `/home/user/workspace`。

```ts
interface FsEntry {
  entryType: "file" | "directory";
  name: string;
  path: string;
  size: number;
  modified?: string | null;
}
```

### `GET /api/sessions/:sessionId/files/content?path=<relativePath>`

读取文本文件并返回 `text/plain; charset=utf-8`。

### `PUT /api/sessions/:sessionId/files/content?path=<relativePath>`

把请求体写入文件。绝对路径必须位于配置的工作目录内，相对路径会基于工作目录解析；逃逸路径会被拒绝。

### `GET /api/sessions/:sessionId/workspace/snapshot`

扫描最多 2000 个工作区文件，跳过 `.git`、依赖和构建目录。

```ts
interface WorkspaceSnapshotEntry {
  path: string;
  size: number;
  modified: string;
}
```

### `GET /api/sessions/:sessionId/preview/status`

读取沙箱内 `/home/user/.codeagent/preview.json`，解析目标端口，通过 FC `getHost(port)` 生成上游 Origin，检查 health path，并注册每会话 Preview 网关路由。

```ts
interface PreviewStatus {
  status: "none" | "starting" | "ready" | "unavailable";
  origin?: string;
  port?: number;
  projectRoot?: string;
  updatedAt?: string;
}
```

`origin` 是浏览器可打开的固定 Preview Origin，例如 `http://127.0.0.1:5184`。状态请求同时提交浏览器 ID 和递增选择序号；网关用同主机 cookie 找到该浏览器当前选择的业务会话。该 Origin 下的 `/`、静态资源和 WebSocket 会按原路径转发到对应 FC 上游端口。

### `POST /api/sessions/:sessionId/preview/start`

固定返回 `410`。控制面不会替 AI 启动项目；AI 必须在沙箱中启动 Web 服务并运行 `codeagent-preview publish`。

### `DELETE /api/sessions/:sessionId`

释放本地运行时连接，销毁对应 FC 沙箱，并把业务状态标记为 `deleted`。

## 2. 前端 API 封装

`src/apps/web/src/lib/api.ts` 提供：

```ts
api.health()
api.listSessions()
api.createSession(title?)
api.getSession(sessionId)
api.sendMessage(sessionId, content)
api.deleteSession(sessionId)
api.listFiles(sessionId, path?)
api.readFile(sessionId, path)
api.writeFile(sessionId, path, content)
api.workspaceSnapshot(sessionId)
api.previewStatus(sessionId)
```

SSE 在前端会话层单独建立，不通过 `requestJson` 封装。

## 3. FC E2B Provider

实现位置：`packages/fc-e2b-provider/src/provider.ts`。

```ts
class FcE2BSandboxProvider implements SandboxProvider {
  readonly name = "fc-e2b";
  readonly defaultCwd: string;

  create(): Promise<string>;
  connect(sandboxId: string): Promise<FcE2BSandboxHandle>;
  ensureServer(sandboxId: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  getUrl(sandboxId: string): Promise<string>;
  getPortUrl(sandboxId: string, port: number): Promise<string>;
}
```

创建参数中的关键约定：

- `secure: false`：Demo 的 iframe 和 HMR 无法附加 E2B 访问 token。
- `network.allowPublicTraffic: true`：允许控制面的 Preview 网关访问应用端口。
- `timeoutMs`：E2B 沙箱有效期；当前不设置 `lifecycle.onTimeout: pause`，到期后沙箱终止。
- 浅休眠：由 FC 在有效期内根据空闲状态透明完成，不是 E2B lifecycle timeout。
- 深休眠：`pause + keepMemory` 会保存内存快照，当前阶段不启用。
- `envs`：注入工作目录、状态目录和 Claude 模型变量。

Provider 的标准 URL 指向 `FC_E2B_AGENT_PORT`，默认 `3001`。应用 Preview 则用 `getPortUrl(sandboxId, targetPort)` 获取独立端口地址。

## 4. 会话编排接口

实现位置：`src/apps/api/src/services/agent-session-manager.ts`。

主要方法：

```ts
prepare(sessionId): Promise<BusinessSession>
sendMessage(sessionId, text): Promise<void>
listEvents(sessionId, afterIndex): Promise<SessionEvent[]>
subscribeEvents(sessionId, listener): () => void
listFiles(sessionId, relativePath?): Promise<FsEntry[]>
readFile(sessionId, relativePath): Promise<Uint8Array>
writeFile(sessionId, relativePath, body): Promise<unknown>
workspaceSnapshot(sessionId): Promise<WorkspaceSnapshotEntry[]>
getPreviewStatus(sessionId): Promise<PreviewStatus>
deleteSession(sessionId): Promise<BusinessSession>
recoverTransportFailure(error): Promise<void>
close(): Promise<void>
```

文件、Preview 与 prompt 都先获取运行时租约。最后一个租约释放后，管理器等待 `FC_RUNTIME_IDLE_MS`，然后只 dispose 本地 SDK 连接。沙箱仍在有效期内时，FC 可以透明进入浅休眠；下一次 connect 或端口流量唤醒实例，管理器再用同一 `agentSessionId` 原生恢复。

## 5. Claude 原生恢复接口

实现位置：`src/apps/api/src/services/native-claude-session.ts`。

```ts
resumeOrCreateNativeClaudeSession({
  sdk,
  persist,
  id,
  agentSessionId,
  cwd,
  mode,
  model,
}): Promise<Session>
```

行为分为两种：

- 没有持久化记录且没有 `agentSessionId`：调用 `sdk.createSession()`，在 ACP 层对应 `session/new`。
- 已有业务或持久化的 `agentSessionId`：绑定新 ACP connection，调用 `unstableResumeSession()`，在协议层对应 `session/resume`。

恢复前会验证业务记录与 SDK 记录的 ID、agent 类型和 `agentSessionId` 一致性。恢复失败抛出 `NativeClaudeSessionResumeError`，不允许回退到新建会话或本地历史回放。

由于 sandbox-agent 0.4.0 尚未公开所需的原生恢复入口，当前实现对私有的 `getLiveConnection`、`bindSession` 和 `upsertSessionHandle` 做了集中运行时检查。

## 6. 持久化接口

### 6.1 业务存储

`BusinessSessionStore` 默认写入：

```text
<CODEAGENT_DATA_DIR>/business-sessions/<sessionId>.json
```

它保存 FC 与 Claude 标识映射。文件名会移除不安全字符，但内容中的 `id` 保持原值。

### 6.2 SDK Session 与事件

`FileSessionPersistDriver` 使用同一个 `CODEAGENT_DATA_DIR` 保存 sandbox-agent Session 记录和事件。SDK SessionRecord 在单进程内按会话串行写入，并通过随机独占临时文件原子替换；事件用于 SSE 重连和 UI 重建，但不会重新注入 Claude prompt。

当前存储实现没有跨进程锁，只支持单个控制面写入者。

## 7. 沙箱内接口

### 7.1 sandbox-agent

镜像入口执行：

```bash
sandbox-agent server --no-token --host 0.0.0.0 --port 3001
```

Provider 用 `/v1/health` 检查服务可用性。启动脚本会配置 Claude/DashScope 环境、用户目录、工作区和全局 `CLAUDE.md`。

### 7.2 `codeagent-preview`

```bash
codeagent-preview publish \
  --port <3000-65535> \
  --cwd <项目目录> \
  --name <显示名称> \
  --health-path <HTTP 路径>

codeagent-preview status
codeagent-preview clear
```

`publish` 先检查 `127.0.0.1:<port>`、health path 和外部 Host 头兼容性，成功后原子写入：

```text
${CODEAGENT_STATE_ROOT:-/home/user/.codeagent}/preview.json
```

工具只发布元数据，不监听端口、不转发流量。控制面读取元数据后，把页面请求和 HMR WebSocket 通过每会话独立 Preview Origin 转发到 FC 端口。

Vite 项目必须设置 `server.host: "0.0.0.0"` 与 `server.allowedHosts: true`（Demo 配置）；其他带 Host allowlist 的框架需要做等价配置。

## 8. 环境变量

### 控制面与 FC

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Fastify 监听地址 |
| `PORT` | `8000` | Fastify 端口 |
| `CODEAGENT_DATA_DIR` | `<项目>/data` | 本地业务与事件存储 |
| `PREVIEW_SCHEME` | `http` | Preview Gateway 对外协议 |
| `PREVIEW_GATEWAY_PORT` | `5184` | Preview Gateway 端口 |
| `E2B_API_KEY` | 无 | 用户在目标 FC SDX 地域创建的 API Key，必填 |
| `FC_E2B_REGION` | `cn-beijing` | FC SDX 地域；当前支持北京、上海、杭州、深圳，控制面据此生成 E2B API URL 和 Domain |
| `FC_RUNTIME_ASSETS_DIR` | `<项目>/sandbox_image` | 控制面上传到新沙箱的 Runtime 文件目录 |
| `FC_E2B_AGENT_PORT` | `3001` | 沙箱内 sandbox-agent 端口 |
| `FC_E2B_TIMEOUT_MS` | `1800000` | E2B 沙箱有效期 |
| `FC_E2B_REQUEST_TIMEOUT_MS` | `120000` | FC 控制面请求超时 |
| `FC_RUNTIME_IDLE_MS` | `600000` | 本地 SDK/ACP 空闲连接保留时间 |

容器镜像不包含 E2B API Key。计算巢专用模板把客户输入作为运行时环境变量传入；Provider 使用内置 `base` 模板。

### Claude

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 无 | 计算巢最终用户提供的模型凭证，必填 |
| `DASHSCOPE_MODEL_NAME` | `qwen3.7-max` | 计算巢最终用户选择的模型名称 |
| `BAILIAN_BASE_URL` | `https://dashscope.aliyuncs.com/apps/anthropic` | 百炼 Claude Code 兼容接口；Provider 会在沙箱内转换为 `ANTHROPIC_BASE_URL` |

Claude 会话模式固定为 `bypassPermissions`，ACP 模型档位固定为 `default`。

### Runtime 初始化

创建或重连沙箱时，Provider 检查本地 Runtime 标记。标记缺失时上传 `start_sandbox_agent.sh`、`codeagent_preview.py` 和 `CLAUDE.md`，再安装固定版本的 Claude Code、sandbox-agent 与 Claude ACP。Runtime 不写入 OSS；沙箱被回收后会在替代沙箱中重新安装。

### OSS 持久化

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FC_OSS_PERSISTENCE_ENABLED` | `false` | 是否启用 FC 实例级动态 OSS 挂载 |
| `FC_OSS_BUCKET` | 无 | 启用时必填 |
| `FC_OSS_ENDPOINT` | 无 | 启用时必填，建议使用目标地域内网 Endpoint |
| `FC_OSS_ROLE_ARN` | 无 | 启用时必填，FC 用于访问 OSS 的 RAM Role |
| `FC_OSS_ROOT_PREFIX` | `/codeagent/v2` | 多租户会话隔离根前缀 |

## 9. 错误与恢复语义

- FC 或 ACP 传输失败时，控制面清除对应内存句柄并把正在执行的会话标记为 `failed`。
- 下一次调用会依据持久化 ID 重新连接和原生 resume。
- 已删除会话不能再次准备或发送消息。
- 原沙箱或 Claude 会话不存在时不自动创建替代品。
- Preview 清单不存在返回 `none`；端口无效或健康检查失败返回 `unavailable`。
