# -*- coding: utf-8 -*-
"""Bailian knowledge-base RAG agent powered by Google ADK."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm

from computenest.integrations.adk import BailianRagTool

SYSTEM_PROMPT = (
    "你是企业知识库问答助手。回答知识库相关问题前必须调用 "
    "retrieve_from_knowledge_base 工具检索百炼知识库；"
    "回答只能基于检索结果和当前对话上下文。"
    "如果工具没有返回相关内容，请明确说明知识库中没有检索到答案，"
    "不要编造知识库外的信息。"
)


def _env(name: str, fallback: str | None = None) -> str:
    value = os.getenv(name) or (os.getenv(fallback) if fallback else None)
    if not value:
        if fallback:
            raise RuntimeError(f"需要设置 {name} 或 {fallback}")
        raise RuntimeError(f"需要设置 {name}")
    return value


def build_model() -> LiteLlm:
    model_name = _env("DASHSCOPE_MODEL_NAME").strip()
    return LiteLlm(model=f"dashscope/{model_name}")


def build_rag_tool() -> BailianRagTool:
    return BailianRagTool(
        access_key_id=_env("ALIBABA_CLOUD_ACCESS_KEY_ID"),
        access_key_secret=_env("ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
        workspace_id=_env("BAILIAN_WORKSPACE_ID"),
        index_id=_env("BAILIAN_INDEX_ID"),
        region_id=os.getenv("BAILIAN_REGION_ID", "cn-beijing"),
    )


root_agent = Agent(
    model=build_model(),
    name="knowledge_rag",
    description="企业知识库问答智能体（Google ADK + 阿里云百炼知识库）",
    instruction=SYSTEM_PROMPT,
    tools=[build_rag_tool()],
)
