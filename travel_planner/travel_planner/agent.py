# -*- coding: utf-8 -*-
"""Travel Planner Agent：高德 MCP + 内置知识库。"""
from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from computenest.integrations.adk import McpTool
from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm

SAMPLE_ROOT = Path(__file__).resolve().parent.parent
KB_DIR = SAMPLE_ROOT / "knowledgebase_docs"
MCP_CONFIG_PATH = SAMPLE_ROOT / "configs" / "mcp_config.json"

TRAVEL_PROMPT = """\
你是一个基于高级规划与反应（Plan-ReAct）架构的智能体，能够动态规划和执行复杂任务，灵活调用工具，并根据环境反馈调整策略。
你的任务是根据用户的需求，制定详细的旅行计划，推荐景点、美食、住宿，并提供实时的交通和天气信息。

## 工具使用规范与优先级
你拥有以下工具，请按此策略调用：
1. **内置知识库**：包含通用旅行安全建议，以及小众景点推荐。处理用户问题时，必须先参考知识库内容。
2. **LBS地理信息服务 (amap-maps 等 MCP)**：**所有**涉及地理位置、路线、距离、实时交通、周边搜索的需求，**必须首先调用此工具**。这是位置信息的权威来源。
3. **联网搜索**：当需要查询**最新、实时**信息时调用（如近期活动、临时闭馆通知、网红新店、最新攻略）。历史或常识性知识优先使用自身知识。

## 工作流程
1. 参考内置知识库，获取相关旅行建议和小众景点推荐。
2. 使用高德 MCP 搜索规划旅行行程、途径景点、美食推荐、酒店推荐。
3. 将以上信息进行整合，输出完整行程规划，其中每日行程**必须**包含：**上午**、**午餐**、**下午**、**晚餐**、**晚上**、**当日酒店**（餐馆和酒店都必须提供具体名称和评价情况，不可以模糊推荐）。
4. 始终遵循核心行为准则，确保输出内容专业、可靠、安全。

## 核心行为准则
1. **主动全面**：除非用户明确指定，否则规划应涵盖景点、餐饮、交通、住宿、贴士等全要素。
2. **安全可靠**：所有地理位置信息（如景点、酒店）必须通过高德地图 MCP 验证。涉及安全（如天气预警、交通管制）必须明确提醒。
3. **诚实透明**：如果信息不确定或工具未返回结果，如实告知用户，不要编造。
4. **沟通要求**：禁止直接将工具的结果直接输出给用户，你需要结合用户的问题，进行必要的润色，使回复内容更加清晰、准确、简洁。
"""


def _load_knowledge() -> str:
    chunks: list[str] = []
    if KB_DIR.is_dir():
        for path in sorted(KB_DIR.glob("*.md")):
            chunks.append(f"### 知识文件：{path.name}\n\n{path.read_text(encoding='utf-8')}")
    return "\n\n".join(chunks)


def build_model():
    model_name = (os.getenv("DASHSCOPE_MODEL_NAME") or "qwen3.7-max").strip()
    return LiteLlm(model=f"dashscope/{model_name}")


def _build_mcp_tools():
    api_key = (os.getenv("DASHSCOPE_API_KEY") or "").strip()
    mcp_config = json.loads(MCP_CONFIG_PATH.read_text(encoding="utf-8"))
    return list(McpTool(mcp_config, variables={"DASHSCOPE_API_KEY": api_key}))


root_agent = Agent(
    model=build_model(),
    name="travel_planner",
    description="智能旅行规划助手（高德 MCP + 内置知识库）",
    instruction=TRAVEL_PROMPT + "\n\n## 内置知识库\n\n" + _load_knowledge(),
    tools=_build_mcp_tools(),
)
