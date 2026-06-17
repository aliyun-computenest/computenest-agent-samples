# Stock Analyst — 股票智能分析助手

基于 [Google ADK](https://github.com/google/adk-python) 的股票分析示例：百炼 WebSearch MCP + Deep Research 系统提示词。输出仅供参考，**非持牌证券投资咨询**。

## 这是什么

- 多轮联网检索：围绕标的行情、走势讨论、风险信息分步搜索
- 结构化报告：数据分析、多情景走势研判、参考性投资建议（含免责）
- Google ADK 官方接口：单端口 **8000**，含内置 Web UI 与 `/run_sse` 流式 API
- 会话持久化：配置 `SESSION_REDIS_URL` 直连 Redis；未配置时使用 ADK 默认内存会话
- **计算巢一键开箱部署**：浏览器 Web UI（端口 **8000**）

## 目录结构

```text
stock_analyst/
├── stock_analyst/
│   ├── __init__.py           # 包标识，暴露 root_agent
│   └── agent.py              # Agent 定义（name="stock_analyst"）
├── configs/
│   └── mcp_config.json       # 百炼 WebSearch MCP 配置
├── services.py               # 注册 Redis Session 后端
├── server.sh                 # 启停脚本（本地 / 容器）
├── requirements.txt          # Python 依赖
├── .env.example              # 环境变量示例
└── .dockerignore             # 打 Docker 镜像时排除 .venv、.env、日志等
```

## 如何使用

### 计算巢部署

通过阿里云计算巢一键部署，无需本地安装环境：

1. **立即部署**：打开 [计算巢 股票智能分析助手 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/StockAnalyst?serviceId=service-0682c63593ea443e900c&deployType=ECS&TemplateName=ECS%E7%89%88)，点击「立即部署」。
2. **填写并创建**：填写 `DASHSCOPE_API_KEY` 等参数，点击「立即创建」。
3. **访问实例**：在实例页「应用输出」查看 **WebUI 访问地址**（端口 **8000**）与 **API 调用示例**。

创建完成后，在实例详情页的「应用输出」中可看到：

- **WebUI 访问地址**：浏览器打开 `http://<实例IP>:8000`，选择应用 `stock_analyst` 开始分析。
- **Code Debug 地址**（容器集群版）：`http://<实例IP>:8080`，用于在线查看与调试源码。
- **API 调用示例**：向 `http://<实例IP>:8000/run_sse` 发起 SSE 请求，`app_name` 为 `stock_analyst`，`user_id` 为 `user`。OpenAPI 文档：`http://<实例IP>:8000/docs`。

**会话（ECS）**：应用层未设置 `SESSION_REDIS_URL` 时使用内存会话；计算巢部署可在环境变量中预填 `SESSION_REDIS_URL=redis://127.0.0.1:6379` 以持久化。

**会话（容器集群）**：须绑定 Session 连接，会话持久化至 Redis。

### 本地运行

**环境要求**

- Python ≥ 3.12（`computenest-agent-integrations` 要求）
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- 可选 Redis（配置 `SESSION_REDIS_URL` 时持久化会话；未配置则内存会话）

**安装与启动**

```bash
cd stock_analyst
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 编辑 .env：DASHSCOPE_API_KEY；可选 SESSION_REDIS_URL

chmod +x server.sh
./server.sh start
```

- 服务 / Web UI：http://127.0.0.1:8000
- API 文档：http://127.0.0.1:8000/docs

**本地测试对话**

浏览器打开 http://127.0.0.1:8000 ，选择 `stock_analyst` 应用输入分析需求；或验证服务已就绪：

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# 期望返回 ["stock_analyst"]
```

**示例提问**

- 请先检索阿里巴巴（9988.HK / BABA）最近一周公开行情与新闻，再输出数据分析、走势预测与投资参考（含风险与免责）

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 百炼 API Key | 必填 |
| `DASHSCOPE_MODEL_NAME` | 对话模型 | `qwen3.7-max` |
| `SESSION_REDIS_URL` | Redis 地址；未设置时使用内存会话 | 无（内存） |
| `PORT` | HTTP 监听 | `8000` |
| `LOG_LEVEL` | 日志级别 | `INFO` |

复制并按需修改：

```bash
cp .env.example .env
```

## 参考

- [Google ADK Python](https://github.com/google/adk-python)
- [google-adk-redis](https://pypi.org/project/google-adk-redis/)
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
