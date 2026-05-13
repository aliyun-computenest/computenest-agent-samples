# 基于 AgentScope + AgentScope Runtime 的智能旅行规划 Agent
import inspect
import os
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from agentscope.agent import ReActAgent
from agentscope.formatter import DashScopeChatFormatter
from agentscope.model import ChatModelBase, DashScopeChatModel
from agentscope.tool import Toolkit
from agentscope.pipeline import stream_printing_messages
from agentscope.memory import InMemoryMemory
from agentscope.session import JSONSession, RedisSession

from agentscope_runtime.engine import AgentApp
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest

from tools.mcp_helpers import register_mcp_toolkit, close_mcp_clients_lifo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class _DashScopeChatWithMultimodalFallback(ChatModelBase):
    """模型调用任意异常时以 ``multimodality=True`` 重建并重试整次（仅一次）。"""
    def __init__(self, model_name: str, api_key: str, stream: bool = True, **kwargs: Any) -> None:
        super().__init__(model_name, stream)
        self._api_key = api_key
        self._kw = dict(kwargs)
        self._core = DashScopeChatModel(
            model_name=model_name,
            api_key=api_key,
            stream=stream,
            **kwargs,
        )
        self._retried = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._core, name)

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        try:
            out = await self._core(*args, **kwargs)
        except Exception:
            if self._retried:
                raise
            self._retried = True
            self._core = DashScopeChatModel(
                model_name=self.model_name,
                api_key=self._api_key,
                stream=self.stream,
                multimodality=True,
                **self._kw,
            )
            return await self._core(*args, **kwargs)
        if self.stream and inspect.isasyncgen(out):
            return self._stream_with_retry(out, args, kwargs)
        return out

    async def _stream_with_retry(self, agen: Any, call_args: tuple[Any, ...], call_kw: dict[str, Any]):
        try:
            async for item in agen:
                yield item
        except Exception:
            if self._retried:
                raise
            self._retried = True
            self._core = DashScopeChatModel(
                model_name=self.model_name,
                api_key=self._api_key,
                stream=self.stream,
                multimodality=True,
                **self._kw,
            )
            out2 = await self._core(*call_args, **call_kw)
            if not inspect.isasyncgen(out2):
                raise RuntimeError("DashScope 多模态重试后仍非流式响应") from None
            async for item in out2:
                yield item


def _build_dashscope_chat_model(
    api_key: str,
    *,
    model_name: str | None = None,
    stream: bool = True,
    **extra: Any,
) -> _DashScopeChatWithMultimodalFallback:
    n = (model_name or os.getenv("DASHSCOPE_MODEL_NAME") or "qwen-max").strip()
    return _DashScopeChatWithMultimodalFallback(model_name=n, api_key=api_key, stream=stream, **extra)


ENV_SESSION_TYPE = "SESSION_TYPE"
ENV_REDIS_URL = "SESSION_REDIS_URL"
SESSION_TYPE_JSON = "json"
SESSION_TYPE_REDIS = "redis"

# 知识库实例缓存（首次请求时按需构建）
_knowledge_cache = None
# 长期记忆实例缓存
_long_term_memory_cache = None

