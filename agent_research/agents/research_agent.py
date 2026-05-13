"""
AI搜学助手 - AgentScope 版本

核心设计原则：
1. 代码控制流程流转，不依赖 LLM 自主决策
2. 使用 AgentScope 框架管理 Agent 和模型调用
3. 真正的流式输出：搜索、分析、撰写都实时更新
4. 数据质量筛选：相关性、时效性、贡献度
5. 多平台、多角度搜索
6. 保留 agentrun-sdk 管理浏览器 Sandbox
"""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from datetime import datetime
from playwright.async_api import async_playwright

import os
import asyncio
import json
import re
import queue
import time

load_dotenv()

# =========================================================================
# 环境变量和配置
# =========================================================================

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY", "")
MODEL_NAME = os.getenv("DASHSCOPE_MODEL_NAME", "qwen-max")

if not DASHSCOPE_API_KEY:
    raise ValueError("DASHSCOPE_API_KEY is not set")

# =========================================================================
# agentrun-sdk: Browser Sandbox 管理
# =========================================================================

from agentrun.sandbox import TemplateType, Sandbox, BrowserSandbox

agentrun_browser_sandbox_name = os.getenv("AGENTRUN_TEMPLATE_ID", "")


class SandboxTemplateNotFoundError(Exception):
    """Sandbox 模板不存在错误"""
    pass


class SandboxCreationError(Exception):
    """Sandbox 创建错误"""
    pass


_sandboxes: Dict[str, BrowserSandbox] = {}
_sandbox_lock = asyncio.Lock()


async def create_browser_sandbox() -> Optional[BrowserSandbox]:
    if not agentrun_browser_sandbox_name:
        return None

    async with _sandbox_lock:
        print("🌐 正在创建新的 Browser Sandbox...")
        try:
            sandbox = await Sandbox.create_async(
                template_type=TemplateType.BROWSER,
                template_name=agentrun_browser_sandbox_name,
            )
            _sandboxes[sandbox.sandbox_id] = sandbox
            print(f"✅ Browser Sandbox 创建成功: {sandbox.sandbox_id}")
            return sandbox
        except Exception as e:
            error_msg = str(e).lower()
            template_not_found_patterns = [
                "template not found", "template does not exist",
                "no such template", "template_not_found",
                "not found", "无法找到模板",
            ]
            if any(p in error_msg for p in template_not_found_patterns):
                print(f"❌ Sandbox 模板不存在: {agentrun_browser_sandbox_name}")
                raise SandboxTemplateNotFoundError(
                    f"Sandbox 模板 '{agentrun_browser_sandbox_name}' 不存在"
                )
            else:
                print(f"❌ 创建 Sandbox 失败: {e}")
                raise SandboxCreationError(f"创建 Sandbox 失败: {e}")


async def get_browser_sandbox(sandbox_id: str = None) -> Optional[BrowserSandbox]:
    async with _sandbox_lock:
        if sandbox_id and sandbox_id in _sandboxes:
            return _sandboxes[sandbox_id]
        for sid, sandbox in _sandboxes.items():
            return sandbox
        if agentrun_browser_sandbox_name:
            try:
                sandbox = await Sandbox.create_async(
                    template_type=TemplateType.BROWSER,
                    template_name=agentrun_browser_sandbox_name,
                )
                _sandboxes[sandbox.sandbox_id] = sandbox
                return sandbox
            except Exception as e:
                error_msg = str(e).lower()
                template_not_found_patterns = [
                    "template not found", "template does not exist",
                    "no such template", "template_not_found",
                    "not found", "无法找到模板",
                ]
                if any(p in error_msg for p in template_not_found_patterns):
                    raise SandboxTemplateNotFoundError(
                        f"Sandbox 模板 '{agentrun_browser_sandbox_name}' 不存在"
                    )
                else:
                    raise SandboxCreationError(f"创建 Sandbox 失败: {e}")
        return None


async def remove_sandbox(sandbox_id: str) -> None:
    async with _sandbox_lock:
        if sandbox_id in _sandboxes:
            del _sandboxes[sandbox_id]
            print(f"🗑️ Sandbox 已移除: {sandbox_id[:8]}...")


async def recreate_sandbox_if_closed(sandbox_id: str, error_message: str) -> Optional[BrowserSandbox]:
    closed_error_patterns = [
        "Target page, context or browser has been closed",
        "Browser has been closed", "Target closed",
        "Connection closed", "Session closed",
        "Page closed", "Context closed",
    ]
    is_closed_error = any(p.lower() in error_message.lower() for p in closed_error_patterns)

    if is_closed_error:
        print(f"⚠️ 检测到 Sandbox 已关闭: {error_message[:100]}")
        await remove_sandbox(sandbox_id)
        new_sandbox = await create_browser_sandbox()
        if new_sandbox:
            print(f"✅ 新 Sandbox 创建成功: {new_sandbox.sandbox_id[:8]}...")
            return new_sandbox
    return None


async def get_all_sandboxes() -> List[Dict[str, Any]]:
    from urllib.parse import urlparse, parse_qs, urlencode
    result = []
    async with _sandbox_lock:
        for sandbox_id, sandbox in _sandboxes.items():
            try:
                vnc_url = sandbox.get_vnc_url()
                access_token = sandbox.data_api.access_token
                parsed = urlparse(vnc_url)
                query_dict = parse_qs(parsed.query)
                query_dict["recording"] = ["false"]
                if access_token:
                    query_dict["Authorization"] = [access_token]
                new_path = parsed.path.replace("/ws/liveview", "/ws/livestream")
                new_query = urlencode(query_dict, doseq=True)
                livestream_url = f"{parsed.scheme}://{parsed.netloc}{new_path}?{new_query}"
                result.append({
                    "sandbox_id": sandbox_id,
                    "vnc_url": vnc_url,
                    "livestream_url": livestream_url,
                    "active": True,
                })
            except Exception as e:
                print(f"⚠️ 获取 Sandbox {sandbox_id} 信息失败: {e}")
                result.append({
                    "sandbox_id": sandbox_id,
                    "vnc_url": "", "livestream_url": "",
                    "active": False,
                })
    return result


# =========================================================================
# 数据模型
# =========================================================================

class SearchResult(BaseModel):
    title: str
    url: str
    snippet: str
    source: str
    date: str
    platform: str = "baidu"
    relevance_score: float = 0.0
    detailed_content: str = ""


class AnalysisResult(BaseModel):
    keywords: List[str] = Field(default_factory=list)
    sentiment_score: float = 0.0
    sentiment_distribution: Dict[str, int] = Field(default_factory=dict)
    heat_trend: List[int] = Field(default_factory=list)
    summary: str = ""
    key_opinions: List[Dict[str, str]] = Field(default_factory=list)
    risk_assessment: Dict[str, str] = Field(default_factory=dict)


