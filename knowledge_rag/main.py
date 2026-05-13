# -*- coding: utf-8 -*-
"""百练知识库检索 + Agent 服务示例

本示例演示如何将阿里云百炼知识库的检索能力封装为工具，注册到 ReActAgent 中，
并通过 AgentScope Runtime 以 FastAPI 服务形式对外提供接口。

使用前请设置以下环境变量:
    export DASHSCOPE_API_KEY="your_dashscope_api_key"      # DashScope API Key
    export BAILIAN_WORKSPACE_ID="your_workspace_id"        # 百炼工作空间 ID
    export BAILIAN_INDEX_ID="your_index_id"                # 知识库索引 ID
    export BAILIAN_REGION_ID="cn-beijing"                  # 百炼工作空间地域（默认 cn-beijing）
依赖安装:
    pip install agentscope agentscope-runtime alibabacloud-bailian20231229 python-dotenv
"""
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

from agentscope.agent import ReActAgent
from agentscope.formatter import DashScopeChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.model import DashScopeChatModel
from agentscope.pipeline import stream_printing_messages
from agentscope.session import JSONSession, RedisSession

from agentscope_runtime.engine import AgentApp
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest

from tools.rag_tool import get_rag_toolkit
from bailian_util import append_file_to_knowledge_base  # noqa: F401

# 从 .env 加载环境变量（可选，不影响系统已设置的环境变量）
load_dotenv()

# 环境变量 key
ENV_SESSION_TYPE = "SESSION_TYPE"
ENV_REDIS_URL = "SESSION_REDIS_URL"

# SESSION_TYPE 可选值
SESSION_TYPE_JSON = "json"
SESSION_TYPE_REDIS = "redis"


# ============================================================
# Step 1: 生命周期管理 & AgentApp 初始化
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """管理服务启动和关闭时的资源"""
    session_type = (os.getenv(ENV_SESSION_TYPE) or SESSION_TYPE_JSON).strip().lower()

    if session_type == SESSION_TYPE_REDIS:
        redis_url = os.getenv(ENV_REDIS_URL)
        if not redis_url:
            raise RuntimeError(
                f"SESSION_TYPE={SESSION_TYPE_REDIS} 时必须设置环境变量 {ENV_REDIS_URL}，"
                f"例如: redis://localhost:6379/0"
            )
        import redis.asyncio as redis
        redis_client = redis.from_url(redis_url)
        app.state.redis_client = redis_client
        app.state.session = RedisSession(connection_pool=redis_client.connection_pool)
    else:
        root_path = os.path.abspath(os.path.dirname(__file__))
        save_dir = os.path.join(root_path, "sessions")
        app.state.session = JSONSession(save_dir=save_dir)

    yield

    if session_type == SESSION_TYPE_REDIS and hasattr(app.state, "redis_client"):
        await app.state.redis_client.aclose()
    print("AgentApp is shutting down...")

_interrupt_redis_url = os.getenv(ENV_REDIS_URL) or None
agent_app = AgentApp(
    app_name="KnowledgeRAG",
    app_description="百练知识库检索问答智能体，具备短期记忆能力",
    lifespan=lifespan,
    interrupt_redis_url=_interrupt_redis_url,
)

# ============================================================
# Step 2: 定义请求处理逻辑
# ============================================================

@agent_app.query(framework="agentscope")
async def query_func(
    self,
    msgs,
    request: AgentRequest = None,
    **kwargs,
):
    session_id = request.session_id
    user_id = request.user_id

    toolkit = await get_rag_toolkit()

    agent = ReActAgent(
        name="知识库助手",
        sys_prompt="你是一个知识库问答助手。收到用户问题后，先调用检索工具查找相关内容，再基于检索结果回答。",
        model=DashScopeChatModel(
            "qwen-max",
            api_key=os.getenv("DASHSCOPE_API_KEY"),
            stream=True,
        ),
        formatter=DashScopeChatFormatter(),
        memory=InMemoryMemory(),
        toolkit=toolkit,
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

# ============================================================
# Step 3: 启动应用
# ============================================================

if __name__ == "__main__":
    # 启动前将预制的百炼价格文档上传到知识库
    preset_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bailian_price.md")
    if os.path.isfile(preset_file):
        print(f"[知识库] 正在上传预制文件：{preset_file}")
        append_file_to_knowledge_base(preset_file)
        print("[知识库] 预制文件上传完成！")
    else:
        print(f"[知识库] 警告：预制文件 {preset_file} 不存在，跳过上传。")

    agent_app.run(host="0.0.0.0", port=8090)
