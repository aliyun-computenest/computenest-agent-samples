# -*- coding: utf-8 -*-
"""基于 AgentScope + Runtime 的舆情 Deep Research 示例（百炼联网搜索 MCP）。

编排逻辑见 `agent.OpinionDeepResearchAgent`：子任务分解 → 程序化多轮搜索 →
续搜判断 → 中间摘要 → 终稿流式输出。
"""
import inspect
import logging
import os
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI

from agentscope.formatter import DashScopeChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.model import ChatModelBase, DashScopeChatModel
from agentscope.pipeline import stream_printing_messages
from agentscope.session import JSONSession, RedisSession
from agentscope.tool import Toolkit, execute_python_code, view_text_file, write_text_file

from agentscope_runtime.engine import AgentApp
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest

from agent import OpinionDeepResearchAgent
from tools.mcp_helpers import close_mcp_clients_lifo, register_mcp_toolkit

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class _DashScopeChatWithMultimodalFallback(ChatModelBase):
    """模型调用任意异常时以 ``multimodality=True`` 重建并重试整次（仅一次）。"""
    def __init__(self, model_name: str, api_key: str, stream: bool = True, **kwargs: Any) -> None:
        super().__init__(model_name, stream)
        self._api_key = api_key
        self._kw = dict(kwargs)
        self._core = DashScopeChatModel(
            model_name=model_name,
            api_key=api_key,
            stream=stream,
            **kwargs,
        )
        self._retried = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._core, name)

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        try:
            out = await self._core(*args, **kwargs)
        except Exception:
            if self._retried:
                raise
            self._retried = True
            self._core = DashScopeChatModel(
                model_name=self.model_name,
                api_key=self._api_key,
                stream=self.stream,
                multimodality=True,
                **self._kw,
            )
            return await self._core(*args, **kwargs)
        if self.stream and inspect.isasyncgen(out):
            return self._stream_with_retry(out, args, kwargs)
        return out

    async def _stream_with_retry(self, agen: Any, call_args: tuple[Any, ...], call_kw: dict[str, Any]):
        try:
            async for item in agen:
                yield item
        except Exception:
            if self._retried:
                raise
            self._retried = True
            self._core = DashScopeChatModel(
                model_name=self.model_name,
                api_key=self._api_key,
                stream=self.stream,
                multimodality=True,
                **self._kw,
            )
            out2 = await self._core(*call_args, **call_kw)
            if not inspect.isasyncgen(out2):
                raise RuntimeError("DashScope 多模态重试后仍非流式响应") from None
            async for item in out2:
                yield item


def _build_dashscope_chat_model(
    api_key: str,
    *,
    model_name: str | None = None,
    stream: bool = True,
    **extra: Any,
) -> _DashScopeChatWithMultimodalFallback:
    n = (model_name or os.getenv("DASHSCOPE_MODEL_NAME") or "qwen-max").strip()
    return _DashScopeChatWithMultimodalFallback(model_name=n, api_key=api_key, stream=stream, **extra)


ENV_SESSION_TYPE = "SESSION_TYPE"
ENV_REDIS_URL = "SESSION_REDIS_URL"
SESSION_TYPE_JSON = "json"
SESSION_TYPE_REDIS = "redis"

WORKSPACE_DIR = Path(__file__).resolve().parent / "workspace"

OPINION_DEEP_RESEARCH_PROMPT = """
你是**舆情深度研究（Deep Research）**助理，在 **Plan-ReAct** 框架下工作。你的目标是：通过**多轮联网检索、交叉核对与缺口补充**，形成结构化、可追溯的舆情研判；**不得使用 Tavily**；检索仅依赖当前工具集中由 **百炼 WebSearch MCP** 提供的联网搜索类工具。

## 重要声明（必须遵守）
1. **内容性质**：输出由 AI 根据检索摘要整理，**仅供参考**，不构成法律、投资或公关处置意见；重要决策需人工核实原始材料。
2. **禁止编造**：事实、数据、直接引语须能在当次检索结果中找到依据；检索未覆盖的维度须明确写「未检索到 / 信息不足」，**不可臆造来源或截图内容**。
3. **合规与伦理**：不煽动对立；不泄露或可推断个人隐私；对未经证实的传言标注为「未经证实」；尊重平台与著作权说明。
4. **工具边界**：`execute_python_code` 仅对已获得的文本/列表做统计、分词频次等辅助，**输入数据须来自检索或用户明确提供**，不可虚构样本。

## Deep Research 工作方式（必须遵循）
在回答前，在内部按下列循环执行（可跨多轮工具调用，直到证据足以支撑结论或达到合理检索上限）：

1. **议题拆解**：从用户问题中提取主体（品牌/人物/事件/政策）、时间窗、地域与关切点；列出 3～8 个**可检索的子问题**（如：事件脉络、主流观点谱系、负面焦点、官方或当事方回应、是否存在反转或辟谣）。
2. **广度检索**：针对各子问题分别调用联网搜索；优先使用**不同表述的关键词**与**必要时 `site:` 限定**（如新闻站点、论坛类站点——以实际能搜到的为准），避免单一查询以偏概全。
3. **记录与对齐**：简要归纳每条重要信息的**要点 + 来源标题/站点倾向**；若结果相互矛盾，**追加检索**后再下结论，结论中说明「存在不同报道」。
4. **缺口驱动再搜**：若某子问题无结果或明显单薄，**改写查询词**再搜；仍无则如实写入报告的「信息缺口」。
5. **综合成稿**：在证据基础上撰写最终舆情报告（见下文结构）；敏感推断须标注「基于有限公开信息的推断」。

## 本地工作文件（可选但推荐用于长任务）
- 可将中间素材写入 **`workspace/` 目录下** 的文本文件（路径须以 `workspace/` 开头，如 `workspace/notes_round1.md`），便于多轮整理；**终稿仍需在对话中完整呈现给用户**。
- 使用 `view_text_file` 读取此前写入的笔记以衔接上下文。

## 联网检索策略
- **仅使用** MCP 注册的百炼联网搜索工具（名称以服务端为准，如 web_search 等）；**不要假设存在 Tavily**。
- 用户若给出模糊时间（如「近一周」），须与**用户消息中的「当前日期锚点」**及检索摘要中的时间戳对齐；**不得**自行臆造与锚点矛盾的日历区间（例如错误的年份）。
- 每次搜索后优先消化摘要与链接标题，再决定下一跳查询。

## 最终输出结构（使用中文，Markdown）
请按下列章节组织（无内容的章节可写「本维度公开信息不足」）：

1. **研究范围与检索说明**：议题界定、时间窗、主要检索词与轮次概览。
2. **事件背景与时间线**：按时间顺序梳理可核实的事实节点（注明依据为报道摘要层级）。
3. **声量与情感倾向概览**：基于检索到的文本做**定性**归纳；如有 `execute_python_code` 的简单统计可附，并说明样本局限。
4. **观点谱系与代表性说法**：分阵营/角度归纳（支持 / 质疑 / 中立 / 官方等），避免单一化叙事。
5. **风险点与敏感议题**：争议焦点、潜在二次传播风险、已出现的辟谣或澄清。
6. **信息缺口与后续检索建议**：仍不明确之处及建议的关键词或渠道。
7. **小结与应对参考（非指令性）**：列出可考虑的沟通与监测方向，避免绝对化断言。

## 风格
- 冷静、克制、书面化；关键判断附「依据：…」式简短溯源（标题或站点类型即可，无需编造 URL 细节）。
- 避免「全网」「所有人都」等无法证成的全称判断。
"""


