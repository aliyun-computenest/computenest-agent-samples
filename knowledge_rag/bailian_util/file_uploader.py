# -*- coding: utf-8 -*-
"""百炼知识库文件上传工具

提供将本地文件追加到阿里云百炼知识库的完整流程：
  1. 申请文件上传租约（ApplyFileUploadLease）
  2. 通过预签名 URL 上传文件
  3. 将文件注册到数据中心（AddFile），获取 file_id
  4. 轮询等待文件解析完成（DescribeFile）
  5. 提交知识库追加任务（SubmitIndexAddDocumentsJob）
  6. 轮询等待追加任务完成（GetIndexJobStatus）

使用前请确保以下环境变量已设置:
    BAILIAN_ALIBABA_CLOUD_ACCESS_KEY_ID      - 阿里云 Access Key ID
    BAILIAN_ALIBABA_CLOUD_ACCESS_KEY_SECRET  - 阿里云 Access Key Secret
    BAILIAN_WORKSPACE_ID             - 百炼工作空间 ID
    BAILIAN_INDEX_ID                 - 知识库索引 ID
    BAILIAN_REGION_ID                - 百炼工作空间地域（默认 cn-beijing）
    BAILIAN_ENDPOINT                 - 百炼 API Endpoint（可选，默认按地域自动生成）
"""
import hashlib
import os
import time

import requests
from alibabacloud_bailian20231229 import models as bailian_models
from alibabacloud_bailian20231229.client import Client as BailianClient
from alibabacloud_tea_openapi.utils_models import Config
from alibabacloud_tea_util import models as util_models

_client: BailianClient | None = None


def _create_client() -> BailianClient:
    """创建百炼 API 客户端（AK/SK 认证）"""
    region_id = os.environ.get("BAILIAN_REGION_ID", "cn-beijing")
    default_endpoint = f"bailian.{region_id}.aliyuncs.com"

    return BailianClient(Config(
        access_key_id=os.environ["BAILIAN_ALIBABA_CLOUD_ACCESS_KEY_ID"],
        access_key_secret=os.environ["BAILIAN_ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
        endpoint=os.environ.get("BAILIAN_ENDPOINT", default_endpoint),
    ))


def _get_client() -> BailianClient:
    """获取全局单例百炼客户端"""
    global _client
    if _client is None:
        _client = _create_client()
    return _client


def _calculate_md5(file_path: str) -> str:
    """计算文件的 MD5 值"""
    md5_hash = hashlib.md5()
    with open(file_path, "rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(4096), b""):
            md5_hash.update(chunk)
    return md5_hash.hexdigest()


def append_file_to_knowledge_base(file_path: str) -> None:
    """将本地文件追加到已有的百炼知识库中。

    完整流程：
      1. 申请文件上传租约（ApplyFileUploadLease）
      2. 通过预签名 URL 上传文件
      3. 将文件注册到数据中心（AddFile），获取 file_id
      4. 轮询等待文件解析完成（DescribeFile）
      5. 提交知识库追加任务（SubmitIndexAddDocumentsJob）
      6. 轮询等待追加任务完成（GetIndexJobStatus）

    Args:
        file_path: 要上传的本地文件路径
    """
    workspace_id = os.environ["BAILIAN_WORKSPACE_ID"]
    index_id = os.environ["BAILIAN_INDEX_ID"]
    category_id = "default"
    file_name = os.path.basename(file_path)
    file_md5 = _calculate_md5(file_path)
    file_size = str(os.path.getsize(file_path))

    client = _get_client()
    runtime = util_models.RuntimeOptions()

    # 步骤 1：申请文件上传租约
    print(f"[知识库] 步骤1：申请文件上传租约（文件：{file_name}）")
    lease_request = bailian_models.ApplyFileUploadLeaseRequest(
        file_name=file_name,
        md_5=file_md5,
        size_in_bytes=file_size,
    )
    lease_response = client.apply_file_upload_lease_with_options(
        category_id, workspace_id, lease_request, {}, runtime
    )
    lease_data = lease_response.body.data
    lease_id = lease_data.file_upload_lease_id
    upload_url = lease_data.param.url
    upload_headers = lease_data.param.headers

    # 步骤 2：通过预签名 URL 上传文件内容
    print("[知识库] 步骤2：上传文件到临时存储")
    with open(file_path, "rb") as file_handle:
        file_content = file_handle.read()
    put_response = requests.put(
        upload_url,
        data=file_content,
        headers={
            "X-bailian-extra": upload_headers["X-bailian-extra"],
            "Content-Type": upload_headers["Content-Type"],
        },
    )
    put_response.raise_for_status()

    # 步骤 3：将文件注册到数据中心，获取 file_id
    print("[知识库] 步骤3：将文件注册到百炼数据中心")
    add_file_request = bailian_models.AddFileRequest(
        lease_id=lease_id,
        parser="DASHSCOPE_DOCMIND",
        category_id=category_id,
    )
    add_file_response = client.add_file_with_options(
        workspace_id, add_file_request, {}, runtime
    )
    file_id = add_file_response.body.data.file_id
    print(f"[知识库] 文件注册成功，file_id={file_id}")

    # 步骤 4：轮询等待文件解析完成
    print("[知识库] 步骤4：等待文件解析完成...")
    while True:
        describe_response = client.describe_file_with_options(
            workspace_id, file_id, {}, runtime
        )
        parse_status = describe_response.body.data.status
        print(f"[知识库]   当前解析状态：{parse_status}")
        if parse_status == "PARSE_SUCCESS":
            print("[知识库] 文件解析完成！")
            break
        if parse_status not in ("INIT", "PARSING"):
            raise RuntimeError(f"文件解析失败，状态：{parse_status}")
        time.sleep(5)

    # 步骤 5：提交知识库追加任务
    print("[知识库] 步骤5：提交知识库追加任务（SubmitIndexAddDocumentsJob）")
    add_docs_request = bailian_models.SubmitIndexAddDocumentsJobRequest(
        index_id=index_id,
        source_type="DATA_CENTER_FILE",
        document_ids=[file_id],
    )
    add_docs_response = client.submit_index_add_documents_job_with_options(
        workspace_id, add_docs_request, {}, runtime
    )
    job_id = add_docs_response.body.data.id
    print(f"[知识库] 追加任务已提交，job_id={job_id}")

    # 步骤 6：轮询等待追加任务完成
    print("[知识库] 步骤6：等待追加任务完成（高峰期可能耗时较长，请耐心等待）...")
    get_job_status_request = bailian_models.GetIndexJobStatusRequest(
        index_id=index_id,
        job_id=job_id,
    )
    while True:
        job_status_response = client.get_index_job_status_with_options(
            workspace_id, get_job_status_request, {}, runtime
        )
        job_status = job_status_response.body.data.status
        print(f"[知识库]   当前任务状态：{job_status}")
        if job_status == "COMPLETED":
            print("[知识库] 文件已成功追加到知识库！")
            break
        if job_status in ("FAILED", "ERROR"):
            raise RuntimeError(f"知识库追加任务失败，状态：{job_status}")
        time.sleep(15)