class SandboxInfo(BaseModel):
    sandbox_id: str
    vnc_url: str
    livestream_url: str
    active: bool = True
    created_at: str = ""


class OpinionState(BaseModel):
    keyword: str = ""
    status: str = "idle"
    logs: List[str] = Field(default_factory=list)
    max_results: int = 10

    raw_data: List[SearchResult] = Field(default_factory=list)
    collected_data_summary: List[Dict[str, str]] = Field(default_factory=list)

    analysis: Optional[AnalysisResult] = None
    analysis_progress: str = ""

    report_text: str = ""
    final_html: str = ""

    collection_progress: int = 0
    current_phase: str = ""

    sandboxes: List[SandboxInfo] = Field(default_factory=list)
    active_sandbox_id: str = ""


# =========================================================================
# 状态推送
# =========================================================================

def push_state_event(event_queue: queue.Queue, state: OpinionState):
    """推送状态快照到事件队列（线程安全）"""
    event = {
        "type": "STATE_SNAPSHOT",
        "snapshot": state.model_dump(),
        "timestamp": int(time.time() * 1000),
    }
    event_queue.put(event)


# =========================================================================
# DashScope 流式调用辅助
# =========================================================================

def call_dashscope_streaming(
    system_prompt: str,
    user_prompt: str,
    on_chunk=None,
) -> str:
    """
    使用 DashScope SDK 进行流式 LLM 调用（同步，在线程中运行）。

    Args:
        system_prompt: 系统提示词
        user_prompt: 用户提示词
        on_chunk: 每次收到新 chunk 时的回调函数，参数为 (full_text_so_far)

    Returns:
        完整的响应文本
    """
    from dashscope import Generation

    responses = Generation.call(
        model=MODEL_NAME,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        stream=True,
        incremental_output=True,
        api_key=DASHSCOPE_API_KEY,
        result_format="message",
    )

    full_text = ""
    for resp in responses:
        if resp.status_code == 200:
            choices = resp.output.get("choices", [])
            if choices:
                delta = choices[0].get("message", {}).get("content", "")
                full_text += delta
                if on_chunk:
                    on_chunk(full_text)
        else:
            print(f"⚠️ DashScope 流式调用出错: {resp.code} - {resp.message}")
            break

    return full_text


def call_dashscope_non_streaming(
    system_prompt: str,
    user_prompt: str,
) -> str:
    """使用 DashScope SDK 进行非流式 LLM 调用"""
    from dashscope import Generation

    resp = Generation.call(
        model=MODEL_NAME,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        api_key=DASHSCOPE_API_KEY,
        result_format="message",
    )

    if resp.status_code == 200:
        return resp.output.choices[0].message.content
    else:
        raise RuntimeError(f"DashScope 调用失败: {resp.code} - {resp.message}")


# =========================================================================
# AgentScope Agent: LLM 决策辅助
# =========================================================================

def agentscope_quick_call(system_prompt: str, user_prompt: str) -> str:
    """
    使用 DashScope SDK 进行快速 LLM 调用。
    用于轻量级决策（如探索决策、相关性增强等）。
    """
    from dashscope import Generation

    response = Generation.call(
        model=MODEL_NAME,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        api_key=DASHSCOPE_API_KEY,
        result_format="message",
    )

    if response.status_code == 200:
        return response.output.choices[0].message.content
    else:
        raise RuntimeError(f"DashScope 调用失败: {response.code} - {response.message}")


# =========================================================================
# 数据质量筛选
# =========================================================================

async def evaluate_relevance(keyword: str, title: str, snippet: str) -> float:
    text = f"{title} {snippet}"
    text_lower = text.lower()

    has_chinese_keyword = any('\u4e00' <= c <= '\u9fff' for c in keyword)
    result_has_chinese = any('\u4e00' <= c <= '\u9fff' for c in text)

    if has_chinese_keyword and not result_has_chinese:
        return 0.0

    irrelevant_patterns = [
        "calculator", "deepseek", "chegg", "stackoverflow", "github.com",
        "npmjs", "pypi", "pizza", "wordreference", "cambridge", "yahoo字典",
        "翻译", "dictionary", "词典"
    ]
    if any(p in text_lower for p in irrelevant_patterns):
        return 0.0

    score = 0.0
    keyword_in_text = keyword in text
    if keyword_in_text:
        score += 0.6
    else:
        if has_chinese_keyword:
            keyword_chars = list(keyword)
            matched_chars = sum(1 for c in keyword_chars if c in text)
            ratio = matched_chars / len(keyword_chars) if keyword_chars else 0
            if ratio < 0.5:
                return 0.0
            score += 0.4 * ratio
        else:
            keyword_words = keyword.lower().split()
            matched_words = sum(1 for w in keyword_words if w in text_lower)
            ratio = matched_words / len(keyword_words) if keyword_words else 0
            if ratio < 0.5:
                return 0.0
            score += 0.4 * ratio

    time_keywords = ["最新", "今日", "近日", "昨日", "本周", "2024", "2025", "2026", "刚刚", "最近"]
    if any(tk in text for tk in time_keywords):
        score += 0.1

    opinion_keywords = ["评价", "评论", "看法", "观点", "讨论", "解析", "如何理解", "怎么学", "讲解"]
    if any(ok in text for ok in opinion_keywords):
        score += 0.1

    platform_keywords = ["知乎", "微博", "豆瓣", "B站", "bilibili", "抖音", "小红书"]
    if any(pk in text for pk in platform_keywords):
        score += 0.1

    ad_keywords = ["广告", "推广", "优惠", "折扣", "促销", "点击立即", "免费下载", "立即购买"]
    if any(ak in text for ak in ad_keywords):
        score -= 0.3

    return max(0.0, min(1.0, score))


def is_valid_result(result: SearchResult, keyword: str) -> bool:
    if not result.title or not result.url:
        return False
    if not result.url.startswith("http"):
        return False
    exclude_domains = ["ad.", "ads.", "click.", "track."]
    if any(ed in result.url.lower() for ed in exclude_domains):
        return False
    return True


# =========================================================================
# 搜索查询生成器
# =========================================================================

