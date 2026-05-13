# 舆情分析专家

## 概述

本示例基于 [**AgentScope**](https://doc.agentscope.io/) 与 [**AgentScope Runtime**](https://runtime.agentscope.io/) 实现：**面向品牌、事件或话题，做多轮公开信息检索，并输出结构化舆情研判草稿**（背景、观点、风险、信息缺口等）。  
智能体实现为 **`OpinionDeepResearchAgent`**：在代码中编排 **子任务分解 → 程序化多轮百炼联网搜索 → 续搜判断 → 中间摘要 → 流式终稿**；`main.py` 负责注册 Runtime、挂载百炼 **联网搜索 MCP**、以及 `execute_python_code` 等工具，共用 **`DASHSCOPE_API_KEY`**，会话可持久化到本地 **JSON** 或 **Redis**。

**免责声明**：报告内容由 AI 根据检索摘要整理，**仅供学习或内部讨论参考**，不构成法律意见、投资建议或正式公关方案；重要结论请对照原始网页核实。

## 核心功能

- **深度检索编排**：自动拆解子问题与检索词，按轮次调用联网搜索，并据结果决定是否追加查询。
- **公开信息来源**：通过百炼 **联网搜索 MCP** 获取网页摘要（需先在控制台开通该 MCP）。
- **辅助分析**：可选使用 AgentScope 内置 `execute_python_code` 等对材料做简单统计（须在代码中 `print` 输出）。
- **会话记忆**：Runtime Session（JSON 文件或 Redis）持久化当前对话中的智能体状态。

## 目录结构

```text
opinion_analyst/
├── README.md
├── __init__.py
├── main.py               # AgentScope + Runtime 入口（默认端口见下文）
├── agent.py              # OpinionDeepResearchAgent：编排分解 / 搜索 / 续搜判断 / 成稿
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

1. **点击立即部署**：打开 [计算巢 舆情深度研究助手 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/OpinionAnalyst?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
2. **填写并创建**：按页面提示填写参数（如 `DASHSCOPE_API_KEY` 等），点击「立即创建」。
3. **访问实例**：创建完成后跳转至实例页面，可通过命令行或前端 Web 进入并使用 Agent 服务。

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="应用详情" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>
进入 WebUI，直接对话。
<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/WeiUI.jpg" alt="WebUI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## 本地运行

### 环境准备

#### 1. Python

建议 Python 3.10+。

#### 2. 依赖安装

```bash
cd opinion_analyst
pip install -r requirements.txt
```

#### 3. 环境变量

可复制 `opinion_analyst/.env.example` 为 `.env`（`cp .env.example .env`），或在 shell 中 `export`：

| 变量 | 必填 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 百炼 API Key（`sk-` 开头），用于对话模型与联网搜索 MCP |
| `DASHSCOPE_MODEL_NAME` | 否 | 默认 `qwen-max`；复杂舆情可选用更长上下文的模型 |
| `SESSION_TYPE` | 否 | `json`（默认）或 `redis` |
| `SESSION_REDIS_URL` | 条件 | `SESSION_TYPE=redis` 时必填 |
| `OPINION_SEARCH_TOOL_NAME` | 否 | 一般留空；仅自动选错或报错时，在百炼 MCP「联网搜索」里查 `function.name` 后填入（见 `.env.example` 说明） |

#### 4. 开通百炼「联网搜索」MCP

1. 打开 [百炼 MCP 广场](https://bailian.console.aliyun.com/cn-beijing/?tab=app#/mcp-market)，找到 **联网搜索** 并完成开通。  
2. 本项目 `configs/mcp_config.json` 默认使用 **SSE** 端点，与 [联网搜索 MCP 文档](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan) 一致。若出现 **405** 等，请优先保持 SSE 配置或按文档升级客户端。

#### 5. MCP 配置说明（`configs/mcp_config.json`）

与仓库内其他示例相同：远程服务使用 `baseUrl` + `type`（默认 `sse`）+ `headers`（`Bearer ${DASHSCOPE_API_KEY}`）。可按需合并其他 MCP，`tools/mcp_helpers.py` 会按配置注册。

### 运行

#### 启动服务

```bash
cd opinion_analyst
python main.py
```

默认监听 **`http://0.0.0.0:8090`**。若端口冲突，请修改 `main.py` 中 `agent_app.run` 的端口，并同步修改 `client.py` 的 `BASE_URL`。

也可使用脚本：

```bash
chmod +x server.sh
./server.sh start
./server.sh status
./server.sh stop
```

#### 测试客户端

```bash
python client.py
```

可在 `client.py` 中修改示例问题或 `BASE_URL` / `SESSION_ID` 等。

## 提问示例

- 请围绕「某某品牌」最近两周的中文报道和讨论做舆情梳理：子问题、检索轮次、信息缺口要写清楚。  
- 关于「某某公共事件」：按时间线整理已知报道并区分不同说法；如有辟谣或反转线索请说明。  
- 主体为「某某产品」，时间最近一个月，重点看「售后、质量」相关讨论，并给出监测参考（避免绝对化结论）。

## 常见问题

- **Key 无效或无法联网搜索**：检查 `.env`、百炼是否已开通联网搜索、网络是否可达阿里云。  
- **检索偏少或很快结束**：可在提问中要求多关键词、多轮检索；或调整 `agent.py` 中默认编排参数 / 换用模型。  
- **子任务 JSON 解析失败**：已内置兜底；仍失败时会降级为默认检索计划并继续执行。

## 参考资料

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime 文档](https://runtime.agentscope.io/)
- [百炼联网搜索 MCP](https://help.aliyun.com/zh/model-studio/web-search-for-coding-plan)
