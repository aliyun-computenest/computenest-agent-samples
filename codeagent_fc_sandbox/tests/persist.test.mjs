import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSessionPersistDriver } from "../packages/core/dist/index.js";

test("同一 SDK SessionRecord 的并发更新会串行化且不会碰撞临时文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-session-persist-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const persist = new FileSessionPersistDriver(root);
  await persist.init();
  const writes = Array.from({ length: 40 }, (_, index) =>
    persist.updateSession(sessionRecord(`connection-${index}`)),
  );

  await Promise.all(writes);

  const saved = await persist.getSession("sdk-session-serial");
  assert.equal(saved?.lastConnectionId, "connection-39");

  const directory = path.join(root, "sdk-sessions");
  const files = await fs.readdir(directory);
  assert.deepEqual(files, ["sdk-session-serial.json"]);
  const filePath = path.join(directory, files[0]);
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).lastConnectionId, "connection-39");
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test("原生 resume 晋升连接后会拒绝旧 ACP 连接的迟到 SessionRecord", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-session-epoch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const persist = new FileSessionPersistDriver(root);
  await persist.init();
  const oldRecord = sessionRecord("connection-old");
  await persist.updateSession(oldRecord);
  await persist.promoteSessionConnection({
    ...oldRecord,
    lastConnectionId: "connection-new",
    sandboxId: "fc-e2b/sandbox-new",
  });

  await persist.updateSession({
    ...oldRecord,
    configOptions: [{ id: "stale", name: "Stale", type: "select", currentValue: "old", options: [] }],
  });

  const current = await persist.getSession(oldRecord.id);
  assert.equal(current.lastConnectionId, "connection-new");
  assert.equal(current.sandboxId, "fc-e2b/sandbox-new");
  assert.equal(current.configOptions, undefined);
});

test("ACP 连接交接期间暂存新事件并拒绝旧连接的迟到 SSE 事件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-session-event-handoff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const persist = new FileSessionPersistDriver(root);
  await persist.init();
  const oldRecord = sessionRecord("connection-old");
  await persist.updateSession(oldRecord);
  const observed = [];
  const unsubscribe = persist.subscribe(oldRecord.id, (event) => observed.push(event));

  await persist.insertEvent(oldRecord.id, sessionEvent(1, "connection-old"));
  await persist.beginSessionConnection(oldRecord.id, "connection-new");
  await persist.insertEvent(oldRecord.id, sessionEvent(2, "connection-new"));
  assert.deepEqual(
    (await persist.listEventsAfter(oldRecord.id, 0)).map((event) => event.connectionId),
    ["connection-old"],
    "候选连接晋升前不能进入历史或 SSE",
  );

  await persist.insertEvent(oldRecord.id, sessionEvent(2, "connection-old"));
  await persist.promoteSessionConnection({
    ...oldRecord,
    lastConnectionId: "connection-new",
    sandboxId: "fc-e2b/sandbox-new",
  });
  assert.deepEqual(
    (await persist.listEventsAfter(oldRecord.id, 0)).map((event) => [
      event.eventIndex,
      event.connectionId,
    ]),
    [
      [1, "connection-old"],
      [2, "connection-new"],
    ],
  );

  await persist.insertEvent(oldRecord.id, sessionEvent(3, "connection-old"));
  await persist.insertEvent(oldRecord.id, sessionEvent(3, "connection-new"));
  unsubscribe();
  assert.deepEqual(
    observed.map((event) => event.connectionId),
    ["connection-old", "connection-new", "connection-new"],
    "晋升后旧连接的迟到事件必须被丢弃",
  );
});

test("清除幽灵 SessionRecord 时保留事件 JSONL 和递增序号", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-session-clear-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const persist = new FileSessionPersistDriver(root);
  await persist.init();
  await persist.updateSession(sessionRecord("connection-old"));
  await persist.insertEvent("sdk-session-serial", sessionEvent(1, "connection-old"));

  await persist.deleteSessionRecord("sdk-session-serial");

  assert.equal(await persist.getSession("sdk-session-serial"), undefined);
  assert.deepEqual(
    (await persist.listEventsAfter("sdk-session-serial", 0)).map((event) => event.eventIndex),
    [1],
  );
  await persist.insertEvent("sdk-session-serial", sessionEvent(2));
  assert.deepEqual(
    (await persist.listEventsAfter("sdk-session-serial", 0)).map((event) => event.eventIndex),
    [1, 2],
  );
});

test("清除幽灵记录后连接 epoch 仍单调，旧连接迟到写不能复活旧 Claude ID", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-session-deleted-epoch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const persist = new FileSessionPersistDriver(root);
  await persist.init();
  let old = sessionRecord("connection-old");
  await persist.updateSession(old);
  for (let index = 0; index < 5; index += 1) {
    await persist.promoteSessionConnection(old);
    old = await persist.getSession(old.id);
  }

  await persist.deleteSessionRecord(old.id);
  await persist.promoteSessionConnection({
    ...old,
    agentSessionId: "claude-native-new",
    lastConnectionId: "connection-new",
  });
  const beforeLateWrite = await persist.getSession(old.id);
  assert.equal(beforeLateWrite.agentSessionId, "claude-native-new");
  assert.ok(beforeLateWrite._codeagentConnectionEpoch > old._codeagentConnectionEpoch);

  await persist.updateSession(old);

  const afterLateWrite = await persist.getSession(old.id);
  assert.equal(afterLateWrite.agentSessionId, "claude-native-new");
  assert.equal(afterLateWrite.lastConnectionId, "connection-new");
});

function sessionRecord(lastConnectionId) {
  return {
    id: "sdk-session-serial",
    agent: "claude-code",
    agentSessionId: "claude-native-serial",
    lastConnectionId,
    createdAt: Date.now(),
    sandboxId: "fc-e2b/sandbox-serial",
    sessionInit: {
      cwd: "/home/user/workspace",
      mcpServers: [],
    },
  };
}

function sessionEvent(eventIndex, connectionId = "connection-1") {
  return {
    id: `event-${eventIndex}`,
    eventIndex,
    sessionId: "sdk-session-serial",
    createdAt: Date.now(),
    connectionId,
    sender: "agent",
    payload: { jsonrpc: "2.0", method: "session/update", params: { eventIndex } },
  };
}
