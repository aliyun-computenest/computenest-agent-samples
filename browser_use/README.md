# Browser Use 智能浏览器助手

## 概述

本示例基于 [**AgentScope**](https://doc.agentscope.io/) 与 [**AgentScope Runtime**](https://runtime.agentscope.io/) 实现 **智能浏览器操控助手**：以**自然语言指令**为输入，通过 **Playwright MCP** 驱动真实浏览器，完成 **① 网页导航与信息提取 ② 表单填写与页面交互 ③ 多步骤自动化任务执行**——让 AI 像人一样操控浏览器。  
智能体为 **`BrowserAgent`**：**ReAct 循环推理 → 页面快照感知 → 浏览器工具调用 → 记忆修剪 → 流式终稿**；`main.py` 挂载 **Playwright MCP**（通过 AgentRun 云端沙箱），共用 **`DASHSCOPE_API_KEY`**，会话可存 **JSON** 或 **Redis**，沙箱 CDP/VNC URL 随首条消息下发供前端实时预览。

## 核心功能

- **功能 1：网页导航与信息提取**：根据用户指令访问指定 URL，读取页面内容并结构化提取所需信息（文本、链接、数据等）。
- **功能 2：表单填写与页面交互**：自动识别并操作页面元素，包括点击按钮、填写表单、下拉选择、滚动翻页等。
- **功能 3：多步骤自动化任务**：将复杂的浏览器操作分解为多个子步骤，在 ReAct 循环中逐步推理执行，支持最多 50 轮迭代。
- **页面快照感知**：每轮推理前自动调用 `browser_snapshot` 获取当前页面文本快照（最大 20,000 字符），注入推理上下文，确保 Agent 始终感知最新页面状态。
- **记忆自动修剪**：保留首条用户任务 + 最近 N 条消息，防止长任务撑爆模型上下文窗口。
- **云端沙箱隔离**：每个会话独享一个 AgentRun 浏览器沙箱，通过 CDP 协议连接，支持 VNC 实时预览；沙箱空闲 600 秒后自动回收。
- **会话记忆**：Runtime Session（JSON 或 Redis）跨请求持久化 Agent 状态。

## 目录结构

```text
browser_use/
├── README.md
├── main.py                    # AgentScope + Runtime 入口（默认端口 8090）
├── client.py                  # 测试客户端（/process SSE）
├── server.sh                  # start / stop / restart / status
├── requirements.txt
├── .env.example
├── agents/
│   └── browser_agent.py       # BrowserAgent：ReAct + 页面快照 + 记忆修剪
├── configs/
│   └── mcp_config.json        # MCP 配置（可选扩展其他 MCP）
├── tools/
│   ├── mcp_helpers.py         # MCP Toolkit 注册工具
│   └── sandbox_manager.py     # AgentRun Sandbox 生命周期管理
├── logs/                      # 服务运行日志
└── sessions/                  # SESSION_TYPE=json 时默认会话目录
```

**`main.py` 与 `agents/browser_agent.py`**：`main.py` 为服务入口（`python main.py`）；`browser_agent.py` 仅提供智能体类，由 `main.py` 引用，**无需单独执行**。

## Agent 能力架构

```text
用户自然语言指令
    ↓
AgentScope Runtime (AgentApp "Friday")
    ↓
BrowserAgent（继承 ReActAgent）
    ├── 页面快照感知（pre_reasoning hook → browser_snapshot）
    ├── ReAct 推理循环（最多 50 轮）
    │   ├── 推理：基于快照 + 记忆规划下一步操作
    │   └── 行动：调用 Playwright MCP 工具（导航/点击/填表/截图等）
    ├── 记忆修剪（保留首条任务 + 最近 N 条，防止上下文溢出）
    ├── AgentRun Sandbox（云端 Chrome 实例，CDP + VNC）
    └── InMemoryMemory + JSONSession / RedisSession（会话持久化）
```

## 计算巢部署

通过阿里云计算巢可一键部署本示例，无需在本地安装环境：

1. **点击立即部署**：打开 [计算巢 Browser Use 部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/BrowserUse?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
2. **填写并创建**：按页面提示填写参数（如 `DASHSCOPE_API_KEY`、`AGENTRUN_ACCOUNT_ID` 等），点击「立即创建」。
3. **访问实例**：创建完成后跳转至实例页面，可通过命令行或前端 Web 进入并使用 Agent 服务。

<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/ApplicationDetails.jpg" alt="应用详情" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>
进入 WebUI，直接对话，前端可实时预览浏览器操作画面（VNC 流）。
<div style="text-align: center; margin: 16px 0;">
  <img src="https://service-info-public.oss-cn-hangzhou.aliyuncs.com/agent/docs/image_cn/browseruse.png" alt="WebUI" style="max-width: 100%; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
</div>

## 本地运行

### 环境准备

#### 1. Python

建议 Python 3.10+。

#### 2. 依赖安装

```bash
cd browser_use
pip install -r requirements.txt
```

#### 3. 环境变量

可复制 `browser_use/.env.example` 为 `.env`（`cp .env.example .env`），或在 shell 中 `export`：

| 变量 | 必填 | 说明                                      |
|------|------|-----------------------------------------|
| `DASHSCOPE_API_KEY` | 是 | 百炼 API Key（`sk-` 开头），用于对话模型             |
| `DASHSCOPE_MODEL_NAME` | 否 | 默认 `qwen-max`；复杂任务可选用更长上下文的模型           |
| `AGENTRUN_ACCOUNT_ID` | 是 | AgentRun 账号 ID，用于构造 CDP / VNC URL       |
| `AGENTRUN_REGION` | 否 | AgentRun 服务区域，默认 `cn-hangzhou`          |
| `AGENTRUN_TEMPLATE_ID` | 否 | Sandbox 模板 ID，例如 `sandbox-browser-xxxx` |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 是 | 阿里云 AccessKey ID，用于 AgentRun SDK 鉴权     |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 是 | 阿里云 AccessKey Secret                    |
| `SESSION_TYPE` | 否 | `json`（默认）或 `redis`                     |
| `SESSION_REDIS_URL` | 条件 | `SESSION_TYPE=redis` 时必填                |

#### 4. AgentRun 沙箱说明

本示例使用 **AgentRun** 提供的云端浏览器沙箱，每个会话独享一个隔离的 Chrome 实例：

- **CDP URL**：`wss://{AGENTRUN_ACCOUNT_ID}.agentrun-data.{REGION}.aliyuncs.com/sandboxes/{sandbox_id}/ws/automation`，供 Playwright MCP 通过 CDP 协议连接并控制浏览器。
- **VNC URL**：`wss://{AGENTRUN_ACCOUNT_ID}.agentrun-data.{REGION}.aliyuncs.com/sandboxes/{sandbox_id}/ws/livestream`，供前端实时预览浏览器画面。
- **生命周期**：沙箱在会话首次请求时创建，空闲 **600 秒**后自动回收；服务关闭时统一销毁所有活跃沙箱。
- **会话复用**：同一 `session_id` 的后续请求复用已有沙箱，浏览器保持在上次操作的页面，无需重新导航。

请在 [AgentRun 控制台](https://functionai.console.aliyun.com/cn-hangzhou/agent/runtime/sandbox) 开通AgentRun服务，并创建好Sandbox 沙箱模板

### 启动服务

#### 一键部署（推荐）

`deploy.sh` 会自动完成：Python 虚拟环境创建、后端依赖安装、前端 npm 依赖安装与构建、前后端服务后台启动，并自动获取公网 IP 配置前端 `BASE_URL`。

```bash
cd browser_use
chmod +x deploy.sh stop.sh server.sh
bash deploy.sh
```

部署完成后：

| 服务 | 地址 |
|------|------|
| **前端 WebUI** | `http://localhost:5173` |
| **后端 API** | `http://0.0.0.0:8090` |

所有日志统一存放于 `logs/` 目录：

| 日志文件 | 说明 |
|----------|------|
| `logs/deploy.log` | 部署过程日志 |
| `logs/backend.log` | 后端运行日志 |
| `logs/frontend.log` | 前端服务日志 |

**可选参数：**

```bash
# 仅部署后端（跳过前端构建）
bash deploy.sh --skip-frontend

# 仅部署前端（跳过后端）
bash deploy.sh --skip-backend

# 前端以开发模式启动（vite dev，支持热更新）
bash deploy.sh --dev
```

#### 停止服务

```bash
# 停止前后端所有服务
bash stop.sh

# 仅停止后端
bash stop.sh --backend-only

# 仅停止前端
bash stop.sh --frontend-only
```

#### 仅管理后端服务

如只需单独控制后端进程，可使用 `server.sh`：

```bash
./server.sh start    # 启动后端
./server.sh stop     # 停止后端
./server.sh restart  # 重启后端
./server.sh status   # 查看状态
```

#### 手动启动（开发调试）

```bash
cd browser_use
python main.py
```

后端默认监听 **`http://0.0.0.0:8090`**。若端口已被占用，请修改 `main.py` 中的端口号。

### 测试客户端

```bash
python client.py
```

可在 `client.py` 中修改 `BASE_URL`、`USER_ID`、`SESSION_ID` 与 `main()` 中的示例指令。

## 示例提示词

- 请访问 **百度**，搜索「AgentScope」，告诉我前三条搜索结果的标题和链接。
- 打开 **GitHub**，搜索 `agentscope` 仓库，找到 Star 数最多的那个，告诉我它的描述和最近一次提交时间。
- 访问 **天气网站**，查询北京今天和未来三天的天气预报，整理成表格返回给我。
- 帮我在某电商网站搜索「机械键盘」，按销量排序，截取前五条商品的名称和价格。
- 打开指定网页，找到联系表单，填写姓名「张三」、邮箱「test@example.com」，然后截图确认。

## 常见问题

- **AgentRun 沙箱创建失败**：确认 `AGENTRUN_ACCOUNT_ID`、`ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 已正确配置，且账号已在 AgentRun 控制台开通服务。
- **CDP 连接超时**：沙箱启动需要数秒，若首次请求立即超时，可适当增大客户端超时时间（`client.py` 中 `timeout=120.0`）。
- **VNC 画面无法预览**：确认前端 WebSocket 连接地址为 `/ws/livestream` 路径；若地址以 `/vnc` 结尾，需替换为 `/ws/livestream`。
- **页面快照过大导致模型报错**：快照已限制为 20,000 字符；若仍超限，可在 `browser_agent.py` 中调小 `max_snapshot_chars`。
- **Agent 陷入循环或超出迭代次数**：默认最多 50 轮 ReAct 迭代；可在 `main.py` 中调整 `max_iters` 参数，或将任务拆分为更小的子任务。
- **会话沙箱被意外回收**：沙箱空闲超时默认 600 秒；长时间无操作后再次请求会自动创建新沙箱并导航至百度首页。
- **API Key 无效**：须为百炼通用 `sk-` Key。详见[官方文档](https://help.aliyun.com/zh/model-studio/)。
- **端口占用**：默认 **8090**；与其它本地服务冲突时，请改 `main.py`（以及 `client.py` 中的 `BASE_URL`）中的端口。

## 参考资料

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [AgentRun 控制台](https://functionai.console.aliyun.com/cn-hangzhou/agent/runtime/sandbox)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [阿里云百炼](https://bailian.console.aliyun.com/)