def generate_search_queries(keyword: str) -> List[Dict[str, str]]:
    queries = []

    queries.extend([
        {"query": f"{keyword} 是什么", "category": "definition"},
        {"query": f"{keyword} 定义", "category": "definition"},
        {"query": f"{keyword} 概念", "category": "definition"},
        {"query": f"{keyword} 百科", "category": "definition"},
    ])
    queries.extend([
        {"query": f"{keyword} 原理", "category": "principle"},
        {"query": f"{keyword} 工作原理", "category": "principle"},
        {"query": f"{keyword} 详解", "category": "principle"},
        {"query": f"{keyword} 通俗解释", "category": "principle"},
    ])
    queries.extend([
        {"query": f"{keyword} 教程", "category": "tutorial"},
        {"query": f"{keyword} 入门", "category": "tutorial"},
        {"query": f"{keyword} 入门教程", "category": "tutorial"},
        {"query": f"{keyword} 学习", "category": "tutorial"},
    ])
    queries.extend([
        {"query": f"{keyword} 知乎", "category": "zhihu"},
        {"query": f"{keyword} 知乎 科普", "category": "zhihu"},
        {"query": f"{keyword} 知乎 入门", "category": "zhihu"},
        {"query": f"{keyword} 如何理解 知乎", "category": "zhihu"},
    ])
    queries.extend([
        {"query": f"{keyword} B站 教程", "category": "bilibili"},
        {"query": f"{keyword} B站 科普", "category": "bilibili"},
        {"query": f"{keyword} 哔哩哔哩 讲解", "category": "bilibili"},
    ])
    queries.extend([
        {"query": f"{keyword} CSDN", "category": "blog"},
        {"query": f"{keyword} 博客园", "category": "blog"},
        {"query": f"{keyword} 技术博客", "category": "blog"},
    ])
    queries.extend([
        {"query": f"{keyword} 例子", "category": "example"},
        {"query": f"{keyword} 案例", "category": "example"},
        {"query": f"{keyword} 实例", "category": "example"},
        {"query": f"{keyword} 应用", "category": "example"},
    ])
    queries.extend([
        {"query": f"{keyword} 进阶", "category": "advanced"},
        {"query": f"{keyword} 深入理解", "category": "advanced"},
        {"query": f"{keyword} 高级", "category": "advanced"},
    ])

    return queries


# =========================================================================
# LLM 控制的页面深入探索
# =========================================================================

async def llm_decide_exploration(
    keyword: str, page_url: str, page_content: str,
    source: str, available_actions: List[Dict[str, str]],
) -> Dict:
    if not available_actions:
        return {"should_explore": False, "action": None, "reason": "没有可用的操作"}

    prompt = f"""你是学习资料收集助手。请根据以下信息决定是否需要进一步探索页面获取更多学习资料。

【搜索关键词】{keyword}
【当前页面】{page_url}
【来源平台】{source}
【已获取内容预览】（前500字）
{page_content[:500]}
【可用操作】
{json.dumps(available_actions, ensure_ascii=False, indent=2)}

【决策标准】
1. 如果当前内容已经足够丰富（超过300字有效内容），可能不需要进一步探索
2. 如果是知乎/B站等平台，评论区通常包含重要的学习讨论，值得探索
3. 如果页面需要登录才能查看更多内容，则不探索
4. 权衡时间成本，每个页面最多探索1-2个操作

请返回 JSON 格式：
{{"should_explore": true/false, "action": "操作名称", "reason": "决策原因"}}
"""
    try:
        # 使用 AgentScope DialogAgent 进行快速决策
        response_text = await asyncio.to_thread(
            agentscope_quick_call,
            "你是学习资料收集助手，帮助决定是否需要深入探索页面。只返回有效的 JSON。",
            prompt,
        )
        json_match = re.search(r'\{[\s\S]*\}', response_text)
        if json_match:
            return json.loads(json_match.group())
    except Exception as e:
        print(f"   ⚠️ LLM 探索决策失败: {str(e)[:50]}")

    return {"should_explore": False, "action": None, "reason": "决策失败，跳过探索"}


async def explore_page_with_llm(page, keyword, url, source, initial_content):
    extra_content = ""
    available_actions = []

    if "weibo.com" in url:
        available_actions = [
            {"action": "view_comments", "description": "查看评论区内容",
             "selector": ".WB_feed_expand, [class*='comment'], .comment-list"},
        ]
    elif "zhihu.com" in url:
        available_actions = [
            {"action": "view_more_answers", "description": "查看更多回答",
             "selector": ".AnswerItem, .List-item"},
            {"action": "view_comments", "description": "查看评论",
             "selector": ".Comments-container, .CommentItem"},
        ]
    elif "bilibili.com" in url:
        available_actions = [
            {"action": "view_comments", "description": "查看评论区热门评论",
             "selector": ".reply-item, .root-reply"},
        ]

    if not available_actions:
        return extra_content

    decision = await llm_decide_exploration(
        keyword=keyword, page_url=url,
        page_content=initial_content,
        source=source, available_actions=available_actions,
    )

    if not decision.get("should_explore", False):
        print(f"   ℹ️ LLM 决定不探索: {decision.get('reason', '未知原因')}")
        return extra_content

    action = decision.get("action")
    print(f"   🔍 LLM 决定探索: {action} - {decision.get('reason', '')}")

    try:
        for action_def in available_actions:
            if action_def["action"] == action:
                selector = action_def["selector"]
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
                await asyncio.sleep(1)

                expand_selectors = [
                    "button:has-text('展开')", "a:has-text('展开')",
                    "button:has-text('查看更多')", "a:has-text('查看更多')",
                ]
                for exp_sel in expand_selectors:
                    try:
                        expand_btn = await page.query_selector(exp_sel)
                        if expand_btn:
                            await expand_btn.click()
                            await asyncio.sleep(1)
                            break
                    except:
                        pass

                for sel in selector.split(", "):
                    try:
                        elems = await page.query_selector_all(sel.strip())
                        for elem in elems[:10]:
                            text = await elem.inner_text()
                            if text and len(text) > 10:
                                extra_content += text[:300] + "\n---\n"
                                if len(extra_content) > 2000:
                                    break
                        if len(extra_content) > 500:
                            break
                    except:
                        pass

                if extra_content:
                    print(f"   ✅ 探索获取到 {len(extra_content)} 字额外内容")
                break
    except Exception as e:
        print(f"   ⚠️ 探索操作失败: {str(e)[:50]}")

    return extra_content


# =========================================================================
# 阶段 1: 资料收集
# =========================================================================

