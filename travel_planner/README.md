# Travel Planner — 智能旅行助手

基于 [Google ADK](https://github.com/google/adk-python) 的旅行规划示例：启动 `adk web` 后加载 Agent `travel_planner`；配置 `SESSION_REDIS_URL` 时可经 [google-adk-redis](https://pypi.org/project/google-adk-redis/) 持久化会话。

## 这是什么

- 行程规划：结合目的地知识、路线与 POI，生成含餐饮、住宿的每日安排
- 高德地图：查询路线规划、周边 POI、实时交通与天气
- 本地知识：旅行安全提示与小众景点推荐
- Google ADK 官方接口：单端口 **8000**，含内置 Web UI 与 `/run_sse` 流式 API
- 会话持久化：配置 `SESSION_REDIS_URL` 直连 Redis；未配置时使用 ADK 默认内存会话（重启后丢失）
- **计算巢一键开箱部署**：浏览器 Web UI（端口 **8000**）

## 目录结构

```text
travel_planner/
├── travel_planner/
│   ├── __init__.py           # 包标识，暴露 root_agent
│   └── agent.py              # Agent 定义（name="travel_planner"）
├── configs/
│   └── mcp_config.json       # 百炼 amap-maps MCP 配置
├── knowledgebase_docs/       # 旅行知识 Markdown
│   ├── general_safety_guide.md
│   └── tourists_recommend.md
├── services.py               # 注册 Redis Session 后端
├── server.sh                 # 启停脚本（本地 / 容器）
├── requirements.txt          # Python 依赖
├── .env.example              # 环境变量示例
└── .dockerignore             # 打 Docker 镜像时排除 .venv、.env、日志等
```

## 如何使用

### 计算巢部署

通过阿里云计算巢一键部署，无需本地安装环境：

1. **立即部署**：打开 [计算巢 智能旅行助手 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/TravelPlanner?serviceId=service-0682c63593ea443e900c&deployType=ECS&TemplateName=ECS%E7%89%88)，点击「立即部署」。
2. **填写并创建**：填写 `DASHSCOPE_API_KEY` 等参数，并确认已开通百炼 **amap-maps** MCP，点击「立即创建」。
3. **访问实例**：在实例页「应用输出」查看 **WebUI 访问地址**（端口 **8000**）与 **API 调用示例**。

创建完成后，在实例详情页的「应用输出」中可看到：

- **WebUI 访问地址**：浏览器打开 `http://<实例IP>:8000`，选择应用 `travel_planner` 开始规划行程。
- **Code Debug 地址**（容器集群版）：`http://<实例IP>:8080`，用于在线查看与调试源码。
- **API 调用示例**：向 `http://<实例IP>:8000/run_sse` 发起 SSE 请求，`app_name` 为 `travel_planner`，`user_id` 为 `user`（与 ADK Web UI 默认一致）。OpenAPI 文档：`http://<实例IP>:8000/docs`。

**会话（ECS）**：应用层未设置 `SESSION_REDIS_URL` 时使用内存会话；计算巢部署可在环境变量中预填 `SESSION_REDIS_URL=redis://127.0.0.1:6379`（宿主机 Redis）以持久化。

**会话（容器集群）**：须绑定 Session 连接，会话持久化至 Redis。

### 本地运行

**环境要求**

- Python ≥ 3.12（`computenest-agent-integrations` 要求）
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- 已在[百炼 MCP 市场](https://bailian.console.aliyun.com/?tab=app#/mcp-market/detail/amap-maps)开通 **amap-maps**
- 可选 Redis（配置 `SESSION_REDIS_URL` 时持久化会话；未配置则内存会话）

**安装与启动**

```bash
cd travel_planner
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

浏览器打开 http://127.0.0.1:8000 ，选择 `travel_planner` 应用输入旅行需求（如「计划下周去杭州 3 日游」）；或验证服务已就绪：

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# 期望返回 ["travel_planner"]
```

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
- [百炼 amap-maps MCP](https://bailian.console.aliyun.com/?tab=app#/mcp-market/detail/amap-maps)
