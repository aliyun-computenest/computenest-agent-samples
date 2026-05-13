"""
AgentScope Runtime 测试客户端：通过 /process 与舆情 Deep Research Agent SSE 对话。
"""
import asyncio
import json

import httpx

BASE_URL = "http://127.0.0.1:8090"
USER_ID = "opinion_analyst_user"
SESSION_ID = "opinion_analyst_session"


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

    async with httpx.AsyncClient(timeout=300.0) as client:
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
        "请对「某消费品牌近一周在中文社交与新闻侧的公开讨论」做一次舆情深度研究演示："
        "说明你的子问题拆解、检索轮次与最终报告结构；若某维度检索结果不足请明确标注信息缺口。"
    )


if __name__ == "__main__":
    asyncio.run(main())
