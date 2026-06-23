# DashScope 长期记忆 - ADK 版

基于 [Google ADK](https://github.com/google/adk-python) 与 `computenest-agent-integrations` 的中文长期记忆示例。启动 `adk web` 后加载 Agent `dashscope_memory`，每轮对话前通过百炼长期记忆检索历史片段并注入模型上下文，每轮结束后把本轮会话写回百炼长期记忆。

**英文说明**：[README_en.md](README_en.md)。

## 这是什么

- Google ADK Agent：单端口 **8000**，含内置 Web UI 与 `/run_sse` API
- 百炼长期记忆：使用 `BailianLongTermMemoryService` 读写记忆库
- 自动记忆检索：通过 ADK `preload_memory_tool` 在模型调用前检索相关历史
- 用户画像注入：配置画像 schema 后，在模型调用前读取用户画像并注入系统指令
- 自动记忆写入：Agent 回合结束后调用 ADK memory service 保存本轮会话
- 会话持久化：配置 `SESSION_REDIS_URL` 时直连 Redis；未配置时使用 ADK 默认内存会话

## 目录结构

```text
dashscope_memory/
├── dashscope_memory/
│   ├── __init__.py        # 包标识，暴露 root_agent
│   └── agent.py           # Agent 定义（name="dashscope_memory"）
├── services.py            # 注册 Bailian Memory 后端
├── server.sh              # 启停脚本（本地 / 容器）
├── requirements.txt       # Python 依赖
├── .env.example           # 环境变量示例
├── .dockerignore
├── README.md
└── README_en.md
```

## 本地运行

**环境要求**

- Python >= 3.12
- DashScope API Key
- 已在百炼控制台创建长期记忆库，并取得 `BAILIAN_MEMORY_LIBRARY_ID`

**安装与启动**

```bash
cd samples/dashscope_memory
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# 编辑 .env：填写 DASHSCOPE_API_KEY 和 BAILIAN_MEMORY_LIBRARY_ID

chmod +x server.sh
./server.sh start
```

- Web UI：http://127.0.0.1:8000
- API 文档：http://127.0.0.1:8000/docs

验证应用加载：

```bash
curl -fsS http://127.0.0.1:8000/list-apps
# 期望返回 ["dashscope_memory"]
```

## 环境变量

| 变量 | 必填 | 说明 | 默认 |
|------|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 百炼 API Key，用于模型与长期记忆 API | 无 |
| `BAILIAN_MEMORY_LIBRARY_ID` | 是 | 百炼长期记忆库 ID | 无 |
| `DASHSCOPE_MODEL_NAME` | 否 | 对话模型 | `qwen-max` |
| `BAILIAN_MEMORY_PROJECT_ID` | 否 | 写入记忆时绑定的百炼项目 ID；未配置则不带 project | 无 |
| `BAILIAN_MEMORY_SEARCH_PROJECT_IDS` | 否 | 检索记忆时限定的项目 ID，英文逗号分隔；未配置时复用 `BAILIAN_MEMORY_PROJECT_ID` | 无 |
| `BAILIAN_MEMORY_PROFILE_SCHEMA` | 否 | 百炼用户画像 schema ID；配置后写入记忆时更新画像，回答前读取画像 | 无 |
| `BAILIAN_MEMORY_TOP_K` | 否 | 记忆检索条数 | `8` |
| `BAILIAN_MEMORY_MIN_SCORE` | 否 | 记忆检索相似度下限 | `0.25` |
| `BAILIAN_MEMORY_ENDPOINT` | 否 | 百炼长期记忆 API endpoint | `https://dashscope.aliyuncs.com/api/v2/apps/memory` |
| `PORT` | 否 | HTTP 监听端口 | `8000` |
| `LOG_LEVEL` | 否 | 日志级别 | `INFO` |
| `SESSION_REDIS_URL` | 否 | Redis 地址；未设置时使用内存会话 | 无（内存） |

## 计算巢部署

通过阿里云计算巢可一键部署本示例，无需在本地安装环境：

1. 打开 [计算巢 DashScope 长期记忆示例部署页](https://computenest.console.aliyun.com/agent/deploy/cn-hangzhou/DashScopeMemory?serviceId=service-693904e6ce8943f49a3b&TemplateName=%E5%B8%82%E5%9C%BA%E6%A8%A1%E6%9D%BF)，点击「立即部署」。
2. 填写 `DASHSCOPE_API_KEY`、`BAILIAN_MEMORY_LIBRARY_ID` 等参数并创建实例。
3. 在实例页「应用输出」查看 WebUI 访问地址和 API 调用示例。

## 参考

- [Google ADK Python](https://github.com/google/adk-python)
- [computenest-agent-integrations](https://pypi.org/project/computenest-agent-integrations/)
- 百炼长期记忆与控制台配置以阿里云官方文档为准。