async def collect_data(keyword: str, state: OpinionState, event_queue: queue.Queue):
    state.keyword = keyword
    state.status = "collecting"
    state.current_phase = "资料收集"
    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] 🔍 开始收集「{keyword}」的学习资料...")
    state.raw_data = []
    state.collected_data_summary = []
    push_state_event(event_queue, state)

    target_count = state.max_results
    collected = []
    seen_urls = set()
    queries = generate_search_queries(keyword)

    # 创建 Browser Sandbox
    try:
        sandbox = await create_browser_sandbox()
        if not sandbox:
            state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ❌ Browser Sandbox 未配置")
            state.status = "error"
            push_state_event(event_queue, state)
            raise RuntimeError("Browser Sandbox 未配置，请设置 AGENTRUN_TEMPLATE_ID")
    except (SandboxTemplateNotFoundError, SandboxCreationError) as e:
        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ❌ {e}")
        state.status = "error"
        state.current_phase = "错误"
        push_state_event(event_queue, state)
        raise RuntimeError(f"无法启动数据收集: {e}")

    sandbox_info = await get_all_sandboxes()
    state.sandboxes = [SandboxInfo(**s) for s in sandbox_info]
    state.active_sandbox_id = sandbox.sandbox_id
    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] 🌐 浏览器已就绪: {sandbox.sandbox_id[:8]}...")
    push_state_event(event_queue, state)

    category_low_relevance_count: Dict[str, int] = {}
    max_low_relevance_per_category = 2
    skipped_categories: set = set()

    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(sandbox.get_cdp_url())
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()

            query_index = 0
            max_retries = 5
            retry_count = 0
            sandbox_retry_count = 0
            max_sandbox_retries = 3

            while len(collected) < target_count:
                if query_index >= len(queries):
                    if retry_count >= max_retries:
                        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 已达到最大重试次数，当前收集 {len(collected)} 条")
                        break
                    retry_count += 1
                    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 数据不足 ({len(collected)}/{target_count})，第 {retry_count} 次补充搜索...")
                    queries.extend([
                        {"query": f"{keyword} 第{retry_count}页", "category": "extra"},
                        {"query": f"{keyword} 相关", "category": "extra"},
                        {"query": f"{keyword} 资讯", "category": "extra"},
                    ])

                query_info = queries[query_index]
                query_index += 1
                q = query_info["query"]
                category = query_info["category"]

                if category in skipped_categories:
                    continue

                state.current_phase = f"数据收集 ({len(collected)}/{target_count})"
                state.collection_progress = int(len(collected) / target_count * 100)

                try:
                    from urllib.parse import quote_plus
                    encoded_query = quote_plus(q)
                    search_url = f"https://www.baidu.com/s?wd={encoded_query}"
                    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] 🔎 搜索 [{category}]: {q[:30]}...")
                    push_state_event(event_queue, state)

                    await page.goto(search_url, timeout=30000)
                    await page.wait_for_load_state("domcontentloaded")
                    await asyncio.sleep(2)

                    current_url = page.url
                    if "baidu.com/s" not in current_url and "baidu.com/baidu" not in current_url:
                        await page.goto(search_url, timeout=30000)
                        await page.wait_for_load_state("domcontentloaded")
                        await asyncio.sleep(2)

                    result_elements = await page.query_selector_all("#content_left .result, #content_left .c-container")

                    if not result_elements:
                        alt_selectors = [
                            "#content_left .result-op",
                            ".result.c-container",
                        ]
                        for alt_sel in alt_selectors:
                            result_elements = await page.query_selector_all(alt_sel)
                            if result_elements:
                                break

                    if not result_elements:
                        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 未找到结果: {q[:30]}...")
                        continue

                    new_results_in_query = 0
                    low_relevance_in_query = 0

                    for elem in result_elements:
                        if len(collected) >= target_count:
                            break
                        try:
                            title_elem = await elem.query_selector("h3 a, .t a, a[href*='baidu.com/link']")
                            snippet_elem = await elem.query_selector(".c-abstract, .c-span-last, .c-row .c-span9, span.content-right_8Zs40")

                            if not title_elem:
                                continue

                            title = await title_elem.inner_text()
                            baidu_link_url = await title_elem.get_attribute("href") or ""

                            if not baidu_link_url or baidu_link_url in seen_urls:
                                continue

                            snippet = ""
                            if snippet_elem:
                                snippet = await snippet_elem.inner_text()

                            seen_urls.add(baidu_link_url)

                            # 深入抓取
                            detailed_content = ""
                            real_url = baidu_link_url
                            detail_page = None
                            source_name = "网络"

                            try:
                                detail_page = await context.new_page()
                                await detail_page.goto(baidu_link_url, timeout=15000)
                                await detail_page.wait_for_load_state("domcontentloaded")
                                await asyncio.sleep(1)

                                real_url = detail_page.url
                                if real_url in seen_urls:
                                    await detail_page.close()
                                    continue
                                seen_urls.add(real_url)

                                # 识别来源
                                source_map = {
                                    "weibo.com": "微博", "zhihu.com": "知乎",
                                    "tieba.baidu.com": "贴吧", "bilibili.com": "B站",
                                    "csdn.net": "CSDN", "jianshu.com": "简书",
                                    "cnblogs.com": "博客园", "baike.baidu.com": "百度百科",
                                    "wikipedia.org": "维基百科",
                                }
                                for domain, name in source_map.items():
                                    if domain in real_url:
                                        source_name = name
                                        break
                                else:
                                    if any(x in real_url for x in ["news", "sina", "sohu", "163", "qq.com"]):
                                        source_name = "新闻"

                                # 按平台提取内容
                                platform_selectors = {
                                    "zhihu.com": [".QuestionRichText", ".RichContent-inner", ".Post-RichText"],
                                    "weibo.com": [".WB_text", "[class*='detail_wbtext']", ".weibo-text"],
                                    "bilibili.com": [".video-desc", ".desc-info-text", ".reply-content", ".article-content"],
                                    "baike.baidu.com": [".lemma-summary", ".para", ".basic-info"],
                                    "csdn.net": ["#content_views", ".article_content", ".markdown_views"],
                                }

                                content_selectors = None
                                for domain_key, selectors in platform_selectors.items():
                                    if domain_key in real_url:
                                        content_selectors = selectors
                                        break

                                if content_selectors is None:
                                    content_selectors = ["article", ".article-content", ".post-content", ".content", "main p"]

                                for sel in content_selectors:
                                    content_elems = await detail_page.query_selector_all(sel)
                                    for content_elem in content_elems[:5]:
                                        text = await content_elem.inner_text()
                                        if text and len(text) > 50:
                                            detailed_content += text[:1500] + "\n\n"
                                            if len(detailed_content) > 3000:
                                                break
                                    if len(detailed_content) > 500:
                                        break

                                if detailed_content:
                                    try:
                                        extra = await explore_page_with_llm(
                                            page=detail_page, keyword=keyword,
                                            url=real_url, source=source_name,
                                            initial_content=detailed_content,
                                        )
                                        if extra:
                                            detailed_content += "\n\n【深入探索内容】\n" + extra
                                    except Exception:
                                        pass

                            except Exception as e:
                                print(f"   ⚠️ 深入抓取失败: {str(e)[:50]}")
                            finally:
                                if detail_page:
                                    await detail_page.close()

                            # 相关性评估
                            content_for_relevance = detailed_content if detailed_content else snippet
                            relevance = await evaluate_relevance(keyword, title, content_for_relevance)

                            if relevance < 0.3:
                                low_relevance_in_query += 1
                                continue

                            full_content = detailed_content.strip()[:3000] if detailed_content else snippet.strip()

                            result = SearchResult(
                                title=title.strip(),
                                url=real_url,
                                snippet=full_content[:500],
                                source=source_name,
                                date=datetime.now().strftime("%Y-%m-%d"),
                                platform="baidu",
                                relevance_score=relevance,
                                detailed_content=detailed_content[:3000] if detailed_content else "",
                            )

                            if not is_valid_result(result, keyword):
                                continue

                            collected.append(result)
                            state.raw_data.append(result)
                            state.collected_data_summary.append({
                                "title": result.title[:50],
                                "url": result.url,
                                "source": result.source,
                                "relevance": f"{relevance:.0%}",
                            })
                            state.collection_progress = int(len(collected) / target_count * 100)
                            new_results_in_query += 1

                            print(f"💾 [{len(collected)}/{target_count}] [{relevance:.0%}] {source_name}: {title[:40]}...")
                            push_state_event(event_queue, state)

                        except Exception as e:
                            print(f"⚠️ 解析结果失败: {e}")
                            continue

                    # 更新类别低相关性计数
                    if new_results_in_query == 0 and low_relevance_in_query > 3:
                        category_low_relevance_count[category] = category_low_relevance_count.get(category, 0) + 1
                        if category_low_relevance_count[category] >= max_low_relevance_per_category:
                            skipped_categories.add(category)
                            state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ⏭️ 跳过低效链路: {category}")
                    elif new_results_in_query > 0:
                        category_low_relevance_count[category] = 0

                    if new_results_in_query > 0:
                        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ✓ 本次获得 {new_results_in_query} 条有效结果")
                        push_state_event(event_queue, state)

                except Exception as e:
                    error_msg = str(e)
                    print(f"⚠️ 搜索失败: {error_msg}")
                    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 搜索失败: {error_msg[:50]}")

                    if sandbox_retry_count < max_sandbox_retries:
                        new_sandbox = await recreate_sandbox_if_closed(sandbox.sandbox_id, error_msg)
                        if new_sandbox:
                            sandbox_retry_count += 1
                            sandbox = new_sandbox
                            sandbox_info_list = await get_all_sandboxes()
                            state.sandboxes = [SandboxInfo(**s) for s in sandbox_info_list]
                            state.active_sandbox_id = sandbox.sandbox_id
                            push_state_event(event_queue, state)
                            try:
                                browser = await playwright.chromium.connect_over_cdp(sandbox.get_cdp_url())
                                context = browser.contexts[0] if browser.contexts else await browser.new_context()
                                page = context.pages[0] if context.pages else await context.new_page()
                                continue
                            except Exception:
                                pass

                await asyncio.sleep(1)

    except Exception as e:
        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ❌ 数据收集出错: {str(e)[:100]}")
        new_sandbox = await recreate_sandbox_if_closed(state.active_sandbox_id, str(e))
        if new_sandbox:
            sandbox_info_list = await get_all_sandboxes()
            state.sandboxes = [SandboxInfo(**s) for s in sandbox_info_list]
            state.active_sandbox_id = new_sandbox.sandbox_id
            push_state_event(event_queue, state)

    state.raw_data.sort(key=lambda x: x.relevance_score, reverse=True)
    state.status = "collected"
    state.collection_progress = 100
    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ✅ 资料收集完成: {len(collected)} 条学习资料")
    state.current_phase = f"已收集 {len(collected)} 条资料"
    push_state_event(event_queue, state)


