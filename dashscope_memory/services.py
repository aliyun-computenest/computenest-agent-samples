# -*- coding: utf-8 -*-
"""Register ADK services for dashscope_memory."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv
from google.adk.cli.service_registry import get_service_registry
from computenest.integrations.adk.memory import BailianLongTermMemoryService
from google_adk_redis import RedisMemorySessionService

load_dotenv(Path(__file__).resolve().parent / ".env")

# 库默认 TTL 1 小时；2147483647 为 Redis 上限，用作长期保留。
_REDIS_SESSION_EXPIRE_SECONDS = 2_147_483_647


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _required_env(name: str) -> str:
    value = _env(name)
    if not value:
        raise RuntimeError(f"需要设置 {name}")
    return value


def _int_env(name: str, default: int) -> int:
    raw = _env(name)
    return int(raw) if raw else default


def _float_env(name: str, default: float) -> float:
    raw = _env(name)
    return float(raw) if raw else default


def _csv_env(name: str) -> list[str]:
    return [item.strip() for item in _env(name).split(",") if item.strip()]


def _bailian_memory_factory(
    uri: str,
    **kwargs: Any,
) -> BailianLongTermMemoryService:
    """Create Bailian long-term memory service from environment variables."""
    del kwargs

    parsed = urlparse(uri)
    if parsed.scheme != "bailian":
        raise RuntimeError(f"Unsupported memory service uri: {uri}")

    project_id = (
        _env("BAILIAN_MEMORY_PROJECT_ID")
        or _env("BAILIAN_MEMORY_ADD_PROJECT_ID")
        or None
    )
    search_project_ids = _csv_env("BAILIAN_MEMORY_SEARCH_PROJECT_IDS")
    if not search_project_ids and project_id:
        search_project_ids = [project_id]

    return BailianLongTermMemoryService(
        api_key=_required_env("DASHSCOPE_API_KEY"),
        memory_library_id=_required_env("BAILIAN_MEMORY_LIBRARY_ID"),
        add_project_id=project_id,
        search_project_ids=search_project_ids or None,
        profile_schema_id=_env("BAILIAN_MEMORY_PROFILE_SCHEMA") or None,
        top_k=_int_env("BAILIAN_MEMORY_TOP_K", 8),
        min_score=_float_env("BAILIAN_MEMORY_MIN_SCORE", 0.25),
        endpoint="https://dashscope.aliyuncs.com/api/v2/apps/memory",
    )


def _redis_session_factory(uri: str, **kwargs: Any) -> RedisMemorySessionService:
    """配置了 SESSION_REDIS_URL 时，通过 redis:// 直连 Redis 持久化会话。"""
    kwargs_copy = {k: v for k, v in kwargs.items() if k != "agents_dir"}
    return RedisMemorySessionService(
        uri=uri, expire=_REDIS_SESSION_EXPIRE_SECONDS, **kwargs_copy
    )


_registry = get_service_registry()
_registry.register_memory_service("bailian", _bailian_memory_factory)
_registry.register_session_service("redis", _redis_session_factory)
