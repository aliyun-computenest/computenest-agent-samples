# -*- coding: utf-8 -*-
"""DashScope（百炼）长期记忆 × AgentScope Runtime 示例（GetUserProfile / SearchMemory / AddMemory）。

安装依赖并配置环境：pip install -r requirements.txt，cp .env.example .env（至少填写 DASHSCOPE_API_KEY）。
启动服务：python main.py 或 ./server.sh start，默认监听 8090；联调可运行 client.py。
百炼 user_id 本示例写死为 demo_user；
BAILIAN_MEMORY_LIBRARY_ID / BAILIAN_MEMORY_PROJECT_ID / BAILIAN_MEMORY_PROFILE_SCHEMA 见 .env.example。
记忆 HTTPS 若报 SSL 证书类错误，见 import fastapi 前「整段注释」的补丁：启用时对该段全部去掉行首 #。"""
from __future__ import annotations

import inspect
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional, Sequence

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------- 可选：记忆 HTTPS 证书失败时，从本行起整段去掉行首「# 」启用（含最后一行调用，须在意 import fastapi 之前）----------
# _memory_ssl_patched = False
#
# def _patch_aiohttp_ssl_for_memory() -> None:
#     """给 aiohttp 套 certifi CA；须在 import fastapi 之前执行本段。依赖 requirements.txt 的 certifi。"""
#     global _memory_ssl_patched
#     if _memory_ssl_patched:
#         return
#     try:
#         import ssl
#
#         import aiohttp
#         import certifi
#     except ImportError:
#         return
#
#     _orig = aiohttp.ClientSession.__init__
#
#     def _wrap(self: Any, *args: Any, **kwargs: Any) -> None:
#         if kwargs.get("connector") is None and "connector" not in kwargs:
#             try:
#                 ctx = ssl.create_default_context(cafile=certifi.where())
#                 kwargs["connector"] = aiohttp.TCPConnector(ssl=ctx)
#             except Exception:
#                 return _orig(self, *args, **kwargs)
#         return _orig(self, *args, **kwargs)
#
#     aiohttp.ClientSession.__init__ = _wrap
#     _memory_ssl_patched = True
#
# _patch_aiohttp_ssl_for_memory()

from fastapi import FastAPI
from agentscope.agent import ReActAgent
from agentscope.formatter import DashScopeChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.model import ChatModelBase, DashScopeChatModel
from agentscope.pipeline import stream_printing_messages
from agentscope.session import JSONSession, RedisSession
from agentscope.tool import Toolkit
from agentscope_runtime.engine import AgentApp
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest
from agentscope_runtime.tools.modelstudio_memory import (
    AddMemory,
    AddMemoryInput,
    GetUserProfile,
    GetUserProfileInput,
    MemoryAPIError,
    MemoryNetworkError,
    MemoryNotFoundError,
    Message,
    SearchMemory,
    SearchMemoryInput,
)

SESSION_TYPE_JSON, SESSION_TYPE_REDIS = "json", "redis"
# 发给大模型的系统提示；后面的画像/记忆摘录会接在这段话后面。
BASE_SYS_PROMPT = "你是乐于助人的中文助手，简洁准确。若有下列摘录（画像字段与检索到的记忆），请据实使用、勿编造。"
# SearchMemory：最多返回条数、相似度下限（0~1）。需要可调这里，不必配环境变量。
SEARCH_TOP_K, SEARCH_MIN_SCORE = 8, 0.25
# 百炼长期记忆 / 画像 API 的 end user id
BAILIAN_USER_ID = "demo_user"

# ----- .env 读取 -----

def _env(k: str, default: str = "") -> str:
    return (os.getenv(k) or default).strip()


# ----- DashScope：与 conversation / travel 等相同；模型调用任意异常则 multimodality 重建并重试整次（仅一次） -----


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


# ----- 从对话消息里取出纯文本（兼容多种结构） -----

