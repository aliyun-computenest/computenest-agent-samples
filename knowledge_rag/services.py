# -*- coding: utf-8 -*-
"""Register ADK service backends for knowledge_rag."""
from __future__ import annotations

from google.adk.cli.service_registry import get_service_registry
from google_adk_redis import RedisMemorySessionService


# 库默认 TTL 1 小时；2147483647 为 Redis 上限，用作长期保留。
_REDIS_SESSION_EXPIRE_SECONDS = 2_147_483_647


def _redis_session_factory(uri: str, **kwargs):
    """配置了 SESSION_REDIS_URL 时，通过 redis:// 直连 Redis 持久化会话。"""
    kwargs_copy = {k: v for k, v in kwargs.items() if k != "agents_dir"}
    return RedisMemorySessionService(
        uri=uri, expire=_REDIS_SESSION_EXPIRE_SECONDS, **kwargs_copy
    )


_registry = get_service_registry()
_registry.register_session_service("redis", _redis_session_factory)
