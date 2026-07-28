import assert from "node:assert/strict";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true, override: true });

const SKIP_FLAG = "FC_E2B_SMOKE_SKIP";

if (process.env[SKIP_FLAG] === "true") {
  console.log(`[SKIP] ${SKIP_FLAG}=true，未创建 FC 沙箱。`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`[FAIL] FC 直连预览验证失败：${errorMessage(error)}`);
  process.exitCode = 1;
});

async function main() {
  const environment = readEnvironment();
  const { FcE2BSandboxProvider } = await import("@codeagent-sandbox-demo/fc-e2b-provider").catch((error) => {
    throw new Error(`缺少 Provider 构建产物；请先运行 npm run build:packages。${errorMessage(error)}`);
  });
  const provider = new FcE2BSandboxProvider({ config: buildProviderConfig(environment) });
  let sandboxId;
  let socket;

  try {
    sandboxId = await provider.create();
    const sandbox = await provider.connect(sandboxId);
    const projectRoot = `${environment.workspaceRoot}/preview-smoke`;

    await runChecked(
      sandbox,
      [
        "set -eu",
        `mkdir -p ${shellQuote(`${projectRoot}/src`)}`,
        writeBase64(`${projectRoot}/package.json`, JSON.stringify({
          private: true,
          type: "module",
          scripts: { dev: "vite" },
        })),
        writeBase64(
          `${projectRoot}/vite.config.js`,
          `export default { server: { host: "0.0.0.0", port: ${environment.previewPort}, strictPort: true, allowedHosts: true } };\n`,
        ),
        writeBase64(
          `${projectRoot}/index.html`,
          '<!doctype html><html><head><meta charset="UTF-8"><title>FC Preview Smoke</title></head><body><div id="app">fc-preview-root-ok</div><script type="module" src="/src/main.js"></script></body></html>\n',
        ),
        writeBase64(
          `${projectRoot}/src/main.js`,
          'document.querySelector("#app").dataset.module = "fc-preview-module-v1";\nif (import.meta.hot) import.meta.hot.accept();\n',
        ),
      ].join("\n"),
      { timeoutMs: 30_000 },
      "创建最小 Vite 项目",
    );
    await runChecked(
      sandbox,
      `cd ${shellQuote(projectRoot)} && npm install --no-audit --no-fund --registry=https://registry.npmmirror.com vite@7.3.0`,
      { timeoutMs: environment.installTimeoutMs },
      "安装 Vite",
    );
    await sandbox.commands.run(
      `cd ${shellQuote(projectRoot)} && exec npm run dev >/tmp/fc-preview-vite.log 2>&1`,
      { background: true, timeoutMs: 0 },
    );

    await waitForSandboxHttp(sandbox, environment.previewPort, environment.httpTimeoutMs);
    await runChecked(
      sandbox,
      `cd ${shellQuote(projectRoot)} && codeagent-preview publish --port ${environment.previewPort} --cwd ${shellQuote(projectRoot)} --name ${shellQuote("FC Preview Smoke")} --start-command ${shellQuote(`npm run dev -- --host 0.0.0.0 --port ${environment.previewPort}`)}`,
      { timeoutMs: 30_000 },
      "发布 Preview manifest",
    );
    const manifestResult = await runChecked(
      sandbox,
      `cat ${shellQuote(`${environment.agentStateRoot}/preview.json`)}`,
      { timeoutMs: 30_000 },
      "读取 Preview manifest",
    );
    const manifest = JSON.parse(String(manifestResult.stdout));
    assert.equal(manifest.targetPort, environment.previewPort);
    assert.equal(manifest.projectRoot, projectRoot);

    const origin = await provider.getPortUrl(sandboxId, environment.previewPort);
    const rootResponse = await waitForHttp(`${origin}/`, environment.httpTimeoutMs);
    const rootHtml = await rootResponse.text();
    assert.match(rootHtml, /fc-preview-root-ok/, "根页面缺少预览标记");

    const moduleResponse = await waitForHttp(`${origin}/src/main.js`, environment.httpTimeoutMs);
    const moduleBody = await moduleResponse.text();
    assert.match(moduleBody, /fc-preview-module-v1/, "根路径模块资源没有通过直连端口返回");

    const viteClientResponse = await waitForHttp(`${origin}/@vite/client`, environment.httpTimeoutMs);
    const viteClient = await viteClientResponse.text();
    const webSocketToken = extractWebSocketToken(viteClient);
    socket = await openViteSocket(origin, webSocketToken, 20_000);

    const updatePromise = waitForSocketMessage(
      socket,
      (message) => message?.type === "update" && message.updates?.some((update) => update.path === "/src/main.js"),
      30_000,
      "没有收到 /src/main.js 的 Vite HMR update",
    );
    await runChecked(
      sandbox,
      writeBase64(
        `${projectRoot}/src/main.js`,
        'document.querySelector("#app").dataset.module = "fc-preview-module-v2";\nif (import.meta.hot) import.meta.hot.accept();\n',
      ),
      { timeoutMs: 30_000 },
      "修改 Vite 模块以触发 HMR",
    );
    await updatePromise;

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          sandboxId,
          previewOrigin: origin,
          anonymousRoot: rootResponse.status,
          moduleResource: moduleResponse.status,
          hmrWebSocket: "connected-and-updated",
          manifestPublished: true,
          backendProxyUsed: false,
        },
        null,
        2,
      ),
    );
  } finally {
    socket?.close();
    if (sandboxId) {
      await provider.destroy(sandboxId).catch((error) => {
        console.error(`[WARN] FC 沙箱清理失败（${sandboxId}）：${errorMessage(error)}`);
      });
    }
  }
}