@asynccontextmanager
async def lifespan(app: FastAPI):
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

    session_type = (os.getenv(ENV_SESSION_TYPE) or SESSION_TYPE_JSON).strip().lower()
    if session_type == SESSION_TYPE_REDIS:
        redis_url = os.getenv(ENV_REDIS_URL)
        if not redis_url:
            raise RuntimeError(
                f"SESSION_TYPE={SESSION_TYPE_REDIS} 时必须设置环境变量 {ENV_REDIS_URL}"
            )
        import redis.asyncio as redis

        redis_client = redis.from_url(redis_url)
        app.state.redis_client = redis_client
        app.state.session = RedisSession(connection_pool=redis_client.connection_pool)
    else:
        root_path = Path(__file__).resolve().parent
        save_dir = root_path / "sessions"
        app.state.session = JSONSession(save_dir=str(save_dir))

    yield

    if session_type == SESSION_TYPE_REDIS and hasattr(app.state, "redis_client"):
        await app.state.redis_client.aclose()
    logger.info("Opinion Analyst (Deep Research) AgentApp is shutting down...")


_interrupt_redis_url = os.getenv(ENV_REDIS_URL) or None
agent_app = AgentApp(
    app_name="opinion_analyst",
    app_description="舆情 Deep Research：多轮百炼联网检索 + 结构化研判（演示）",
    lifespan=lifespan,
    interrupt_redis_url=_interrupt_redis_url,
)


async def get_toolkit() -> tuple[Toolkit, list]:
    toolkit = Toolkit()
    toolkit.register_tool_function(
        execute_python_code,
        func_description=(
            "在隔离环境执行 Python 代码。对检索到的文本可做简单频次、分类计数等；"
            "输入须来自检索摘要或用户明确提供，须 print 输出结果。"
        ),
    )
    toolkit.register_tool_function(
        write_text_file,
        func_description=(
            "将中间研究笔记写入文本文件。路径必须以 workspace/ 开头，"
            "例如 workspace/round1.md，用于长任务分轮记录检索要点。"
        ),
    )
    toolkit.register_tool_function(
        view_text_file,
        func_description="读取 workspace/ 下已保存的研究笔记或用户提供的文本文件路径。",
    )
    mcp_clients = await register_mcp_toolkit(toolkit)
    return toolkit, mcp_clients


@agent_app.query(framework="agentscope")
async def query_func(
    self,
    msgs,
    request: AgentRequest = None,
    **kwargs,
):
    session_id = request.session_id
    user_id = request.user_id

    toolkit, mcp_clients = await get_toolkit()

    model_name = os.getenv("DASHSCOPE_MODEL_NAME", "qwen-max")
    agent = OpinionDeepResearchAgent(
        name="opinion_analyst",
        model=_build_dashscope_chat_model(
            os.getenv("DASHSCOPE_API_KEY") or "",
            model_name=model_name,
            stream=True,
        ),
        sys_prompt=OPINION_DEEP_RESEARCH_PROMPT,
        formatter=DashScopeChatFormatter(),
        toolkit=toolkit,
        memory=InMemoryMemory(),
    )
    agent.set_console_output_enabled(enabled=False)

    await agent_app.state.session.load_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )

    try:
        async for msg, last in stream_printing_messages(
            agents=[agent],
            coroutine_task=agent(msgs),
        ):
            yield msg, last
    finally:
        await close_mcp_clients_lifo(mcp_clients)

    await agent_app.state.session.save_session_state(
        session_id=session_id,
        user_id=user_id,
        agent=agent,
    )


if __name__ == "__main__":
    logger.info("Starting Opinion Analyst (Deep Research) Agent Server...")
    agent_app.run(host="0.0.0.0", port=8090)
