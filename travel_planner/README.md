# 智能旅行助手

## 概述

本示例基于 **AgentScope** 与 **AgentScope Runtime** 实现，提供智能旅行规划能力。智能体集成高德 MCP 获取 LBS 与路线规划、本地知识库（旅行安全与小众景点）、可选长期记忆（Mem0），并通过 Runtime 提供会话持久化与流式接口。

## 核心功能

- **行程规划**：通过高德 MCP 生成交通、餐饮、住宿与景点推荐。
- **旅行知识库**：本地 RAG（SimpleKnowledge + 本地 Markdown），提供安全贴士与小众景点推荐。
- **长期记忆（可选）**：启用后使用 Mem0 记录用户偏好，实现个性化推荐。
- **会话记忆**：Runtime Session（JSON 文件或 Redis）持久化当前会话。

## 目录结构

```text
travel_planner/
├── README.md
├── __init__.py
├── main.py               # AgentScope + AgentScope Runtime 入口
├── server.sh             # 服务控制脚本 start/stop/restart/status
├── client.py             # 测试客户端（/process SSE）
├── requirements.txt
├── configs/
│   └── mcp_config.json   # MCP 配置（高德等）
├── knowledgebase_docs/   # 知识库 Markdown
│   ├── general_safety_guide.md
│   └── tourists_recommend.md
├── tools/
│   ├── __init__.py
│   └── mcp_helpers.py    # MCP 客户端注册
└── sessions/             # 默认会话存储目录（JSON 时）
```

## 计算巢部署

通过阿里云计算巢可一键部署本示例，无需在本地安装环境：

1. **点击立即部署**：打开 [计算巢 智能旅行助手 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/TravelPlanner?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
2. **填写并创建**：按页面提示填写参数（如 `DASHSCOPE_API_KEY` 等），点击「立即创建」。
3. **访问实例**：创建完成后跳转至实例页面，可通过命令行或前端 Web 进入并使用 Agent 服务。

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="应用详情" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>
进入WebUI，直接对话。
<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/WeiUI.jpg" alt="WebUI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## 本地运行

### 环境准备

#### 1. Python

建议 Python 3.10+。

#### 2. 依赖安装

```bash
cd travel_planner
pip install -r requirements.txt
```

#### 3. 环境变量

可复制 `travel_planner/.env.example` 为 `.env` 后按需填写（`cp .env.example .env`），或在项目根目录 / `travel_planner` 下直接创建 `.env`，也可在终端 `export`：

| 变量 | 必填 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 阿里云 DashScope API Key；用于模型、知识库/长期记忆嵌入，以及 MCP 配置中的高德服务鉴权（`configs/mcp_config.json` 里的 `Authorization: Bearer ${DASHSCOPE_API_KEY}` 会从环境变量读取） |
| `DASHSCOPE_MODEL_NAME` | 否 | 对话模型，默认 `qwen-max` |
| `SESSION_TYPE` | 否 | `json`（默认）或 `redis` |
| `SESSION_REDIS_URL` | 否 | 当 `SESSION_TYPE=redis` 时必填，如 `redis://localhost:6379/0` |
| `TRAVEL_PLANNER_USE_LONG_TERM_MEMORY` | 否 | 设为 `1`/`true`/`yes` 时启用 Mem0 长期记忆（需 DashScope） |

高德能力通过阿里云百炼的 amap-maps MCP 服务提供，使用上述 `DASHSCOPE_API_KEY` 鉴权即可，无需单独申请高德 Key。**使用前需在百炼 MCP 市场开通高德（amap-maps）方可生效**，开通地址：[百炼 MCP 市场 - 高德 amap-maps](https://bailian.console.aliyun.com/cn-beijing/?spm=5176.24779694.console-base_search-panel.dtab-product_sfm.2e9b4d22SkTaYy&tab=app#/mcp-market/detail/amap-maps)。

**MCP 配置说明**（`configs/mcp_config.json`）：

- **type**：传输类型，百炼只有两种——`sse`（地址多为 `.../sse`）或 `streamableHttp`（地址多为 `.../mcp`）。代码会据此创建对应的 MCP 客户端（内部对应 AgentScope 的 `transport` 参数，无需在配置里写 `transport`）。
- **baseUrl**：二选一，服务地址；`baseUrl` 与百炼控制台一致。
- **headers**：如 `Authorization: Bearer ${DASHSCOPE_API_KEY}` 会从环境变量读取并替换。

### 运行

#### 启动服务

```bash
cd travel_planner
python main.py
```

默认监听 `http://0.0.0.0:8090`。

也可使用控制脚本：

```bash
./server.sh start    # 启动（后台，日志写入 server.log）
./server.sh stop     # 停止
./server.sh restart  # 重启
./server.sh status   # 查看状态
```

#### 测试客户端

```bash
# 确保服务已启动
python client.py
```

可修改 `client.py` 中的 `BASE_URL`、`USER_ID`、`SESSION_ID` 以及 `main()` 中的示例提示词。

## 示例提示词

- 元旦去哈尔滨旅行，帮我规划下 5 天 4 晚的行程，兼顾冰雪大世界、中央大街和东北美食
- 清明假期去杭州 3 天，除了西湖、灵隐寺，还想加 1 天西溪湿地徒步，该怎么规划每日行程？
- 五一去成都玩 3 天，想打卡宽窄巷子、熊猫基地，再安排 1 天都江堰或青城山，行程怎么分配？

## 常见问题

- **高德 MCP 报错**：需先在[百炼 MCP 市场](https://bailian.console.aliyun.com/cn-beijing/?spm=5176.24779694.console-base_search-panel.dtab-product_sfm.2e9b4d22SkTaYy&tab=app#/mcp-market/detail/amap-maps)开通高德（amap-maps）；并确认 `DASHSCOPE_API_KEY` 已设置，鉴权依赖该 Key。
- **知识库未生效**：确认 `DASHSCOPE_API_KEY` 有效，且 `knowledgebase_docs/` 下存在 `.md` 文件。
- **长期记忆**：需设置 `TRAVEL_PLANNER_USE_LONG_TERM_MEMORY=1`，并保证 DashScope 可用。

## 参考资料

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
