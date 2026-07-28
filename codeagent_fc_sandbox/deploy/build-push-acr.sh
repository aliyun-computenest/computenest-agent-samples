#!/usr/bin/env bash
# 可在任意目录执行：IMAGE_TAG=latest ./codeagent_fc_sandbox/deploy/build-push-acr.sh
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-latest}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMPLE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

docker buildx build --platform linux/amd64 \
  -f "${SCRIPT_DIR}/Dockerfile" \
  -t "compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/codeagent_fc_sandbox:${IMAGE_TAG}" \
  --push \
  "${SAMPLE_ROOT}"