# =========================================================================
# 阶段 2: 知识分析（使用 DashScope 流式调用）
# =========================================================================

async def analyze_data(state: OpinionState, event_queue: queue.Queue):
    state.status = "analyzing"
    state.current_phase = "知识分析"
    state.analysis_progress = ""
    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] 📊 开始知识点提取和分析...")
    push_state_event(event_queue, state)

    source_stats = {}
    for item in state.raw_data:
        source_stats[item.source] = source_stats.get(item.source, 0) + 1

    state.analysis_progress = "正在统计数据来源分布...\n"
    state.analysis_progress += f"数据来源: {json.dumps(source_stats, ensure_ascii=False)}\n\n"
    push_state_event(event_queue, state)

    data_for_analysis = []
    detailed_contents = []
    for item in state.raw_data[:30]:
        data_for_analysis.append({
            "title": item.title,
            "snippet": item.snippet[:300],
            "source": item.source,
            "relevance": item.relevance_score,
        })
        if item.detailed_content:
            detailed_contents.append({
                "title": item.title,
                "source": item.source,
                "content": item.detailed_content[:1500],
            })

    state.analysis_progress += "正在提取核心概念和知识点...\n"
    state.analysis_progress += f"已获取 {len(detailed_contents)} 条详细内容用于知识提取\n"
    push_state_event(event_queue, state)

    detailed_section = ""
    if detailed_contents:
        detailed_section = f"""

【详细内容摘录】（深入抓取的原文内容）：
{json.dumps(detailed_contents[:10], ensure_ascii=False, indent=2)}
"""

    analysis_prompt = f"""
请对以下关于「{state.keyword}」的 {len(state.raw_data)} 条学习资料进行知识提取和分析。

【资料概览】
- 学习主题: {state.keyword}
- 资料总量: {len(state.raw_data)} 条
- 资料来源分布: {json.dumps(source_stats, ensure_ascii=False)}

【资料样本】
{json.dumps(data_for_analysis, ensure_ascii=False, indent=2)}

{detailed_section}

【分析要求】
1. **核心概念提取**: 提取 15-20 个核心概念和术语
2. **难度评估**: 计算综合难度得分 (-1 到 1)，统计内容类型分布
3. **学习热度**: 预估学习热度趋势 (0-100)
4. **关键知识点提炼**: 从资料中提炼 5-8 个最重要的知识点
5. **学习建议**: 前置知识、学习路径、进阶方向

请返回 JSON 格式：
{{"keywords": [...], "sentiment_score": 0.0, "sentiment_distribution": {{"定义": 40, "原理": 35, "应用": 25}}, "heat_trend": [30, 45, 60, 80, 70, 55, 40], "summary": "300-500字的知识概述", "key_opinions": [{{"viewpoint": "...", "source": "...", "sentiment": "定义/原理/应用", "influence": "核心/重要/补充"}}], "risk_assessment": {{"spread_risk": "高/中/低", "spread_reason": "前置知识要求", "reputation_risk": "高/中/低", "reputation_reason": "学习难度说明", "trend": "上升/平稳/下降", "trend_reason": "学习路径建议"}}}}
"""

    analysis_sys_prompt = """你是资深知识分析专家和教育顾问，擅长从海量学习资料中提炼核心知识点。

【分析原则】
1. 资料驱动：所有结论必须基于收集的资料
2. 深度提炼：挖掘概念背后的深层原理
3. 原文引用：提炼知识点时要引用原文
4. 结构化分析：按定义、原理、应用进行分类
5. 学习导向：关注学习路径和难度评估

【输出要求】
- 必须返回有效的 JSON 格式
- summary 要详细，300-500 字
- key_opinions 要具体，引用原文"""

    try:
        state.analysis_progress += "正在调用 AI 进行知识提取...\n"
        push_state_event(event_queue, state)

        last_push_time = [time.time()]
        last_push_len = [0]

        def on_analysis_chunk(full_text):
            now = time.time()
            if len(full_text) - last_push_len[0] >= 200 or now - last_push_time[0] >= 0.5:
                state.analysis_progress = f"正在分析中... ({len(full_text)} 字)\n"
                push_state_event(event_queue, state)
                last_push_len[0] = len(full_text)
                last_push_time[0] = now

        response_text = await asyncio.to_thread(
            call_dashscope_streaming,
            analysis_sys_prompt,
            analysis_prompt,
            on_analysis_chunk,
        )

        json_match = re.search(r'\{[\s\S]*\}', response_text)
        if json_match:
            analysis_data = json.loads(json_match.group())
            state.analysis = AnalysisResult(
                keywords=analysis_data.get("keywords", [state.keyword]),
                sentiment_score=float(analysis_data.get("sentiment_score", 0)),
                sentiment_distribution=analysis_data.get("sentiment_distribution", {"正面": 33, "中性": 34, "负面": 33}),
                heat_trend=analysis_data.get("heat_trend", [50]*7),
                summary=analysis_data.get("summary", f"关于「{state.keyword}」的知识分析"),
                key_opinions=analysis_data.get("key_opinions", []),
                risk_assessment=analysis_data.get("risk_assessment", {}),
            )
            state.analysis_progress += f"\n✅ 知识提取完成！\n"
            state.analysis_progress += f"- 难度评分: {state.analysis.sentiment_score:.2f}\n"
            state.analysis_progress += f"- 核心概念: {', '.join(state.analysis.keywords[:5])}\n"
            state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ✅ 知识提取完成")
        else:
            raise ValueError("无法解析 JSON")

    except Exception as e:
        print(f"⚠️ 分析出错: {e}")
        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 分析出错，使用默认值")
        state.analysis = AnalysisResult(
            keywords=[state.keyword],
            sentiment_score=0,
            sentiment_distribution={"正面": 33, "中性": 34, "负面": 33},
            heat_trend=[50]*7,
            summary=f"关于「{state.keyword}」的知识分析",
        )

    state.status = "analyzed"
    state.current_phase = "知识提取完成"
    push_state_event(event_queue, state)