def _msg_plain(msg: Any) -> str:
    if msg is None:
        return ""
    if hasattr(msg, "get_text_content"):
        return (msg.get_text_content() or "").strip()
    if isinstance(msg, dict):
        c = msg.get("content")
        if isinstance(c, str):
            return c.strip()
        if isinstance(c, list):
            parts: list[str] = []
            for b in c:
                if isinstance(b, str):
                    parts.append(b)
                elif isinstance(b, dict):
                    parts.append(str(b.get("text") or ""))
            return "\n".join(p for p in parts if p).strip()
        if isinstance(c, dict):
            return str(c.get("text") or "").strip()
    return str(msg).strip()


def _latest_user_q(msgs: Any) -> str:
    if msgs is None:
        return ""
    seq: Sequence[Any] = msgs if isinstance(msgs, list) else [msgs]
    for m in reversed(seq):
        role = getattr(m, "role", None) or (m.get("role") if isinstance(m, dict) else None)
        if role == "user" and (t := _msg_plain(m)):
            return t
    return ""


async def _last_user_assistant(agent: Any) -> tuple[str, str]:
    mem = await agent.memory.get_memory()
    if not mem:
        return "", ""
    ai_i: Optional[int] = None
    ai_t = ""
    for i in range(len(mem) - 1, -1, -1):
        if getattr(mem[i], "role", None) == "assistant" and (t := _msg_plain(mem[i])):
            ai_i, ai_t = i, t
            break
    if ai_i is None:
        return "", ""
    for j in range(ai_i - 1, -1, -1):
        if getattr(mem[j], "role", None) == "user" and (t := _msg_plain(mem[j])):
            return t, ai_t
    return "", ""

# ----- 调用百炼记忆 API 时，把 .env 里可选参数并进请求体（有则带、无则不带） -----

def _mem_extra(body: dict, *, add_pass: bool = False) -> dict:
    o = dict(body)
    if x := _env("BAILIAN_MEMORY_LIBRARY_ID"):
        o["memory_library_id"] = x
    if x := _env("BAILIAN_MEMORY_PROJECT_ID"):
        o["project_id"] = x
    if add_pass and "profile_schema" not in o and (x := _env("BAILIAN_MEMORY_PROFILE_SCHEMA")):
        o["profile_schema"] = x
    return o

# ----- 百炼：拉用户画像（GetUserProfile）→ 转成若干行文字塞进系统提示 -----

async def _get_profile_lines(uid: str, schema: str) -> list[str]:
    data: dict = {"schema_id": schema, "user_id": uid}
    if (lib := _env("BAILIAN_MEMORY_LIBRARY_ID")) and "memory_library_id" in GetUserProfileInput.model_fields:
        data["memory_library_id"] = lib
    inp = GetUserProfileInput.model_validate(data)
    t = GetUserProfile()
    try:
        p = (await t.arun(inp)).profile
        return [
            f"- {a.name}: {(str(a.value).strip() if a.value is not None else '') or '（空）'}"
            for a in p.attributes
        ]
    except MemoryNotFoundError:
        return []
    except (MemoryAPIError, MemoryNetworkError, ValueError) as e:
        logger.warning("GetUserProfile: %s", e)
        return []
    finally:
        await t.close()

# ----- 百炼：按当前用户问题做记忆检索（SearchMemory）-----

async def _search_snips(uid: str, q: str, top_k: int, min_s: float) -> list[str]:
    if not q.strip():
        return []
    top_k, min_s = max(1, min(20, top_k)), max(0.0, min(1.0, min_s))
    s = SearchMemory()
    try:
        out = await s.arun(
            SearchMemoryInput.model_validate(
                _mem_extra(
                    {
                        "user_id": uid,
                        "messages": [Message(role="user", content=q)],
                        "top_k": top_k,
                        "min_score": min_s,
                    },
                ),
            ),
        )
        return [n.content for n in out.memory_nodes if getattr(n, "content", None)]
    except (MemoryAPIError, MemoryNetworkError, ValueError) as e:
        logger.warning("SearchMemory: %s", e)
        return []
    finally:
        await s.close()

# ----- 百炼：把本轮「用户一句 + 助手一句」写入记忆库（AddMemory），可选更新画像 -----

