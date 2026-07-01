"""Agent 编排逻辑 — 定义代码执行 Agent 实例。"""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm

from computenest.integrations.adk.tools import (
    SandboxProvider,
    ToolsetType,
    create_toolset,
)

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger(__name__)

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
DASHSCOPE_MODEL_NAME = os.getenv("DASHSCOPE_MODEL_NAME", "qwen3-plus")

model = LiteLlm(
    model=f"openai/{DASHSCOPE_MODEL_NAME}",
    api_key=DASHSCOPE_API_KEY,
    api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
)


def _detect_provider() -> SandboxProvider:
    """根据环境变量显式判断沙箱提供商。

    - E2B_API_KEY 非空        → SandboxProvider.E2B
    - AGENTRUN_ACCOUNT_ID 非空 → SandboxProvider.AGENT_RUN
    - 两者均未设置       → RuntimeError
    """
    if os.getenv("E2B_API_KEY", "").strip():
        return SandboxProvider.E2B
    if os.getenv("AGENTRUN_ACCOUNT_ID", "").strip():
        return SandboxProvider.AGENT_RUN
    raise RuntimeError(
        "未检测到沙箱提供商配置。请设置 E2B_API_KEY（E2B 沙箱）或 AGENTRUN_ACCOUNT_ID（AgentRun 沙箱）。"
    )


_tools = create_toolset(ToolsetType.CODE_INTERPRETER, provider=_detect_provider())

SYSTEM_INSTRUCTION = """你是一个专业的代码编写与执行助手。你可以：
1. 根据用户需求编写代码
2. 在隔离沙箱中执行代码并返回结果
3. 在沙箱中安装依赖包（如 pip install）
4. 在沙箱中读写文件
5. 解释代码执行结果

可用能力说明：
- 代码执行：在沙箱 kernel 中运行 Python 代码，支持通过上下文 ID 保持变量跨调用
- 持久化上下文：创建执行上下文后，在同一上下文内多次执行可共享变量与 import
- Shell 命令：执行 shell 命令，如安装依赖、查看目录等
- 文件操作：在沙箱内读写文件、列目录、创建/删除目录与文件

工作流程建议：
1. 直接执行代码（沙箱按需自动创建）
2. 如需多步骤保持变量，先创建上下文，再在同一上下文中执行多段代码
3. 如需安装依赖，通过 shell 命令执行 pip install
"""

root_agent = LlmAgent(
    name="code_executor",
    model=model,
    description="代码编写与沙箱执行 Agent，支持 E2B / AgentRun 双沙箱后端",
    instruction=SYSTEM_INSTRUCTION,
    tools=_tools,
)