# =========================================================================
# 阶段 3: 撰写知识讲解文档（使用 DashScope 流式调用）
# =========================================================================

async def write_report(state: OpinionState, event_queue: queue.Queue):
    state.status = "writing"
    state.current_phase = "文档撰写"
    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] 📝 开始撰写知识讲解文档...")
    state.report_text = ""
    push_state_event(event_queue, state)

    analysis = state.analysis or AnalysisResult()
    keyword = state.keyword
    data_count = len(state.raw_data)

    source_stats = {}
    for item in state.raw_data:
        source_stats[item.source] = source_stats.get(item.source, 0) + 1

    state.report_text = f"# {keyword} 知识讲解\n\n> 正在生成知识讲解文档，请稍候...\n\n"
    push_state_event(event_queue, state)

    references_data = []
    for i, item in enumerate(state.raw_data[:20]):
        ref = {
            "id": i + 1, "title": item.title, "source": item.source,
            "url": item.url, "snippet": item.snippet[:200],
            "relevance": f"{item.relevance_score:.0%}",
        }
        if item.detailed_content:
            ref["content"] = item.detailed_content[:600]
        references_data.append(ref)

    references_list_md = "\n".join([
        f"[{ref['id']}] [{ref['title'][:50]}...]({ref['url']}) - {ref['source']}"
        for ref in references_data
    ])

    report_prompt = f"""
请为「{keyword}」撰写一份通俗易懂的知识讲解文档。

【资料基础】
- 整理时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}
- 资料量: {data_count} 条学习资料
- 资料来源: {json.dumps(source_stats, ensure_ascii=False)}
- 难度评分: {analysis.sentiment_score:.2f}
- 核心概念: {', '.join(analysis.keywords[:15])}

【知识概述】
{analysis.summary}

【关键知识点】
{json.dumps(analysis.key_opinions, ensure_ascii=False, indent=2)}

【参考资料】
{json.dumps(references_data, ensure_ascii=False, indent=2)}

【文档撰写要求】
必须包含以下六个章节（3000-5000字）：
1. 一、概念简介
2. 二、核心原理
3. 三、详细讲解
4. 四、应用案例
5. 五、关联知识与进阶
6. 六、总结与学习建议
7. 附录：参考资料

【引用规范】
- 使用 Markdown 链接格式引用参考资料
- 格式：根据[百度百科](URL)的定义...
- 每个章节至少引用 2-3 个资料来源

【写作风格】
- 通俗易懂、循序渐进
- 多用类比和实例帮助理解
- 适合零基础读者阅读

【附录格式】
{references_list_md}

请直接输出 Markdown 格式的知识讲解文档。
"""

    writer_sys_prompt = """你是顶级知识讲解专家和科普作家，拥有 15 年以上教育和科普写作经验。

【核心能力】
1. 知识提炼：从海量资料中提取核心概念
2. 深入浅出：用通俗语言和生动类比解释复杂概念
3. 循序渐进：按认知规律组织内容
4. 实例驱动：用丰富的案例加深理解

【质量标准】
- 篇幅: 3000-5000 字
- 引用: 每个章节至少引用 2-3 个资料来源
- 深度: 概念解释透彻
- 实用: 提供可操作的学习建议"""

    try:
        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] 📝 正在生成知识讲解内容...")
        push_state_event(event_queue, state)

        last_push_time = [time.time()]
        last_push_len = [0]

        def on_report_chunk(full_text):
            state.report_text = full_text
            now = time.time()
            if len(full_text) - last_push_len[0] >= 100 or now - last_push_time[0] >= 0.3:
                push_state_event(event_queue, state)
                last_push_len[0] = len(full_text)
                last_push_time[0] = now

        report_content = await asyncio.to_thread(
            call_dashscope_streaming,
            writer_sys_prompt,
            report_prompt,
            on_report_chunk,
        )

        report_content = re.sub(r'^```\w*\n?', '', report_content)
        report_content = re.sub(r'\n?```$', '', report_content)

        state.report_text = report_content
        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ✅ 知识讲解文档完成: {len(report_content)} 字")

    except Exception as e:
        print(f"⚠️ 文档撰写出错: {e}")
        state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ 文档撰写出错，使用模板")
        state.report_text = _generate_template_report(state)

    state.status = "written"
    state.current_phase = "文档完成"
    push_state_event(event_queue, state)


