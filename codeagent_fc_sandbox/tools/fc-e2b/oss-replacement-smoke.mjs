import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Sandbox } from "e2b";
import {
  BusinessSessionStore,
  FileSessionPersistDriver,
  createBusinessSessionId,
} from "../../packages/core/dist/index.js";
import { FcE2BSandboxProvider } from "../../packages/fc-e2b-provider/dist/index.js";
import { assertConfig, loadConfig } from "../../src/apps/api/dist/config.js";
import { AgentSessionManager } from "../../src/apps/api/dist/services/agent-session-manager.js";

const baseConfig = loadConfig();
assertConfig(baseConfig);
if (!baseConfig.fc.oss.enabled) throw new Error("FC OSS persistence is not enabled");

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeagent-oss-replacement-"));
const config = {
  ...baseConfig,
  dataDir,
  fc: { ...baseConfig.fc, runtimeIdleMs: 5 * 60 * 1000 },
};
const sessionId = createBusinessSessionId();
const userId = `smoke-user-${randomUUID().slice(0, 8)}`;
const projectId = `smoke-project-${randomUUID().slice(0, 8)}`;
const memoryToken = `OSS_NATIVE_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const workspaceNonce = `WORKSPACE_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const skillNonce = `SKILL_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const marker = `${JSON.stringify({ sessionId, workspaceNonce, createdAt: new Date().toISOString() })}\n`;
const markerHash = sha256(marker);
const skillBody = [
  "---",
  "name: oss-recovery-probe",
  "description: 仅用于 FC OSS 跨沙箱恢复验收",
  "---",
  "",
  `Skill 文件校验标记：${skillNonce}`,
  "",
].join("\n");

let managerA;
let managerB;
let sandboxIdA;
let sandboxIdB;
let directB;
let succeeded = false;
let firstTurnMaxEventIndex = 0;
let ossCleanupSucceeded = false;

assert.equal(marker.includes(memoryToken), false, "Claude memory token leaked into workspace marker");
assert.equal(skillBody.includes(memoryToken), false, "Claude memory token leaked into Skill");

try {
  const first = await createControlPlane();
  managerA = first.manager;
  const ossPrefix = first.provider.storagePrefixFor({ sessionId, userId, projectId });
  await first.store.create({
    id: sessionId,
    runtimeProvider: "fc-e2b",
    userId,
    projectId,
    title: projectId,
    status: "creating",
    ossPrefix,
    templateName: config.fc.template,
    workspaceRoot: config.workspaceRoot,
    claudeConfigDir: config.claudeConfigDir,
    recoveryEpoch: 0,
  });

  const readyA = await managerA.prepare(sessionId);
  sandboxIdA = required(readyA.sandboxId, "first sandboxId");
  const agentSessionId = required(readyA.agentSessionId, "Claude agentSessionId");
  console.log(`[1/8] Sandbox A ready: ${sandboxIdA}`);

  await managerA.writeFile(sessionId, "oss-recovery-marker.json", marker);
  const directA = await connectSandbox(sandboxIdA);
  await writeRemoteFile(
    directA,
    `${config.claudeConfigDir}/skills/oss-recovery-probe/SKILL.md`,
    skillBody,
  );
  const firstEventIndex = await maxEventIndex(managerA);
  await sendAndWait(
    managerA,
    first.store,
    `请只在当前 Claude 对话上下文中记住临时口令 ${memoryToken}。不要读取或修改文件，也不要把口令写入任何文件；只回复“已记住”。`,
    firstEventIndex,
  );
  await directA.commands.run("sync", { timeoutMs: 60_000, user: "user" });
  const claudeFilesA = await directA.commands.run(
    `find ${shellQuote(`${config.claudeConfigDir}/projects`)} -type f -name '*.jsonl' -print | head -20`,
    { timeoutMs: 30_000, user: "user" },
  );
  assert.ok(claudeFilesA.stdout.trim(), "Sandbox A did not persist a Claude session JSONL to OSS");
  const firstTurnEvents = await managerA.listEvents(sessionId, 0);
  firstTurnMaxEventIndex = maxEventIndexOf(firstTurnEvents);
  assert.equal(
    firstTurnEvents.filter((event) => methodOf(event) === "session/new").length,
    1,
    "initial turn must create exactly one Claude session",
  );
  console.log(`[2/8] Workspace、Skill 和 Claude 上下文已写入 OSS: ${ossPrefix}`);

  await managerA.close();
  managerA = undefined;
  await directA.kill();
  console.log(`[3/8] Sandbox A killed to simulate FC reclaim: ${sandboxIdA}`);

  const second = await createControlPlane();
  managerB = second.manager;
  const readyB = await managerB.prepare(sessionId);
  sandboxIdB = required(readyB.sandboxId, "replacement sandboxId");
  assert.notEqual(sandboxIdB, sandboxIdA, "replacement must use a new FC sandbox");
  assert.equal(readyB.ossPrefix, ossPrefix, "replacement changed the OSS prefix");
  assert.equal(readyB.agentSessionId, agentSessionId, "Claude agentSessionId changed during resume");
  assert.equal(readyB.pendingSandboxId, undefined, "replacement remained pending after resume");
  assert.equal(
    (await second.persist.getSession(sessionId))?.sandboxId,
    `fc-e2b/${sandboxIdB}`,
    "SDK SessionRecord still points at the reclaimed sandbox",
  );
  const recoveredEvents = await managerB.listEvents(sessionId, 0);
  assert.equal(
    recoveredEvents.filter((event) => methodOf(event) === "session/new").length,
    1,
    "replacement created a second Claude session",
  );
  assert.ok(
    recoveredEvents.some(
      (event) => event.eventIndex > firstTurnMaxEventIndex && methodOf(event) === "session/resume",
    ),
    "replacement did not emit ACP session/resume",
  );
  assert.ok(
    recoveredEvents
      .filter((event) => event.eventIndex > firstTurnMaxEventIndex && event.sender === "client")
      .every((event) => !JSON.stringify(event.payload).includes(memoryToken)),
    "replacement replayed the first-turn memory token from local events",
  );
  console.log(`[4/8] Sandbox B resumed the same Claude session: ${sandboxIdB}`);

  const recoveredMarker = Buffer.from(
    await managerB.readFile(sessionId, "oss-recovery-marker.json"),
  ).toString("utf8");
  assert.equal(sha256(recoveredMarker), markerHash, "workspace marker hash changed after replacement");
  console.log(`[5/8] Workspace marker recovered with SHA-256 ${markerHash}`);

  const beforeRecall = await maxEventIndex(managerB);
  const recallEvents = await sendAndWait(
    managerB,
    second.store,
    "只回复我上一轮要求你记住的口令，不要解释。",
    beforeRecall,
  );
  const recalledText = assistantMessageText(recallEvents);
  assert.ok(
    recalledText.includes(memoryToken),
    `Claude did not recall the pre-reclaim token; assistant text: ${JSON.stringify(recalledText)}`,
  );
  console.log(`[6/8] Claude native resume recalled a token that was never written to workspace or Skill`);

  directB = await connectSandbox(sandboxIdB);
  const skillRead = await directB.commands.run(
    `cat ${shellQuote(`${config.claudeConfigDir}/skills/oss-recovery-probe/SKILL.md`)}`,
    { timeoutMs: 30_000, user: "user" },
  );
  assert.equal(skillRead.stdout, skillBody, "persisted Skill content changed");
  const jsonl = await directB.commands.run(
    `find ${shellQuote(`${config.claudeConfigDir}/projects`)} -type f -name '*.jsonl' -print | head -20`,
    { timeoutMs: 30_000, user: "user" },
  );
  assert.ok(jsonl.stdout.trim(), "OSS CLAUDE_CONFIG_DIR contains no Claude session JSONL");
  const legacy = await directB.commands.run(
    "find /home/user/.claude/projects -type f -name '*.jsonl' -print 2>/dev/null | head -1",
    { timeoutMs: 30_000, user: "user" },
  );
  assert.equal(legacy.stdout.trim(), "", "Claude session was written to the legacy local ~/.claude");
  const mount = await directB.commands.run(
    `mountpoint -q ${shellQuote(config.fc.oss.mountDir)} && printf mounted`,
    { timeoutMs: 30_000 },
  );
  assert.equal(mount.stdout, "mounted");
  console.log("[7/8] Skill、session JSONL 与实际 OSS mount 均已验证");

  succeeded = true;
  console.log(JSON.stringify({
    result: "PASS",
    sessionId,
    ossPrefix,
    sandboxIdA,
    sandboxIdB,
    agentSessionId,
    workspaceRoot: config.workspaceRoot,
    claudeConfigDir: config.claudeConfigDir,
    markerSha256: markerHash,
    nativeResume: true,
    singleSessionNew: true,
    sessionResumeObserved: true,
    localPromptReplayObserved: false,
    memoryTokenAbsentFromWorkspaceAndSkill: true,
    workspaceRecovered: true,
    skillRecovered: true,
    claudeJsonlOnOss: true,
  }, null, 2));
} finally {
  await managerA?.close().catch(() => undefined);
  await managerB?.close().catch(() => undefined);
  if (succeeded && directB && process.env.FC_OSS_SMOKE_KEEP_DATA !== "true") {
    try {
      await directB.commands.run(
        `find ${shellQuote(config.fc.oss.mountDir)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
        { timeoutMs: 10 * 60 * 1000 },
      );
      ossCleanupSucceeded = true;
    } catch (error) {
      console.error(`[WARN] OSS smoke prefix cleanup failed: ${errorMessage(error)}`);
    }
  }
  if (directB) await directB.kill().catch(() => false);
  else if (sandboxIdB) await killSandbox(sandboxIdB);
  if (!succeeded && sandboxIdA) await killSandbox(sandboxIdA);
  await fs.rm(dataDir, { recursive: true, force: true });
  const ossCleanupStatus = !succeeded
    ? "; OSS data kept for diagnosis"
    : process.env.FC_OSS_SMOKE_KEEP_DATA === "true"
      ? "; OSS data retained by FC_OSS_SMOKE_KEEP_DATA=true"
      : ossCleanupSucceeded
        ? "; OSS prefix cleaned"
        : "; OSS prefix cleanup failed (see warning)";
  console.log(`[8/8] FC sandbox resources cleaned${ossCleanupStatus}`);
}

