import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true, override: true });

const SKIP_FLAG = "FC_E2B_SMOKE_SKIP";

if (process.env[SKIP_FLAG] === "true") {
  console.log(`[SKIP] ${SKIP_FLAG}=true，未创建 FC 沙箱。`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`[FAIL] FC API 进程重启恢复验证失败：${errorMessage(error)}`);
  process.exitCode = 1;
});

async function main() {
  const [{ FcE2BSandboxProvider }, { FileSessionPersistDriver }] = await Promise.all([
    import("@codeagent-sandbox-demo/fc-e2b-provider"),
    import("@codeagent-sandbox-demo/core"),
  ]).catch((error) => {
    throw new Error(`缺少构建产物；请先运行 npm run build。${errorMessage(error)}`);
  });

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fc-e2b-api-restart-smoke-"));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let sandboxId;
  let child;

  try {
    child = startApi(port, dataDir, "A");
    await waitForApi(origin, child);

    const created = await requestJson(`${origin}/api/sessions`, {
      method: "POST",
      body: JSON.stringify({ userId: "api-restart-smoke", projectId: "api-restart-smoke" }),
    });
    const prepared = await waitForSession(origin, created.id, (session) =>
      session.status === "ready" && Boolean(session.sandboxId) && Boolean(session.agentSessionId));
    sandboxId = prepared.sandboxId;
    const firstAgentSessionId = prepared.agentSessionId;

    const nonce = `FC_PROCESS_RESUME_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const firstUpdatedAt = prepared.updatedAt;
    await requestJson(`${origin}/api/sessions/${created.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: `请记住一个临时口令：${nonce}。只回复“已记住”，不要复述口令，也不要写入文件。`,
      }),
    });
    await waitForSession(origin, created.id, (session) =>
      session.status === "ready" && session.updatedAt !== firstUpdatedAt, promptTimeoutMs());

    let persist = new FileSessionPersistDriver(dataDir);
    await persist.init();
    const beforeRestartEvents = await persist.listEventsAfter(created.id, 0);
    const beforeRestartIndex = maxEventIndex(beforeRestartEvents);
    assert.equal(beforeRestartEvents.filter((event) => methodOf(event) === "session/new").length, 1);

    await stopApi(child, "SIGKILL");
    child = undefined;

    child = startApi(port, dataDir, "B");
    await waitForApi(origin, child);
    const reloaded = await requestJson(`${origin}/api/sessions/${created.id}`);
    assert.equal(reloaded.sandboxId, sandboxId, "API B 必须从磁盘读取同一 sandboxId");
    assert.equal(reloaded.agentSessionId, firstAgentSessionId, "API B 必须从磁盘读取同一 agentSessionId");

    const secondUpdatedAt = reloaded.updatedAt;
    await requestJson(`${origin}/api/sessions/${created.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "我刚才让你记住的临时口令是什么？只回复口令本身。" }),
    });
    await waitForSession(origin, created.id, (session) =>
      session.status === "ready" && session.updatedAt !== secondUpdatedAt, promptTimeoutMs());

    persist = new FileSessionPersistDriver(dataDir);
    await persist.init();
    const allEvents = await persist.listEventsAfter(created.id, 0);
    const afterRestart = allEvents.filter((event) => event.eventIndex > beforeRestartIndex);
    assert.ok(afterRestart.some((event) => methodOf(event) === "session/resume"), "API B 未产生 ACP session/resume");
    assert.equal(allEvents.filter((event) => methodOf(event) === "session/new").length, 1, "进程重启不得创建第二个 Claude session");
    assert.ok(
      afterRestart
        .filter((event) => event.sender === "client")
        .every((event) => !JSON.stringify(event.payload).includes(nonce)),
      "API B 不得把第一轮口令作为本地历史注入 prompt",
    );
    const reply = assistantTextAfter(allEvents, beforeRestartIndex);
    assert.ok(reply.includes(nonce), `恢复后的回复没有包含第一轮口令：${JSON.stringify(reply.slice(0, 500))}`);

    await requestJson(`${origin}/api/sessions/${created.id}`, { method: "DELETE" });
    sandboxId = undefined;

    console.log(JSON.stringify({
      result: "PASS",
      backendProcesses: ["A", "B"],
      forcedRestartSignal: "SIGKILL",
      businessSessionId: created.id,
      sandboxId: reloaded.sandboxId,
      agentSessionId: firstAgentSessionId,
      nativeResumeObserved: true,
      memoryRecovered: true,
      localPromptReplayObserved: false,
    }, null, 2));
  } finally {
    if (child) await stopApi(child, "SIGKILL").catch(() => undefined);
    if (sandboxId) {
      const provider = new FcE2BSandboxProvider({ config: cleanupProviderConfig() });
      await provider.destroy(sandboxId).catch((error) => {
        console.error(`[WARN] FC 沙箱清理失败（${sandboxId}）：${errorMessage(error)}`);
      });
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function startApi(port, dataDir, label) {
  const child = spawn(process.execPath, ["src/apps/api/dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEAGENT_DATA_DIR: dataDir,
      FC_RUNTIME_IDLE_MS: "600000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) logs.push(`[API ${label}] ${line}`);
      if (logs.length > 200) logs.splice(0, logs.length - 200);
    });
  }
  child.recentLogs = logs;
  return child;
}

async function stopApi(child, signal) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill(signal);
  await new Promise((resolve) => child.once("exit", resolve));
}

async function waitForApi(origin, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`API 提前退出：\n${child.recentLogs.slice(-30).join("\n")}`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`API 未就绪：${errorMessage(lastError)}\n${child.recentLogs.slice(-30).join("\n")}`);
}

async function waitForSession(origin, sessionId, predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJson(`${origin}/api/sessions/${sessionId}`);
    if (latest.status === "failed") throw new Error(`会话失败：${latest.error || "unknown error"}`);
    if (predicate(latest)) return latest;
    await sleep(500);
  }
  throw new Error(`等待会话状态超时：${JSON.stringify(latest)}`);
}

async function requestJson(url, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (init.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} -> HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  return text ? JSON.parse(text) : undefined;
}

function cleanupProviderConfig() {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.DASHSCOPE_API_KEY || "";
  const template = process.env.FC_E2B_TEMPLATE || "base";
  if (!process.env.E2B_API_KEY) throw new Error("清理沙箱所需的 E2B_API_KEY 缺失");
  return {
    apiKey: process.env.E2B_API_KEY,
    apiUrl: process.env.E2B_API_URL ?? "https://api.cn-beijing.e2b.fc.aliyuncs.com",
    domain: process.env.E2B_DOMAIN ?? "cn-beijing.e2b.fc.aliyuncs.com",
    template,
    timeoutMs: positiveInteger("FC_E2B_TIMEOUT_SECONDS", 1800) * 1000,
    requestTimeoutMs: positiveInteger("FC_E2B_REQUEST_TIMEOUT_MS", 120_000),
    runtimeAssetsDir: process.env.FC_RUNTIME_ASSETS_DIR ?? "sandbox_image",
    workspaceRoot: process.env.SANDBOX_WORKSPACE_ROOT ?? "/home/user/workspace",
    claudeConfigDir: "/home/user/.claude",
    agentStateRoot: process.env.CODEAGENT_STATE_ROOT ?? "/home/user/.codeagent",
    agentPort: positiveInteger("FC_E2B_AGENT_PORT", 3001),
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

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function methodOf(event) {
  return event?.payload && typeof event.payload === "object" && typeof event.payload.method === "string"
    ? event.payload.method
    : "";
}

function assistantTextAfter(events, eventIndex) {
  return events
    .filter((event) => event.eventIndex > eventIndex && event.sender === "agent" && methodOf(event) === "session/update")
    .map((event) => event.payload?.params?.update)
    .filter((update) => update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text")
    .map((update) => update.content.text ?? "")
    .join("");
}

function maxEventIndex(events) {
  return events.reduce((maximum, event) => Math.max(maximum, event.eventIndex ?? 0), 0);
}

function promptTimeoutMs() {
  return positiveInteger("FC_E2B_SMOKE_PROMPT_TIMEOUT_MS", 300_000);
}

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
