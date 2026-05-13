# -*- coding: utf-8 -*-
"""MCP 客户端注册；配置路径为本项目 configs/mcp_config.json"""
import json
import logging
import os
import string
from typing import Optional

from agentscope.mcp import (
    HttpStatefulClient,
    HttpStatelessClient,
    StdIOStatefulClient,
)
from agentscope.tool import Toolkit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

root_path = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))


def _load_config(config_path: str) -> dict:
    try:
        if os.path.exists(config_path):
            with open(config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            logger.info("Loaded MCP configuration from %s", config_path)
            return config
        logger.warning("Configuration file %s not found, using empty config", config_path)
        return {}
    except Exception as e:
        logger.error("Error loading configuration: %s", e)
        return {}


def _expand_env_vars(value: str) -> str:
    if isinstance(value, str):
        template = string.Template(value)
        try:
            return template.substitute(os.environ)
        except KeyError as e:
            logger.warning("Environment variable not found: %s", e)
            return value
    return value


def _expand_headers(headers: Optional[dict]) -> Optional[dict]:
    if not headers or not isinstance(headers, dict):
        return headers
    return {k: _expand_env_vars(v) if isinstance(v, str) else v for k, v in headers.items()}


def _normalize_transport(server_config: dict) -> str:
    raw = (server_config.get("type") or server_config.get("transport") or "sse").strip().lower()
    return "streamable_http" if raw.replace("_", "") == "streamablehttp" else (raw or "sse")


async def _create_clients(config: dict, toolkit: Toolkit):
    server_configs = config.get("mcpServers", {})
    clients = []

    for server_name, server_config in server_configs.items():
        try:
            if "command" in server_config:
                command = server_config["command"]
                args = server_config.get("args", [])
                env = server_config.get("env", {})
                expanded_args = [_expand_env_vars(arg) for arg in args]
                expanded_env = {k: _expand_env_vars(v) for k, v in env.items()}
                client = StdIOStatefulClient(
                    name=server_name,
                    command=command,
                    args=expanded_args,
                    env=expanded_env,
                )
                await client.connect()
                await toolkit.register_mcp_client(client)

            elif "url" in server_config or "baseUrl" in server_config:
                url = _expand_env_vars(server_config.get("url") or server_config.get("baseUrl"))
                transport = _normalize_transport(server_config)
                stateful = server_config.get("stateful", True)
                headers = _expand_headers(server_config.get("headers"))
                client_kw = dict(name=server_name, transport=transport, url=url)
                if headers:
                    client_kw["headers"] = headers
                if stateful:
                    client = HttpStatefulClient(**client_kw)
                    await client.connect()
                    await toolkit.register_mcp_client(client)
                else:
                    client = HttpStatelessClient(**client_kw)
                    await toolkit.register_mcp_client(client)
            else:
                raise ValueError("Invalid server configuration")
            clients.append(client)
        except Exception as e:
            if "Invalid server configuration" in str(e):
                raise e
            logger.error("Failed to create client %s: %s", server_name, e)

    return clients


async def register_mcp_toolkit(
    toolkit: Toolkit,
    config_path: Optional[str] = None,
) -> list:
    """加载 MCP 配置并注册到 toolkit；返回客户端列表，请求结束时需 LIFO close。"""
    config_path = config_path or os.path.join(root_path, "configs", "mcp_config.json")
    config = _load_config(config_path)
    return await _create_clients(config, toolkit)


async def close_mcp_clients_lifo(clients: list) -> None:
    for client in reversed(clients):
        if hasattr(client, "close") and callable(getattr(client, "close", None)):
            try:
                await client.close()
            except Exception as e:
                logger.warning("关闭 MCP 客户端 %s 时出错: %s", getattr(client, "name", client), e)
