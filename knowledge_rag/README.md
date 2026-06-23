# Knowledge RAG - 企业知识库智能问答 Agent

基于 **Google ADK** 和 `computenest-agent-integrations` 的企业知识库问答示例，使用阿里云百炼知识库检索工具 `retrieve_from_knowledge_base` 获取相关文档片段，再由通义千问模型基于检索结果回答。

## 核心功能

- 接入阿里云百炼知识库，支持语义检索与相关度排序
- 通过 ADK Tool 调用 `BailianRagTool`
- 会话持久化：配置 `SESSION_REDIS_URL` 时直连 Redis；未配置时使用 ADK 默认内存会话
- 通过 `adk web` 提供 WebUI 与 API

## 目录结构

```text
knowledge_rag/
├── knowledge_rag/
│   ├── __init__.py
│   └── agent.py          # ADK root_agent
├── bailian_price.md      # 示例知识文档，可手动上传到百炼知识库
├── server.sh             # 本地启停脚本
├── requirements.txt      # Python 依赖
├── .env.example          # 环境变量模板
└── README.md
```

## 环境变量

| 变量名 | 说明 | 必填 | 默认值 |
| - | - | - | - |
| `DASHSCOPE_API_KEY` | DashScope / 通义千问 API Key | 是 | - |
| `DASHSCOPE_MODEL_NAME` | 模型名称 | 是 | - |
| `BAILIAN_WORKSPACE_ID` | 百炼工作空间 ID | 是 | - |
| `BAILIAN_INDEX_ID` | 百炼知识库索引 ID | 是 | - |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 阿里云 Access Key ID | 是 | - |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 阿里云 Access Key Secret | 是 | - |
| `SESSION_REDIS_URL` | Redis 地址；未设置时使用内存会话 | 否 | 无（内存） |

百炼地域固定使用 `cn-beijing`。

## 本地运行

```bash
cd samples/knowledge_rag
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env 填入真实配置
./server.sh start
```

默认访问：

```text
http://0.0.0.0:8000
```

常用命令：

```bash
./server.sh status
./server.sh restart
./server.sh stop
```

## 使用方式

启动后在 ADK Web 中选择 `knowledge_rag`，即可询问知识库内容，例如：

```text
请问 qwen3-max 的 token 费用是多少？
```

智能体会先调用 `retrieve_from_knowledge_base` 检索百炼知识库，再基于返回片段回答。若知识库没有相关内容，会明确说明未检索到答案。

## 说明

- 本示例不再自动上传 `bailian_price.md`。如需使用该示例文档，请先在百炼控制台创建知识库并上传文件，然后把对应 `BAILIAN_WORKSPACE_ID`、`BAILIAN_INDEX_ID` 写入 `.env`。
- 配置 `SESSION_REDIS_URL` 时，会话使用 `google-adk-redis` 持久化；未配置时使用 ADK 默认内存会话。

## 参考资料

- [Google ADK](https://google.github.io/adk-docs/)
- [阿里云百炼控制台](https://bailian.console.aliyun.com/)
- [阿里云百炼知识库文档](https://help.aliyun.com/zh/model-studio/user-guide/rag)
