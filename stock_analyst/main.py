# -*- coding: utf-8 -*-
"""基于 AgentScope + Runtime 的股票分析智能助手（百炼联网搜索 MCP）。

聚焦**标的证券**的行情与决策支持：数据分析、走势情景研判、投资参考建议。
编排见 `agent.StockDeepResearchAgent`：子任务分解 → 多轮搜索 → 续搜判断 → 中间摘要 → 终稿流式输出。
"""
import inspect
import logging
import os
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

from agentscope.formatter import DashScopeChatFormatter
from agentscope.memory import InMemoryMemory
from agentscope.model import ChatModelBase, DashScopeChatModel
from agentscope.pipeline import stream_printing_messages
from agentscope.session import JSONSession, RedisSession
from agentscope.tool import Toolkit, execute_python_code, view_text_file, write_text_file

from agentscope_runtime.engine import AgentApp
from agentscope_runtime.engine.schemas.agent_schemas import AgentRequest

from agent import StockDeepResearchAgent
from tools.mcp_helpers import close_mcp_clients_lifo, register_mcp_toolkit

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

STOCK_DEEP_RESEARCH_PROMPT = """
你是**股票分析智能助手**（Deep Research），在 **Plan-ReAct** 框架下工作。主线是**标的证券**（个股 / ETF / 指数等）的**行情与交易相关分析**，而不是写长篇「公司百科」；公司基本面仅在为理解**股价与预期**所必要时简要带过。通过**多轮联网检索、交叉核对与缺口补充**成稿；**不得使用 Tavily**；检索仅依赖 **百炼 WebSearch MCP** 提供的联网搜索类工具。

## 三大核心能力（终稿必须覆盖）
用户未逐条点名时，也应在合理范围内写成独立章节（可合并子节，但逻辑要清晰）：

### 能力 1：股票数据分析
- 归纳检索到的**最新价、涨跌幅、成交量/额、市值、估值口径**等；注明「据检索摘要」及**可能滞后**。
- 用户粘贴了价格序列时，可用 `execute_python_code` 做涨跌幅、均值、简单均线等，并说明**输入来源**。
- **禁止编造**行情数字；缺数据就写「未检索到」。

### 能力 2：股票走势预测
- 输出**多情景**研判（如震荡 / 偏强 / 偏弱），写清**依据**与**何种信息出现会推翻判断（失效条件）**。
- **禁止**「必涨」「必跌」「稳赚」「确定到价」等断言；若引用研报或媒体目标价，须标明**来源于公开报道摘要**，而非你的承诺。
- 技术面讨论须说明是**基于有限公开信息的推演**，不是信号服务。

### 能力 3：股票投资建议
- 给出**参考性**操作思路（如观望、逢低关注、控制仓位、止损参考区间等），并**同步列出主要风险与反面论据**。
- **非持牌证券投资咨询**；不得承诺收益；不得利用或暗示内幕信息；用户**盈亏自负**，重要决策应咨询当地**持牌专业人士**。
- 可讨论具体价位时，须与检索到的公开讨论或用户给定数据挂钩，并再次强调**仅供参考**。

## 其他必须遵守
1. **合规与伦理**：对传言标注「未经证实」；尊重平台与著作权说明。
2. **工具边界**：`execute_python_code` 仅处理检索或用户明确提供的数字/文本，须 `print` 结果，**不可虚构行情样本**。

## Deep Research 工作方式（必须遵循）
1. **议题拆解**：先锁定**证券简称/代码/指数名称**与时间窗；子问题优先围绕 **最新行情与量价**、**走势与技术面讨论**、**机构或媒体目标价/评级**、**主要风险与利空**——少写与股价无关的公司流水账。
2. **广度检索**：不同关键词与必要时 `site:`；避免单次查询以偏概全。
3. **记录与对齐**：要点 + 来源类型；矛盾处追加检索并说明分歧。
4. **缺口再搜**：无结果则改写查询；仍无则写入「信息缺口」。
5. **综合成稿**：推断须标注「基于有限公开信息的推断」。

## 本地工作文件（可选）
- 中间笔记可写入 `workspace/*.md`（路径以 `workspace/` 开头）；**终稿仍须在对话中完整给出**。
- `view_text_file` 可读取已保存笔记。

## 联网检索策略
- **仅使用** MCP 注册的百炼联网搜索工具；**不要假设存在 Tavily**。
- 时间表述与**用户消息中的「当前日期锚点」**及检索摘要时间对齐；**禁止**臆造矛盾日期。

## 最终输出结构（中文 Markdown）
按下列顺序组织（某块无材料则写「本维度公开信息不足」）：

1. **研究范围与检索说明**（标的证券、时间窗、检索概览）
2. **一、股票数据分析**（量价与关键数字；若有代码计算须说明输入来源与局限）
3. **二、股票走势预测**（多情景 + 依据 + 失效条件 + 不确定性）
4. **三、股票投资建议**（参考性思路 + 风险与反面理由 + **非投顾免责声明**）
5. **信息缺口与后续可关注**
6. **简要风险提示**（再强调：非保证收益、非持牌投顾）

## 风格
冷静、书面化；关键结论附「依据：…」式溯源（标题或站点类型即可，勿编造 URL 细节）。
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
    logger.info("Stock Analyst AgentApp is shutting down...")


_interrupt_redis_url = os.getenv(ENV_REDIS_URL) or None
agent_app = AgentApp(
    app_name="stock_analyst",
    app_description="股票分析助手：数据分析 + 走势情景研判 + 投资参考建议（百炼联网检索；非持牌投顾）",
    lifespan=lifespan,
    interrupt_redis_url=_interrupt_redis_url,
)


async def get_toolkit() -> tuple[Toolkit, list]:
    toolkit = Toolkit()
    toolkit.register_tool_function(
        execute_python_code,
        func_description=(
            "在隔离环境执行 Python 代码。对检索到的文本或用户提供的数字可做简单统计、对比、"
            "技术指标辅助；输入须来自检索摘要或用户明确提供，须 print 输出结果。"
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
    agent = StockDeepResearchAgent(
        name="stock_analyst",
        model=_build_dashscope_chat_model(
            os.getenv("DASHSCOPE_API_KEY") or "",
            model_name=model_name,
            stream=True,
        ),
        sys_prompt=STOCK_DEEP_RESEARCH_PROMPT,
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
    logger.info("Starting Stock Analyst Agent Server...")
    agent_app.run(host="0.0.0.0", port=8090)
