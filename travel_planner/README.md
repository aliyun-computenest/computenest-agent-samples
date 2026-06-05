# 智能旅行助手

基于 [AgentScope Agent Service](https://docs.agentscope.io/v2/deploy/agent-service.md) 的旅行规划示例：高德地图 MCP + 本地旅行知识 + 多轮对话。

## 这是什么

- 行程规划：结合目的地知识、路线与 POI，生成含餐饮、住宿的每日安排
- 高德 MCP：路线、周边搜索、实时交通等地理信息
- 本地知识：`knowledgebase_docs/` 中的旅行安全与小众景点推荐
- **计算巢一键开箱部署**：浏览器 Web UI（端口 5173）

## 目录结构

```text
travel_planner/
├── main.py                 # 服务入口
├── client.py               # 本地测试：创建 Session + 流式对话
├── server.sh               # Agent 启停
├── requirements.txt
├── .env.example
├── configs/mcp_config.json # 高德 MCP（百炼 amap-maps）
├── knowledgebase_docs/     # 旅行知识 Markdown
│   ├── general_safety_guide.md
│   └── tourists_recommend.md
└── tools/
    ├── mcp_helpers.py
    └── prompts.py
```

## 如何使用

### 计算巢部署

通过阿里云计算巢一键部署，无需本地安装环境：

1. **立即部署**：打开 [计算巢 智能旅行助手 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/TravelPlanner?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
2. **填写并创建**：填写 `DASHSCOPE_API_KEY` 等参数，点击「立即创建」。
3. **访问实例**：在实例页「应用输出」查看 **WebUI 访问地址**（端口 **5173**）与 **API 调用示例**（`POST /chat/`）。

创建完成后，在实例详情页「应用输出」中可看到：

- **WebUI 访问地址**：浏览器打开 `http://<实例IP>:5173`，Username 使用 `demo_user`。
- **API 调用示例**：向 `http://<实例IP>:8090/chat/` 发消息，请求头 `X-User-ID: demo_user`，body 需 `agent_id=travel_planner` 与 `session_id`（可在 Web UI 查看，或 `POST /sessions/` 创建）。OpenAPI：`http://<实例IP>:8090/docs`。

**Redis（ECS）**：使用环境变量中的 `SESSION_REDIS_URL`；未配置时使用默认 `redis://127.0.0.1:6379/0`。

**Redis（容器集群）**：必须在环境变量中配置 `SESSION_REDIS_URL`。

### 本地运行

**环境要求**

- Python ≥ 3.11
- [DashScope API Key](https://help.aliyun.com/zh/model-studio/)
- Redis（须配置 `SESSION_REDIS_URL`）
- 已在[百炼 MCP 市场](https://bailian.console.aliyun.com/?tab=app#/mcp-market/detail/amap-maps)开通 **amap-maps**

**安装与启动**

```bash
cd travel_planner
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 编辑 .env：DASHSCOPE_API_KEY、SESSION_REDIS_URL

chmod +x server.sh
./server.sh start
```

- 服务：http://127.0.0.1:8090
- API 文档：http://127.0.0.1:8090/docs

**本地测试对话**

另开终端运行 `client.py`；使用预置 `agent_id=travel_planner`，每次运行会新建 Session。

```bash
source .venv/bin/activate
python client.py
```

**示例提问**

- 元旦去哈尔滨旅行，帮我规划下 5 天 4 晚的行程，兼顾冰雪大世界、中央大街和东北美食
- 清明假期去杭州 3 天，除了西湖、灵隐寺，还想加 1 天西溪湿地徒步，该怎么规划每日行程？

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 百炼 API Key | 必填 |
| `DASHSCOPE_MODEL_NAME` | 对话模型 | `qwen3.7-max` |
| `SESSION_REDIS_URL` | Redis 地址 | 必填；ECS 默认 `redis://127.0.0.1:6379/0` |
| `HOST` / `PORT` | HTTP 监听 | `0.0.0.0` / `8090` |
| `CREATE_DEFAULT_SESSION` | 设为 `1` 时启动预建 Session「Default」 | `0`（计算巢部署为 `1`） |

复制并按需修改：

```bash
cp .env.example .env
```

## 参考

- [AgentScope 快速开始](https://docs.agentscope.io/zh/v2/quickstart)
- [Agent Service 文档](https://docs.agentscope.io/v2/deploy/agent-service.md)
