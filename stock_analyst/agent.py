# -*- coding: utf-8 -*-
"""股票分析编排：子任务分解 → 多轮 MCP 联网搜索 → 续搜判断 → 中间摘要 → 终稿（数据分析/走势/建议）。"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta
from typing import Any, Type
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, ValidationError

from agentscope.agent import ReActAgent
from agentscope.formatter import FormatterBase
from agentscope.memory import MemoryBase
from agentscope.message import Msg, TextBlock, ToolResultBlock, ToolUseBlock
from agentscope.model import ChatModelBase
from agentscope.tool import Toolkit

try:
    import json_repair
except ImportError:
    json_repair = None  # type: ignore[misc, assignment]

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 模块级默认（main 创建 Agent 时可直接用默认值）
# ---------------------------------------------------------------------------
# 传给 ReActAgent 父类：单次对话里「推理-调工具」循环的最大步数；本类主流程在 reply() 中自编排，一般很少打满。
DEFAULT_MAX_REACT_ITERS = 4
# 联网检索最多几「轮」：每轮结束后由续搜判断决定是否进入下一轮；理论检索次数上限 ≈ 本值 × max_queries_per_round。
DEFAULT_MAX_SEARCH_ROUNDS = 3
# 每一轮里最多执行几条搜索查询（首轮用分解出的词，后续轮用续搜返回的词，均截断到此数量）。
DEFAULT_MAX_QUERIES_PER_ROUND = 4
# 单条搜索返回的正文写入证据池时，按字符截断长度，避免上下文与中间摘要过大。
DEFAULT_EVIDENCE_CHARS_PER_QUERY = 12000

_ANCHOR_TZ = ZoneInfo("Asia/Shanghai")
_TOOL_SSE_PREVIEW_CHARS = 4000
_PROGRESS_PLAN_EXCERPT_CHARS = 400
_FOLLOWUP_DIGEST_CHARS = 6000
_INTERMEDIATE_BLOB_CHARS = 24000

_SKIP_TOOL_NAMES = frozenset(
    {"execute_python_code", "write_text_file", "view_text_file", "generate_response"},
)

# 非深度研究回合：直接对话
_CONVERSATIONAL_REPLY_SYS = """你是股票分析智能助手（本服务示例）。
用户**当前这一轮**不需要「多轮联网检索 + 结构化长报告」。请**直接、简洁、友好**地回答（几句到一小段即可）。
若用户其实是在咨询具体标的的行情分析，可礼貌提示：请提供股票 / ETF / 指数的名称或代码，并说明时间范围或关注点。"""


class StockRouteDecision(BaseModel):
    """由轻量路由模型判断：是否走深度研究编排。"""

    need_deep_research: bool = Field(
        description="为 true 时执行多轮联网检索与长报告；为 false 时仅简短对话回复",
    )
    reason: str = Field(default="", description="判断理由，一两句中文即可")


class StockDecompose(BaseModel):
    knowledge_gaps: str = Field(description="当前对标的证券走势、数据或策略判断的不确定点与待核实点")
    working_plan: str = Field(description="3～6 步可执行的研究计划（中文），须覆盖数据分析→走势研判→投资参考建议所需证据")
    initial_queries: list[str] = Field(
        description=(
            "3～8 条中文搜索词，优先围绕**证券行情与量价**、**走势/技术面讨论**、**机构或媒体目标价与评级**、"
            "**风险与利空**；含证券简称/代码/指数名；少写泛泛的公司介绍类查询"
        ),
        min_length=1,
        max_length=10,
    )


class StockFollowUp(BaseModel):
    need_more_search: bool = Field(description="是否需要继续联网搜索")
    reason: str = Field(description="判断理由（中文）")
    next_queries: list[str] = Field(
        default_factory=list,
        description="若需继续搜索，给出新的查询词，最多 5 条",
        max_length=5,
    )


class StockDeepResearchAgent(ReActAgent):
    def __init__(
        self,
        name: str,
        sys_prompt: str,
        model: ChatModelBase,
        formatter: FormatterBase,
        toolkit: Toolkit | None = None,
        memory: MemoryBase | None = None,
        max_iters: int = DEFAULT_MAX_REACT_ITERS,
        max_search_rounds: int = DEFAULT_MAX_SEARCH_ROUNDS,
        max_queries_per_round: int = DEFAULT_MAX_QUERIES_PER_ROUND,
        evidence_chars_per_query: int = DEFAULT_EVIDENCE_CHARS_PER_QUERY,
    ) -> None:
        super().__init__(
            name=name,
            sys_prompt=sys_prompt,
            model=model,
            formatter=formatter,
            toolkit=toolkit,
            memory=memory,
            max_iters=max_iters,
        )
        self.max_search_rounds = max_search_rounds
        self.max_queries_per_round = max_queries_per_round
        self.evidence_chars_per_query = evidence_chars_per_query
        self.user_query = ""
        self._raw_evidence: list[dict[str, Any]] = []
        self._working_plan = ""
        self._knowledge_gaps = ""

    async def _phase_route(self) -> StockRouteDecision:
        """一次轻量 JSON 调用，区分「闲聊/元问题」与「需要深度研究」——避免枚举用户句式。"""
        sys_txt = (
            "你是**路由判断器**，只输出**一个 JSON 对象**，不要 Markdown 围栏或其它文字；"
            "字符串内英文双引号须写成 \\\" 。\n"
            "根据用户**最新一句话**判断：是否需要本助手执行「多轮联网检索 + 结构化股票分析报告"
            "（含数据分析、走势情景、投资参考思路等长文）」。\n\n"
            "**need_deep_research = true**：用户想分析具体或泛指的证券/指数/ETF、行情、走势、买卖参考、"
            "板块比较、新闻对股价影响等**投资分析类**任务（即使用户表述简短，只要意图是分析标的即可）。\n"
            "**need_deep_research = false**：纯闲聊、打招呼、你是谁/能做什么、感谢、与证券分析无关的"
            "话题、或明显不需要检索与长报告的简单追问。\n\n"
            f"JSON Schema：\n{StockRouteDecision.model_json_schema()}\n"
            "字段 reason：用一两句中文说明为何如此判断。"
        )
        try:
            raw = await self._llm_plain(sys_txt, f"用户输入：\n{self.user_query}")
            return StockRouteDecision.model_validate(self._parse_json_object(raw))
        except (ValidationError, ValueError) as e:
            logger.warning("路由 JSON 解析失败，默认走深度研究: %s", e)
        except Exception as e:  # noqa: BLE001
            logger.warning("路由异常，默认走深度研究: %s", e, exc_info=True)
        return StockRouteDecision(
            need_deep_research=True,
            reason="路由解析失败，保守走深度研究。",
        )

    async def _stream_conversational_reply(self) -> Msg:
        """不跑分解/搜索，直接流式短答（与长报告 sys_prompt 分离）。"""
        prompt = await self.formatter.format(
            [
                Msg("system", _CONVERSATIONAL_REPLY_SYS, "system"),
                *await self.memory.get_memory(),
            ],
        )
        res = await self.model(prompt, tools=None, tool_choice="none")
        res_msg = Msg(self.name, [], "assistant")
        if hasattr(res, "__aiter__"):
            async for chunk in res:
                res_msg.content = chunk.content
                await self.print(res_msg, False)
            await self.print(res_msg, True)
        else:
            res_msg.content = res.content
            await self.print(res_msg, True)
        await self.memory.add(res_msg)
        return res_msg

    # ---- 主流程 ----------------------------------------------------------------

    async def reply(
        self,
        msg: Msg | list[Msg] | None = None,
        structured_model: Type[BaseModel] | None = None,
    ) -> Msg:
        if structured_model is not None:
            logger.warning("StockDeepResearchAgent 忽略 structured_model，仅输出文本终稿。")

        await self._retrieve_from_long_term_memory(msg)
        await self._retrieve_from_knowledge(msg)

        if isinstance(msg, list):
            if len(msg) == 0:
                raise ValueError("Message list cannot be empty")
            current_msg = msg[-1]
        else:
            current_msg = msg

        self.user_query = current_msg.get_text_content() or ""
        await self.memory.add(msg)

        route = await self._phase_route()
        if not route.need_deep_research:
            logger.info("路由：直接对话（不跑深度研究）。理由: %s", route.reason)
            return await self._stream_conversational_reply()

        self._raw_evidence = []
        plan = await self._phase_decompose()
        nq = self._normalize_search_queries(plan.initial_queries)
        if not nq:
            nq = self._normalize_search_queries([self.user_query[:200]])
        plan = plan.model_copy(update={"initial_queries": nq})
        self._working_plan = plan.working_plan
        self._knowledge_gaps = plan.knowledge_gaps

        await self._print_stage_decompose(plan)
        await self._phase_search_and_followup(plan.initial_queries)
        await self._print_stage_search_done()

        intermediate = await self._phase_intermediate_summary()
        await self._print_stage_before_final()

        await self.memory.add(
            Msg("user", self._build_final_user_content(intermediate), "user"),
        )
        return await self._stream_final_report()

    # ---- 日期锚点 & 检索词规范化 --------------------------------------------------

    @staticmethod
    def _anchor_now() -> datetime:
        return datetime.now(tz=_ANCHOR_TZ)

    def _time_anchor_block(self) -> str:
        today = self._anchor_now().date()
        w0 = today - timedelta(days=6)
        return "\n".join(
            [
                "## 当前日期锚点",
                f"- **今天**：{today.isoformat()}",
                f"- **「近一周 / 最近 7 天」建议闭区间**：{w0.isoformat()} 至 {today.isoformat()}（含首尾）",
                "- 撰写「研究范围与检索说明」中的日期时应与上面对齐；若检索摘要中的时间与此不一致，**以检索材料中的时间为准**并在文中说明。",
                "- 若检索材料不足，须写明信息缺口，**禁止**用虚构日期凑满报告。",
            ],
        )

    def _retrieval_time_rules_for_llm(self) -> str:
        cy = self._anchor_now().year
        return (
            f"【检索词时间规则】当前公历年份为 {cy}。\n"
            "- `initial_queries` / `next_queries` 中：需要写年份时应与当前年一致，或优先用「近一周」「本月」「最近」等相对表述；"
            "**禁止**无故写入已过时的公历年份（如 2024、2023），除非用户原问题**明确**要求检索该年。\n"
            "- 用户若只说「近一周」「最新」，检索词里**不必**硬加具体年份，以免搜到陈旧稿件。\n"
        )

    def _normalize_stale_years_in_query(self, q: str) -> str:
        cy = self._anchor_now().year
        user_q = self.user_query
        if len({int(t) for t in re.findall(r"\b(20\d{2})\b", q)}) >= 2:
            return q

        def repl(m: re.Match[str]) -> str:
            y = int(m.group(1))
            tok = m.group(0)
            if y >= cy or tok in user_q or not (2020 <= y < cy):
                return tok
            return str(cy)

        return re.sub(r"\b(20\d{2})\b", repl, q)

    def _normalize_search_queries(self, queries: list[str]) -> list[str]:
        out: list[str] = []
        for q in queries:
            s = (q or "").strip()
            if not s:
                continue
            out.append(self._normalize_stale_years_in_query(s))
        return out

    # ---- SSE 进度（拆解 / 检索结束 / 终稿前）------------------------------------

    @staticmethod
    def _assistant_text_msg(name: str, text: str) -> Msg:
        return Msg(name, [TextBlock(type="text", text=text)], "assistant")

    async def _print_stage_decompose(self, plan: StockDecompose) -> None:
        cap = _PROGRESS_PLAN_EXCERPT_CHARS
        wp = (plan.working_plan or "").strip()
        excerpt = wp[:cap] + ("…" if len(wp) > cap else "")
        body = (
            "【研究进度】已完成**标的证券与行情向议题拆解**及首轮检索规划。\n\n"
            f"**工作计划摘要**：{excerpt or '（略）'}\n"
        )
        await self.print(self._assistant_text_msg(self.name, body), True)

    async def _print_stage_search_done(self) -> None:
        n = len(self._raw_evidence)
        err_n = sum(1 for x in self._raw_evidence if x.get("error"))
        tail = (
            f"（其中 **{err_n}** 条返回错误，已在后续材料中保留报错信息）" if err_n else ""
        )
        body = (
            f"【研究进度】**联网检索阶段**结束：共 **{n}** 条次检索{tail}。"
            "**当前正在**根据检索结果整理中间摘要…\n"
        )
        await self.print(self._assistant_text_msg(self.name, body), True)

    async def _print_stage_before_final(self) -> None:
        await self.print(
            self._assistant_text_msg(
                self.name,
                "【研究进度】中间摘要已就绪，**当前正在**撰写数据分析、走势研判与投资参考建议…\n",
            ),
            True,
        )

    async def _print_search_round_start(self, round_idx: int, queries: list[str]) -> None:
        """每轮程序化检索开始前向 SSE 打印进度。实际总轮数由「是否继续检索」的判定决定，上限为 max_search_rounds。"""
        n_round = round_idx + 1
        k = len([x for x in queries if (x or "").strip()])
        if round_idx == 0:
            lead = f"正在进行**第 {n_round} 轮**联网检索"
        else:
            lead = f"**上一轮材料仍不足，需补充检索**，正在进行**第 {n_round} 轮**联网检索"
        body = f"【研究进度】{lead}（本批 **{k}** 条查询）…\n"
        await self.print(self._assistant_text_msg(self.name, body), True)

    # ---- 分阶段 LLM / 检索 -------------------------------------------------------

    async def _phase_decompose(self) -> StockDecompose:
        sys_txt = (
            "你是**股票分析**检索规划助手：聚焦**标的证券**的**数据分析、走势研判、投资参考**三类需求，"
            "不要规划成「公司百科」式检索。输出**仅包含一个 JSON 对象**，不要 Markdown 代码围栏，"
            "不要在 JSON 前后加说明。字符串内英文双引号须写成 \\\" ；各字段简短。\n"
            f"{self._retrieval_time_rules_for_llm()}\n"
            "JSON 必须符合下列字段：\n"
            f"{StockDecompose.model_json_schema()}\n"
            "字段说明：working_plan 须体现先补**行情/量价数据**，再补**走势与观点**，再补**策略与风险**；"
            "initial_queries 优先含：最新价、涨跌、成交量、K线/技术面、研报目标价或评级、风险提示等关键词组合。"
        )
        try:
            raw = await self._llm_plain(sys_txt, f"用户问题：\n{self.user_query}")
            return StockDecompose.model_validate(self._parse_json_object(raw))
        except (ValidationError, ValueError) as e:
            logger.warning("子任务分解解析或校验失败，使用兜底: %s", e)
        except Exception as e:  # noqa: BLE001
            logger.warning("子任务分解异常，使用兜底: %s", e, exc_info=True)
        return StockDecompose(
            knowledge_gaps="需通过联网检索核实行情数据、走势讨论与风险信息。",
            working_plan=(
                "1) 检索最新行情与量价 2) 检索走势/技术面与机构媒体观点 3) 检索风险与反面论据 "
                "4) 交叉核对后撰写：数据分析、走势情景、投资参考（附免责）"
            ),
            initial_queries=self._normalize_search_queries([self.user_query[:200]]),
        )

    async def _phase_search_and_followup(self, seed_queries: list[str]) -> None:
        queries = list(seed_queries)[: self.max_queries_per_round]
        for round_idx in range(self.max_search_rounds):
            await self._print_search_round_start(round_idx, queries)
            for q in queries:
                q = (q or "").strip()
                if not q:
                    continue
                try:
                    blob = await self._invoke_mcp_search(q)
                    self._raw_evidence.append(
                        {"query": q, "output": blob[: self.evidence_chars_per_query]},
                    )
                except Exception as ex:  # noqa: BLE001
                    logger.exception("联网搜索失败 query=%s", q)
                    self._raw_evidence.append({"query": q, "error": str(ex)})

            fu = await self._phase_follow_up()
            if not fu.need_more_search or round_idx >= self.max_search_rounds - 1:
                break
            queries = self._normalize_search_queries(
                [x.strip() for x in fu.next_queries if x.strip()],
            )[: self.max_queries_per_round]
            if not queries:
                break

    async def _phase_follow_up(self) -> StockFollowUp:
        sys_txt = (
            "你是股票分析检索策略助手。根据已获摘录，判断是否需继续搜索以补全"
            "**数据分析**（价量/估值）、**走势预测依据**（技术或一致预期）、**投资建议所需风险与反面信息**。"
            "只输出**一个 JSON 对象**，不要其它文字；字符串内英文双引号须写成 \\\" 。\n"
            f"{self._retrieval_time_rules_for_llm()}\n"
            "Schema：\n"
            f"{StockFollowUp.model_json_schema()}\n"
            "need_more_search=true 时务必填写有意义的 next_queries。"
        )
        digest = self._evidence_digest(_FOLLOWUP_DIGEST_CHARS)
        user_txt = (
            f"用户原问题：{self.user_query}\n\n"
            f"工作计划摘要：{self._working_plan[:1500]}\n\n"
            f"知识缺口：{self._knowledge_gaps[:1500]}\n\n"
            f"已检索材料摘录：\n{digest}"
        )
        try:
            raw = await self._llm_plain(sys_txt, user_txt)
            return StockFollowUp.model_validate(self._parse_json_object(raw))
        except (ValidationError, ValueError):
            return StockFollowUp(
                need_more_search=False,
                reason="解析失败，停止追加检索。",
                next_queries=[],
            )

    async def _phase_intermediate_summary(self) -> str:
        sys_txt = (
            "你是研究助理。将下列检索材料整理为**中间摘要**，用中文分三部分小标题："
            "**数据分析要点**、**走势与预测相关依据**、**投资建议须考虑的风险与反面论据**。"
            "只写材料中有的内容；无则写「摘录不足」；不要编造事实；不要输出终稿全文。"
        )
        blob = json.dumps(self._raw_evidence, ensure_ascii=False)[:_INTERMEDIATE_BLOB_CHARS]
        return await self._llm_plain(
            sys_txt,
            f"用户问题：{self.user_query}\n\n检索 JSON（截断）：\n{blob}",
        )

    async def _stream_final_report(self) -> Msg:
        prompt = await self.formatter.format(
            [Msg("system", self.sys_prompt, "system"), *await self.memory.get_memory()],
        )
        res = await self.model(prompt, tools=None, tool_choice="none")
        res_msg = Msg(self.name, [], "assistant")
        if hasattr(res, "__aiter__"):
            async for chunk in res:
                res_msg.content = chunk.content
                await self.print(res_msg, False)
            await self.print(res_msg, True)
        else:
            res_msg.content = res.content
            await self.print(res_msg, True)
        await self.memory.add(res_msg)
        return res_msg

    def _build_final_user_content(self, intermediate_summary: str) -> str:
        return (
            "【编排阶段说明】以下由系统自动完成：子任务分解、多轮百炼联网搜索、是否续搜的判断、中间摘要。"
            "请你作为**股票分析智能助手**，**严格依据**下列材料撰写完整终稿（Markdown），"
            "**必须包含**系统提示中的三大块：**股票数据分析**、**股票走势预测（多情景）**、**股票投资建议（参考性+免责）**；"
            "不得编造材料中无来源的细节；走势预测禁止「必涨必跌」式断言；建议须列风险与反面理由。\n\n"
            f"{self._time_anchor_block()}\n\n"
            f"## 工作计划\n{self._working_plan}\n\n"
            f"## 知识缺口（规划阶段）\n{self._knowledge_gaps}\n\n"
            f"## 中间摘要\n{intermediate_summary}\n\n"
            f"## 检索条目数\n{len(self._raw_evidence)}\n"
        )

    def _evidence_digest(self, max_chars: int) -> str:
        parts: list[str] = []
        n = 0
        for item in self._raw_evidence:
            block = json.dumps(item, ensure_ascii=False)
            if n + len(block) > max_chars:
                parts.append(block[: max_chars - n])
                break
            parts.append(block)
            n += len(block)
        return "\n".join(parts)

    async def _llm_plain(self, system_text: str, user_text: str) -> str:
        prompt = await self.formatter.format(
            [Msg("system", system_text, "system"), Msg("user", user_text, "user")],
        )
        res = await self.model(prompt)
        msg = Msg(self.name, [], "assistant")
        if hasattr(res, "__aiter__"):
            async for chunk in res:
                msg.content = chunk.content
        else:
            msg.content = res.content
        return msg.get_text_content() or ""

    @staticmethod
    def _parse_json_object(text: str) -> dict[str, Any]:
        text = (text or "").strip()
        fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
        if fence:
            text = fence.group(1).strip()
        start = text.find("{")
        if start < 0:
            raise ValueError("未找到 JSON 对象")
        tail = text[start:]
        try:
            obj, _ = json.JSONDecoder().raw_decode(tail, 0)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
        if json_repair is not None:
            try:
                repaired = json_repair.loads(tail)
                if isinstance(repaired, dict):
                    return repaired
            except Exception as e:  # noqa: BLE001
                logger.debug("json_repair.loads 未成功: %s", e)
        raise ValueError("JSON 解析失败（模型输出可能含未转义引号或残缺结构）")

    def _pick_search_tool_spec(self) -> dict[str, Any]:
        forced = (os.getenv("STOCK_SEARCH_TOOL_NAME") or "").strip()
        schemas = self.toolkit.get_json_schemas()
        if not schemas:
            raise RuntimeError("Toolkit 中无任何工具，请确认百炼 WebSearch MCP 已注册。")
        if forced:
            for spec in schemas:
                if spec.get("function", {}).get("name", "") == forced:
                    return spec
            raise RuntimeError(
                f"未找到名为 {forced} 的工具，请检查 STOCK_SEARCH_TOOL_NAME。",
            )
        scored: list[tuple[int, dict[str, Any]]] = []
        for spec in schemas:
            fn = spec.get("function", {}).get("name", "")
            if fn in _SKIP_TOOL_NAMES:
                continue
            desc = (spec.get("function", {}).get("description") or "").lower()
            score = (3 if ("search" in desc or "搜索" in desc) else 0) + (
                2 if ("web" in fn.lower() or "search" in fn.lower()) else 0
            )
            scored.append((score, spec))
        scored.sort(key=lambda x: x[0], reverse=True)
        if scored and scored[0][0] > 0:
            return scored[0][1]
        for spec in schemas:
            fn = spec.get("function", {}).get("name", "")
            if fn and fn not in _SKIP_TOOL_NAMES:
                return spec
        raise RuntimeError("未找到可用的联网搜索类 MCP 工具。")

    def _build_search_arguments(self, spec: dict[str, Any], query: str) -> dict[str, Any]:
        func = spec.get("function", {})
        params = func.get("parameters") or {}
        props = params.get("properties") or {}
        required = list(params.get("required") or [])
        out: dict[str, Any] = {}
        picked = False
        for key in ("query", "q", "search_query", "keywords", "input", "text", "question"):
            if key in props:
                out[key] = query
                picked = True
                break
        if not picked:
            for key, meta in props.items():
                if isinstance(meta, dict) and meta.get("type") == "string":
                    out[key] = query
                    picked = True
                    break
        if not picked:
            raise RuntimeError("无法在搜索工具的 JSON Schema 中找到合适的字符串查询字段。")
        for r in required:
            if r in out:
                continue
            meta = props.get(r, {})
            t = meta.get("type")
            if t == "string":
                out[r] = query
            elif t == "integer":
                out[r] = 10
            elif t == "boolean":
                out[r] = False
            elif t == "array":
                out[r] = []
            else:
                out[r] = ""
        return out

    async def _invoke_mcp_search(self, query: str) -> str:
        spec = self._pick_search_tool_spec()
        name = spec["function"]["name"]
        args = self._build_search_arguments(spec, query)
        tool_call = ToolUseBlock(
            id=str(uuid.uuid4()),
            type="tool_use",
            name=name,
            input=args,
        )
        await self.print(Msg(self.name, [tool_call], "assistant"), True)

        tool_res = await self.toolkit.call_tool_function(tool_call)
        chunks: list[str] = []
        async for chunk in tool_res:
            out = chunk.content
            if isinstance(out, list):
                for block in out:
                    if isinstance(block, dict) and "text" in block:
                        chunks.append(str(block["text"]))
                    else:
                        chunks.append(str(block))
            else:
                chunks.append(str(out))
        full_text = "\n".join(chunks)

        preview = full_text
        if len(preview) > _TOOL_SSE_PREVIEW_CHARS:
            preview = (
                preview[:_TOOL_SSE_PREVIEW_CHARS]
                + f"\n…（共 {len(full_text)} 字符，SSE 预览已截断；完整内容已参与中间摘要编排）"
            )
        await self.print(
            Msg(
                "system",
                [
                    ToolResultBlock(
                        type="tool_result",
                        id=tool_call["id"],
                        name=name,
                        output=preview,
                    ),
                ],
                "system",
            ),
            True,
        )
        return full_text
