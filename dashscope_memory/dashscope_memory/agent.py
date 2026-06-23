# -*- coding: utf-8 -*-
"""DashScope long-term memory agent powered by Google ADK."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from google.adk.agents.callback_context import CallbackContext
from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools.preload_memory_tool import preload_memory_tool

logger = logging.getLogger(__name__)

BASE_INSTRUCTION = (
    "你是乐于助人的中文助手，回答要简洁准确。"
    "如果系统提供了来自用户历史对话的长期记忆，请据实使用；"
    "如果系统提供了用户画像，也应据实参考；"
    "没有相关记忆时不要编造。"
)


def build_model() -> LiteLlm:
    model_name = (
        os.getenv("DASHSCOPE_MODEL_NAME")
        or "qwen3.7-max"
    ).strip()
    return LiteLlm(model=f"dashscope/{model_name}")


def _format_user_profile(profile: dict[str, Any]) -> str:
    attributes = profile.get("attributes") or []
    lines: list[str] = []
    for attribute in attributes:
        name = str(attribute.get("name") or "").strip()
        value = attribute.get("value")
        if not name or value in (None, ""):
            continue
        lines.append(f"- {name}: {value}")
    if not lines:
        return ""
    return "<USER_PROFILE>\n" + "\n".join(lines) + "\n</USER_PROFILE>"


async def load_user_profile(callback_context: CallbackContext) -> None:
    """Load Bailian user profile once for the current ADK session."""
    if callback_context.state.get("bailian_user_profile_loaded"):
        return

    callback_context.state["bailian_user_profile_loaded"] = True
    memory_service = callback_context._invocation_context.memory_service
    if memory_service is None or not hasattr(
        memory_service,
        "get_user_profile",
    ):
        return

    user_id = callback_context._invocation_context.user_id
    profile_schema_id = os.getenv("BAILIAN_MEMORY_PROFILE_SCHEMA") or None
    try:
        profile = await memory_service.get_user_profile(
            user_id=user_id,
            profile_schema_id=profile_schema_id,
        )
    except ValueError:
        logger.debug("Bailian user profile is not configured; skip loading.")
        return
    except Exception:
        logger.exception("Failed to load Bailian user profile.")
        return

    profile_text = _format_user_profile(profile)
    callback_context.state["bailian_user_profile"] = profile_text
    if profile_text:
        logger.info("Loaded Bailian user profile for user %s", user_id)


def build_instruction(callback_context: CallbackContext) -> str:
    """Build the system instruction with session-cached user profile."""
    user_profile = callback_context.state.get("bailian_user_profile")
    if not user_profile:
        return BASE_INSTRUCTION
    return f"{BASE_INSTRUCTION}\n\n{user_profile}"


async def save_session_to_memory(callback_context: CallbackContext) -> None:
    """Persist the current session through ADK's configured memory service."""
    try:
        await callback_context.add_session_to_memory()
    except ValueError:
        logger.debug("Memory service is not configured; skip memory save.")
    except Exception:
        logger.exception("Failed to save session to long-term memory.")


root_agent = Agent(
    model=build_model(),
    name="dashscope_memory",
    description="中文长期记忆助手（Google ADK + 百炼长期记忆）",
    instruction=build_instruction,
    tools=[preload_memory_tool],
    before_agent_callback=load_user_profile,
    after_agent_callback=save_session_to_memory,
)
