# -*- coding: utf-8 -*-
"""Travel Planner Agent Service 入口。

启动时初始化 Credential 与 Agent「Travel Planner」；Workspace 注入高德 MCP。
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv()

from agentscope.agent import ContextConfig, ReActConfig
from agentscope.app import LocalWorkspaceManager, create_app
from agentscope.app.storage import (
    AgentData,
    AgentRecord,
    ChatModelConfig,
    RedisStorage,
    SessionConfig,
)
from agentscope.credential import DashScopeCredential
from agentscope.permission import PermissionContext, PermissionMode
from agentscope.state import AgentState

from tools.mcp_helpers import build_mcp_clients
from tools.prompts import TRAVEL_PLANNER_PROMPT

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("travel_planner")

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8090"))
WORKSPACE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workspaces")

USER_ID = "demo_user"
CREDENTIAL_ID = "dashscope"
CREDENTIAL_NAME = "DashScope"
AGENT_ID = "travel_planner"
AGENT_NAME = "Travel Planner"
DEFAULT_SESSION_NAME = "Default"
SYSTEM_PROMPT = TRAVEL_PLANNER_PROMPT


def redis_storage_from_env() -> RedisStorage:
    """从环境变量 SESSION_REDIS_URL 构建 Redis 存储。"""
    url = (os.getenv("SESSION_REDIS_URL") or "").strip()
    if not url:
        raise RuntimeError(
            "未设置环境变量 SESSION_REDIS_URL。"
            "请在 .env 中配置或导出该环境变量后再启动服务。",
        )
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 6379
    path = (parsed.path or "/0").lstrip("/")
    db = int(path) if path.isdigit() else 0
    password = parsed.password
    return RedisStorage(host=host, port=port, db=db, password=password)


def load_default_mcps() -> list:
    """预置高德等 MCP（连接失败时跳过）。"""
    try:
        return asyncio.run(build_mcp_clients(connect=False))
    except asyncio.CancelledError as exc:
        logger.warning("MCP 初始化跳过: %s", exc)
        return []
    except Exception as exc:  # noqa: BLE001
        logger.warning("MCP 初始化跳过: %s", exc)
        return []


async def create_credential(storage, api_key: str) -> str:
    """创建 DashScope Credential。"""
    credential_id = await storage.upsert_credential(
        USER_ID,
        DashScopeCredential(
            id=CREDENTIAL_ID,
            name=CREDENTIAL_NAME,
            api_key=api_key,
        ),
    )
    logger.info("已创建 Credential: %s", credential_id)
    return credential_id


async def create_agent(storage) -> str:
    """创建 Agent。"""
    agent_id = await storage.upsert_agent(
        USER_ID,
        AgentRecord(
            id=AGENT_ID,
            user_id=USER_ID,
            data=AgentData(
                name=AGENT_NAME,
                system_prompt=SYSTEM_PROMPT,
                context_config=ContextConfig(),
                react_config=ReActConfig(),
            ),
        ),
    )
    logger.info("已创建 Agent「%s」: %s", AGENT_NAME, agent_id)
    return agent_id


def create_default_session_enabled() -> bool:
    """是否预建默认 Session（CREATE_DEFAULT_SESSION，默认 0）。"""
    return (os.getenv("CREATE_DEFAULT_SESSION") or "0").strip() == "1"


async def create_default_session(storage) -> None:
    """预建 Session「Default」。"""
    model_name = (os.getenv("DASHSCOPE_MODEL_NAME") or "qwen3.7-max").strip()
    workspace_id = uuid.uuid4().hex
    session_record = await storage.upsert_session(
        user_id=USER_ID,
        agent_id=AGENT_ID,
        config=SessionConfig(
            name=DEFAULT_SESSION_NAME,
            workspace_id=workspace_id,
            chat_model_config=ChatModelConfig(
                type="dashscope_chat",
                credential_id=CREDENTIAL_ID,
                model=model_name,
                parameters={},
            ),
        ),
        state=AgentState(
            permission_context=PermissionContext(mode=PermissionMode("bypass")),
        ),
    )
    logger.info("已创建 Session「%s」: %s", DEFAULT_SESSION_NAME, session_record.id)


async def bootstrap(app) -> None:
    """启动时初始化 Credential 与 Agent；可选预建默认 Session。"""
    api_key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError(
            "未设置环境变量 DASHSCOPE_API_KEY。"
            "请在 .env 中配置或导出该环境变量后再启动服务。",
        )

    storage = app.state.storage

    # Step 1: Credential
    await create_credential(storage, api_key)

    # Step 2: Agent
    await create_agent(storage)

    # Step 3: 默认 Session（默认不创建，CREATE_DEFAULT_SESSION=1 时预建）
    if create_default_session_enabled():
        await create_default_session(storage)


@asynccontextmanager
async def lifespan(app):
    from agentscope.app._lifespan import lifespan as agentscope_lifespan

    async with agentscope_lifespan(app):
        await bootstrap(app)
        yield


def build_app():
    """构建 Travel Planner Agent Service。"""
    storage = redis_storage_from_env()
    workspace_manager = LocalWorkspaceManager(
        basedir=WORKSPACE_ROOT,
        default_mcps=load_default_mcps(),
    )
    app = create_app(
        storage=storage,
        workspace_manager=workspace_manager,
        title="Travel Planner",
        version="2.0.0",
    )
    app.router.lifespan_context = lifespan
    return app


app = build_app()


if __name__ == "__main__":
    import uvicorn

    logger.info("Agent Service 监听 http://%s:%s（OpenAPI: /docs）", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT)
