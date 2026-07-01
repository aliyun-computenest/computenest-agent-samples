# ADK Browser Use — 浏览器自动化智能体

基于 [Google ADK](https://github.com/google/adk-python) 的浏览器自动化示例，支持 **E2B** 与 **AgentRun** 双沙箱后端。接收自然语言指令，在隔离的浏览器沙箱中自主执行网页导航、表单填写、信息提取等操作。

## 这是什么

- **双沙箱后端**：根据环境变量自动选择后端——`E2B_API_KEY` 存在时使用 E2B（ACSSandbox 私有化部署），`AGENTRUN_ACCOUNT_ID` 存在时使用 AgentRun（阿里云公有云沙箱服务）
- **隔离浏览器沙箱**：每次对话在独立的浏览器沙箱中运行，互不干扰，操作安全隔离
- **完整浏览器能力**：支持页面导航、元素点击、表单填写、截图、JavaScript 执行等
- **Playwright 驱动**：通过 CDP 协议连接沙箱中的 Chrome 实例，使用 Playwright 进行浏览器自动化
- Google ADK 官方接口：单端口 **8000**，含内置 Web UI 与 `/run_sse` 流式 API
- 会话持久化：配置 `SESSION_REDIS_URL` 直连 Redis；未配置时使用 ADK 默认内存会话
- **计算巢一键开箱部署**：浏览器 Web UI（端口 **8000**）

## 目录结构

```text
adk_browser_use/
├── __init__.py                  # sqlite3 兼容性处理
├── browser_use/
│   ├── __init__.py              # 包初始化（暴露 root_agent）
│   └── agent.py                 # Agent 定义（root_agent，使用沙箱工厂自动选后端）
├── services.py                  # Redis 会话服务注册
├── server.sh                    # 启停脚本（本地 / 容器）
├── requirements.txt             # Python 依赖
├── .env.example                 # 环境变量示例
└── .dockerignore                # 打 Docker 镜像时排除 .venv、.env、日志等
```

## 如何使用

### 计算巢部署

通过阿里云计算巢一键部署，无需本地安装环境：

1. **立即部署**：打开计算巢部署页，点击「立即部署」。
2. **填写并创建**：根据沙箱后端选择填写参数（E2B 模式填写 `E2B_API_KEY`；AgentRun 模式填写 `ALIBABA_CLOUD_ACCESS_KEY_ID` 等），点击「立即创建」。
3. **访问实例**：在实例页「应用输出」查看 **WebUI 访问地址**（端口 **8000**）与 **API 调用示例**。

### 本地运行

**环境要求**

- Python ≥ 3.12
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- 沙箱凭证（二选一）：
  - **E2B 模式**：[E2B API Key](https://e2b.dev/docs)，并设置 `TLS_CERT`
  - **AgentRun 模式**：阿里云 Access Key + `AGENTRUN_REGION` + `AGENTRUN_ACCOUNT_ID`
- 可选 Redis（配置 `SESSION_REDIS_URL` 时持久化会话；未配置则内存会话）

**安装与启动**

```bash
cd adk_browser_use
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 编辑 .env：填写 DASHSCOPE_API_KEY 以及所选沙箱后端的凭证

chmod +x server.sh
./server.sh start
```

- 服务 / Web UI：http://127.0.0.1:8000
- API 文档：http://127.0.0.1:8000/docs

**本地测试对话**

浏览器打开 http://127.0.0.1:8000 ，选择 `adk_browser_use` 应用输入浏览器操作需求；或验证服务已就绪：

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# 期望返回 ["adk_browser_use"]
```

**示例提问**

- 请帮我打开百度，搜索「AgentScope」，告诉我前三条搜索结果的标题和链接
- 请访问 GitHub，搜索 agentscope 仓库，找到 Star 数最多的那个，截图给我看
- 打开天气网站，查询北京今天的天气，把结果整理成表格
- 帮我访问指定网页，找到联系表单，填写姓名「张三」和邮箱「test@example.com」

## 沙箱后端

| 后端 | 触发条件 | 所需凭证 |
|------|---------|----------|
| **E2B**（ACSSandbox） | `E2B_API_KEY` 环境变量非空 | `E2B_API_KEY`、`E2B_DOMAIN`、`TLS_CERT` |
| **AgentRun** | `AGENTRUN_ACCOUNT_ID` 环境变量非空 | `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`AGENTRUN_REGION`、`AGENTRUN_ACCOUNT_ID` |

切换逻辑位于 `computenest-agent-integrations` 的 `sandbox_factory`，对 `agent.py` 透明。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 百炼 API Key | 必填 |
| `DASHSCOPE_MODEL_NAME` | 对话模型 | `qwen3-plus` |
| `TEMPLATE_NAME` | 沙箱模板名称（E2B / AgentRun 共用） | `browser` |
| `TLS_CERT` | ACSSandbox TLS 证书（E2B 模式下容器入口脚本自动安装） | 无 |
| `E2B_API_KEY` | E2B 沙箱 API Key（仅 E2B 模式必填） | 无 |
| `E2B_DOMAIN` | E2B 私有部署域名（仅 E2B 模式） | `agent-vpc.infra` |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 阿里云 AK（AgentRun 模式必填） | 无 |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 阿里云 SK（AgentRun 模式必填） | 无 |
| `AGENTRUN_REGION` | AgentRun 服务地域（AgentRun 模式必填） | 无 |
| `AGENTRUN_ACCOUNT_ID` | 阿里云账号 ID（AgentRun 模式必填） | 无 |
| `SESSION_REDIS_URL` | Redis 地址；未设置时使用内存会话 | 无（内存） |
| `PORT` | HTTP 监听端口 | `8000` |

复制并按需修改：

```bash
cp .env.example .env
```

## 参考

- [Google ADK Python](https://github.com/google/adk-python)
- [AgentRun Python SDK](https://github.com/Serverless-Devs/agentrun-sdk-python)
- [E2B Sandbox](https://e2b.dev/docs)
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
- [Playwright](https://playwright.dev/)
