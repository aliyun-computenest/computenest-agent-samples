"""
AgentScope Runtime 测试客户端：向 dashscope_memory/main.py 的 /process 发 SSE 请求。
百炼 user_id 在服务端 main.py 中固定为 demo_user；下面 body 里的 user_id 仅作 Runtime 请求字段占位，建议与之一致。
"""
import asyncio
import json

import httpx

BASE_URL = "http://127.0.0.1:8090"
USER_ID = "demo_user"
SESSION_ID = "demo_session_1"


def build_input_message(text: str) -> list:
    return [
        {
            "role": "user",
            "content": [{"type": "text", "text": text}],
            "type": "message",
        }
    ]


async def send_request(message: str) -> None:
    body = {
        "input": build_input_message(message),
        "session_id": SESSION_ID,
        "user_id": USER_ID,
        "stream": True,
    }

    print(f"[client] 发送: {message}")
    print("[client] SSE 事件:")

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{BASE_URL}/process",
            json=body,
        ) as r:
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if data == "[DONE]" or not data:
                        continue
                    try:
                        json.loads(data)
                    except json.JSONDecodeError:
                        pass
                    print(line)
    print()


async def main():
    await send_request("我的饮食习惯是爱吃清淡的，比如潮汕牛肉")


if __name__ == "__main__":
    asyncio.run(main())
