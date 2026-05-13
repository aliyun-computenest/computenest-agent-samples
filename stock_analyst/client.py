"""
AgentScope Runtime 测试客户端：通过 /process 与股票分析 Agent 进行 SSE 流式对话。
"""
import asyncio
import json

import httpx

BASE_URL = "http://127.0.0.1:8090"
USER_ID = "stock_analyst_user"
SESSION_ID = "stock_analyst_session"


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

    print(f"[run agent] Sending: {message}")
    print("[run agent] Event from server:")

    async with httpx.AsyncClient(timeout=180.0) as client:
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
    await send_request(
        "请任选一只你熟悉的 A 股或美股：基于联网检索给出"
        "「股票数据分析」「股票走势预测（多情景）」「股票投资建议（参考性+风险与免责）」三部分，"
        "并说明信息来源与局限性。"
    )


if __name__ == "__main__":
    asyncio.run(main())