# 旅行规划系统提示词
TRAVEL_PLANNER_PROMPT = """
你是一个基于高级规划与反应（Plan-ReAct）架构的智能体，能够动态规划和执行复杂任务，灵活调用工具，并根据环境反馈调整策略。
你的任务是根据用户的需求，制定详细的旅行计划，推荐景点、美食、住宿，并提供实时的交通和天气信息。

## 工具使用规范与优先级
你拥有以下工具，请按此策略调用：
1. **知识库 (knowledgebase)**：你的知识库包含了通用旅行安全建议，以及小众景点推荐。处理用户问题时，必须先检索知识库。
2. **记忆库 (long_term_memory)**：在对话开始时，自动读取用户档案；在对话结束时，如有新偏好，询问用户后存入记忆。
3. **LBS地理信息服务 (amap_tool)**：**所有**涉及地理位置、路线、距离、实时交通、周边搜索的需求，**必须首先调用此工具**。这是位置信息的权威来源。
4. **联网搜索**：当需要查询**最新、实时**信息时调用（如近期活动、临时闭馆通知、网红新店、最新攻略）。历史或常识性知识优先使用自身知识。

## 工作流程
1. 检索知识库，获取相关旅行建议和小众景点推荐。
2. 读取长期记忆，了解用户偏好（如预算、兴趣、过敏等）。
3. 使用 amap_tool 搜索规划旅行行程、途径景点、美食推荐、酒店推荐。
4. 将以上信息进行整合，输出完整行程规划，其中每日行程**必须**包含：**上午**、**午餐**、**下午**、**晚餐**、**晚上**、**当日酒店**（餐馆和酒店都必须提供具体名称和评价情况，不可以模糊推荐）。
5. 在对话结束时，询问用户是否保存新的偏好到长期记忆。如果用户同意，保存新的偏好到长期记忆。
6. 始终遵循核心行为准则，确保输出内容专业、可靠、安全。

## 核心行为准则
1. **主动全面**：除非用户明确指定，否则规划应涵盖景点、餐饮、交通、住宿、贴士等全要素。
2. **安全可靠**：所有地理位置信息（如景点、酒店）必须通过高德地图工具 amap_tool 验证。涉及安全（如天气预警、交通管制）必须明确提醒。
3. **诚实透明**：如果信息不确定或工具未返回结果，如实告知用户，不要编造。
4. **记忆与个性**：积极利用记忆工具，记住用户的关键偏好（如预算、喜好、厌恶），使推荐越用越懂。
5. **沟通要求**：禁止直接将工具的结果直接输出给用户，你需要结合用户的问题，进行必要的润色，使回复内容更加清晰、准确、简洁。
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    """管理服务启动和关闭时的资源（Session 短期记忆后端）"""
    session_type = (os.getenv(ENV_SESSION_TYPE) or SESSION_TYPE_JSON).strip().lower()
    if session_type == SESSION_TYPE_REDIS:
        redis_url = os.getenv(ENV_REDIS_URL)
        if not redis_url:
            raise RuntimeError(
                f"SESSION_TYPE={SESSION_TYPE_REDIS} 时必须设置环境变量 {ENV_REDIS_URL}"
            )
        import redis.asyncio as redis
        redis_client = redis.from_url(redis_url)
        app.state.redis_client = redis_client
        app.state.session = RedisSession(connection_pool=redis_client.connection_pool)
    else:
        root_path = Path(__file__).resolve().parent
        save_dir = root_path / "sessions"
        app.state.session = JSONSession(save_dir=str(save_dir))

    yield

    if session_type == SESSION_TYPE_REDIS and hasattr(app.state, "redis_client"):
        await app.state.redis_client.aclose()
    logger.info("Travel Planner AgentApp is shutting down...")


_interrupt_redis_url = os.getenv(ENV_REDIS_URL) or None
agent_app = AgentApp(
    app_name="travel_planner_advanced",
    app_description="智能旅行规划智能体：行程规划、景点/美食/住宿推荐、LBS 与知识库",
    lifespan=lifespan,
    interrupt_redis_url=_interrupt_redis_url,
)


async def _build_knowledge():
    """从 knowledgebase_docs 目录下的 Markdown 构建本地知识库（SimpleKnowledge + Qdrant 内存）。"""
    global _knowledge_cache
    if _knowledge_cache is not None:
        return _knowledge_cache

    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        logger.warning("未设置 DASHSCOPE_API_KEY，跳过知识库构建")
        return None

    try:
        from agentscope.rag import TextReader, SimpleKnowledge, QdrantStore
        from agentscope.embedding import DashScopeTextEmbedding

        root = Path(__file__).resolve().parent
        docs_dir = root / "knowledgebase_docs"
        if not docs_dir.is_dir():
            logger.warning("知识库目录不存在: %s", docs_dir)
            return None

        reader = TextReader(chunk_size=512, split_by="paragraph")
        all_docs = []

        for path in sorted(docs_dir.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8")
                docs = await reader(text=text)
                all_docs.extend(docs)
            except Exception as e:
                logger.warning("读取知识库文件 %s 失败: %s", path, e)

        if not all_docs:
            logger.warning("未加载到任何知识库文档")
            return None

        embedding_model = DashScopeTextEmbedding(
            api_key=api_key,
            model_name="text-embedding-v3",
            dimensions=1536,
        )
        knowledge = SimpleKnowledge(
            embedding_model=embedding_model,
            embedding_store=QdrantStore(
                location=":memory:",
                collection_name="travel_knowledge",
                dimensions=1536,
            ),
        )
        await knowledge.add_documents(all_docs)
        _knowledge_cache = knowledge
        logger.info("知识库已构建，共 %s 个文档块", len(all_docs))
        return knowledge
    except Exception as e:
        logger.exception("构建知识库失败: %s", e)
        return None


async def get_knowledge():
    """获取（按需构建并缓存）知识库实例。"""
    return await _build_knowledge()


def _get_long_term_memory():
    """若设置了 DASHSCOPE_API_KEY 且启用长期记忆，返回 Mem0LongTermMemory（基于 DashScope model/embedding），否则返回 None。"""
    global _long_term_memory_cache
    if _long_term_memory_cache is not None:
        return _long_term_memory_cache

    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key or os.getenv("TRAVEL_PLANNER_USE_LONG_TERM_MEMORY", "").strip().lower() not in ("1", "true", "yes"):
        return None

    try:
        from agentscope.memory import Mem0LongTermMemory
        from agentscope.embedding import DashScopeTextEmbedding

        _long_term_memory_cache = Mem0LongTermMemory(
            agent_name=agent_app.app_name,
            user_name="default_user",  # 多用户场景可改为按 request.user_id 创建或使用 ReMe
            model=_build_dashscope_chat_model(
                api_key,
                model_name=os.getenv("DASHSCOPE_MODEL_NAME", "qwen-max"),
                stream=False,
            ),
            embedding_model=DashScopeTextEmbedding(
                model_name="text-embedding-v3",
                api_key=api_key,
                dimensions=1536,
            ),
            on_disk=False,
        )
        logger.info("已启用 Mem0 长期记忆")
        return _long_term_memory_cache
    except Exception as e:
        logger.warning("初始化 Mem0 长期记忆失败: %s", e)
        return None


async def get_toolkit(knowledge=None):
    """获取 Toolkit：注册高德 MCP，可选注册知识库检索工具。返回 (toolkit, mcp_clients)，调用方需在同一 task 内对 mcp_clients 做 LIFO 关闭。"""
    toolkit = Toolkit()
    mcp_clients = await register_mcp_toolkit(toolkit)

    if knowledge is not None:
        toolkit.register_tool_function(
            knowledge.retrieve_knowledge,
            func_description=(
                "从旅行知识库中检索与给定查询相关的文档。"
                "处理用户问题时，应先使用本工具获取旅行安全建议、小众景点推荐等知识。"
            ),
        )
    return toolkit, mcp_clients


@agent_app.query(framework="agentscope")
async def query_func(
    self,
    msgs,
    request: AgentRequest = None,
    **kwargs,
):
    """旅行规划请求处理：ReActAgent + 知识库 + 高德 MCP + 可选长期记忆 + 会话持久化。"""
    session_id = request.session_id
    user_id = request.user_id

    knowledge = await get_knowledge()
    toolkit, mcp_clients = await get_toolkit(knowledge)
    long_term_memory = _get_long_term_memory()

    model_name = os.getenv("DASHSCOPE_MODEL_NAME", "qwen-max")
    agent_kw = {
        "name": "travel_planner_advanced",
        "model": _build_dashscope_chat_model(
            os.getenv("DASHSCOPE_API_KEY") or "",
            model_name=model_name,
            stream=True,
        ),
        "sys_prompt": TRAVEL_PLANNER_PROMPT,
        "formatter": DashScopeChatFormatter(),
        "toolkit": toolkit,
        "memory": InMemoryMemory(),
    }
    if long_term_memory is not None:
        agent_kw["long_term_memory"] = long_term_memory
        agent_kw["long_term_memory_mode"] = "agent_control"
    agent = ReActAgent(**agent_kw)
    agent.set_console_output_enabled(enabled=False)

    await agent_app.state.session.load_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )

    try:
        async for msg, last in stream_printing_messages(
            agents=[agent],
            coroutine_task=agent(msgs),
        ):
            yield msg, last
    finally:
        # 在同一请求 task 内关闭 MCP 客户端，避免 anyio cancel scope 跨 task 报错
        await close_mcp_clients_lifo(mcp_clients)

    await agent_app.state.session.save_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )


if __name__ == "__main__":
    logger.info("Starting Travel Planner Agent Server...")
    agent_app.run(host="0.0.0.0", port=8090)
