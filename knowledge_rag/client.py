"""
AgentScope Runtime 测试客户端：通过 /process 接口进行 SSE 流式对话。
"""
import asyncio
import json

import httpx

# 运行配置
BASE_URL = "http://127.0.0.1:8091"
USER_ID = "rag_test_user"
SESSION_ID = "rag_test_session"

def build_input_message(text: str) -> list:
    """构造 AgentScope 协议要求的 input 消息格式。"""
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
        "input": build_input_message(message),
        "session_id": SESSION_ID,
        "user_id": USER_ID,
        "stream": True,
    }

    print(f"[run agent] Sending: {message}")
    print("[run agent] Event from server:")

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
                        print(line)
                    except json.JSONDecodeError:
                        print(line)
    print()

async def main():
    """多轮对话测试：验证知识库检索与短期记忆。"""
    await send_request("请介绍一下你能回答哪些方面的问题？")
    await send_request("你还记得我刚才问了什么吗？")

if __name__ == "__main__":
    asyncio.run(main())
