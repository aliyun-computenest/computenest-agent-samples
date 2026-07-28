import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelNativeClaudePrompt,
  isNativeClaudeSessionResourceNotFound,
  NativeClaudeSessionResumeError,
  resumeOrCreateNativeClaudeSession,
} from "../src/apps/api/dist/services/native-claude-session.js";

test("只把目标 Claude session/resume 的 ResourceNotFound 识别为会话缺失", () => {
  const targetMissing = new NativeClaudeSessionResumeError(
    "business-1",
    "claude-native-1",
    Object.assign(new Error("Resource not found: claude-native-1"), {
      name: "AcpRpcError",
      code: -32002,
      data: { uri: "claude-native-1" },
    }),
  );
  const otherResourceMissing = new NativeClaudeSessionResumeError(
    "business-1",
    "claude-native-1",
    Object.assign(new Error("Resource not found: mode/bypassPermissions"), {
      name: "AcpRpcError",
      code: -32002,
      data: { uri: "mode/bypassPermissions" },
    }),
  );
  const rawRpcError = Object.assign(new Error("Resource not found: claude-native-1"), {
    name: "AcpRpcError",
    code: -32002,
    data: { uri: "claude-native-1" },
  });

  assert.equal(isNativeClaudeSessionResourceNotFound(targetMissing), true);
  assert.equal(isNativeClaudeSessionResourceNotFound(otherResourceMissing), false);
  assert.equal(isNativeClaudeSessionResourceNotFound(rawRpcError), false);
});

test("已有 Claude 会话通过 ACP session/resume 原生恢复且保持 agentSessionId", async () => {
  const calls = [];
  const persisted = sessionRecord();
  const persist = fakePersist(persisted, calls);
  const sdk = fakeSdk(calls, {
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "old-model", options: [] }],
    modes: { currentModeId: "default", availableModes: [] },
  }, "fc-e2b/sandbox-2");

  const session = await resumeOrCreateNativeClaudeSession({
    sdk,
    persist,
    id: "business-1",
    agentSessionId: "claude-native-1",
    cwd: "/workspace",
    mode: "acceptEdits",
    model: "claude-sonnet",
  });

  assert.equal(session.agentSessionId, "claude-native-1");
  assert.equal(persisted.agentSessionId, "claude-native-1");
  assert.deepEqual(calls.filter(([name]) => name === "resume"), [
    ["resume", { sessionId: "claude-native-1", cwd: "/workspace", mcpServers: [] }],
  ]);
  assert.equal(calls.some(([name]) => name === "create"), false);
  assert.equal(calls.some(([name]) => name === "listEvents"), false);
  assert.deepEqual(calls.filter(([name]) => name === "bind"), [["bind", "business-1", "claude-native-1"]]);
  assert.deepEqual(calls.filter(([name]) => name === "mode"), [["mode", "acceptEdits"]]);
  assert.deepEqual(calls.filter(([name]) => name === "model"), [["model", "claude-sonnet"]]);
  const saved = calls.filter(([name]) => name === "update").at(-1)[1];
  assert.equal(saved.agentSessionId, "claude-native-1");
  assert.equal(saved.lastConnectionId, "connection-new");
  assert.equal(saved.sandboxId, "fc-e2b/sandbox-2");
  assert.equal(saved.configOptions[0].currentValue, "old-model");
  assert.equal(saved.modes.currentModeId, "default");
});

test("没有任何 Claude 会话标识时只创建一次业务新会话", async () => {
  const calls = [];
  const persist = fakePersist(undefined, calls);
  const sdk = fakeSdk(calls);

  const session = await resumeOrCreateNativeClaudeSession({
    sdk,
    persist,
    id: "business-new",
    cwd: "/workspace",
    mode: "acceptEdits",
    model: "claude-sonnet",
  });

  assert.equal(session.agentSessionId, "claude-created");
  assert.deepEqual(calls.filter(([name]) => name === "create"), [
    [
      "create",
      {
        id: "business-new",
        agent: "claude",
        cwd: "/workspace",
      },
    ],
  ]);
  assert.equal(calls.some(([name]) => name === "resume"), false);
  assert.equal(calls.some(([name]) => name === "listEvents"), false);
  assert.deepEqual(calls.filter(([name]) => name === "mode"), [["mode", "acceptEdits"]]);
  assert.deepEqual(calls.filter(([name]) => name === "model"), [["model", "claude-sonnet"]]);
});

test("新建 Claude 会话后会晋升当前 ACP 连接", async () => {
  const calls = [];
  const persist = fakePersist(undefined, calls);
  persist.promoteSessionConnection = async (record) => calls.push(["promote", record]);
  const sdk = fakeSdk(calls);

  await resumeOrCreateNativeClaudeSession({
    sdk,
    persist,
    id: "business-promote",
    cwd: "/workspace",
  });

  const promoted = calls.filter(([name]) => name === "promote");
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0][1].id, "business-promote");
  assert.equal(promoted[0][1].agentSessionId, "claude-created");
});

