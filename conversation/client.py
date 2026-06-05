# -*- coding: utf-8 -*-
"""Conversation 本地 API 测试：使用预置 Agent → 创建 Session → 发两轮对话。

先启动服务（python main.py 或 ./server.sh start），再运行本脚本。
每次运行都会创建新 Session。
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid

import httpx
from dotenv import load_dotenv

load_dotenv()

_port = (os.getenv("PORT") or "8090").strip()
BASE_URL = f"http://127.0.0.1:{_port}".rstrip("/")
USER_ID = "demo_user"
# 与 main.py 预置 id 一致
AGENT_ID = "conversation"
CREDENTIAL_ID = "dashscope"


def headers() -> dict[str, str]:
    return {"X-User-ID": USER_ID, "Content-Type": "application/json"}


async def get_agent_id(client: httpx.AsyncClient) -> str:
    return AGENT_ID


async def get_session_id(client: httpx.AsyncClient, agent_id: str) -> str:
    model_name = (os.getenv("DASHSCOPE_MODEL_NAME") or "qwen3.7-max").strip()
    session_name = f"chat-{uuid.uuid4().hex[:8]}"
    workspace_id = uuid.uuid4().hex

    session_resp = await client.post(
        "/sessions/",
        headers=headers(),
        json={
            "agent_id": agent_id,
            "name": session_name,
            "workspace_id": workspace_id,
            "chat_model_config": {
                "type": "dashscope_chat",
                "credential_id": CREDENTIAL_ID,
                "model": model_name,
                "parameters": {},
            },
        },
    )
    session_resp.raise_for_status()
    return session_resp.json()["session_id"]


async def chat(
    client: httpx.AsyncClient,
    agent_id: str,
    session_id: str,
    text: str,
) -> None:
    print(f"\n[user] {text}\n[assistant]", end="", flush=True)
    async with client.stream(
        "POST",
        "/chat/",
        headers=headers(),
        json={
            "agent_id": agent_id,
            "session_id": session_id,
            "input": {
                "role": "user",
                "name": "user",
                "content": [{"type": "text", "text": text}],
            },
        },
    ) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload:
                continue
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "TEXT_BLOCK_DELTA":
                print(event.get("delta", ""), end="", flush=True)
            elif event.get("type") == "REPLY_END":
                print()


async def main() -> None:
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=120.0) as client:
        # Step 0: 获取 Agent
        agent_id = await get_agent_id(client)

        # Step 1: 创建 Session
        session_id = await get_session_id(client, agent_id)

        # Step 2: 流式对话（同一会话内发两轮消息）
        print(f"agent_id={agent_id} session_id={session_id}")
        await chat(client, agent_id, session_id, "我叫 AgentScope")
        await chat(client, agent_id, session_id, "你还记得我叫什么吗？")


if __name__ == "__main__":
    asyncio.run(main())
