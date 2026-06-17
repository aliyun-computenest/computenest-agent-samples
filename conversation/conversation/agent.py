# -*- coding: utf-8 -*-
"""Conversation Agent：中文多轮对话助手。"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm

SYSTEM_PROMPT = "你是一个智能助手，擅长用中文礼貌回复用户的问题。"


def build_model():
    model_name = (os.getenv("DASHSCOPE_MODEL_NAME") or "qwen3.7-max").strip()
    return LiteLlm(model=f"dashscope/{model_name}")


root_agent = Agent(
    model=build_model(),
    name="conversation",
    description="中文多轮对话助手（Google ADK 版）",
    instruction=SYSTEM_PROMPT,
)
