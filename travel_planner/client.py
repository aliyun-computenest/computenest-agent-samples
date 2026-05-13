"""
AgentScope Runtime 测试客户端：通过 /process 接口与旅行规划 Agent 进行 SSE 流式对话。
"""
import asyncio
import json

import httpx

# 运行配置（默认与 agent.py 端口一致）
BASE_URL = "http://127.0.0.1:8090"
USER_ID = "travel_planner_user"
SESSION_ID = "travel_planner_session"


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
    """向旅行规划 Agent 发送一条消息，并打印 SSE 流式响应。"""
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
                        event = json.loads(data)
                        print(line)
                    except json.JSONDecodeError:
                        print(line)
    print()


async def main():
    """示例：多轮对话测试（短期记忆 + 可选知识库/高德 MCP）。"""
    # 示例提示词（可替换为任意旅行相关需求）
    await send_request("元旦去哈尔滨旅行，帮我规划下 5 天 4 晚的行程，兼顾冰雪大世界、中央大街和东北美食")
    # 验证短期记忆
    # await send_request("你还记得我刚才说的目的地和天数吗？")


if __name__ == "__main__":
    asyncio.run(main())
