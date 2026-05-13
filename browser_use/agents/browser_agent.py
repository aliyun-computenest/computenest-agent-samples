# -*- coding: utf-8 -*-
"""Browser Agent"""
import os
import re
import uuid
from typing import Any, Optional

from agentscope.agent import ReActAgent
from agentscope.formatter import FormatterBase
from agentscope.memory import MemoryBase
from agentscope.message import Msg, TextBlock, ToolUseBlock
from agentscope.model import ChatModelBase
from agentscope.mcp import StdIOStatefulClient
from agentscope.tool import Toolkit
from tools.sandbox_manager import SandboxManager

_BROWSER_AGENT_DEFAULT_SYS_PROMPT = """You are a web browsing assistant. You can use browser tools to navigate websites, click elements, fill forms, and extract information from web pages.

Always be methodical and careful when interacting with web pages. After each action, observe the current state of the page before proceeding.

When you have completed the task, use the finish function to provide your final response."""

_BROWSER_AGENT_REASONING_PROMPT = """You are viewing the current website. Below is a snapshot of the current webpage.
Since you can only view the latest webpage, you must promptly summarize the current state, record needed data, and plan your next action."""


class BrowserAgent(ReActAgent):
    """
    Browser Agent that extends ReActAgent with browser-specific capabilities.

    The agent leverages MCP (Model Context Protocol) servers to access browser
    tools with Playwright, enabling sophisticated web automation tasks.

    Example:
        .. code-block:: python

            agent = BrowserAgent(
                name="web_navigator",
                model=my_chat_model,
                formatter=my_formatter,
                memory=my_memory,
                toolkit=browser_toolkit,
                start_url="https://example.com"
            )

            response = await agent.reply("Search for Python tutorials")
    """

    def __init__(
        self,
        name: str,
        model: ChatModelBase,
        formatter: FormatterBase,
        memory: MemoryBase,
        toolkit: Toolkit,
        max_iters: int = 50,
        start_url: Optional[str] = "https://www.google.com",
        sys_prompt: str = _BROWSER_AGENT_DEFAULT_SYS_PROMPT,
        reasoning_prompt: str = _BROWSER_AGENT_REASONING_PROMPT,
        max_mem_length: int = 20,
        session_dir: str = ".outputs",
    ) -> None:
        """Initialize the Browser Agent.

        Args:
            name (str):
                The unique identifier name for the agent instance.
            model (ChatModelBase):
                The chat model used for generating responses and reasoning.
            formatter (FormatterBase):
                The formatter used to convert messages into the required format
                for the model API.
            memory (MemoryBase):
                The memory component used to store and retrieve dialogue history.
            toolkit (Toolkit):
                A pre-configured toolkit containing browser tools.
            max_iters (int, optional):
                The maximum number of reasoning-acting loop iterations.
                Defaults to 50.
            start_url (Optional[str], optional):
                The initial URL to navigate to when the agent starts.
                Defaults to "https://www.google.com".
            sys_prompt (str, optional):
                The system prompt that defines the agent's behavior.
            reasoning_prompt (str, optional):
                The prompt used during the reasoning phase.
            max_mem_length (int, optional):
                Maximum memory length before summarization. Defaults to 20.
        """
        super().__init__(
            name=name,
            sys_prompt=sys_prompt,
            model=model,
            formatter=formatter,
            memory=memory,
            toolkit=toolkit,
            max_iters=max_iters,
        )

        self.session_dir = session_dir
        self.start_url = start_url
        self.reasoning_prompt = reasoning_prompt
        self.max_memory_length = max_mem_length
        self._has_initial_navigated = False

        # Register browser-specific hooks
        self.register_instance_hook(
            "pre_reply",
            "browser_agent_default_url_pre_reply",
            browser_agent_default_url_pre_reply,
        )

        self.register_instance_hook(
            "pre_reasoning",
            "browser_agent_observe_pre_reasoning",
            browser_agent_observe_pre_reasoning,
        )

        # Trim must run AFTER the snapshot is added so the count is accurate
        self.register_instance_hook(
            "pre_reasoning",
            "browser_agent_trim_memory_pre_reasoning",
            browser_agent_trim_memory_pre_reasoning,
        )

        self.register_instance_hook(
            "post_reasoning",
            "browser_agent_remove_observation_post_reasoning",
            browser_agent_remove_observation_post_reasoning,
        )

        self.register_instance_hook(
            "post_acting",
            "browser_agent_post_acting_clean_content",
            browser_agent_post_acting_clean_content,
        )

        self.register_instance_hook(
            "pre_print",
            "finish_function_pre_print_hook",
            finish_function_pre_print_hook,
        )
    
    async def setup(self, sandbox_manager: Optional["SandboxManager"] = None) -> None:
        """Connect browser client and register it with the toolkit.

        Args:
            sandbox_manager: Pre-existing SandboxManager to reuse (e.g. for a
                persistent session). When ``None``, a new sandbox is created.
        """
        if sandbox_manager is not None:
            # Reuse the caller-managed sandbox; do NOT create or destroy it.
            self.sandbox_manager = sandbox_manager
        else:
            self.sandbox_manager = SandboxManager()
            self.sandbox_manager.create(os.environ.get("AGENTRUN_TEMPLATE_ID"), 600)

        self.browser_client = StdIOStatefulClient(
            name="playwright-mcp",
            command="npx",
            args=[
                "@playwright/mcp@latest",
                "--cdp-endpoint=" + self.sandbox_manager.get_cdp_url(),
                "--output-dir=" + self.session_dir,
            ],
        )
        await self.browser_client.connect()
        await self.toolkit.register_mcp_client(self.browser_client)

    async def close(self) -> None:
        """Close the MCP browser client.

        Sandbox lifecycle is managed externally (per-session in main.py);
        this method intentionally does NOT destroy the sandbox.
        """
        await self.browser_client.close()


    async def _navigate_to_start_url(self) -> None:
        """Navigate to the configured start URL."""
        tool_call = ToolUseBlock(
            id=str(uuid.uuid4()),
            type="tool_use",
            name="browser_navigate",
            input={"url": self.start_url},
        )
        await self.toolkit.call_tool_function(tool_call)

    async def _get_snapshot_in_text(self, is_pre_observe: bool = False) -> Msg:
        """Capture a text-based snapshot of the current webpage content."""
        snapshot_tool_call = ToolUseBlock(
            type="tool_use",
            id=str(uuid.uuid4()),
            name="browser_snapshot",
            input={},
        )
        snapshot_response = await self.toolkit.call_tool_function(snapshot_tool_call)
        snapshot_str = ""
        async for chunk in snapshot_response:
            snapshot_str = chunk.content[0]["text"]

        # Cap snapshot size to avoid overflowing the model context window.
        # ~20 000 chars ≈ 5 000 tokens, leaving room for the rest of the context.
        max_snapshot_chars = 20_000
        if len(snapshot_str) > max_snapshot_chars:
            snapshot_str = snapshot_str[:max_snapshot_chars] + "\n...[snapshot truncated]"

        text = self.reasoning_prompt + "\n" + snapshot_str if is_pre_observe else snapshot_str

        return Msg(
            "user",
            content=[TextBlock(type="text", text=text)],
            role="user",
        )

    @staticmethod
    def _filter_execution_text(text: str, keep_page_state: bool = False) -> str:
        """Filter and clean browser tool execution output."""
        if not keep_page_state:
            text = re.sub(r"- Page URL.*", "", text, flags=re.DOTALL)
            text = re.sub(r"```yaml.*?```", "", text, flags=re.DOTALL)
        text = re.sub(r"```js.*?```", "", text, flags=re.DOTALL)
        text = re.sub(
            r"### New console messages.*?(?=### Page state)",
            "",
            text,
            flags=re.DOTALL,
        )
        return text.strip()


