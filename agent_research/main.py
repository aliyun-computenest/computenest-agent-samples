"""
AI搜学助手 - AgentScope 版本后端

提供：
1. SSE API (/api/agent) - 兼容 AG-UI 前端协议的实时状态推送
2. Browser VNC URL API (/api/browser/vnc)
3. Browser Sandboxes API (/api/browser/sandboxes)
4. Browser Screenshot API (/api/browser/screenshot)
"""
import uvicorn
import asyncio
import json
import queue
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from playwright.async_api import async_playwright
from contextlib import asynccontextmanager

from agents.research_agent import (
    OpinionState, run_pipeline,
    get_browser_sandbox, get_all_sandboxes,
)
from tools.event_queue import event_manager


# ===== Lifespan =====
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("\n" + "="*60)
    print("🚀 启动AI搜学助手 (AgentScope 版本)")
    print("   - AgentScope + DashScope 模型")
    print("   - 代码控制流程")
    print("   - 实时状态推送")
    print("   - 多 Sandbox 支持")
    print("="*60)
    yield
    print("\n🛑 关闭AI搜学助手")


# ===== 主 FastAPI 应用 =====
app = FastAPI(title="AI搜学助手 (AgentScope)", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===== AG-UI 兼容的 SSE API =====
@app.post("/api/agent")
async def agent_endpoint(request: Request):
    """
    AG-UI 兼容端点 - 发送 AG-UI 格式的 SSE 事件

    前端使用 @ag-ui/client 的 HttpAgent 连接此端点，
    期望收到 RUN_STARTED / STATE_SNAPSHOT / RUN_FINISHED / RUN_ERROR 事件。
    """
    body = await request.json()

    # 解析 AG-UI 协议字段
    run_id = body.get("run_id", "")
    thread_id = body.get("thread_id", "")
    messages = body.get("messages", [])
    frontend_state = body.get("state", {})

    print(f"\n{'='*60}")
    print(f"🚀 开始处理请求: run_id={run_id}")
    print(f"{'='*60}")

    # 初始化状态
    state = OpinionState()
    if frontend_state:
        if "max_results" in frontend_state:
            state.max_results = int(frontend_state["max_results"])
            print(f"📊 最大采集数量: {state.max_results}")

    # 提取用户消息
    user_message = ""
    for msg in messages:
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                user_message = content
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and "text" in part:
                        user_message = part["text"]
                        break
            break

    if not user_message:
        user_message = "开始学习分析"

    # 从消息中提取关键词
    keyword = user_message
    # 尝试从 "帮我学习和理解'xxx'" 格式中提取
    import re
    match = re.search(r"['\u2018\u2019\u201c\u201d](.+?)['\u2018\u2019\u201c\u201d]", user_message)
    if match:
        keyword = match.group(1)

    print(f"📝 用户消息: {user_message}")
    print(f"📝 关键词: {keyword}")

    # 获取事件队列（线程安全的 queue.Queue）
    eq = event_manager.get_queue(run_id)

    async def event_generator():
        """SSE 事件生成器 - 发送 AG-UI 兼容事件"""

        # 1. 发送 RUN_STARTED
        run_started = {
            "type": "RUN_STARTED",
            "threadId": thread_id,
            "runId": run_id,
        }
        yield f"data: {json.dumps(run_started)}\n\n"

        # 2. 在后台启动 Pipeline
        agent_task = asyncio.create_task(
            run_agent_in_background(keyword, state, eq, run_id)
        )

        # 3. 消费事件队列
        agent_done = False
        has_error = False

        while not agent_done:
            try:
                # 非阻塞读取队列
                try:
                    event = eq.get_nowait()
                    if isinstance(event, dict):
                        event_dict = event
                    else:
                        event_dict = {"type": "UNKNOWN", "data": str(event)}
                    yield f"data: {json.dumps(event_dict, ensure_ascii=False, default=str)}\n\n"
                except queue.Empty:
                    await asyncio.sleep(0.1)

                # 检查 Pipeline 是否完成
                if agent_task.done():
                    # 清空队列中剩余事件
                    while not eq.empty():
                        try:
                            event = eq.get_nowait()
                            if isinstance(event, dict):
                                event_dict = event
                            else:
                                event_dict = {"type": "UNKNOWN", "data": str(event)}
                            yield f"data: {json.dumps(event_dict, ensure_ascii=False, default=str)}\n\n"
                        except:
                            break

                    agent_done = True
                    try:
                        agent_task.result()
                    except Exception as e:
                        print(f"❌ Pipeline 执行错误: {e}")
                        has_error = True
                        error_event = {
                            "type": "RUN_ERROR",
                            "message": str(e),
                        }
                        yield f"data: {json.dumps(error_event)}\n\n"

            except Exception as e:
                print(f"❌ 事件生成器错误: {e}")
                break

        # 4. 发送 RUN_FINISHED
        if not has_error:
            run_finished = {
                "type": "RUN_FINISHED",
                "threadId": thread_id,
                "runId": run_id,
            }
            yield f"data: {json.dumps(run_finished)}\n\n"

        # 5. 清理
        event_manager.remove_queue(run_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


async def run_agent_in_background(
    keyword: str,
    state: OpinionState,
    event_queue: queue.Queue,
    run_id: str,
):
    """在后台运行 AgentScope Pipeline"""
    try:
        await run_pipeline(keyword, state, event_queue)
        print(f"✅ Pipeline 执行完成")
    except Exception as e:
        print(f"❌ Pipeline 执行失败: {e}")
        import traceback
        traceback.print_exc()
        raise


# ===== Browser VNC/Livestream API =====
@app.get("/api/browser/vnc")
async def get_browser_vnc_url():
    from urllib.parse import urlparse, parse_qs, urlencode

    try:
        sandbox = await get_browser_sandbox()
        if sandbox is None:
            return JSONResponse({
                "available": False,
                "vnc_url": None,
                "livestream_url": None,
                "sandbox_id": None,
                "message": "Browser Sandbox 未配置或不可用"
            })

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

        return JSONResponse({
            "available": True,
            "vnc_url": vnc_url,
            "livestream_url": livestream_url,
            "sandbox_id": sandbox.sandbox_id,
            "message": "VNC URL 获取成功"
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse({
            "available": False,
            "vnc_url": None,
            "livestream_url": None,
            "sandbox_id": None,
            "message": f"获取 VNC URL 失败: {str(e)}"
        }, status_code=500)


# ===== Browser Sandboxes API =====
@app.get("/api/browser/sandboxes")
async def get_browser_sandboxes():
    try:
        sandboxes = await get_all_sandboxes()
        return JSONResponse({
            "sandboxes": sandboxes,
            "count": len(sandboxes),
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse({
            "sandboxes": [],
            "count": 0,
            "error": str(e),
        }, status_code=500)


# ===== Browser Screenshot API =====
@app.get("/api/browser/screenshot")
async def get_browser_screenshot(sandbox_id: str = None):
    try:
        sandbox = await get_browser_sandbox(sandbox_id)
        if sandbox is None:
            return JSONResponse({
                "available": False,
                "message": "Browser Sandbox 未配置或不可用"
            }, status_code=404)

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(sandbox.get_cdp_url())
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
            screenshot_bytes = await page.screenshot(type="png", full_page=False)

            return Response(
                content=screenshot_bytes,
                media_type="image/png",
                headers={
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "X-Sandbox-Id": sandbox.sandbox_id or ""
                }
            )
    except Exception as e:
        print(f"❌ 截图失败: {e}")
        return JSONResponse({
            "available": False,
            "message": f"截图失败: {str(e)}"
        }, status_code=500)


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8090,
        log_level="info",
        reload=False,
        timeout_keep_alive=120,
        limit_concurrency=100,
    )
