#!/usr/bin/env bash
# CodeAgent FC Sandbox — ECS 最小启动。凭证只从宿主机运行环境传入。
# 换镜像版本时须同时修改下面 docker pull 与 docker run 末尾两处地址。变量说明见同目录 README.md。
set -euo pipefail

: "${DASHSCOPE_API_KEY:?需要设置 DASHSCOPE_API_KEY}"
: "${E2B_API_KEY:?需要设置 E2B_API_KEY}"

docker pull compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/codeagent_fc_sandbox:latest

docker run -d \
  --name codeagent_fc_sandbox \
  --restart unless-stopped \
  --network host \
  -v codeagent_fc_sandbox_data:/app/data \
  -e DASHSCOPE_API_KEY \
  -e DASHSCOPE_MODEL_NAME \
  -e BAILIAN_BASE_URL \
  -e E2B_API_KEY \
  -e FC_E2B_REGION \
  -e FC_OSS_PERSISTENCE_ENABLED \
  -e FC_OSS_BUCKET \
  -e FC_OSS_ENDPOINT \
  -e FC_OSS_ROLE_ARN \
  -e FC_OSS_ROOT_PREFIX \
  compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/codeagent_fc_sandbox:latest
