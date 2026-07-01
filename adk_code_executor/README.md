# ADK Code Executor — 代码执行智能体

基于 [Google ADK](https://github.com/google/adk-python) 的代码编写与执行示例，支持 **E2B** 与 **AgentRun** 双沙箱后端。接收自然语言需求，在隔离的沙箱中自主编写并运行代码，支持持久化执行上下文管理。

## 这是什么

- **双沙箱后端**：根据环境变量自动选择后端——`E2B_API_KEY` 存在时使用 E2B（ACSSandbox 私有化部署），`AGENTRUN_ACCOUNT_ID` 存在时使用 AgentRun（阿里云公有云沙箱服务）
- **隔离沙箱执行**：每次对话在独立沙箱中运行，互不干扰，执行结果安全隔离
- **多语言支持**：支持 Python / JavaScript 代码执行，可通过 shell 命令安装任意依赖
- **持久化上下文**：创建执行上下文后，多次工具调用间可保持变量与 import
- **完整文件系统**：支持沙箱内文件读写与目录管理
- Google ADK 官方接口：单端口 **8000**，含内置 Web UI 与 `/run_sse` 流式 API
- 会话持久化：配置 `SESSION_REDIS_URL` 直连 Redis；未配置时使用 ADK 默认内存会话
- **计算巢一键开箱部署**：浏览器 Web UI（端口 **8000**）

## 目录结构

```text
adk_code_executor/
├── __init__.py                  # sqlite3 兼容性处理
├── agent.py                     # Agent 定义（root_agent，使用沙箱工厂自动选后端）
├── main.py                      # CLI 测试入口（本地调试用）
├── tools/
│   ├── __init__.py              # 工具包
│   └── sandbox_factory.py       # 沙箱工厂（根据 TLS_CERT 选择 E2B 或 AgentRun）
├── server.sh                    # 启停脚本（本地 / 容器）
├── requirements.txt             # Python 依赖
├── .env.example                 # 环境变量示例
└── .dockerignore                # 打 Docker 镜像时排除 .venv、.env、日志等
```

## 如何使用

### 计算巢部署

通过阿里云计算巢一键部署，无需本地安装环境：

1. **立即部署**：打开 [计算巢 代码执行智能体 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/AdjCodeExecutor?serviceId=service-0682c63593ea443e900c&deployType=ECS&TemplateName=ECS%E7%89%88)，点击「立即部署」。
2. **填写并创建**：根据沙箱后端选择填写参数（E2B 模式填写 `E2B_API_KEY`；AgentRun 模式填写 `ALIBABA_CLOUD_ACCESS_KEY_ID` 等），点击「立即创建」。
3. **访问实例**：在实例页「应用输出」查看 **WebUI 访问地址**（端口 **8000**）与 **API 调用示例**。

创建完成后，在实例详情页的「应用输出」中可看到：

- **WebUI 访问地址**：浏览器打开 `http://<实例IP>:8000`，选择应用 `adk_code_executor` 开始使用。
- **Code Debug 地址**（容器集群版）：`http://<实例IP>:8080`，用于在线查看与调试源码。
- **API 调用示例**：向 `http://<实例IP>:8000/run_sse` 发起 SSE 请求，`app_name` 为 `adk_code_executor`，`user_id` 为 `user`。OpenAPI 文档：`http://<实例IP>:8000/docs`。

**会话（ECS）**：应用层未设置 `SESSION_REDIS_URL` 时使用内存会话；计算巢部署可在环境变量中预填 `SESSION_REDIS_URL=redis://127.0.0.1:6379` 以持久化。

**会话（容器集群）**：须绑定 Session 连接，会话持久化至 Redis。

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
cd adk_code_executor
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

浏览器打开 http://127.0.0.1:8000 ，选择 `adk_code_executor` 应用输入代码需求；或验证服务已就绪：

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# 期望返回 ["adk_code_executor"]
```

**示例提问**

- 请帮我用 Python 写一个计算前 20 个斐波那契数列的函数，在沙箱中执行并返回结果
- 请在沙箱里安装 pandas，读取一个示例 CSV 并输出前 5 行统计信息
- 帮我写一个快速排序算法，用随机数组测试并输出排序前后对比

## 沙箱后端

| 后端 | 触发条件 | 所需凭证 |
|------|---------|----------|
| **E2B**（ACSSandbox） | `E2B_API_KEY` 环境变量非空 | `E2B_API_KEY`、`E2B_DOMAIN` |
| **AgentRun** | `AGENTRUN_ACCOUNT_ID` 环境变量非空 | `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`AGENTRUN_REGION`、`AGENTRUN_ACCOUNT_ID` |

切换逻辑位于 `tools/sandbox_factory.py`，对 `agent.py` 透明。

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 百炼 API Key | 必填 |
| `DASHSCOPE_MODEL_NAME` | 对话模型 | `qwen3-plus` |
| `TEMPLATE_NAME` | 沙箱模板名称（E2B / AgentRun 共用） | `code-interpreter` |
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
- [E2B Code Interpreter](https://e2b.dev/docs/code-interpreter)
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
