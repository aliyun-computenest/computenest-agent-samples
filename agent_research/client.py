"""
AI搜学助手 测试客户端：通过 /api/agent 接口进行 SSE 流式对话。
"""
import asyncio
import json

import httpx

# 运行配置
BASE_URL = "http://127.0.0.1:8090"
RUN_ID = "test_run_001"
THREAD_ID = "test_thread_001"


def build_input_message(text: str) -> list:
    """构造 AG-UI 协议要求的 input 消息格式。"""
    return [
        {
            "role": "user",
            "content": [{"type": "text", "text": text}],
            "type": "message",
        }
    ]


async def send_request(message: str) -> None:
    """向 Agent 发送一条消息，并打印 SSE 流式响应。"""
    body = {
        "run_id": RUN_ID,
        "thread_id": THREAD_ID,
        "messages": [
            {
                "role": "user",
                "content": message,
            }
        ],
        "state": {
            "max_results": 20
        }
    }

    print(f"[run agent] Sending: {message}")
    print("[run agent] Event from server:")

    async with httpx.AsyncClient(timeout=300.0) as client:
        async with client.stream(
            "POST",
            f"{BASE_URL}/api/agent",
            json=body,
        ) as r:
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if not data:
                        continue
                    try:
                        event = json.loads(data)
                        event_type = event.get("type", "UNKNOWN")
                        if event_type == "STATE_SNAPSHOT":
                            snapshot = event.get("snapshot", {})
                            status = snapshot.get("status", "")
                            phase = snapshot.get("current_phase", "")
                            progress = snapshot.get("collection_progress", 0)
                            print(f"[{event_type}] status={status}, phase={phase}, progress={progress}%")
                        elif event_type == "RUN_STARTED":
                            print(f"[{event_type}] Run started")
                        elif event_type == "RUN_FINISHED":
                            print(f"[{event_type}] Run finished")
                        elif event_type == "RUN_ERROR":
                            print(f"[{event_type}] Error: {event.get('message', '')}")
                        else:
                            print(f"[{event_type}] {data[:100]}")
                    except json.JSONDecodeError:
                        print(line)
    print()


async def main():
    """测试：学习指定主题。"""
    await send_request("帮我学习和理解'机器学习'")


if __name__ == "__main__":
    asyncio.run(main())