def _generate_template_report(state: OpinionState) -> str:
    analysis = state.analysis or AnalysisResult()
    keyword = state.keyword
    data_count = len(state.raw_data)
    source_stats = {}
    for item in state.raw_data:
        source_stats[item.source] = source_stats.get(item.source, 0) + 1

    return f"""# {keyword} 知识讲解

> **内容概述**: {analysis.summary or f'基于 {data_count} 条学习资料整理的知识讲解'}

---

## 一、概念简介

### 1.1 资料来源
- **整理时间**: {datetime.now().strftime('%Y-%m-%d')}
- **资料来源**: {', '.join(source_stats.keys()) if source_stats else '网络'}
- **资料量**: 共 {data_count} 条学习资料

### 1.2 什么是「{keyword}」

「{keyword}」是一个重要的概念/事物。核心知识点包括：

{chr(10).join([f'- **{kw}**' for kw in (analysis.keywords[:6] if analysis.keywords else [keyword])])}

---

## 二、核心原理

待补充。

---

## 三、详细讲解

待补充。

---

## 四、应用案例

待补充。

---

## 五、关联知识与进阶

待补充。

---

## 六、总结与学习建议

待补充。

---

### 附录：参考资料

{chr(10).join([f'{i+1}. [{item.title[:50]}...]({item.url}) - {item.source}' for i, item in enumerate(state.raw_data[:10])])}

---
*本文档由 AI 搜学助手自动生成，仅供参考。*
*⚠️ 内容由AI生成，仅供参考，您据此所作判断及操作均由您自行承担责任。*
"""


# =========================================================================
# 阶段 4: 渲染 HTML
# =========================================================================

