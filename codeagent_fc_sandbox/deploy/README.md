# codeagent_fc_sandbox Docker 部署

当前推荐镜像：

```text
compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/codeagent_fc_sandbox:latest
```

## 构建

```bash
# 仓库根目录
IMAGE_TAG=latest ./codeagent_fc_sandbox/deploy/build-push-acr.sh
```

等价的完整命令：

```bash
docker buildx build --platform linux/amd64 \
  -f codeagent_fc_sandbox/deploy/Dockerfile \
  -t compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/codeagent_fc_sandbox:latest \
  --push \
  codeagent_fc_sandbox
```

镜像包含 CodeAgent WebUI、API、FC E2B Provider 和沙箱 Runtime 安装文件。构建过程不读取或写入模型、FC 云沙箱或 OSS 凭证。

## 单独推送

```bash
docker push compute-nest-registry.cn-hangzhou.cr.aliyuncs.com/computenest/codeagent_fc_sandbox:latest
```

## 运行

容器使用 host 网络，同时监听 CodeAgent WebUI/API `8000` 和 Preview Gateway `5184`。控制面状态保存在 Docker 命名卷 `codeagent_fc_sandbox_data` 的 `/app/data` 中。

```bash
export DASHSCOPE_API_KEY=your-dashscope-api-key
export DASHSCOPE_MODEL_NAME=qwen3.7-max
export BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic

export E2B_API_KEY=your-fc-sandbox-api-key
export FC_E2B_REGION=cn-beijing

# 可选：手工部署时启用 OSS 持久化
export FC_OSS_PERSISTENCE_ENABLED=true
export FC_OSS_BUCKET=your-oss-bucket
export FC_OSS_ENDPOINT=http://oss-cn-beijing-internal.aliyuncs.com
export FC_OSS_ROLE_ARN=acs:ram::<account-id>:role/<role-name>
export FC_OSS_ROOT_PREFIX=/codeagent/v2

bash codeagent_fc_sandbox/deploy/deploy-ecs.sh
```

访问 `http://<ECS-IP>:8000`。端口 `5184` 由 WebUI 内部使用：浏览器选择会话后，Preview Gateway 根据客户端与会话的绑定关系，把请求转发到该会话对应的 FC 沙箱端口。

> 安全提示：当前 `8000` 控制面 API 和 `5184` Preview Gateway 均无身份认证或访问控制。不要在安全组中直接向公网开放这两个端口；应限制为可信来源或私网访问，生产环境还需在前方配置具备身份认证和授权能力的网关或反向代理。

## FC 云沙箱

控制面固定使用 FC 内置 `base` 模板。新沙箱创建后，Provider 从控制面镜像上传启动脚本、Preview 工具和 Claude 指令，并通过 npmmirror 安装固定版本的 Claude Code、sandbox-agent 与 Claude ACP。用户不需要提供 ACR 地址、模板 ID 或镜像凭证。

`FC_E2B_REGION` 决定 FC E2B API URL 和 Domain，`E2B_API_KEY` 必须属于同一地域。计算巢部署时，该地域自动使用服务实例地域；手工 Docker 部署时由运行者显式设置。

## OSS 持久化

计算巢服务固定启用 OSS 持久化，不向部署用户展示 OSS 开关、Bucket 或根前缀选项。部署时会在服务实例地域自动创建私有 Standard OSS Bucket 和专用 RAM Role，并注入：

- `FC_OSS_PERSISTENCE_ENABLED=true`
- 自动创建的 `FC_OSS_BUCKET`
- 同地域内网 `FC_OSS_ENDPOINT`
- 专用 `FC_OSS_ROLE_ARN`
- 固定根前缀 `FC_OSS_ROOT_PREFIX=/codeagent/v2`

每个业务会话使用独立 OSS prefix。自动创建的 Bucket 使用 `DeletionPolicy: Retain`，删除计算巢服务实例时保留 Bucket 和会话数据。

手工 Docker 部署不会自动创建 OSS 资源；不设置 `FC_OSS_PERSISTENCE_ENABLED=true` 时，沙箱回收后不保证恢复 workspace 或 Claude Session。

## 健康检查

```bash
curl http://127.0.0.1:8000/health
```

预期返回 `status: "ok"`、`provider: "fc-e2b"` 以及当前地域和持久化模式。

## 环境变量摘要

| 变量 | 必填 | 说明 |
|------|------|------|
| `DASHSCOPE_API_KEY` | 是 | 百炼模型调用凭证 |
| `DASHSCOPE_MODEL_NAME` | 否 | 模型名称，镜像默认 `qwen3.7-max` |
| `BAILIAN_BASE_URL` | 否 | Anthropic 兼容接口地址，应用有默认值 |
| `E2B_API_KEY` | 是 | FC 云沙箱 API Key |
| `FC_E2B_REGION` | 是 | FC 云沙箱地域；计算巢自动注入，手工部署需设置 |
| `FC_OSS_PERSISTENCE_ENABLED` | 否 | 手工部署时是否启用 OSS 持久化 |
| `FC_OSS_BUCKET` | 启用 OSS 时必填 | OSS Bucket 名称 |
| `FC_OSS_ENDPOINT` | 启用 OSS 时必填 | 与 FC 同地域的 OSS 内网 Endpoint |
| `FC_OSS_ROLE_ARN` | 启用 OSS 时必填 | FC 可扮演且拥有 Bucket 读写权限的 RAM Role ARN |
| `FC_OSS_ROOT_PREFIX` | 否 | OSS 根前缀，默认 `/codeagent/v2` |

## 部署边界

当前部署方式面向单个 ECS 控制面实例：`/app/data` 仅支持单副本写入，WebUI 和 Preview Gateway 也需要共同维护客户端到会话的内存绑定。因此暂不提供 ACK/ACS 多副本部署示例。