async function createControlPlane() {
  const persist = new FileSessionPersistDriver(dataDir);
  const store = new BusinessSessionStore(dataDir);
  await persist.init();
  await store.init();
  const provider = new FcE2BSandboxProvider({
    config: {
      apiKey: config.fc.apiKey,
      apiUrl: config.fc.apiUrl,
      domain: config.fc.domain,
      template: config.fc.template,
      timeoutMs: config.fc.timeoutMs,
      requestTimeoutMs: config.fc.requestTimeoutMs,
      runtimeAssetsDir: config.fc.runtimeAssetsDir,
      agentPort: config.fc.agentPort,
      workspaceRoot: config.workspaceRoot,
      claudeConfigDir: config.claudeConfigDir,
      agentStateRoot: config.agentStateRoot,
      oss: {
        bucketName: config.fc.oss.bucketName,
        endpoint: config.fc.oss.endpoint,
        roleArn: config.fc.oss.roleArn,
        rootPrefix: config.fc.oss.rootPrefix,
        mountDir: config.fc.oss.mountDir,
      },
      claude: config.claude,
    },
  });
  return { persist, store, provider, manager: new AgentSessionManager(config, provider, persist, store) };
}

async function sendAndWait(manager, store, text, afterIndex) {
  await manager.sendMessage(sessionId, text);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const business = await store.require(sessionId);
    const events = await manager.listEvents(sessionId, afterIndex);
    if (business.status === "failed") throw new Error(business.error || "Claude prompt failed");
    if (business.status === "ready" && events.length > 0) return events;
    await sleep(1_000);
  }
  throw new Error(`Claude prompt did not finish within timeout for ${sessionId}`);
}

