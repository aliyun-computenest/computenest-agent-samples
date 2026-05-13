# 基于 AgentScope + AgentScope Runtime 的 Hello World 对话 Agent
import inspect
import os
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from agentscope.agent import ReActAgent
from agentscope.formatter import DashScopeChatFormatter
from agentscope.model import ChatModelBase, DashScopeChatModel
from agentscope.tool import Toolkit, execute_python_code
from agentscope.pipeline import stream_printing_messages
from agentscope.memory import InMemoryMemory
from agentscope.session import JSONSession, RedisSession

from agentscope_runtime.engine import AgentApp
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest

from tools.mcp_helpers import register_mcp_toolkit


class _DashScopeChatWithMultimodalFallback(ChatModelBase):
    """默认与 ``DashScopeChatModel`` 相同；模型调用任意异常时再以 ``multimodality=True`` 重建并重试整次（仅一次）。"""

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


# 环境变量 key
ENV_SESSION_TYPE = "SESSION_TYPE"
ENV_REDIS_URL = "SESSION_REDIS_URL"

# SESSION_TYPE 可选值
SESSION_TYPE_JSON = "json"
SESSION_TYPE_REDIS = "redis"


# 1. 生命周期管理：启动时初始化 Session（短期记忆后端）
@asynccontextmanager
async def lifespan(app: FastAPI):
    """管理服务启动和关闭时的资源"""

    session_type = (os.getenv(ENV_SESSION_TYPE) or SESSION_TYPE_JSON).strip().lower()

    if session_type == SESSION_TYPE_REDIS:
        # 使用 Redis 存储会话
        redis_url = os.getenv(ENV_REDIS_URL)
        if not redis_url:
            raise RuntimeError(
                f"SESSION_TYPE={SESSION_TYPE_REDIS} 时必须设置环境变量 {ENV_REDIS_URL}，例如: redis://localhost:6379/0"
            )
        import redis.asyncio as redis
        redis_client = redis.from_url(redis_url)
        app.state.redis_client = redis_client  # 保持引用，避免连接被回收
        app.state.session = RedisSession(connection_pool=redis_client.connection_pool)
    else:
        # 默认：使用本地 JSON 文件存储（无需 Redis）
        root_path = os.path.abspath(os.path.dirname(__file__))
        save_dir = os.path.join(root_path, "sessions")
        app.state.session = JSONSession(save_dir=save_dir)

    yield

    # 若使用 Redis，关闭异步连接
    if session_type == SESSION_TYPE_REDIS and hasattr(app.state, "redis_client"):
        await app.state.redis_client.aclose()
    print("AgentApp is shutting down...")


# 2. 创建 AgentApp 实例
_interrupt_redis_url = os.getenv(ENV_REDIS_URL) or None
agent_app = AgentApp(
    app_name="Friday",
    app_description="Friday 对话智能体，具备短期记忆能力",
    lifespan=lifespan,
    interrupt_redis_url=_interrupt_redis_url,
)


async def get_toolkit():
    toolkit = Toolkit()
     # 注册tools
    # toolkit.register_tool_function(execute_python_code)

    # 注册mcp tools
    await register_mcp_toolkit(toolkit)
    return toolkit


# 3. 定义请求处理逻辑：纯对话 Agent（无工具），带会话记忆
@agent_app.query(framework="agentscope")
async def query_func(
    self,
    msgs,
    request: AgentRequest = None,
    **kwargs,
):
    session_id = request.session_id
    user_id = request.user_id

    toolkit = await get_toolkit()

    agent = ReActAgent(
        name="conversation",
        model=_build_dashscope_chat_model(
            os.getenv("DASHSCOPE_API_KEY") or "",
            model_name=os.getenv("DASHSCOPE_MODEL_NAME", "qwen-max"),
            stream=True,
        ),
        sys_prompt="你是一个智能助手，擅长用中文礼貌回复用户的问题。",
        toolkit=toolkit,  # 纯对话无工具
        memory=InMemoryMemory(),
        formatter=DashScopeChatFormatter(),
    )
    agent.set_console_output_enabled(enabled=False)

    # 加载会话状态（短期记忆）
    await agent_app.state.session.load_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )

    async for msg, last in stream_printing_messages(
        agents=[agent],
        coroutine_task=agent(msgs),
    ):
        yield msg, last

    # 保存会话状态
    await agent_app.state.session.save_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )


# 4. 启动应用
if __name__ == "__main__":
    agent_app.run(host="0.0.0.0", port=8090)
