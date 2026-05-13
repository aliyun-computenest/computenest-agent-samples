# -*- coding: utf-8 -*-
"""百炼知识库检索工具封装

将阿里云百炼知识库的检索能力封装为 AgentScope Tool，供 Agent 调用。

依赖环境变量:
    ALIBABA_CLOUD_ACCESS_KEY_ID      阿里云 Access Key ID
    ALIBABA_CLOUD_ACCESS_KEY_SECRET  阿里云 Access Key Secret
    BAILIAN_WORKSPACE_ID             百炼工作空间 ID
    BAILIAN_INDEX_ID                 知识库索引 ID
    BAILIAN_REGION_ID                百炼工作空间地域（默认 cn-beijing）
"""
import os

from alibabacloud_bailian20231229.client import Client as BailianClient
from alibabacloud_bailian20231229 import models as bailian_models
from alibabacloud_tea_openapi.utils_models import Config

from agentscope.message import TextBlock
from agentscope.tool import Toolkit, ToolResponse


def _create_bailian_client() -> BailianClient:
    """创建百炼 API 客户端（AK/SK 认证）"""
    region_id = os.environ.get("BAILIAN_REGION_ID", "cn-beijing")
    endpoint = f"bailian.{region_id}.aliyuncs.com"
    return BailianClient(Config(
        access_key_id=os.environ["BAILIAN_ALIBABA_CLOUD_ACCESS_KEY_ID"],
        access_key_secret=os.environ["BAILIAN_ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
        endpoint=endpoint,
    ))


_bailian_client: BailianClient | None = None


def _get_bailian_client() -> BailianClient:
    global _bailian_client
    if _bailian_client is None:
        _bailian_client = _create_bailian_client()
    return _bailian_client


async def retrieve_from_knowledge_base(query: str) -> ToolResponse:
    """在百练知识库中检索与用户问题相关的文档内容。

    Args:
        query: 用户的检索问题
    """
    response = await _get_bailian_client().retrieve_async(
        os.environ["BAILIAN_WORKSPACE_ID"],
        bailian_models.RetrieveRequest(
            index_id=os.environ["BAILIAN_INDEX_ID"],
            query=query,
        ),
    )

    # 处理异常
    if not response.body or not response.body.success:
        error_msg = response.body.message if response.body else "未知错误"
        return ToolResponse(content=[TextBlock(type="text", text=f"检索失败: {error_msg}")])

    # 格式化检索结果
    nodes = response.body.data.nodes if response.body.data else []
    if not nodes:
        return ToolResponse(content=[TextBlock(type="text", text="未检索到相关内容。")])

    chunks = []
    for index, node in enumerate(nodes, 1):
        score_text = f" (相关度: {node.score:.4f})" if node.score is not None else ""
        chunks.append(f"[片段{index}]{score_text}\n{node.text}")

    return ToolResponse(content=[TextBlock(type="text", text="\n\n".join(chunks))])


async def get_rag_toolkit() -> Toolkit:
    """创建并返回注册了知识库检索工具的 Toolkit。"""
    toolkit = Toolkit()
    toolkit.register_tool_function(
        retrieve_from_knowledge_base,
        func_description="检索百练知识库中与问题相关的文档内容，用于回答用户提问。",
    )
    return toolkit