async function maxEventIndex(manager) {
  const events = await manager.listEvents(sessionId, 0);
  return events.reduce((maximum, event) => Math.max(maximum, event.eventIndex), 0);
}

async function writeRemoteFile(sandbox, filePath, content) {
  const encoded = Buffer.from(content).toString("base64");
  await sandbox.commands.run(
    `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)} && sync`,
    { timeoutMs: 60_000, user: "user" },
  );
}

function connectSandbox(sandboxId) {
  return Sandbox.connect(sandboxId, connectionOptions());
}

async function killSandbox(sandboxId) {
  const sandbox = await connectSandbox(sandboxId).catch(() => undefined);
  await sandbox?.kill().catch(() => false);
}

function connectionOptions() {
  return {
    apiKey: config.fc.apiKey,
    apiUrl: config.fc.apiUrl,
    domain: config.fc.domain,
    requestTimeoutMs: config.fc.requestTimeoutMs,
    timeoutMs: config.fc.timeoutMs,
  };
}

function required(value, label) {
  if (!value) throw new Error(`${label} is missing`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assistantMessageText(events) {
  return events.flatMap((event) => {
    if (event.sender !== "agent") return [];
    const update = event.payload?.params?.update;
    if (update?.sessionUpdate !== "agent_message_chunk") return [];
    return typeof update.content?.text === "string" ? [update.content.text] : [];
  }).join("");
}

function methodOf(event) {
  return event?.payload && typeof event.payload === "object" && typeof event.payload.method === "string"
    ? event.payload.method
    : "";
}

function maxEventIndexOf(events) {
  return events.reduce((maximum, event) => Math.max(maximum, event.eventIndex ?? 0), 0);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
