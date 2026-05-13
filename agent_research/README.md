# AI 搜学助手

## 概述

本示例基于 [**AgentScope**](https://doc.agentscope.io/) 与 [**AgentScope Runtime**](https://runtime.agentscope.io/) 实现 **智能学习研究助手**：以**自然语言指令**为输入，通过 **Playwright 驱动浏览器**自动收集学习资料，完成 **① 多平台资料搜集 ② 知识点智能分析 ③ 可视化讲解报告生成**——让 AI 帮你快速理解和掌握各种知识概念。

智能体采用**代码控制流程**设计：**资料收集 → 知识分析 → 文档撰写 → HTML 渲染**，每一步都实时推送状态更新。使用 **DashScope 模型**进行流式内容生成，通过 **AgentRun 云端沙箱**提供隔离的浏览器环境，支持 VNC 实时预览。

## 核心功能

- **功能 1：多平台资料搜集**：自动在百度搜索并深入抓取知乎、B站、CSDN、博客园等多个平台的学习资料，支持相关性评分和内容去重。
- **功能 2：知识点智能分析**：提取核心概念、评估学习难度、分析内容类型分布（定义/原理/应用），提炼关键知识点。
- **功能 3：可视化讲解报告**：生成包含六个章节的知识讲解文档，并自动渲染为带有 ECharts 图表的精美 HTML 页面。
- **LLM 深度探索**：对知乎、B站等平台，通过 LLM 决策是否深入探索评论区获取更多学习讨论内容。
- **数据质量筛选**：基于关键词匹配、平台识别、时效性等多维度评估资料相关性，自动过滤广告和低质量内容。
- **云端沙箱隔离**：每个会话独享一个 AgentRun 浏览器沙箱，通过 CDP 协议连接，支持 VNC 实时预览。
- **实时状态推送**：采用 AG-UI 兼容的 SSE 协议，实时推送收集进度、分析状态、文档生成进度。

## 目录结构

```text
agent_research/
├── README.md
├── main.py                    # AgentScope + FastAPI 服务入口（默认端口 8090）
├── client.py                  # 测试客户端（/api/agent SSE）
├── server.sh                  # start / stop / restart / status
├── requirements.txt
├── agents/
│   └── research_agent.py      # 核心智能体：资料收集 + 知识分析 + 文档撰写
├── configs/
│   └── mcp_config.json        # MCP 配置（可扩展其他工具）
├── tools/
│   ├── analysis_standards.py  # 分析标准：情感计算、热度趋势、关键词提取
│   └── event_queue.py         # SSE 事件队列管理
├── web/starter_webui/         # Next.js 前端（可视化看板）
└── logs/                      # 服务运行日志
```

**`main.py` 与 `agents/research_agent.py`**：`main.py` 为服务入口（`python main.py`）；`research_agent.py` 包含完整的 Pipeline 逻辑，由 `main.py` 引用，**无需单独执行**。

## Agent 能力架构

```text
用户自然语言指令（如：帮我学习"机器学习"）
    ↓
FastAPI + AG-UI SSE 协议（/api/agent）
    ↓
Research Pipeline（代码控制流程）
    ├── 阶段 1：资料收集
    │   ├── 生成多角度搜索查询（定义/原理/教程/知乎/B站/博客/案例/进阶）
    │   ├── Browser Sandbox → 百度搜索 → 深入抓取详情页
    │   ├── LLM 决策探索（知乎评论区、B站评论等）
    │   └── 相关性评估 + 质量筛选
    ├── 阶段 2：知识分析
    │   ├── 统计数据来源分布
    │   ├── DashScope 流式调用 → 提取核心概念和知识点
    │   └── 生成难度评估、学习热度、关键观点
    ├── 阶段 3：文档撰写
    │   ├── DashScope 流式生成 Markdown 文档
    │   └── 包含：概念简介、核心原理、详细讲解、应用案例、进阶建议、参考资料
    └── 阶段 4：HTML 渲染
        ├── Markdown → HTML 转换
        └── ECharts 图表（内容类型分布、热度趋势、来源分布、难度评估、词云）
```

## 计算巢部署

通过阿里云计算巢可一键部署本示例，无需在本地安装环境：

1. **点击立即部署**：打开计算巢 AI 搜学助手部署页，点击「立即部署」。
2. **填写并创建**：按页面提示填写参数，点击「立即创建」。
3. **访问实例**：创建完成后跳转至实例页面，可通过命令行或前端 Web 进入并使用 Agent 服务。

进入 WebUI，输入想要学习的知识主题，系统将自动收集资料并生成可视化讲解报告。

## 本地运行

### 环境准备

#### 1. Python

建议 Python 3.10+。

#### 2. 依赖安装

```bash
cd agent_research
pip install -r requirements.txt
```

#### 3. 环境变量

可复制 `agent_research/.env.example` 为 `.env`（`cp .env.example .env`），或在 shell 中 `export`：

| 变量 | 必填 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 百炼 API Key（`sk-` 开头），用于对话模型 |
| `DASHSCOPE_MODEL_NAME` | 否 | 默认 `qwen-max`；复杂任务可选用更长上下文的模型 |
| `AGENTRUN_TEMPLATE_ID` | 是 | AgentRun 浏览器 Sandbox 模板名称，如 `sandbox-browser-xxxx` |
| `AGENTRUN_REGION` | 否 | AgentRun 服务区域，默认 `cn-hangzhou` |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 是 | 阿里云 AccessKey ID，用于 AgentRun SDK 鉴权 |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 是 | 阿里云 AccessKey Secret |

#### 4. AgentRun 沙箱说明

本示例使用 **AgentRun** 提供的云端浏览器沙箱，每个会话独享一个隔离的 Chrome 实例：

- **CDP URL**：供 Playwright 通过 CDP 协议连接并控制浏览器进行搜索和内容抓取。
- **VNC URL**：供前端实时预览浏览器画面，观察资料收集过程。
- **生命周期**：沙箱在会话首次请求时创建，空闲后自动回收。

请在 [AgentRun 控制台](https://functionai.console.aliyun.com/cn-hangzhou/agent/runtime/sandbox) 开通 AgentRun 服务

### 启动服务

#### 使用 server.sh

```bash
./server.sh start    # 启动服务
./server.sh stop     # 停止服务
./server.sh restart  # 重启服务
./server.sh status   # 查看状态
```

#### 手动启动（开发调试）

```bash
cd agent_research
python main.py
```

后端默认监听 **`http://0.0.0.0:8090`**。若端口已被占用，请修改 `main.py` 中的端口号。

### 测试客户端

```bash
python client.py
```

可在 `client.py` 中修改 `BASE_URL`、`RUN_ID`、`THREAD_ID` 与 `main()` 中的示例指令。

## 示例提示词

- 帮我学习和理解「机器学习」的基础知识
- 帮我学习和理解「深度学习」的核心原理
- 帮我学习和理解「自然语言处理」
- 帮我学习和理解「强化学习」的应用场景
- 帮我学习和理解「Transformer 架构」
- 帮我学习和理解「图神经网络」

## 工作流程详解

### 阶段 1：资料收集

1. **查询生成**：根据关键词生成多角度搜索查询，包括：
   - 定义类：`"{keyword} 是什么"`、`"{keyword} 定义"`、`"{keyword} 百科"`
   - 原理类：`"{keyword} 原理"`、`"{keyword} 详解"`、`"{keyword} 通俗解释"`
   - 教程类：`"{keyword} 教程"`、`"{keyword} 入门"`、`"{keyword} 学习"`
   - 平台类：`"{keyword} 知乎"`、`"{keyword} B站 教程"`、`"{keyword} CSDN"`
   - 应用类：`"{keyword} 例子"`、`"{keyword} 案例"`、`"{keyword} 应用"`

2. **搜索抓取**：使用 Playwright 在百度搜索，深入抓取每个结果页面的详细内容。

3. **平台适配**：针对不同平台（知乎、B站、CSDN、百度百科等）使用特定的内容提取选择器。

4. **LLM 探索**：对知乎、B站等平台，通过 LLM 决定是否深入探索评论区获取更多内容。

5. **质量筛选**：基于关键词匹配度、语言一致性、平台权重、时效性等评估相关性，过滤广告和低质量内容。

### 阶段 2：知识分析

1. **统计分布**：统计数据来源平台分布。
2. **概念提取**：调用 DashScope 提取 15-20 个核心概念和术语。
3. **难度评估**：计算综合难度得分，评估学习曲线。
4. **观点提炼**：从资料中提炼 5-8 个最重要的知识点。
5. **学习建议**：生成前置知识要求和进阶方向建议。

### 阶段 3：文档撰写

使用 DashScope 流式生成包含六个章节的 Markdown 文档：
- 一、概念简介
- 二、核心原理
- 三、详细讲解
- 四、应用案例
- 五、关联知识与进阶
- 六、总结与学习建议
- 附录：参考资料

### 阶段 4：HTML 渲染

1. 将 Markdown 转换为 HTML。
2. 自动嵌入 ECharts 图表：
   - 内容类型分布（饼图）
   - 学习热度趋势（折线图）
   - 资料来源分布（柱状图）
   - 学习难度评估（仪表盘）
   - 核心概念词云

## 常见问题

- **Browser Sandbox 创建失败**：确认 `AGENTRUN_TEMPLATE_ID`、`ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 已正确配置，且账号已在 AgentRun 控制台开通服务。
- **资料收集结果少**：尝试使用更通用的关键词，或增加 `max_results` 参数值。
- **分析速度较慢**：复杂主题需要更多资料收集时间，建议耐心等待或选择更高性能的模型。
- **生成的文档不够详细**：可以尝试使用更长上下文的模型（如 `qwen-long`），或在提示词中明确要求更详细的解释。
- **API Key 无效**：须为百炼通用 `sk-` Key。详见[官方文档](https://help.aliyun.com/zh/model-studio/)。
- **端口占用**：默认 **8090**；与其它本地服务冲突时，请改 `main.py`（以及 `client.py` 中的 `BASE_URL`）中的端口。

## 参考资料

- [AgentScope 文档](https://doc.agentscope.io/)
- [AgentScope Runtime](https://runtime.agentscope.io/)
- [AgentRun 控制台](https://functionai.console.aliyun.com/cn-hangzhou/agent/runtime/sandbox)
- [阿里云百炼](https://bailian.console.aliyun.com/)