async def render_html(state: OpinionState, event_queue: queue.Queue):
    state.status = "rendering"
    state.current_phase = "HTML 渲染"
    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] 🎨 渲染知识讲解文档...")
    push_state_event(event_queue, state)

    try:
        import markdown
        report_html = markdown.markdown(
            state.report_text,
            extensions=["extra", "tables", "toc"]
        )
    except ImportError:
        report_html = state.report_text.replace("\n\n", "</p><p>").replace("\n", "<br>")
        report_html = f"<p>{report_html}</p>"

    analysis = state.analysis or AnalysisResult()
    sentiment_data = analysis.sentiment_distribution or {"定义": 33, "原理": 34, "应用": 33}
    heat_trend = analysis.heat_trend or [50]*7
    heat_labels = ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"]
    keywords = analysis.keywords or [state.keyword]
    keyword_weights = []
    for i, kw in enumerate(keywords[:20]):
        weight = 100 - i * 5
        keyword_weights.append({"name": kw, "value": max(weight, 20)})

    source_stats = {}
    for item in state.raw_data:
        source_stats[item.source] = source_stats.get(item.source, 0) + 1

    state.final_html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{state.keyword} - AI 搜学助手</title>
    <base target="_blank">
    <script>
        (function() {{
            var baseUrl = '';
            try {{
                if (window.parent && window.parent.location && window.parent !== window) {{
                    baseUrl = window.parent.location.origin;
                }}
            }} catch(e) {{
                baseUrl = window.location.origin || '';
            }}
            function loadScript(url) {{
                return new Promise(function(resolve, reject) {{
                    var script = document.createElement('script');
                    script.src = baseUrl + url;
                    script.onload = resolve;
                    script.onerror = function() {{
                        var fallbackUrl = url.includes('wordcloud')
                            ? 'https://cdn.jsdelivr.net/npm/echarts-wordcloud@2.1.0/dist/echarts-wordcloud.min.js'
                            : 'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js';
                        var fallbackScript = document.createElement('script');
                        fallbackScript.src = fallbackUrl;
                        fallbackScript.onload = resolve;
                        fallbackScript.onerror = reject;
                        document.head.appendChild(fallbackScript);
                    }};
                    document.head.appendChild(script);
                }});
            }}
            loadScript('/echarts/echarts.min.js').then(function() {{
                return loadScript('/echarts/echarts-wordcloud.min.js');
            }}).then(function() {{
                window.dispatchEvent(new CustomEvent('echarts-ready'));
            }}).catch(function(e) {{
                console.error('Failed to load ECharts:', e);
            }});
        }})();
    </script>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); min-height: 100vh; padding: 40px 20px; line-height: 1.8; }}
        .container {{ max-width: 1100px; margin: 0 auto; background: rgba(255,255,255,0.98); padding: 50px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }}
        .disclaimer {{ background: linear-gradient(135deg, #fff3cd 0%, #ffe8a1 100%); border: 1px solid #ffc107; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; font-size: 14px; color: #856404; }}
        h1 {{ color: #1a202c; border-bottom: 3px solid #667eea; padding-bottom: 15px; margin-bottom: 30px; font-size: 2em; }}
        h2 {{ color: #2d3748; margin-top: 40px; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #e2e8f0; }}
        h3 {{ color: #4a5568; margin-top: 25px; margin-bottom: 15px; }}
        p {{ margin-bottom: 16px; color: #4a5568; }}
        ul, ol {{ margin-left: 24px; margin-bottom: 16px; color: #4a5568; }}
        li {{ margin-bottom: 8px; }}
        strong {{ color: #2d3748; }}
        blockquote {{ background: #f7fafc; border-left: 4px solid #667eea; padding: 15px 20px; margin: 20px 0; border-radius: 0 8px 8px 0; }}
        table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
        th, td {{ border: 1px solid #e2e8f0; padding: 12px; text-align: left; }}
        th {{ background: #f7fafc; font-weight: 600; }}
        a {{ color: #667eea; text-decoration: none; }}
        a:hover {{ text-decoration: underline; }}
        hr {{ border: none; border-top: 1px solid #e2e8f0; margin: 30px 0; }}
        code {{ background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }}
        .charts-section {{ background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%); border-radius: 12px; padding: 30px; margin: 30px 0; }}
        .charts-title {{ text-align: center; color: #2d3748; font-size: 1.5em; margin-bottom: 25px; font-weight: 600; }}
        .charts-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }}
        .chart-card {{ background: white; border-radius: 12px; padding: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }}
        .chart-card-title {{ text-align: center; color: #4a5568; font-size: 1em; margin-bottom: 15px; font-weight: 500; }}
        .chart-container {{ width: 100%; height: 280px; }}
        .wordcloud-container {{ grid-column: span 2; }}
        .wordcloud-chart {{ height: 320px; }}
        @media (max-width: 768px) {{ .charts-grid {{ grid-template-columns: 1fr; }} .wordcloud-container {{ grid-column: span 1; }} }}
    </style>
</head>
<body>
    <div class="container">
        <div class="disclaimer">
            ⚠️ <strong>免责声明</strong>：内容由AI生成，仅供参考，您据此所作判断及操作均由您自行承担责任。
        </div>
        {report_html}
        <div class="charts-section">
            <div class="charts-title">📊 知识结构可视化</div>
            <div class="charts-grid">
                <div class="chart-card">
                    <div class="chart-card-title">内容类型分布</div>
                    <div id="sentimentChart" class="chart-container"></div>
                </div>
                <div class="chart-card">
                    <div class="chart-card-title">学习热度趋势</div>
                    <div id="heatChart" class="chart-container"></div>
                </div>
                <div class="chart-card">
                    <div class="chart-card-title">资料来源分布</div>
                    <div id="sourceChart" class="chart-container"></div>
                </div>
                <div class="chart-card">
                    <div class="chart-card-title">学习难度评估</div>
                    <div id="riskChart" class="chart-container"></div>
                </div>
                <div class="chart-card wordcloud-container">
                    <div class="chart-card-title">核心概念词云</div>
                    <div id="wordcloudChart" class="chart-container wordcloud-chart"></div>
                </div>
            </div>
        </div>
    </div>
    <script>
        function initCharts() {{
            if (typeof echarts === 'undefined') {{ setTimeout(initCharts, 100); return; }}
            var sentimentChart = echarts.init(document.getElementById('sentimentChart'));
            sentimentChart.setOption({{
                tooltip: {{ trigger: 'item', formatter: '{{b}}: {{c}}% ({{d}}%)' }},
                legend: {{ bottom: '5%', left: 'center' }},
                series: [{{ type: 'pie', radius: ['40%', '70%'], avoidLabelOverlap: false,
                    itemStyle: {{ borderRadius: 10, borderColor: '#fff', borderWidth: 2 }},
                    label: {{ show: false, position: 'center' }},
                    emphasis: {{ label: {{ show: true, fontSize: 20, fontWeight: 'bold' }} }},
                    labelLine: {{ show: false }},
                    data: [
                        {{ value: {sentiment_data.get('定义', 33)}, name: '定义', itemStyle: {{ color: '#52c41a' }} }},
                        {{ value: {sentiment_data.get('原理', 34)}, name: '原理', itemStyle: {{ color: '#1890ff' }} }},
                        {{ value: {sentiment_data.get('应用', 33)}, name: '应用', itemStyle: {{ color: '#ff4d4f' }} }}
                    ]
                }}]
            }});
            var heatChart = echarts.init(document.getElementById('heatChart'));
            heatChart.setOption({{
                tooltip: {{ trigger: 'axis' }},
                xAxis: {{ type: 'category', data: {json.dumps(heat_labels)}, boundaryGap: false }},
                yAxis: {{ type: 'value', min: 0, max: 100 }},
                series: [{{ type: 'line', smooth: true, data: {json.dumps(heat_trend)},
                    areaStyle: {{ color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{{ offset: 0, color: 'rgba(102, 126, 234, 0.5)' }}, {{ offset: 1, color: 'rgba(102, 126, 234, 0.05)' }}]) }},
                    lineStyle: {{ color: '#667eea', width: 3 }}, itemStyle: {{ color: '#667eea' }}
                }}]
            }});
            var sourceChart = echarts.init(document.getElementById('sourceChart'));
            sourceChart.setOption({{
                tooltip: {{ trigger: 'axis', axisPointer: {{ type: 'shadow' }} }},
                xAxis: {{ type: 'category', data: {json.dumps(list(source_stats.keys()))} }},
                yAxis: {{ type: 'value' }},
                series: [{{ type: 'bar', data: {json.dumps(list(source_stats.values()))},
                    itemStyle: {{ color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{{ offset: 0, color: '#667eea' }}, {{ offset: 1, color: '#764ba2' }}]), borderRadius: [5, 5, 0, 0] }}
                }}]
            }});
            var riskChart = echarts.init(document.getElementById('riskChart'));
            var difficultyScore = {analysis.sentiment_score * 50 + 50};
            var difficultyColor = difficultyScore < 40 ? '#52c41a' : (difficultyScore < 60 ? '#faad14' : '#ff4d4f');
            riskChart.setOption({{
                series: [{{ type: 'gauge', startAngle: 180, endAngle: 0, min: 0, max: 100, splitNumber: 5,
                    itemStyle: {{ color: difficultyColor }}, progress: {{ show: true, width: 20 }}, pointer: {{ show: false }},
                    axisLine: {{ lineStyle: {{ width: 20 }} }}, axisTick: {{ show: false }}, splitLine: {{ show: false }},
                    axisLabel: {{ show: false }}, title: {{ show: false }},
                    detail: {{ valueAnimation: true, fontSize: 28, offsetCenter: [0, '0%'],
                        formatter: function(value) {{ if (value < 40) return '入门级'; if (value < 60) return '中级'; return '高级'; }},
                        color: difficultyColor
                    }},
                    data: [{{ value: difficultyScore }}]
                }}]
            }});
            var wordcloudChart = echarts.init(document.getElementById('wordcloudChart'));
            wordcloudChart.setOption({{
                series: [{{ type: 'wordCloud', shape: 'circle', left: 'center', top: 'center',
                    width: '90%', height: '90%', sizeRange: [14, 60], rotationRange: [-45, 45],
                    gridSize: 8, drawOutOfBound: false,
                    textStyle: {{ fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif', fontWeight: 'bold',
                        color: function() {{ var colors = ['#667eea', '#764ba2', '#f093fb', '#f5576c', '#4facfe', '#00f2fe', '#43e97b', '#38f9d7']; return colors[Math.floor(Math.random() * colors.length)]; }}
                    }},
                    data: {json.dumps(keyword_weights)}
                }}]
            }});
            window.addEventListener('resize', function() {{
                sentimentChart.resize(); heatChart.resize(); sourceChart.resize(); riskChart.resize(); wordcloudChart.resize();
            }});
        }}
        window.addEventListener('echarts-ready', initCharts);
        if (document.readyState === 'complete') {{ setTimeout(initCharts, 500); }}
        else {{ window.addEventListener('load', function() {{ setTimeout(initCharts, 500); }}); }}
    </script>
</body>
</html>"""

    state.status = "complete"
    state.current_phase = "整理完成"
    state.logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] ✅ 知识整理完成")
    push_state_event(event_queue, state)


# =========================================================================
# 主 Pipeline：代码控制流程流转
# =========================================================================

async def run_pipeline(keyword: str, state: OpinionState, event_queue: queue.Queue):
    """
    执行完整的学习分析流程。

    流程由代码严格控制，不依赖 LLM 自主决策：
    1. 资料收集 → 2. 知识分析 → 3. 文档撰写 → 4. HTML 渲染
    """
    print(f"\n{'='*60}")
    print(f"🚀 AgentScope Pipeline 开始: {keyword}")
    print(f"{'='*60}")

    try:
        # 阶段 1: 资料收集
        await collect_data(keyword, state, event_queue)

        # 阶段 2: 知识分析
        await analyze_data(state, event_queue)

        # 阶段 3: 文档撰写
        await write_report(state, event_queue)

        # 阶段 4: HTML 渲染
        await render_html(state, event_queue)

        print(f"\n✅ Pipeline 完成: {keyword}")

    except Exception as e:
        print(f"\n❌ Pipeline 出错: {e}")
        import traceback
        traceback.print_exc()
        raise