async def browser_agent_default_url_pre_reply(
    self: "BrowserAgent",
    *args: Any,
    **kwargs: Any,
) -> None:
    """Navigate to start URL if this is the first interaction."""
    if self.start_url and not self._has_initial_navigated:
        await self._navigate_to_start_url()
        self._has_initial_navigated = True


async def browser_agent_trim_memory_pre_reasoning(
    self: "BrowserAgent",
    *args: Any,
    **kwargs: Any,
) -> None:
    """Enforce max_mem_length: keep the first message (user task) + the most
    recent (max_mem_length - 1) messages.  Runs after the snapshot is added so
    the snapshot counts toward the limit and old steps are pruned first."""
    mem_msgs = await self.memory.get_memory()
    limit = max(self.max_memory_length, 3)  # always keep at least 3 slots
    if len(mem_msgs) <= limit:
        return

    # Keep: index 0 (original user task) + the last (limit-1) messages
    keep_ids = {mem_msgs[0].id} | {m.id for m in mem_msgs[-(limit - 1):]}
    to_delete = [m.id for m in mem_msgs if m.id not in keep_ids]
    if to_delete:
        await self.memory.delete(to_delete)


async def browser_agent_observe_pre_reasoning(
    self: "BrowserAgent",
    *args: Any,
    **kwargs: Any,
) -> None:
    """Get a snapshot in text before reasoning."""
    snapshot_msg = await self._get_snapshot_in_text()
    await self.memory.add(snapshot_msg)


async def browser_agent_remove_observation_post_reasoning(
    self: "BrowserAgent",
    *args: Any,
    **kwargs: Any,
) -> None:
    """Remove the snapshot msg after reasoning."""
    mem_msgs = await self.memory.get_memory()
    if len(mem_msgs) >= 2:
        await self.memory.delete([mem_msgs[-2].id])


def finish_function_pre_print_hook(
    self: "BrowserAgent",
    kwargs: dict,
) -> dict | None:
    """Check if finish_function is called and convert it to a text reply."""
    msg = kwargs["msg"]

    if isinstance(msg.content, str):
        return None

    last_response = kwargs["last"]
    if isinstance(msg.content, list):
        for i, block in enumerate(msg.content):
            if (
                block["type"] == "tool_use"
                and block["name"] == self.finish_function_name
            ):
                try:
                    text = block["input"].get("response", "")
                    msg.content[i] = TextBlock(type="text", text=text)
                    return kwargs
                except Exception:
                    pass
    return None


async def browser_agent_post_acting_clean_content(
    self: "BrowserAgent",
    *args: Any,
    **kwargs: Any,
) -> None:
    """Clean messy tool return content after acting."""
    mem_msgs = await self.memory.get_memory()
    if len(mem_msgs) == 0:
        return
    last_output_msg = mem_msgs[-1]
    for i, b in enumerate(last_output_msg.content):
        if b["type"] == "tool_result":
            for j, return_json in enumerate(b.get("output", [])):
                if isinstance(return_json, dict) and "text" in return_json:
                    cleaned = self._filter_execution_text(return_json["text"])
                    # Cap individual tool-result text to avoid context overflow
                    if len(cleaned) > 10_000:
                        cleaned = cleaned[:10_000] + "\n...[tool result truncated]"
                    last_output_msg.content[i]["output"][j]["output"] = cleaned
    await self.memory.delete([last_output_msg.id])
    await self.memory.add(last_output_msg)
