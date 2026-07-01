"""Agent 编排逻辑 — 定义浏览器自动化 Agent 实例。"""

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
DASHSCOPE_MODEL_NAME = os.getenv("DASHSCOPE_MODEL_NAME", "qwen3.7-plus")

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


_tools = create_toolset(ToolsetType.BROWSER_USE, provider=_detect_provider())

SYSTEM_INSTRUCTION = """你是一个专业的浏览器自动化助手。你可以：
1. 根据用户指令导航到指定网页
2. 点击页面元素、填写表单、滚动页面
3. 截取页面截图并返回结果
4. 提取页面中的文本、链接和结构化数据
5. 执行多步骤的自动化浏览任务

可用能力说明：
- 页面导航：访问指定 URL，等待页面加载完成
- 元素交互：点击按钮、输入文本、悬停、选择下拉项
- 页面截图：对当前页面或全页面进行截图
- 内容提取：获取页面 HTML、标题、当前 URL
- 浏览器历史：前进、后退导航
- JavaScript 执行：在页面上下文中运行自定义脚本

工作流程建议：
1. 先导航到目标页面
2. 观察页面状态（截图或获取 HTML）
3. 根据用户需求执行交互操作
4. 验证操作结果并向用户汇报
"""

root_agent = LlmAgent(
    name="browser_use",
    model=model,
    description="浏览器自动化 Agent，支持 E2B / AgentRun 双沙箱后端",
    instruction=SYSTEM_INSTRUCTION,
    tools=_tools,
)