async def _add_turn(uid: str, u: str, a: str, pschema: Optional[str]) -> None:
    if not u.strip() or not a.strip():
        return
    body: dict = {
        "user_id": uid,
        "messages": [Message(role="user", content=u), Message(role="assistant", content=a)],
    }
    if pschema:
        body["profile_schema"] = pschema
    m = AddMemory()
    try:
        await m.arun(AddMemoryInput.model_validate(_mem_extra(body, add_pass=True)))
    except (MemoryAPIError, MemoryNetworkError, ValueError) as e:
        logger.warning("AddMemory: %s", e)
    finally:
        await m.close()

# ----- 服务启动/关闭时：会话状态落本地 JSON 目录，或 Redis（由 SESSION_TYPE 决定）-----

@asynccontextmanager
async def lifespan(app: FastAPI):
    st = (_env("SESSION_TYPE") or SESSION_TYPE_JSON).lower()
    if st == SESSION_TYPE_REDIS:
        url = _env("SESSION_REDIS_URL")
        if not url:
            raise RuntimeError("SESSION_TYPE=redis 需要 SESSION_REDIS_URL")
        import redis.asyncio as redis

        pool = redis.from_url(url)
        app.state.redis_client = pool
        app.state.session = RedisSession(connection_pool=pool.connection_pool)
    else:
        app.state.session = JSONSession(save_dir=str(Path(__file__).resolve().parent / "sessions"))
    yield
    if st == SESSION_TYPE_REDIS and hasattr(app.state, "redis_client"):
        await app.state.redis_client.aclose()


# Runtime 应用实例：对外提供对话接口（如 /process），并把下面 query_func 注册成处理逻辑
agent_app = AgentApp(
    app_name="dashscope_memory",
    app_description="DashScope 长期记忆（GetUserProfile / SearchMemory / AddMemory）+ Runtime 示例",
    lifespan=lifespan,
    interrupt_redis_url=_env("SESSION_REDIS_URL") or None,
)


@agent_app.query(framework="agentscope")
async def query_func(self, msgs, request: AgentRequest = None, **kwargs):
    """一次用户请求：先查画像与记忆 → 拼进系统提示 → 跑大模型 → 最后把本轮对话写回记忆库。"""
    if not (ak := _env("DASHSCOPE_API_KEY")):
        raise RuntimeError("请配置 DASHSCOPE_API_KEY")
    sid = request.session_id
    uid = BAILIAN_USER_ID
    user_text, ps = _latest_user_q(msgs), _env("BAILIAN_MEMORY_PROFILE_SCHEMA") or None

    # 1）按需拉画像、按问题检索记忆片段
    pl = await _get_profile_lines(uid, ps) if ps and uid else []
    sn = await _search_snips(uid, user_text, SEARCH_TOP_K, SEARCH_MIN_SCORE) if user_text and uid else []
    # 2）把摘录接到系统提示后，模型才能在回复里用上
    ctx = "\n".join(p for p in ("\n".join(pl) if pl else "", "\n".join(sn) if sn else "") if p)
    sys_p = BASE_SYS_PROMPT + (f"\n{ctx}" if ctx else "")

    # 3）创建本请求专用的 Agent，加载历史会话后开始流式回复
    ag = ReActAgent(
        name="memory_assistant",
        model=_build_dashscope_chat_model(
            ak,
            model_name=_env("DASHSCOPE_MODEL_NAME", "qwen-max"),
            stream=True,
        ),
        sys_prompt=sys_p,
        toolkit=Toolkit(),
        memory=InMemoryMemory(),
        formatter=DashScopeChatFormatter(),
    )
    ag.set_console_output_enabled(False)
    await agent_app.state.session.load_session_state(session_id=sid, user_id=uid, agent=ag)
    ag._sys_prompt = sys_p
    async for msg, last in stream_printing_messages(agents=[ag], coroutine_task=ag(msgs)):
        yield msg, last
    await agent_app.state.session.save_session_state(session_id=sid, user_id=uid, agent=ag)

    # 4）从 Agent 短期记忆里取出「刚结束这一轮」的用户话和助手话，写入百炼长期记忆
    lu, la = await _last_user_assistant(ag)
    turn_u, turn_a = user_text or lu, la
    if turn_u and turn_a:
        await _add_turn(uid, turn_u, turn_a, ps)


if __name__ == "__main__":
    logger.info("Starting DashScope Memory demo server...")
    agent_app.run(host="0.0.0.0", port=8090)
