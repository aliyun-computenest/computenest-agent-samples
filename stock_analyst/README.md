# 股票智能分析助手

## 概述

本示例基于 [**AgentScope**](https://doc.agentscope.io/) 与 [**AgentScope Runtime**](https://runtime.agentscope.io/) 实现 **股票分析智能助手**：以**标的证券**（个股 / ETF / 指数等）为主线，通过多轮联网检索与编排，在终稿中结构化输出 **① 股票数据分析 ② 股票走势预测（多情景研判）③ 股票投资建议（参考性思路 + 风险与免责）**——避免写成泛泛的「公司长篇介绍」。  
智能体为 **`StockDeepResearchAgent`**：**子任务分解 → 程序化多轮百炼联网搜索 → 续搜判断 → 中间摘要 → 流式终稿**；`main.py` 挂载 **联网搜索 MCP**、`execute_python_code`、`write_text_file`、`view_text_file`，共用 **`DASHSCOPE_API_KEY`**，会话可存 **JSON** 或 **Redis**。

**免责声明**：输出由 AI 根据检索摘要生成，**非持牌证券投资咨询**，不保证收益；仅供参考与技术演示，决策与盈亏由用户自负，重要事项请咨询持牌专业人士并核对原始披露。

## 核心功能

- **功能 1：股票数据分析**：整理检索到的价量、涨跌幅、估值等公开信息；可对用户粘贴或材料中的数列用 `execute_python_code` 做简单统计（须 `print`）。
- **功能 2：股票走势预测**：基于公开材料做**多情景**走势讨论，写明依据与失效条件；禁止「必涨必跌」式断言。
- **功能 3：股票投资建议**：给出**参考性**操作思路（如仓位、止损关注等），须同步列风险与反面论据，并附**非投顾免责**说明。
- **深度检索编排**：检索词优先围绕行情、走势观点、目标价/评级、风险，而非公司百科式主题（与 `opinion_analyst` 同型编排流程）。
- **会话记忆**：Runtime Session（JSON 或 Redis）。

## 目录结构

```text
stock_analyst/
├── README.md
├── __init__.py
├── main.py               # AgentScope + Runtime 入口（默认端口见下文）
├── agent.py              # StockDeepResearchAgent：编排分解 / 搜索 / 续搜判断 / 成稿
├── server.sh             # start / stop / restart / status
├── client.py             # 测试客户端（/process SSE）
├── requirements.txt
├── .env.example
├── configs/
│   └── mcp_config.json   # 百炼 WebSearch MCP（SSE + Bearer）
├── tools/
│   ├── __init__.py
│   └── mcp_helpers.py
├── workspace/            # 若使用文件读写类工具，中间文件可能落于此（可选）
└── sessions/             # SESSION_TYPE=json 时默认会话目录
```

**`main.py` 与 `agent.py`**：`main.py` 为服务入口（`python main.py`）；`agent.py` 仅提供智能体类，由 `main.py` 引用，**无需单独执行**。

## 计算巢部署

通过阿里云计算巢可一键部署本示例，无需在本地安装环境：

1. **点击立即部署**：打开 [计算巢 股票智能分析助手 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/StockAnalyst?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
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
cd stock_analyst
pip install -r requirements.txt
```

#### 3. 环境变量

可复制 `stock_analyst/.env.example` 为 `.env`（`cp .env.example .env`），或在 shell 中 `export`：

| 变量 | 必填 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 百炼 API Key（`sk-` 开头），用于对话模型与联网搜索 MCP |
| `DASHSCOPE_MODEL_NAME` | 否 | 默认 `qwen-max`；复杂研究可选用更长上下文的模型 |
| `STOCK_SEARCH_TOOL_NAME` | 否 | 强制指定联网搜索 MCP 工具的 `function.name`；一般留空，由程序自动选择 |
| `SESSION_TYPE` | 否 | `json`（默认）或 `redis` |
| `SESSION_REDIS_URL` | 条件 | `SESSION_TYPE=redis` 时必填 |

#### 4. 开通百炼「联网搜索」MCP

本示例的 `configs/mcp_config.json` 默认使用 **SSE** 端点：

`https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/sse`

使用前请在 [百炼 MCP 广场](https://bailian.console.aliyun.com/cn-beijing/?tab=app#/mcp-market) 找到 **联网搜索** 并完成开通。若控制台提示将协议升级为 Streamable HTTP，按指引升级即可；**多数情况下 SSE 端点仍可继续使用**。说明与排错见：[联网搜索 MCP 文档](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan)。

#### 5. MCP 配置说明（`configs/mcp_config.json`）

`tools/mcp_helpers.py` 支持常见 MCP 接入方式：

- **远程服务**：`baseUrl` + `type`（本示例默认 `sse`）+ `headers`（`Bearer ${DASHSCOPE_API_KEY}`）。
- 若你确认环境已支持且需使用新版 Streamable HTTP，可将 `type` 改为 `streamableHttp`、`baseUrl` 改为 `https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp`；若出现 **`405 Method Not Allowed`**，请改回 **SSE** 配置，或尝试 `pip install -U mcp httpx httpx-sse agentscope` 后再试。
- 亦可按需合并其他 MCP，`tools/mcp_helpers.py` 会按配置注册。

### 启动服务

```bash
cd stock_analyst
python main.py
```

默认监听 **`http://0.0.0.0:8090`**。若本机 **8090** 已被其它进程占用，请修改 `main.py` 中的端口，或先释放该端口。

或使用脚本：

```bash
chmod +x server.sh
./server.sh start
./server.sh status
./server.sh stop
```

### 测试客户端

```bash
python client.py
```

可在 `client.py` 中修改 `BASE_URL`、`USER_ID`、`SESSION_ID` 与 `main()` 中的示例问题。

## 示例提示词

- 请分析 **XXX（代码）** 最近一周：**数据分析**（价量与关键数字）、**走势预测**（多情景）、**投资参考建议**（含风险与免责）。
- 某 ETF 近期波动加大，请基于公开检索做数据整理、情景化走势研判，并给出**参考性**仓位与风控思路（非保证收益）。
- 用户将粘贴 20 日收盘价，请先用检索补充最新行情，再结合粘贴数据做简单均线/涨跌统计，最后给出走势情景与**参考**建议。

## 常见问题

- **联网搜索 MCP 连不上或未生效**：确认已在 MCP 广场开通联网搜索；默认配置为 `.../WebSearch/sse`。若对 `.../WebSearch/mcp` 发起请求出现 **HTTP 405**，多为 Streamable HTTP 与当前 MCP 客户端/网关不匹配，**请使用本仓库默认的 SSE 配置**。
- **日志里 `DeprecationWarning: Use streamable_http_client`**：来自 MCP 相关依赖的版本提示，一般不影响 SSE 模式；若坚持使用 `/mcp` 端点，可升级 `mcp`、`agentscope` 等包后再试。
- **API Key**：须为百炼通用 `sk-` Key，与文档说明一致。详见[官方文档](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan)。
- **自动选错搜索工具**：在 `.env` 中设置 `STOCK_SEARCH_TOOL_NAME` 为控制台显示的实际工具名。
- **代码工具无输出**：`execute_python_code` 需使用 `print()` 才能看到标准输出。
- **端口占用**：默认 **8090**；与其它本地服务冲突时，请改 `main.py`（以及 `client.py` 中的 `BASE_URL`）中的端口。

## 参考资料

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [阿里云百炼：联网搜索 MCP 说明](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan)
