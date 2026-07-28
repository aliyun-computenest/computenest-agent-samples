# FC E2B 验证工具

该目录用于验证 FC 内置 `base` 模板的沙箱连接、运行时初始化、Claude 原生恢复和浏览器端口直连。

`.env.local` 只需配置模型凭证、`E2B_API_KEY` 和 `FC_E2B_REGION`。Provider 在新沙箱中通过 npmmirror 安装固定版本的 CodeAgent Runtime，不需要 ACR 或自定义模板 ID。

## 验证命令

基础联通：

```bash
npm run fc:e2b:smoke
```

后端重启与 Claude 原生会话恢复：

```bash
npm run fc:e2b:recovery-smoke
```

完整 API 进程重启恢复（API A 完成第一轮后被 `SIGKILL`，API B 从同一数据目录恢复）：

```bash
npm run fc:e2b:api-restart-smoke
```

该脚本模拟第一个 `AgentSessionManager` 关闭后创建第二个 manager，要求：

- 仍连接同一个 `sandboxId`；
- `agentSessionId` 不变；
- ACP 事件出现 `session/resume`；
- 全程只有一次 `session/new`；
- 第二轮能使用第一轮 Claude 上下文；
- 没有本地历史回放提示词。

脚本会先检查 DashScope Anthropic 网关，密钥无效时会在创建 FC 沙箱前失败。

Vite 根路径与 HMR 直连：

```bash
npm run fc:e2b:preview-smoke
```

该脚本在真实沙箱中安装并启动最小 Vite 项目，通过 `codeagent-preview publish` 写入并校验 Preview manifest，匿名检查 `/`、`/src/main.js`、`/@vite/client`，然后连接该沙箱端口的 HMR WebSocket，并通过修改文件确认收到 update。整个过程不经过 Fastify Preview 代理。

OSS 直挂与沙箱回收恢复：

```bash
npm run fc:e2b:oss-replacement-smoke
```

该脚本使用正式 Provider 和 `AgentSessionManager` 创建沙箱 A，把 `.claude` 与 workspace 写入会话独立 OSS 前缀；随后 kill A，并要求控制面自动创建沙箱 B、挂载同一前缀、使用原 `agentSessionId` 执行 ACP `session/resume`。验收还要求全程只有一次 `session/new`，且只存在于第一轮 Claude 上下文中的随机口令可在 B 中被召回。

所有 smoke 默认在结束时销毁测试沙箱。仅做脚本检查时可显式跳过：

```bash
FC_E2B_SMOKE_SKIP=true npm run fc:e2b:recovery-smoke
FC_E2B_SMOKE_SKIP=true npm run fc:e2b:api-restart-smoke
FC_E2B_SMOKE_SKIP=true npm run fc:e2b:preview-smoke
```
