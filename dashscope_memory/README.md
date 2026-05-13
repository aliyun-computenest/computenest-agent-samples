# DashScope 长期记忆 × Runtime

## 概述

本示例基于 [**AgentScope**](https://doc.agentscope.io/) 与 [**AgentScope Runtime**](https://runtime.agentscope.io/)，演示如何在对话服务中接入阿里云 **DashScope（百炼）长期记忆** API：在每次用户请求前 **拉取用户画像**、**按当前问题检索记忆片段** 并拼入系统提示；对话结束后将 **本轮用户/助手各一句** 写回记忆库（可选关联画像 schema）。底层工具来自 `agentscope_runtime.tools.modelstudio_memory` 的 **GetUserProfile**、**SearchMemory**、**AddMemory**。

**英文说明**：[README_en.md](README_en.md)。

## 核心流程

1. **GetUserProfile**：若配置了 `BAILIAN_MEMORY_PROFILE_SCHEMA`，将画像字段格式化为列表，接入系统提示。
2. **SearchMemory**：用当前用户最后一轮问题做向量检索，取 `top_k` 条且相似度不低于 `min_score` 的片段，接入系统提示。
3. **ReActAgent + DashScope 模型**：加载 Runtime **Session**（JSON 或 Redis）中的短期对话历史，流式回复。
4. **AddMemory**：从 Agent 短期记忆中取出本轮用户句与助手句，调用 AddMemory 写入长期记忆（可带 `profile_schema`）。

本示例将百炼侧 **end user id** 固定为 `demo_user`（见 `main.py` 中 `BAILIAN_USER_ID`）；生产环境可按 `session_id` 或业务用户 id 映射替换。

## 目录结构

```text
dashscope_memory/
├── README.md
├── README_en.md
├── __init__.py
├── main.py               # AgentApp + 画像/检索/写入编排
├── client.py             # 测试客户端（/process SSE）
├── server.sh             # start / stop / restart / status
├── requirements.txt
├── .env.example
└── sessions/             # SESSION_TYPE=json 时自动创建，用于会话状态
```

## 计算巢部署

通过阿里云计算巢可一键部署本示例，无需在本地安装环境：

1. **点击立即部署**：打开 [计算巢 DashScope 长期记忆示例 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/DashScopeMemory?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
2. **填写并创建**：按页面提示填写参数（如 `DASHSCOPE_API_KEY`，以及可选的 `BAILIAN_MEMORY_LIBRARY_ID` / `BAILIAN_MEMORY_PROJECT_ID` / `BAILIAN_MEMORY_PROFILE_SCHEMA` 等），点击「立即创建」。
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

建议 **Python 3.10+**。

```bash
cd dashscope_memory
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，至少填写 DASHSCOPE_API_KEY
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 百炼 API Key，用于对话模型与记忆 API |
| `DASHSCOPE_MODEL_NAME` | 否 | 默认 `qwen-max` |
| `BAILIAN_MEMORY_LIBRARY_ID` | 否 | 指定记忆库；不填则走控制台默认 |
| `BAILIAN_MEMORY_PROJECT_ID` | 否 | 绑定控制台记忆规则的项目 |
| `BAILIAN_MEMORY_PROFILE_SCHEMA` | 否 | 画像 schema；不填则不调 GetUserProfile，AddMemory 也不带画像更新 |
| `SESSION_TYPE` | 否 | `json`（默认）或 `redis` |
| `SESSION_REDIS_URL` | 条件 | `SESSION_TYPE=redis` 时必填 |

记忆与画像相关能力需在 [百炼控制台](https://bailian.console.aliyun.com/) 开通长期记忆并按文档配置库与 schema。

### 启动服务

```bash
cd dashscope_memory
python main.py
```

默认监听 **`http://0.0.0.0:8090`**。端口占用时可修改 `main.py` 末尾 `agent_app.run(..., port=8090)`。

或使用脚本：

```bash
chmod +x server.sh
./server.sh start
./server.sh status
./server.sh stop
```

### 测试客户端

```bash
cd dashscope_memory
python client.py
```

向 `/process` 发送 **SSE** 流式请求；`session_id` 与 `user_id` 可与 `client.py` 中常量对齐，便于多轮会话调试。

### 可调参数（代码内）

在 `main.py` 中：

- `SEARCH_TOP_K`、`SEARCH_MIN_SCORE`：检索条数与相似度下限（0~1）。
- `BAILIAN_USER_ID`：百炼侧用户标识（示例为 `demo_user`）。

### 记忆 HTTPS / SSL 证书错误

若调用记忆接口时出现证书校验失败，可在 **`import fastapi` 之前** 按 `main.py` 文件顶部注释说明，去掉该段每行行首的 `#` 以启用 aiohttp + certifi 补丁（需已安装 `requirements.txt` 中的 `certifi`）。

## 相关文档

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- 百炼长期记忆与控制台配置以阿里云官方文档为准。
