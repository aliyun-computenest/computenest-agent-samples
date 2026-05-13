# 基于 AgentScope + AgentScope Runtime 的 Hello World 对话 Agent
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv

from fastapi import FastAPI
from agentscope.agent import ReActAgent
from agentscope.mcp import StdIOStatefulClient
from agentscope.model import DashScopeChatModel
from agentscope.formatter import DashScopeChatFormatter
from agentscope.tool import Toolkit, execute_python_code
from agentscope.pipeline import stream_printing_messages
from agentscope.memory import InMemoryMemory
from agentscope.session import JSONSession, RedisSession

from agentscope_runtime.engine import AgentApp
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest

from tools.mcp_helpers import register_mcp_toolkit
from agents.browser_agent import BrowserAgent
from tools.sandbox_manager import SandboxManager

# 从 .env 加载环境变量（可选，不影响系统已设置的环境变量）
load_dotenv()

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

    # Per-session sandbox registry: session_id -> SandboxManager
    # Stored on app.state so it shares the app lifecycle.
    app.state.sandboxes: dict[str, SandboxManager] = {}

    yield

    # 若使用 Redis，关闭异步连接
    if session_type == SESSION_TYPE_REDIS and hasattr(app.state, "redis_client"):
        await app.state.redis_client.aclose()

    # Destroy all active per-session sandboxes
    for mgr in list(app.state.sandboxes.values()):
        try:
            mgr.destroy()
        except Exception:
            pass
    app.state.sandboxes.clear()
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

    # Get or create the sandbox bound to this session
    sandboxes: dict[str, SandboxManager] = agent_app.state.sandboxes
    sandbox_manager = sandboxes.get(session_id)
    is_new_sandbox = sandbox_manager is None or not sandbox_manager.is_active()
    if is_new_sandbox:
        sandbox_manager = SandboxManager()
        sandbox_manager.create(os.environ.get("AGENTRUN_TEMPLATE_ID"), 600)
        sandboxes[session_id] = sandbox_manager

    # Create browser agent
    agent = BrowserAgent(
        name="BrowserBot",
        model=DashScopeChatModel(
            api_key=os.environ.get("DASHSCOPE_API_KEY"),
            model_name=os.environ.get("DASHSCOPE_MODEL_NAME", "qwen-max"),
            stream=True,
        ),
        formatter=DashScopeChatFormatter(),
        memory=InMemoryMemory(),
        toolkit=toolkit,
        max_iters=50,
        # Only navigate to start URL on the first request of a session;
        # subsequent requests should keep the browser where it is.
        start_url="https://www.baidu.com" if is_new_sandbox else None,
    )

    # Reuse the session's sandbox; a new browser client is created each time
    # but it connects to the same persistent Chrome instance.
    await agent.setup(sandbox_manager=sandbox_manager)
    
    agent.set_console_output_enabled(enabled=False)

    # Always include sandbox URLs in the first streamed message so the
    # frontend can (re-)connect to the browser viewer on every request.
    sandbox_meta = {}
    cdp_url = sandbox_manager.get_cdp_url()
    vnc_url = sandbox_manager.get_vnc_url()
    if cdp_url:
        sandbox_meta["cdp_url"] = cdp_url
    if vnc_url:
        sandbox_meta["vnc_url"] = vnc_url

    # 加载会话状态（短期记忆）
    await agent_app.state.session.load_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )

    first_msg = True
    async for msg, last in stream_printing_messages(
        agents=[agent],
        coroutine_task=agent(msgs),
    ):
        if first_msg and sandbox_meta:
            msg.metadata = {**(msg.metadata or {}), **sandbox_meta}
            first_msg = False
        yield msg, last

    # 保存会话状态
    await agent_app.state.session.save_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )
    await agent.close()


# 4. 启动应用
if __name__ == "__main__":
    agent_app.run(host="0.0.0.0", port=8090)
