import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BusinessSessionCorruptError,
  BusinessSessionStore,
} from "../packages/core/dist/index.js";

test("同一业务会话的并发 save 会串行化并留下完整 JSON", async (t) => {
  const root = await temporaryRoot(t);
  const store = new BusinessSessionStore(root);
  await store.init();
  const created = await store.create(sessionInput("serial-1", "初始版本"));

  const writes = Array.from({ length: 40 }, (_, index) =>
    store.save({ ...created, title: `版本-${index}` }),
  );
  const saved = await Promise.all(writes);

  assert.equal(saved.at(-1).title, "版本-39");
  assert.equal((await store.require("serial-1")).title, "版本-39");

  const directory = path.join(root, "business-sessions");
  const files = await fs.readdir(directory);
  assert.deepEqual(files, ["serial-1.json"]);
  const raw = await fs.readFile(path.join(directory, "serial-1.json"), "utf8");
  assert.equal(JSON.parse(raw).title, "版本-39");
});

test("并发 update 会在锁内读取前一版本并保留双方字段", async (t) => {
  const root = await temporaryRoot(t);
  const store = new BusinessSessionStore(root);
  await store.init();
  await store.create(sessionInput("session-update"));

  await Promise.all([
    store.update("session-update", (current) => ({ ...current, sandboxId: "sandbox-1" })),
    store.update("session-update", (current) => ({ ...current, agentSessionId: "claude-1" })),
  ]);

  const current = await store.require("session-update");
  assert.equal(current.sandboxId, "sandbox-1");
  assert.equal(current.agentSessionId, "claude-1");
});

test("init 会对截断的业务会话 JSON 报出明确文件路径", async (t) => {
  const root = await temporaryRoot(t);
  const directory = path.join(root, "business-sessions");
  const corruptPath = path.join(directory, "broken.json");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(corruptPath, '{"id":"broken"', "utf8");

  const store = new BusinessSessionStore(root);
  await assert.rejects(store.init(), (error) => {
    assert.ok(error instanceof BusinessSessionCorruptError);
    assert.equal(error.filePath, corruptPath);
    assert.ok(error.cause instanceof SyntaxError);
    assert.match(error.message, /业务会话持久化文件损坏或不完整/);
    return true;
  });
});

test("get 会将运行期出现的截断 JSON 转换为持久化错误", async (t) => {
  const root = await temporaryRoot(t);
  const store = new BusinessSessionStore(root);
  await store.init();
  const corruptPath = path.join(root, "business-sessions", "broken.json");
  await fs.writeFile(corruptPath, "{", "utf8");

  await assert.rejects(store.get("broken"), (error) => {
    assert.ok(error instanceof BusinessSessionCorruptError);
    assert.equal(error.filePath, corruptPath);
    return true;
  });
});

function sessionInput(id, title) {
  return {
    id,
    runtimeProvider: "fc-e2b",
    userId: "test-user",
    projectId: "test-project",
    title,
    status: "ready",
    templateName: "test-template",
    workspaceRoot: "/home/user/workspace",
  };
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "business-session-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