function readEnvironment() {
  const apiKey = requiredEnv("E2B_API_KEY");
  const template = process.env.FC_E2B_TEMPLATE || "base";

  return {
    apiKey,
    template,
    apiUrl: process.env.E2B_API_URL ?? "https://api.cn-beijing.e2b.fc.aliyuncs.com",
    domain: process.env.E2B_DOMAIN ?? "cn-beijing.e2b.fc.aliyuncs.com",
    agentPort: positiveInteger("FC_E2B_AGENT_PORT", 3001),
    previewPort: positiveInteger("FC_E2B_PREVIEW_SMOKE_PORT", 5173),
    sandboxTimeoutMs: positiveInteger("FC_E2B_TIMEOUT_SECONDS", 1800) * 1000,
    requestTimeoutMs: positiveInteger("FC_E2B_REQUEST_TIMEOUT_MS", 120_000),
    installTimeoutMs: positiveInteger("FC_E2B_PREVIEW_INSTALL_TIMEOUT_MS", 360_000),
    httpTimeoutMs: positiveInteger("FC_E2B_PREVIEW_HTTP_TIMEOUT_MS", 90_000),
    workspaceRoot: process.env.SANDBOX_WORKSPACE_ROOT ?? "/home/user/workspace",
    agentStateRoot: process.env.CODEAGENT_STATE_ROOT ?? "/home/user/.codeagent",
  };
}

function buildProviderConfig(environment) {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.DASHSCOPE_API_KEY || "";
  return {
    apiKey: environment.apiKey,
    apiUrl: environment.apiUrl,
    domain: environment.domain,
    template: environment.template,
    timeoutMs: environment.sandboxTimeoutMs,
    requestTimeoutMs: environment.requestTimeoutMs,
    runtimeAssetsDir: process.env.FC_RUNTIME_ASSETS_DIR ?? "sandbox_image",
    workspaceRoot: environment.workspaceRoot,
    claudeConfigDir: "/home/user/.claude",
    agentStateRoot: environment.agentStateRoot,
    agentPort: environment.agentPort,
    claude: {
      authToken,
      baseUrl: process.env.BAILIAN_BASE_URL ?? "https://dashscope.aliyuncs.com/apps/anthropic",
      model: process.env.ANTHROPIC_MODEL ?? process.env.DASHSCOPE_MODEL ?? "qwen3.7-max",
      haikuModel: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "qwen3.6-flash",
      sonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "qwen3.7-max",
      opusModel: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "qwen3.7-max",
      subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? "qwen3.7-max",
    },
  };
}

async function runChecked(sandbox, command, options, label) {
  const result = await sandbox.commands.run(command, options);
  if (!result || typeof result !== "object") throw new Error(`${label}没有返回命令结果`);
  if (result.exitCode !== 0) {
    const detail = String(result.stderr || result.stdout || `exit ${result.exitCode}`).trim();
    throw new Error(`${label}失败：${detail.slice(-2_000)}`);
  }
  return result;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      // 不发送 X-Access-Token；此断言刻意验证公开匿名端口。
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return response;
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`无法匿名访问 ${url}：${errorMessage(lastError)}`);
}

async function waitForSandboxHttp(sandbox, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await sandbox.commands.run(
        `node -e ${shellQuote(`fetch('http://127.0.0.1:${port}/').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status)})`)}`,
        { timeoutMs: 10_000 },
      );
      if (result?.exitCode === 0) return;
      lastError = new Error(String(result?.stderr || result?.stdout || `exit ${result?.exitCode}`));
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`沙箱内 Preview 服务未就绪：${errorMessage(lastError)}`);
}

function extractWebSocketToken(viteClient) {
  const match = viteClient.match(/const wsToken = ["']([^"']+)["'];/);
  if (!match) throw new Error("无法从 /@vite/client 提取 HMR WebSocket token");
  return match[1];
}

function openViteSocket(origin, token, timeoutMs) {
  const socketUrl = new URL(origin);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("token", token);
  const socket = new WebSocket(socketUrl, "vite-hmr");
  return waitForSocketMessage(
    socket,
    (message) => message?.type === "connected",
    timeoutMs,
    "Vite HMR WebSocket 未连接",
  ).then(() => socket, (error) => {
    socket.close();
    throw error;
  });
}

function waitForSocketMessage(socket, predicate, timeoutMs, failureMessage) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(reject, new Error(failureMessage)), timeoutMs);
    const onError = () => finish(reject, new Error(failureMessage));
    const onClose = () => finish(reject, new Error(`${failureMessage}（连接提前关闭）`));
    const onMessage = (event) => {
      try {
        const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        if (predicate(message)) finish(resolve, message);
      } catch {
        // Vite HMR 消息应为 JSON；与断言无关的帧可以忽略。
      }
    };
    const finish = (complete, value) => {
      clearTimeout(timeout);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("message", onMessage);
      complete(value);
    };
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    socket.addEventListener("message", onMessage);
  });
}

function writeBase64(filePath, content) {
  return `printf %s ${shellQuote(Buffer.from(content).toString("base64"))} | base64 -d > ${shellQuote(filePath)}`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  return error.message || error.stack || error.name;
}
