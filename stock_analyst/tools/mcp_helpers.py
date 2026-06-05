# -*- coding: utf-8 -*-
"""从 mcp_config.json 构建 AgentScope 2.0 MCPClient 列表（支持百炼 streamableHttp）。"""
from __future__ import annotations

import json
import logging
import os
import string
from typing import Any

from agentscope.mcp import HttpMCPConfig, MCPClient, StdioMCPConfig

logger = logging.getLogger(__name__)

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _load_config(config_path: str) -> dict[str, Any]:
    if os.path.exists(config_path):
        with open(config_path, encoding="utf-8") as f:
            return json.load(f)
    logger.warning("MCP 配置不存在 %s，使用空配置", config_path)
    return {}


def _expand_env_vars(value: str) -> str:
    if not isinstance(value, str):
        return value
    template = string.Template(value)
    try:
        return template.substitute(os.environ)
    except KeyError as exc:
        logger.warning("环境变量未设置: %s", exc)
        return value


def _expand_headers(headers: dict[str, Any] | None) -> dict[str, str] | None:
    if not headers:
        return None
    return {
        k: _expand_env_vars(v) if isinstance(v, str) else str(v)
        for k, v in headers.items()
    }


def _resolve_http_url(server_config: dict[str, Any]) -> str:
    url = server_config.get("url") or server_config.get("baseUrl")
    if not url:
        raise ValueError("HTTP MCP 须配置 url 或 baseUrl")
    return _expand_env_vars(url)


async def build_mcp_clients(
    config_path: str | None = None,
    *,
    connect: bool = True,
) -> list[MCPClient]:
    """按 travel_planner 同款 mcp_config.json 创建 MCPClient。

    connect=False 时仅创建客户端，不在当前事件循环 connect。
    模块 import 阶段须 connect=False，避免 asyncio.run() 关闭 loop 后 MCP 会话失效。
    """
    path = config_path or os.path.join(_ROOT, "configs", "mcp_config.json")
    config = _load_config(path)
    clients: list[MCPClient] = []

    for server_name, server_config in config.get("mcpServers", {}).items():
        try:
            if "command" in server_config:
                command = server_config["command"]
                args = [_expand_env_vars(a) for a in server_config.get("args", [])]
                env = {
                    k: _expand_env_vars(v)
                    for k, v in server_config.get("env", {}).items()
                }
                client = MCPClient(
                    name=server_name,
                    is_stateful=True,
                    mcp_config=StdioMCPConfig(
                        command=command,
                        args=args,
                        env=env or None,
                    ),
                )
                if connect:
                    await client.connect()
                clients.append(client)
            elif "url" in server_config or "baseUrl" in server_config:
                url = _resolve_http_url(server_config)
                headers = _expand_headers(server_config.get("headers"))
                stateful = bool(server_config.get("stateful", True))
                client = MCPClient(
                    name=server_name,
                    is_stateful=stateful,
                    mcp_config=HttpMCPConfig(url=url, headers=headers),
                )
                if stateful and connect:
                    await client.connect()
                clients.append(client)
            else:
                raise ValueError(f"无效的 MCP 配置: {server_name}")
        except Exception:
            logger.exception("创建 MCP 客户端失败: %s", server_name)
            continue

    return clients
