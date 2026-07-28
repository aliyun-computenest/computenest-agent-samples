import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true, override: true });

const SKIP_FLAG = "FC_E2B_SMOKE_SKIP";
const REPLAY_MARKER = "Previous session history";

if (process.env[SKIP_FLAG] === "true") {
  console.log(`[SKIP] ${SKIP_FLAG}=true，未创建 FC 沙箱。`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`[FAIL] FC 原生会话恢复验证失败：${errorMessage(error)}`);
  process.exitCode = 1;
});

async function main() {
  const environment = readEnvironment();
  await verifyDashScopeGateway(environment);
  const [{ FcE2BSandboxProvider }, { BusinessSessionStore, FileSessionPersistDriver }, { AgentSessionManager }] =
    await Promise.all([
      import("@codeagent-sandbox-demo/fc-e2b-provider"),
      import("@codeagent-sandbox-demo/core"),
      import("../../src/apps/api/dist/services/agent-session-manager.js"),
    ]).catch((error) => {
      throw new Error(`缺少已构建产物；请先运行 npm run build:packages && npm run build:api。${errorMessage(error)}`);
    });

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fc-e2b-recovery-smoke-"));
  let persist = new FileSessionPersistDriver(dataDir);
  let store = new BusinessSessionStore(dataDir);
  await Promise.all([persist.init(), store.init()]);

  const config = buildAppConfig(environment, dataDir);
  const firstProvider = new FcE2BSandboxProvider({ config: buildProviderConfig(config) });
  let currentProvider = firstProvider;
  let manager;
  let sandboxId;

  try {
    sandboxId = await firstProvider.create();
    const sessionId = `recovery_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const nonce = `FC_RESUME_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

    await store.create({
      id: sessionId,
      runtimeProvider: "fc-e2b",
      userId: "recovery-smoke",
      projectId: "recovery-smoke",
      title: "FC 原生恢复冒烟验证",
      status: "creating",
      sandboxId,
      sandboxProviderId: `fc-e2b/${sandboxId}`,
      templateName: environment.template,
      workspaceRoot: environment.workspaceRoot,
    });

    manager = new AgentSessionManager(config, firstProvider, persist, store);
    const firstPrepared = await manager.prepare(sessionId);
    assert.equal(firstPrepared.sandboxId, sandboxId, "首次连接不应替换已创建的 FC 沙箱");
    assert.equal(firstPrepared.agentSessionId, undefined, "第一条消息前不应提前创建 Claude session");

    await manager.sendMessage(
      sessionId,
      `请记住一个临时口令：${nonce}。只回复“已记住”，不要复述口令，也不要写入文件。`,
    );
    await waitForPrompt(store, sessionId, environment.promptTimeoutMs, "第一轮记忆提示");
    const firstCompleted = await store.get(sessionId);
    assert.ok(firstCompleted?.agentSessionId, "第一条消息后必须保存 Claude agentSessionId");
    const firstAgentSessionId = firstCompleted.agentSessionId;
    await waitForEvent(
      persist,
      sessionId,
      (events) => events.some((event) => event.sender === "client" && methodOf(event) === "session/prompt"),
      15_000,
      "第一轮 session/prompt 事件未持久化",
    );
    const firstTurnEvents = await persist.listEventsAfter(sessionId, 0);
    const beforeRestartIndex = maxEventIndex(firstTurnEvents);

    // close() 只断开本地 SDK/ACP，沙箱本身仍然存活；新 manager 模拟后端进程重启。
    await manager.close();
    manager = undefined;

    // Recreate both persistence drivers from disk instead of reusing in-memory
    // objects, matching what a restarted API process sees.
    persist = new FileSessionPersistDriver(dataDir);
    store = new BusinessSessionStore(dataDir);
    await Promise.all([persist.init(), store.init()]);
    const secondProvider = new FcE2BSandboxProvider({ config: buildProviderConfig(config) });
    currentProvider = secondProvider;
    manager = new AgentSessionManager(config, secondProvider, persist, store);
    const resumed = await manager.prepare(sessionId);

    assert.equal(resumed.sandboxId, sandboxId, "后端重启后必须重连同一个 FC 沙箱");
    assert.equal(resumed.agentSessionId, firstAgentSessionId, "后端重启后必须恢复同一个 Claude agentSessionId");

    const resumedEvents = await waitForEvent(
      persist,
      sessionId,
      (events) => events.some((event) => event.eventIndex > beforeRestartIndex && methodOf(event) === "session/resume"),
      20_000,
      "没有观察到 ACP session/resume",
    );
    assert.equal(
      resumedEvents.filter((event) => methodOf(event) === "session/new").length,
      1,
      "恢复过程中不应创建第二个 Claude session",
    );

    const secondPromptStartIndex = maxEventIndex(resumedEvents);
    await manager.sendMessage(sessionId, "我刚才让你记住的临时口令是什么？只回复口令本身。");
    await waitForPrompt(store, sessionId, environment.promptTimeoutMs, "第二轮记忆检查");

    const secondTurnEvents = await waitForEvent(
      persist,
      sessionId,
      (events) => events.some((event) => event.eventIndex > secondPromptStartIndex && isAssistantTextEvent(event)),
      20_000,
      "恢复后的 Claude 回复事件没有持久化",
    );
    const afterRestart = secondTurnEvents.filter((event) => event.eventIndex > beforeRestartIndex);
    assert.ok(
      afterRestart.every((event) => !JSON.stringify(event.payload).includes(REPLAY_MARKER)),
      `恢复事件中不应包含 ${REPLAY_MARKER} 本地历史回放标记`,
    );
    assert.ok(
      afterRestart
        .filter((event) => event.sender === "client")
        .every((event) => !JSON.stringify(event.payload).includes(nonce)),
      "第二轮客户端请求不应把第一轮口令作为本地历史重放",
    );
    const secondReply = assistantTextAfter(secondTurnEvents, secondPromptStartIndex);
    assert.ok(
      secondReply.includes(nonce),
      `恢复后的 Claude 回复没有包含第一轮口令；实际回复：${JSON.stringify(secondReply.slice(0, 500))}`,
    );

    console.log(
      JSON.stringify(
        {
          result: "PASS",
          sandboxId,
          businessSessionId: sessionId,
          agentSessionId: firstAgentSessionId,
          nativeResumeObserved: true,
          memoryRecovered: true,
          localReplayObserved: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await manager?.close().catch(() => undefined);
    if (sandboxId) {
      await currentProvider.destroy(sandboxId).catch((error) => {
        console.error(`[WARN] FC 沙箱清理失败（${sandboxId}）：${errorMessage(error)}`);
      });
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function verifyDashScopeGateway(environment) {
  const baseUrl = new URL(environment.baseUrl);
  if (baseUrl.hostname !== "dashscope.aliyuncs.com") return;

  const response = await fetch(new URL(`${baseUrl.pathname.replace(/\/$/, "")}/v1/messages`, baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${environment.authToken}`,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: environment.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply OK" }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (response.ok) return;

  let detail = "";
  try {
    const payload = JSON.parse(text);
    const code = typeof payload.code === "string" ? payload.code : "";
    const message = typeof payload.message === "string" ? payload.message : "";
    detail = [code, message].filter(Boolean).join(" ");
  } catch {
    detail = text.slice(0, 300);
  }
  throw new Error(`DashScope Anthropic 网关预检失败：HTTP ${response.status}${detail ? `，${detail}` : ""}`);
}

function readEnvironment() {
  const apiKey = requiredEnv("E2B_API_KEY");
  const template = process.env.FC_E2B_TEMPLATE || "base";
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.DASHSCOPE_API_KEY;
  if (!authToken) throw new Error("缺少 ANTHROPIC_AUTH_TOKEN 或 DASHSCOPE_API_KEY");

  return {
    apiKey,
    template,
    authToken,
    apiUrl: process.env.E2B_API_URL ?? "https://api.cn-beijing.e2b.fc.aliyuncs.com",
    domain: process.env.E2B_DOMAIN ?? "cn-beijing.e2b.fc.aliyuncs.com",
    region: process.env.FC_E2B_REGION ?? "cn-beijing",
    agentPort: positiveInteger("FC_E2B_AGENT_PORT", 3001),
    sandboxTimeoutMs: positiveInteger("FC_E2B_TIMEOUT_SECONDS", 1800) * 1000,
    requestTimeoutMs: positiveInteger("FC_E2B_REQUEST_TIMEOUT_MS", 120_000),
    promptTimeoutMs: positiveInteger("FC_E2B_SMOKE_PROMPT_TIMEOUT_MS", 300_000),
    workspaceRoot: process.env.SANDBOX_WORKSPACE_ROOT ?? "/home/user/workspace",
    claudeConfigDir: "/home/user/.claude",
    agentStateRoot: process.env.CODEAGENT_STATE_ROOT ?? "/home/user/.codeagent",
    baseUrl: process.env.BAILIAN_BASE_URL ?? "https://dashscope.aliyuncs.com/apps/anthropic",
    model: process.env.ANTHROPIC_MODEL ?? process.env.DASHSCOPE_MODEL ?? "qwen3.7-max",
    sessionModel: sessionModel(),
    mode: process.env.CLAUDE_MODE ?? "bypassPermissions",
    haikuModel: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "qwen3.6-flash",
    sonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "qwen3.7-max",
    opusModel: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "qwen3.7-max",
    subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? "qwen3.7-max",
  };
}

function buildAppConfig(environment, dataDir) {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    webDistDir: "",
    workspaceRoot: environment.workspaceRoot,
    claudeConfigDir: environment.claudeConfigDir,
    agentStateRoot: environment.agentStateRoot,
    fc: {
      apiKey: environment.apiKey,
      apiUrl: environment.apiUrl,
      domain: environment.domain,
      region: environment.region,
      template: environment.template,
      agentPort: environment.agentPort,
      timeoutMs: environment.sandboxTimeoutMs,
      requestTimeoutMs: environment.requestTimeoutMs,
      runtimeAssetsDir: process.env.FC_RUNTIME_ASSETS_DIR ?? "sandbox_image",
      runtimeIdleMs: 10 * 60 * 1000,
    },
    claude: {
      authToken: environment.authToken,
      baseUrl: environment.baseUrl,
      model: environment.model,
      sessionModel: environment.sessionModel,
      mode: environment.mode,
      haikuModel: environment.haikuModel,
      sonnetModel: environment.sonnetModel,
      opusModel: environment.opusModel,
      subagentModel: environment.subagentModel,
    },
  };
}

function buildProviderConfig(config) {
  return {
    apiKey: config.fc.apiKey,
    apiUrl: config.fc.apiUrl,
    domain: config.fc.domain,
    template: config.fc.template,
    timeoutMs: config.fc.timeoutMs,
    requestTimeoutMs: config.fc.requestTimeoutMs,
    runtimeAssetsDir: config.fc.runtimeAssetsDir,
    workspaceRoot: config.workspaceRoot,
    claudeConfigDir: config.claudeConfigDir,
    agentStateRoot: config.agentStateRoot,
    agentPort: config.fc.agentPort,
    claude: {
      authToken: config.claude.authToken,
      baseUrl: config.claude.baseUrl,
      model: config.claude.model,
      haikuModel: config.claude.haikuModel,
      sonnetModel: config.claude.sonnetModel,
      opusModel: config.claude.opusModel,
      subagentModel: config.claude.subagentModel,
    },
  };
}

async function waitForPrompt(store, sessionId, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await store.require(sessionId);
    if (session.status === "ready") return session;
    if (session.status === "failed") throw new Error(`${label}失败：${session.error ?? "未知错误"}`);
    await sleep(500);
  }
  throw new Error(`${label}在 ${timeoutMs}ms 内未完成`);
}

async function waitForEvent(persist, sessionId, predicate, timeoutMs, failureMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await persist.listEventsAfter(sessionId, 0);
    if (predicate(events)) return events;
    await sleep(200);
  }
  throw new Error(failureMessage);
}

function methodOf(event) {
  return event?.payload && typeof event.payload === "object" && "method" in event.payload
    ? event.payload.method
    : undefined;
}

function isAssistantTextEvent(event) {
  if (event.sender !== "agent" || methodOf(event) !== "session/update") return false;
  const update = event.payload?.params?.update;
  return update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text";
}

function assistantTextAfter(events, eventIndex) {
  return events
    .filter((event) => event.eventIndex > eventIndex && isAssistantTextEvent(event))
    .map((event) => String(event.payload.params.update.content.text ?? ""))
    .join("");
}

function maxEventIndex(events) {
  return events.reduce((maximum, event) => Math.max(maximum, event.eventIndex), 0);
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

function sessionModel() {
  const value = process.env.CLAUDE_SESSION_MODEL ?? "default";
  if (["default", "opus", "sonnet", "haiku"].includes(value)) return value;
  throw new Error("CLAUDE_SESSION_MODEL 必须是 default、opus、sonnet 或 haiku");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