test("业务记录已有 Claude ID 但 SDK 记录缺失时恢复成功后才落盘", async () => {
  const calls = [];
  const persist = fakePersist(undefined, calls);
  const sdk = fakeSdk(calls);

  const session = await resumeOrCreateNativeClaudeSession({
    sdk,
    persist,
    id: "business-seed",
    agentSessionId: "claude-existing",
    cwd: "/workspace",
  });

  assert.equal(session.agentSessionId, "claude-existing");
  assert.equal(calls.filter(([name]) => name === "update").length, 1);
  assert.equal(calls.find(([name]) => name === "update")[1].sandboxId, "fc-e2b/sandbox-1");
  assert.equal(calls.some(([name]) => name === "create"), false);
  assert.equal(calls.some(([name]) => name === "listEvents"), false);
});

test("ACP 原生恢复失败时明确报错且不退回新建会话", async () => {
  const calls = [];
  const persist = fakePersist(sessionRecord(), calls);
  const sdk = fakeSdk(calls, new Error("native session missing"));

  await assert.rejects(
    resumeOrCreateNativeClaudeSession({
      sdk,
      persist,
      id: "business-1",
      agentSessionId: "claude-native-1",
      cwd: "/workspace",
    }),
    (error) => {
      assert.ok(error instanceof NativeClaudeSessionResumeError);
      assert.match(error.message, /native session missing/);
      return true;
    },
  );
  assert.equal(calls.some(([name]) => name === "create"), false);
  assert.equal(calls.some(([name]) => name === "listEvents"), false);
  assert.equal(calls.some(([name]) => name === "update"), false, "resume 失败不能提交候选 sandbox 记录");
});

test("SDK 记录缺失且原生恢复失败时也不会预写候选 sandbox", async () => {
  const calls = [];
  const persist = fakePersist(undefined, calls);
  const sdk = fakeSdk(calls, new Error("session JSONL missing"), "fc-e2b/sandbox-replacement");

  await assert.rejects(
    resumeOrCreateNativeClaudeSession({
      sdk,
      persist,
      id: "business-seed-failed",
      agentSessionId: "claude-existing",
      cwd: "/workspace",
    }),
    NativeClaudeSessionResumeError,
  );
  assert.equal(calls.some(([name]) => name === "update"), false);
  assert.equal(calls.some(([name]) => name === "create"), false);
});

test("取消运行中提示直接调用 ACP session/cancel 而不销毁或重建会话", async () => {
  const calls = [];
  const sdk = fakeSdk(calls);
  const session = {
    agent: "claude",
    agentSessionId: "claude-native-1",
  };

  await cancelNativeClaudePrompt(sdk, session);

  assert.deepEqual(calls.filter(([name]) => name === "cancel"), [
    ["cancel", { sessionId: "claude-native-1" }],
  ]);
  assert.equal(calls.some(([name]) => name === "create"), false);
  assert.equal(calls.some(([name]) => name === "destroy"), false);
});

function sessionRecord() {
  return {
    id: "business-1",
    agent: "claude",
    agentSessionId: "claude-native-1",
    lastConnectionId: "connection-old",
    createdAt: 1,
    sandboxId: "fc-e2b/sandbox-1",
    sessionInit: { cwd: "/workspace", mcpServers: [] },
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "old-model", options: [] }],
    modes: { currentModeId: "default", availableModes: [] },
  };
}

function fakePersist(initial, calls) {
  let current = initial;
  return {
    getSession: async () => current,
    updateSession: async (record) => {
      current = record;
      calls.push(["update", record]);
    },
    listSessions: async () => ({ items: current ? [current] : [] }),
    listEvents: async () => {
      calls.push(["listEvents"]);
      throw new Error("本测试禁止读取本地事件历史");
    },
    insertEvent: async () => undefined,
  };
}

function fakeSdk(calls, resumeResult = {}, sandboxId = "fc-e2b/sandbox-1") {
  const sessionFor = (record) => ({
    agent: "claude",
    agentSessionId: record.agentSessionId,
    setMode: async (mode) => calls.push(["mode", mode]),
    setModel: async (model) => calls.push(["model", model]),
    toRecord: () => record,
  });
  const live = {
    connectionId: "connection-new",
    bindSession(localId, agentSessionId) {
      calls.push(["bind", localId, agentSessionId]);
    },
    acp: {
      async cancel(request) {
        calls.push(["cancel", request]);
      },
      async unstableResumeSession(request) {
        calls.push(["resume", request]);
        if (resumeResult instanceof Error) throw resumeResult;
        return resumeResult;
      },
    },
  };
  return {
    sandboxId,
    async createSession(request) {
      calls.push(["create", request]);
      return sessionFor({
        id: request.id,
        agent: "claude",
        agentSessionId: "claude-created",
        lastConnectionId: "connection-created",
        createdAt: Date.now(),
        sandboxId,
        sessionInit: { cwd: request.cwd, mcpServers: [] },
      });
    },
    async getLiveConnection(agent) {
      calls.push(["live", agent]);
      return live;
    },
    upsertSessionHandle(record) {
      calls.push(["upsert", record]);
      return sessionFor(record);
    },
  };
}
