# CodeAgent FC Sandbox 控制面镜像。
# 构建上下文为 codeagent_fc_sandbox 示例根目录。
FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV npm_config_registry=https://registry.npmmirror.com

COPY package.json package-lock.json .npmrc tsconfig.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/fc-e2b-provider/package.json packages/fc-e2b-provider/package.json
COPY src/apps/api/package.json src/apps/api/package.json
COPY src/apps/web/package.json src/apps/web/package.json
RUN npm ci

COPY packages ./packages
COPY src ./src
COPY sandbox_image ./sandbox_image
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    PREVIEW_SCHEME=http \
    PREVIEW_GATEWAY_PORT=5184 \
    CODEAGENT_DATA_DIR=/app/data \
    DASHSCOPE_MODEL_NAME=qwen3.7-max

COPY --from=build /app /app
RUN mkdir -p /app/data && chown -R node:node /app

VOLUME ["/app/data"]
USER node
EXPOSE 8000 5184
CMD ["node", "src/apps/api/dist/index.js"]
