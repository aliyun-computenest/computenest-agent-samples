# FC 沙箱 Runtime 文件

该目录保存控制面创建新沙箱后上传的 Runtime 文件：

```text
bin/start_sandbox_agent.sh   配置环境并启动 sandbox-agent :3001
bin/codeagent_preview.py     验证并发布 AI 启动的页面端口
config/CLAUDE.md             注入沙箱中 Claude Code 的全局工作约定
```

计算巢控制面 Docker 镜像会将整个目录复制到 `/app/sandbox_image`。Provider 使用 FC 内置 `base` 模板创建沙箱，上传这些文件并安装固定版本的 Claude Code、sandbox-agent 与 Claude ACP。

## sandbox-agent 启动

Provider 安装 Runtime 后执行：

```bash
SANDBOX_AGENT_PORT=3001 /usr/local/bin/start-sandbox-agent
```

脚本会：

1. 校验可选的 FC OSS 挂载，并创建 workspace、Claude 配置目录和本地缓存目录。
2. 仅在不存在时复制全局 `CLAUDE.md`；不会覆盖已有配置、Skill、session 或项目文件。
3. 通过运行时环境传入 DashScope Anthropic 认证和模型映射，不把 token 写入持久化 `settings.json`。
4. 以普通用户运行无 token 的 `sandbox-agent server`。

无 token 仅用于当前 Demo；生产环境必须重新设计访问控制。

### 使用 OSS 持久目录

Provider 挂载 OSS 后，应同时传入以下环境变量：

```bash
export FC_OSS_MOUNT_DIR=/mnt/codeagent-persist
export CLAUDE_CONFIG_DIR=/mnt/codeagent-persist/.claude
export WORKSPACE=/mnt/codeagent-persist/workspace
```

`FC_OSS_MOUNT_DIR` 非空时，脚本会先等待挂载就绪（默认最多 30 秒），并严格检查：

- `FC_OSS_MOUNT_DIR` 本身必须是 `/proc/self/mountinfo` 可见的独立挂载点；普通本地目录不算。
- `CLAUDE_CONFIG_DIR` 和 `WORKSPACE` 必须是该挂载点下的独立子目录。
- `CODEAGENT_STATE_ROOT`、`AGENT_TMP` 和 `CODEAGENT_CACHE_ROOT` 必须留在沙箱本地盘。

任何检查失败都会直接终止启动，防止 OSS 未挂载时把新会话写入同名的本地空目录。首次启动只会补齐缺失目录和缺失的 `CLAUDE.md`；已有 `.claude/settings.json`、Skills、Claude session JSONL 以及 workspace 内容均保持原样。

依赖缓存默认放在易失的 `/tmp/codeagent-cache`，并通过 `XDG_CACHE_HOME`、`NPM_CONFIG_CACHE`、`npm_config_store_dir`、`YARN_CACHE_FOLDER`、`COREPACK_HOME` 和 `PIP_CACHE_DIR` 传给 agent 进程，避免 npm/pnpm 等大量小文件落到 OSS。可用 `CODEAGENT_CACHE_ROOT` 改成本地其他路径。挂载较慢时可用 `FC_OSS_MOUNT_WAIT_SECONDS` 调整等待秒数。

不设置 `FC_OSS_MOUNT_DIR` 时保持原有本地目录行为，`CLAUDE_CONFIG_DIR` 默认仍为 `/home/user/.claude`，`WORKSPACE` 默认仍为 `/home/user/workspace`。

## 页面发布

页面服务由 Claude 在项目目录中直接启动，例如：

```bash
npm run dev -- --host 0.0.0.0 --port 5173
codeagent-preview publish \
  --port 5173 \
  --cwd "$PWD" \
  --name "Web Preview" \
  --start-command "npm run dev -- --host 0.0.0.0 --port 5173"
```

公开端口必须位于 `3000–65535`。Vite 还需要配置 `server.allowedHosts: true`（Demo）；其他带 Host allowlist 的开发服务器需要做等价配置。

`codeagent-preview` 会检查本机 TCP 端口、HTTP health path 和外部 Host 请求，成功后把准确启动命令一并写入：

```text
/home/user/.codeagent/preview.json
```

它只发布 `targetPort`、`healthPath` 和项目目录等元数据，不运行反向代理。控制面通过 FC E2B `getHost(targetPort)` 获得上游地址，再用每会话独立 Preview Origin 代理根路径 HTTP 与 WebSocket。项目始终运行在根路径 `/`，不需要业务路径前缀。

辅助命令：

```bash
codeagent-preview status
codeagent-preview clear
```
