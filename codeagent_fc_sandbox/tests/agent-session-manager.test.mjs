import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BusinessSessionStore,
  FileSessionPersistDriver,
} from "../packages/core/dist/index.js";
import { AgentSessionManager } from "../src/apps/api/dist/services/agent-session-manager.js";

test("首条用户消息会生成持久化标题，后续消息不会覆盖", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-first-message-title";
  await fixture.createBusinessSession(id, { title: "新的会话" });
  const runtime = fakeSdk(
    "fc-e2b/sandbox-first-message-title",
    "claude-first-message-title",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
  );
  const manager = fixture.manager(async () => runtime.sdk);

  await manager.sendMessage(id, "  请帮我   创建一个 React   待办应用  ");
  await waitForStatus(fixture.store, id, "ready");
  assert.equal((await fixture.store.require(id)).title, "请帮我 创建一个 React 待办应用");
  await waitUntil(() => runtime.calls.filter(([name]) => name === "prompt").length === 1, "首轮 prompt 未结束");
  await sleep(10);

  await manager.sendMessage(id, "把页面改成深色主题");
  await waitForStatus(fixture.store, id, "ready");
  assert.equal((await fixture.store.require(id)).title, "请帮我 创建一个 React 待办应用");
  await manager.close();
});

test("纯问候标题会被第一条任务描述升级", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-greeting-title";
  await fixture.createBusinessSession(id, { title: "新的会话" });
  const runtime = fakeSdk(
    "fc-e2b/sandbox-greeting-title",
    "claude-greeting-title",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
  );
  const manager = fixture.manager(async () => runtime.sdk);

  await manager.sendMessage(id, "你好！");
  await waitForStatus(fixture.store, id, "ready");
  assert.equal((await fixture.store.require(id)).title, "你好！");

  await manager.sendMessage(id, "写一个 Tank 大战小游戏");
  await waitForStatus(fixture.store, id, "ready");
  assert.equal((await fixture.store.require(id)).title, "写一个 Tank 大战小游戏");
  await manager.close();
});

test("启动时会从首条有效历史消息回填旧的占位标题", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-backfill-title";
  await fixture.createBusinessSession(id, { title: "新的会话", status: "ready" });
  await fixture.persist.insertEvent(id, sessionPromptEvent(id, 1, "你好"));
  await fixture.persist.insertEvent(id, sessionPromptEvent(id, 2, "实现一个   文件预览页面"));
  const manager = fixture.manager(async () => {
    throw new Error("标题回填不应连接 FC 沙箱");
  });

  await manager.start();

  assert.equal((await fixture.store.require(id)).title, "实现一个 文件预览页面");
  await manager.close();
});

test("新业务会话 prepare 和 preview 不会提前创建 Claude 会话", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-lazy-claude";
  await fixture.createBusinessSession(id);
  const runtime = fakeSdk(
    "fc-e2b/sandbox-lazy-claude",
    "claude-first-turn",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
  );
  const manager = fixture.manager(async () => runtime.sdk);

  const prepared = await manager.prepare(id);

  assert.equal(prepared.status, "ready");
  assert.equal(prepared.agentSessionId, undefined);
  assert.equal(await fixture.persist.getSession(id), undefined);
  assert.equal(runtime.calls.some(([name]) => name === "create"), false);
  assert.equal(runtime.calls.some(([name]) => name === "resume"), false);

  assert.deepEqual(await manager.getPreviewStatus(id), { status: "none" });
  assert.equal(runtime.calls.some(([name]) => name === "create"), false);
  assert.equal(runtime.calls.some(([name]) => name === "resume"), false);
  await manager.close();
});

test("第一条消息才创建 Claude 会话并执行 prompt", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-first-prompt";
  await fixture.createBusinessSession(id);
  const runtime = fakeSdk(
    "fc-e2b/sandbox-first-prompt",
    "claude-first-prompt",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
  );
  const manager = fixture.manager(async () => runtime.sdk);

  await manager.prepare(id);
  assert.equal(runtime.calls.some(([name]) => name === "create"), false);

  await manager.sendMessage(id, "创建一个待办应用");
  await waitForStatus(fixture.store, id, "ready");

  const ready = await fixture.store.require(id);
  assert.equal(ready.agentSessionId, "claude-first-prompt");
  assert.equal(ready.claudeSessionPrompted, true);
  assert.equal(ready.claudeSessionDurable, true);
  assert.equal(runtime.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(runtime.calls.filter(([name]) => name === "prompt").length, 1);
  assert.equal(runtime.calls.some(([name]) => name === "resume"), false);
  await manager.close();
});

test("不同业务会话的 prompt 可以并行执行", async (t) => {
  const fixture = await createFixture(t);
  const firstPrompt = deferred();
  const secondPrompt = deferred();
  const first = fakeSdk("fc-e2b/sandbox-parallel-1", "claude-parallel-1", fixture.persist, firstPrompt.promise);
  const second = fakeSdk("fc-e2b/sandbox-parallel-2", "claude-parallel-2", fixture.persist, secondPrompt.promise);
  const runtimes = [first.sdk, second.sdk];
  const manager = fixture.manager(async () => {
    const runtime = runtimes.shift();
    assert.ok(runtime, "不应创建第三个 runtime");
    return runtime;
  });
  await Promise.all([
    fixture.createBusinessSession("session-parallel-1"),
    fixture.createBusinessSession("session-parallel-2"),
  ]);

  await Promise.all([
    manager.sendMessage("session-parallel-1", "任务一"),
    manager.sendMessage("session-parallel-2", "任务二"),
  ]);

  await Promise.all([
    waitForStatus(fixture.store, "session-parallel-1", "running"),
    waitForStatus(fixture.store, "session-parallel-2", "running"),
  ]);
  assert.equal(first.calls.filter(([name]) => name === "prompt").length, 1);
  assert.equal(second.calls.filter(([name]) => name === "prompt").length, 1);

  firstPrompt.resolve({ stopReason: "end_turn" });
  secondPrompt.resolve({ stopReason: "end_turn" });
  await Promise.all([
    waitForStatus(fixture.store, "session-parallel-1", "ready"),
    waitForStatus(fixture.store, "session-parallel-2", "ready"),
  ]);
  await manager.close();
});

test("空幽灵 Claude ID 精确缺失时 prepare 清理身份且首条消息重新创建", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-empty-ghost";
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-empty-ghost",
    sandboxProviderId: "fc-e2b/sandbox-empty-ghost",
    agentSessionId: "claude-ghost",
  });
  await fixture.persist.updateSession(
    sessionRecord(id, "claude-ghost", "fc-e2b/sandbox-empty-ghost", "/home/user/workspace"),
  );
  await fixture.persist.insertEvent(id, sessionNewEvent(id, 1));
  const runtime = fakeSdk(
    "fc-e2b/sandbox-empty-ghost",
    "claude-recreated",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
    {
      resume: async (request) => {
        assert.equal(request.sessionId, "claude-ghost");
        throw resourceNotFound("claude-ghost");
      },
    },
  );
  const manager = fixture.manager(async () => runtime.sdk);

  const recovered = await manager.prepare(id);

  assert.equal(recovered.status, "ready");
  assert.equal(recovered.agentSessionId, undefined);
  assert.equal(recovered.claudeSessionPrompted, false);
  assert.equal(recovered.claudeSessionDurable, false);
  assert.equal(await fixture.persist.getSession(id), undefined);
  assert.equal(runtime.calls.filter(([name]) => name === "resume").length, 1);
  assert.equal(runtime.calls.some(([name]) => name === "create"), false);

  await manager.sendMessage(id, "创建一个文件预览页面");
  await waitForStatus(fixture.store, id, "ready");
  const ready = await fixture.store.require(id);
  assert.equal(ready.agentSessionId, "claude-recreated");
  assert.equal(ready.claudeSessionPrompted, true);
  assert.equal(ready.claudeSessionDurable, true);
  assert.equal(runtime.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(runtime.calls.filter(([name]) => name === "prompt").length, 1);
  await manager.close();
});

test("已 durable 的 Claude ID 精确缺失时仍严格失败", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-durable-missing";
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-durable-missing",
    sandboxProviderId: "fc-e2b/sandbox-durable-missing",
    agentSessionId: "claude-durable-missing",
    claudeSessionDurable: true,
  });
  await fixture.persist.updateSession(
    sessionRecord(id, "claude-durable-missing", "fc-e2b/sandbox-durable-missing", "/home/user/workspace"),
  );
  const runtime = fakeSdk(
    "fc-e2b/sandbox-durable-missing",
    "claude-durable-missing",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
    { resume: async () => { throw resourceNotFound("claude-durable-missing"); } },
  );
  const manager = fixture.manager(async () => runtime.sdk);

  await assert.rejects(manager.prepare(id), /Claude 原生会话恢复失败/);

  const failed = await fixture.store.require(id);
  assert.equal(failed.agentSessionId, "claude-durable-missing");
  assert.equal(failed.claudeSessionDurable, true);
  assert.ok(await fixture.persist.getSession(id));
  assert.equal(runtime.calls.some(([name]) => name === "create"), false);
  await manager.close();
});

test("首轮 Prompt 未完成就回收沙箱时清理幽灵 Claude ID 并允许继续会话", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-prompted-missing";
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-prompted-missing",
    sandboxProviderId: "fc-e2b/sandbox-prompted-missing",
    agentSessionId: "claude-prompted-missing",
    claudeSessionPrompted: true,
    claudeSessionDurable: false,
  });
  await fixture.persist.updateSession(
    sessionRecord(id, "claude-prompted-missing", "fc-e2b/sandbox-prompted-missing", "/home/user/workspace"),
  );
  await fixture.persist.insertEvent(id, sessionPromptEvent(id, 1, "第一轮尚未完成"));
  const runtime = fakeSdk(
    "fc-e2b/sandbox-prompted-missing",
    "claude-prompted-missing",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
    { resume: async () => { throw resourceNotFound("claude-prompted-missing"); } },
  );
  const manager = fixture.manager(async () => runtime.sdk);

  const recovered = await manager.prepare(id);

  assert.equal(recovered.status, "ready");
  assert.equal(recovered.agentSessionId, undefined);
  assert.equal(recovered.claudeSessionPrompted, false);
  assert.equal(recovered.claudeSessionDurable, false);
  assert.equal(await fixture.persist.getSession(id), undefined);
  assert.equal(runtime.calls.some(([name]) => name === "create"), false);

  await manager.sendMessage(id, "从新沙箱继续");
  await waitForStatus(fixture.store, id, "ready");
  assert.equal((await fixture.store.require(id)).agentSessionId, "claude-prompted-missing");
  assert.equal(runtime.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(runtime.calls.filter(([name]) => name === "prompt").length, 1);
  await manager.close();
});

test("首轮 Prompt 已收到 ACP 响应时 Claude ID 精确缺失仍严格失败", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-prompt-response-missing";
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-prompt-response-missing",
    sandboxProviderId: "fc-e2b/sandbox-prompt-response-missing",
    agentSessionId: "claude-prompt-response-missing",
    claudeSessionPrompted: true,
    claudeSessionDurable: false,
  });
  await fixture.persist.updateSession(
    sessionRecord(id, "claude-prompt-response-missing", "fc-e2b/sandbox-prompt-response-missing", "/home/user/workspace"),
  );
  await fixture.persist.insertEvent(id, sessionPromptEvent(id, 1, "已经完成的第一轮"));
  await fixture.persist.insertEvent(id, agentResponseEvent(id, 2, 1));
  const runtime = fakeSdk(
    "fc-e2b/sandbox-prompt-response-missing",
    "claude-prompt-response-missing",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
    { resume: async () => { throw resourceNotFound("claude-prompt-response-missing"); } },
  );
  const manager = fixture.manager(async () => runtime.sdk);

  await assert.rejects(manager.prepare(id), /Claude 原生会话恢复失败/);

  const failed = await fixture.store.require(id);
  assert.equal(failed.agentSessionId, "claude-prompt-response-missing");
  assert.ok(await fixture.persist.getSession(id));
  assert.equal(runtime.calls.some(([name]) => name === "create"), false);
  await manager.close();
});

test("传输恢复后旧 prompt 的 finally 不会释放新一代 runtime 租约", async (t) => {
  const fixture = await createFixture(t, { runtimeIdleMs: 25 });
  const oldPrompt = deferred();
  const newPrompt = deferred();
  const first = fakeSdk("fc-e2b/sandbox-1", "claude-native-1", fixture.persist, oldPrompt.promise);
  const second = fakeSdk("fc-e2b/sandbox-1", "claude-native-1", fixture.persist, newPrompt.promise);
  const starts = [first.sdk, second.sdk];
  const manager = fixture.manager(async () => {
    const sdk = starts.shift();
    assert.ok(sdk, "不应创建第三代 runtime");
    return sdk;
  });

  await fixture.createBusinessSession("session-recovery");
  await manager.prepare("session-recovery");
  await manager.sendMessage("session-recovery", "第一轮");
  await waitForStatus(fixture.store, "session-recovery", "running");

  await manager.recoverTransportFailure(new Error("socket closed"));
  assert.equal((await fixture.store.require("session-recovery")).status, "failed");

  await manager.sendMessage("session-recovery", "恢复后的第二轮");
  await waitForStatus(fixture.store, "session-recovery", "running");
  assert.equal(second.calls.filter(([name]) => name === "resume").length, 1);

  oldPrompt.resolve({ stopReason: "end_turn" });
  await sleep(70);
  assert.equal(
    second.calls.filter(([name]) => name === "dispose").length,
    0,
    "旧 prompt 完成不能触发新 runtime 的 idle dispose",
  );
  assert.equal((await fixture.store.require("session-recovery")).status, "running");

  newPrompt.resolve({ stopReason: "end_turn" });
  await waitForStatus(fixture.store, "session-recovery", "ready");
  await sleep(70);
  assert.equal(second.calls.filter(([name]) => name === "dispose").length, 1);
  await manager.close();
});

test("创建中删除会先写墓碑并在获得 sandboxId 后回收远端沙箱", async (t) => {
  const fixture = await createFixture(t);
  const start = deferred();
  const prompt = deferred();
  const late = fakeSdk("fc-e2b/sandbox-late", "claude-late", fixture.persist, prompt.promise);
  let startRequested = false;
  const manager = fixture.manager(() => {
    startRequested = true;
    return start.promise;
  });

  await fixture.createBusinessSession("session-delete");
  const prepareOutcome = manager.prepare("session-delete").catch((error) => error);
  await waitUntil(() => startRequested, "runtime start 未开始");

  const deletePromise = manager.deleteSession("session-delete");
  await waitForStatus(fixture.store, "session-delete", "deleting");
  start.resolve(late.sdk);

  const deleted = await deletePromise;
  const prepareError = await prepareOutcome;
  assert.ok(prepareError instanceof Error);
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.sandboxId, undefined, "失效 runtime 不应把晚到 sandboxId 写回墓碑");
  assert.equal(deleted.pendingSandboxId, undefined);
  assert.ok(fixture.provider.destroyed.includes("sandbox-late"));
  await assert.rejects(manager.sendMessage("session-delete", "不应恢复"), /deleted/);
  assert.equal((await fixture.store.require("session-delete")).status, "deleted");
  await manager.close();
});

test("prompt 传输失败会主动失效坏连接并原生恢复同一 Claude session", async (t) => {
  const fixture = await createFixture(t);
  const failedPrompt = deferred();
  const recoveredPrompt = deferred();
  const first = fakeSdk("fc-e2b/sandbox-transport", "claude-transport", fixture.persist, failedPrompt.promise);
  const second = fakeSdk("fc-e2b/sandbox-transport", "claude-transport", fixture.persist, recoveredPrompt.promise);
  const starts = [first.sdk, second.sdk];
  const manager = fixture.manager(async () => {
    const sdk = starts.shift();
    assert.ok(sdk, "传输恢复不应创建第三代 runtime");
    return sdk;
  });

  await fixture.createBusinessSession("session-transport");
  await manager.prepare("session-transport");
  await manager.sendMessage("session-transport", "第一轮");
  await waitForStatus(fixture.store, "session-transport", "running");

  failedPrompt.reject(Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }));
  await waitForStatus(fixture.store, "session-transport", "failed");
  await manager.sendMessage("session-transport", "恢复后的第二轮");
  await waitForStatus(fixture.store, "session-transport", "running");

  assert.equal(first.calls.filter(([name]) => name === "dispose").length, 1);
  assert.equal(second.calls.filter(([name]) => name === "resume").length, 1);
  recoveredPrompt.resolve({ stopReason: "end_turn" });
  await waitForStatus(fixture.store, "session-transport", "ready");
  await manager.close();
});

test("恢复期间晚到的旧 runtime 会先回收且不会与新代并发创建", async (t) => {
  const fixture = await createFixture(t);
  const firstStart = deferred();
  const neverPrompt = deferred();
  const late = fakeSdk("fc-e2b/sandbox-orphan", "claude-orphan", fixture.persist, neverPrompt.promise);
  const current = fakeSdk("fc-e2b/sandbox-current", "claude-current", fixture.persist, neverPrompt.promise);
  let startCount = 0;
  const manager = fixture.manager(async () => {
    startCount += 1;
    return startCount === 1 ? firstStart.promise : current.sdk;
  });

  await fixture.createBusinessSession("session-pending-start");
  const oldPrepare = manager.prepare("session-pending-start").catch((error) => error);
  await waitUntil(() => startCount === 1, "第一代 runtime 未开始创建");
  await manager.recoverTransportFailure(new Error("connection reset"));

  const newPrepare = manager.prepare("session-pending-start");
  await sleep(30);
  assert.equal(startCount, 1, "旧 runtime 完成关闭前不应启动新一代");

  firstStart.resolve(late.sdk);
  const oldError = await oldPrepare;
  assert.ok(oldError instanceof Error);
  await newPrepare;

  assert.equal(startCount, 2);
  assert.equal(late.calls.filter(([name]) => name === "dispose").length, 1);
  assert.ok(fixture.provider.destroyed.includes("sandbox-orphan"));
  assert.equal((await fixture.store.require("session-pending-start")).sandboxId, "sandbox-current");
  await manager.close();
});

test("idle dispose 完成前新的请求不会并发 resume", async (t) => {
  const fixture = await createFixture(t, { runtimeIdleMs: 10 });
  const disposeGate = deferred();
  const first = fakeSdk("fc-e2b/sandbox-idle", "claude-idle", fixture.persist, Promise.resolve({ stopReason: "end_turn" }), {
    disposePromise: disposeGate.promise,
  });
  const second = fakeSdk("fc-e2b/sandbox-idle", "claude-idle", fixture.persist, Promise.resolve({ stopReason: "end_turn" }));
  const starts = [first.sdk, second.sdk];
  let startCount = 0;
  const manager = fixture.manager(async () => {
    startCount += 1;
    const sdk = starts.shift();
    assert.ok(sdk, "idle 恢复不应创建第三代 runtime");
    return sdk;
  });

  await fixture.createBusinessSession("session-idle-close");
  await manager.sendMessage("session-idle-close", "先创建 Claude 会话");
  await waitForStatus(fixture.store, "session-idle-close", "ready");
  await waitUntil(() => first.calls.some(([name]) => name === "dispose"), "idle dispose 未开始");

  const resumed = manager.prepare("session-idle-close");
  await sleep(30);
  assert.equal(startCount, 1, "旧 SDK 仍在 dispose 时不应开始 session/resume");
  disposeGate.resolve();
  await resumed;

  assert.equal(startCount, 2);
  assert.equal(second.calls.filter(([name]) => name === "resume").length, 1);
  await manager.close();
});

test("空会话的缓存 Runtime 被回收后首条消息会透明切换 replacement", async (t) => {
  const fixture = await createFixture(t, { oss: true });
  const id = "session-cached-runtime-missing";
  const ossPrefix = "/codeagent/v2/tenants/u/projects/p/sessions/session-cached-runtime-missing";
  await fixture.createBusinessSession(id, { ossPrefix });
  fixture.provider.nextSandboxIds.push("sandbox-old", "sandbox-new");

  const stale = fakeSdk(
    "fc-e2b/sandbox-old",
    "claude-stale",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
  );
  stale.sdk.createSession = async (request) => {
    stale.calls.push(["create", request]);
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  const replacement = fakeSdk(
    "fc-e2b/sandbox-new",
    "claude-new",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
  );
  const starts = [];
  const manager = fixture.manager(async ({ sandboxId }) => {
    starts.push(sandboxId);
    if (starts.length === 1) {
      assert.equal(sandboxId, "fc-e2b/sandbox-old");
      return stale.sdk;
    }
    if (starts.length === 2) {
      assert.equal(sandboxId, "fc-e2b/sandbox-old");
      throw { name: "SandboxNotFoundError", message: "sandbox old not found" };
    }
    assert.equal(sandboxId, "fc-e2b/sandbox-new");
    return replacement.sdk;
  });

  await manager.prepare(id);
  assert.equal((await fixture.store.require(id)).sandboxId, "sandbox-old");

  await manager.sendMessage(id, "创建一个待办应用");
  await waitForStatus(fixture.store, id, "ready");

  const ready = await fixture.store.require(id);
  assert.deepEqual(starts, [
    "fc-e2b/sandbox-old",
    "fc-e2b/sandbox-old",
    "fc-e2b/sandbox-new",
  ]);
  assert.deepEqual(fixture.provider.createCalls, [{ ossPrefix }, { ossPrefix }]);
  assert.equal(stale.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(stale.calls.filter(([name]) => name === "prompt").length, 0);
  assert.equal(replacement.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(replacement.calls.filter(([name]) => name === "prompt").length, 1);
  assert.equal(ready.sandboxId, "sandbox-new");
  assert.equal(ready.agentSessionId, "claude-new");
  assert.equal(ready.recoveryEpoch, 2);
  await manager.close();
});

test("死沙箱用同一 OSS prefix 创建 replacement，原生 resume 成功后才切换正式 sandbox", async (t) => {
  const fixture = await createFixture(t, { oss: true });
  const id = "session-oss-replacement";
  const ossPrefix = "/codeagent/v2/tenants/u/projects/p/sessions/session-oss-replacement";
  const workspaceRoot = "/mnt/codeagent-persist/workspace";
  await fixture.createBusinessSession(id, {
    sandboxId: "sandbox-old",
    sandboxProviderId: "fc-e2b/sandbox-old",
    agentSessionId: "claude-native-1",
    ossPrefix,
    workspaceRoot,
    claudeConfigDir: "/mnt/codeagent-persist/.claude",
  });
  await fixture.persist.updateSession(sessionRecord(id, "claude-native-1", "fc-e2b/sandbox-old", workspaceRoot));
  fixture.provider.nextSandboxIds.push("sandbox-new");

  const resumeGate = deferred();
  const prompt = deferred();
  const replacement = fakeSdk("fc-e2b/sandbox-new", "claude-native-1", fixture.persist, prompt.promise, {
    resume: () => resumeGate.promise,
  });
  const starts = [];
  const sandboxChanges = [];
  const manager = fixture.manager(async ({ sandboxId }) => {
    starts.push(sandboxId);
    if (sandboxId === "fc-e2b/sandbox-old") {
      throw { name: "SandboxNotFoundError", message: "sandbox old not found" };
    }
    assert.equal(sandboxId, "fc-e2b/sandbox-new");
    return replacement.sdk;
  }, {
    onSandboxIdChanged: (...args) => sandboxChanges.push(args),
  });

  const preparing = manager.prepare(id);
  await waitUntil(
    async () => (await fixture.store.require(id)).pendingSandboxId === "sandbox-new",
    "replacement 未进入 pending 状态",
  );
  const duringResume = await fixture.store.require(id);
  assert.equal(duringResume.sandboxId, "sandbox-old");
  assert.equal(duringResume.sandboxProviderId, "fc-e2b/sandbox-old");
  assert.equal(duringResume.pendingSandboxId, "sandbox-new");
  assert.equal((await fixture.persist.getSession(id)).sandboxId, "fc-e2b/sandbox-old");
  await waitUntil(() => starts.length === 2, "replacement runtime 尚未开始连接");
  assert.deepEqual(starts, ["fc-e2b/sandbox-old", "fc-e2b/sandbox-new"]);
  assert.deepEqual(fixture.provider.createCalls, [{ ossPrefix }]);

  resumeGate.resolve({});
  await preparing;
  const ready = await fixture.store.require(id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.sandboxId, "sandbox-new");
  assert.equal(ready.sandboxProviderId, "fc-e2b/sandbox-new");
  assert.equal(ready.pendingSandboxId, undefined);
  assert.equal(ready.agentSessionId, "claude-native-1");
  assert.equal((await fixture.persist.getSession(id)).sandboxId, "fc-e2b/sandbox-new");
  assert.equal(replacement.calls.some(([name]) => name === "create"), false);
  assert.equal(replacement.calls.filter(([name]) => name === "resume").length, 1);
  assert.deepEqual(sandboxChanges, [[id, "sandbox-old", "sandbox-new"]]);
  await manager.close();
});

test("非 OSS 空会话的沙箱丢失后首条消息会创建新沙箱", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-empty-sandbox-missing";
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-old",
    sandboxProviderId: "fc-e2b/sandbox-old",
  });
  const replacement = fakeSdk(
    "fc-e2b/sandbox-new",
    "claude-new",
    fixture.persist,
    Promise.resolve({ stopReason: "end_turn" }),
  );
  const starts = [];
  const manager = fixture.manager(async ({ sandboxId }) => {
    starts.push(sandboxId);
    if (sandboxId === "fc-e2b/sandbox-old") {
      throw { name: "SandboxNotFoundError", message: "sandbox old not found" };
    }
    assert.equal(sandboxId, undefined);
    return replacement.sdk;
  });

  await manager.sendMessage(id, "创建一个待办应用");
  await waitForStatus(fixture.store, id, "ready");

  const ready = await fixture.store.require(id);
  assert.deepEqual(starts, ["fc-e2b/sandbox-old", undefined]);
  assert.equal(ready.sandboxId, "sandbox-new");
  assert.equal(ready.sandboxProviderId, "fc-e2b/sandbox-new");
  assert.equal(ready.agentSessionId, "claude-new");
  assert.equal(ready.claudeSessionPrompted, true);
  assert.equal(ready.claudeSessionDurable, true);
  assert.equal(replacement.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(replacement.calls.filter(([name]) => name === "prompt").length, 1);
  await manager.close();
});

test("非 OSS 已 prompt 会话的沙箱丢失后不会静默创建新沙箱", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-prompted-sandbox-missing";
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-old",
    sandboxProviderId: "fc-e2b/sandbox-old",
    agentSessionId: "claude-old",
    claudeSessionPrompted: true,
  });
  await fixture.persist.insertEvent(id, sessionPromptEvent(id, 1, "之前的任务"));
  let starts = 0;
  const manager = fixture.manager(async ({ sandboxId }) => {
    starts += 1;
    assert.equal(sandboxId, "fc-e2b/sandbox-old");
    throw { name: "SandboxNotFoundError", message: "sandbox old not found" };
  });

  await assert.rejects(
    manager.sendMessage(id, "继续"),
    (error) => error?.name === "SandboxNotFoundError" && error?.message === "sandbox old not found",
  );

  const failed = await fixture.store.require(id);
  assert.equal(starts, 1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.sandboxId, "sandbox-old");
  assert.equal(failed.sandboxProviderId, "fc-e2b/sandbox-old");
  assert.equal(failed.agentSessionId, "claude-old");
  await manager.close();
});

test("普通 HTTP 404 不会被误判为死沙箱并创建 replacement", async (t) => {
  const fixture = await createFixture(t, { oss: true });
  const id = "session-route-404";
  await fixture.createBusinessSession(id, {
    sandboxId: "sandbox-old",
    sandboxProviderId: "fc-e2b/sandbox-old",
    agentSessionId: "claude-native-1",
    ossPrefix: "/codeagent/v2/tenants/u/projects/p/sessions/session-route-404",
  });
  const manager = fixture.manager(async () => {
    throw Object.assign(new Error("GET /v1/health: route not found"), { statusCode: 404 });
  });

  await assert.rejects(manager.prepare(id), /route not found/);
  assert.equal(fixture.provider.createCalls.length, 0);
  assert.deepEqual(fixture.provider.destroyed, []);
  const failed = await fixture.store.require(id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.sandboxId, "sandbox-old");
  assert.equal(failed.sandboxProviderId, "fc-e2b/sandbox-old");
  assert.equal(failed.pendingSandboxId, undefined);
  await manager.close();
});

test("replacement 原生 resume 失败时回收新沙箱并保留旧正式 ID", async (t) => {
  const fixture = await createFixture(t, { oss: true });
  const id = "session-resume-failed";
  const workspaceRoot = "/mnt/codeagent-persist/workspace";
  await fixture.createBusinessSession(id, {
    sandboxId: "sandbox-old",
    sandboxProviderId: "fc-e2b/sandbox-old",
    agentSessionId: "claude-native-1",
    ossPrefix: "/codeagent/v2/tenants/u/projects/p/sessions/session-resume-failed",
    workspaceRoot,
    claudeConfigDir: "/mnt/codeagent-persist/.claude",
  });
  await fixture.persist.updateSession(sessionRecord(id, "claude-native-1", "fc-e2b/sandbox-old", workspaceRoot));
  fixture.provider.nextSandboxIds.push("sandbox-new");
  const prompt = deferred();
  const replacement = fakeSdk("fc-e2b/sandbox-new", "claude-native-1", fixture.persist, prompt.promise, {
    resume: async () => {
      throw new Error("native session missing");
    },
  });
  const manager = fixture.manager(async ({ sandboxId }) => {
    if (sandboxId === "fc-e2b/sandbox-old") {
      throw { name: "SandboxNotFoundError", message: "sandbox old not found" };
    }
    return replacement.sdk;
  });

  await assert.rejects(manager.prepare(id), /Claude 原生会话恢复失败/);
  assert.deepEqual(fixture.provider.destroyed, ["sandbox-new"]);
  assert.equal(replacement.calls.filter(([name]) => name === "dispose").length, 1);
  const failed = await fixture.store.require(id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.sandboxId, "sandbox-old");
  assert.equal(failed.sandboxProviderId, "fc-e2b/sandbox-old");
  assert.equal(failed.pendingSandboxId, undefined);
  assert.equal(failed.agentSessionId, "claude-native-1");
  assert.equal((await fixture.persist.getSession(id)).sandboxId, "fc-e2b/sandbox-old");
  await manager.close();
});

test("replacement 回收遇到瞬时错误时保留 pendingSandboxId，避免遗忘仍在写 OSS 的候选沙箱", async (t) => {
  const cleanupError = Object.assign(new Error("FC cleanup temporarily unavailable"), { statusCode: 503 });
  const fixture = await createFixture(t, { oss: true, destroyError: cleanupError });
  const id = "session-cleanup-failed";
  const workspaceRoot = "/mnt/codeagent-persist/workspace";
  await fixture.createBusinessSession(id, {
    sandboxId: "sandbox-old",
    sandboxProviderId: "fc-e2b/sandbox-old",
    agentSessionId: "claude-native-1",
    ossPrefix: "/codeagent/v2/u/u/p/p/s/session-cleanup-failed",
  });
  await fixture.persist.updateSession(sessionRecord(id, "claude-native-1", "fc-e2b/sandbox-old", workspaceRoot));
  fixture.provider.nextSandboxIds.push("sandbox-new");
  const replacement = fakeSdk(
    "fc-e2b/sandbox-new",
    "claude-native-1",
    fixture.persist,
    deferred().promise,
    { resume: async () => { throw new Error("native session missing"); } },
  );
  const manager = fixture.manager(async ({ sandboxId }) => {
    if (sandboxId === "fc-e2b/sandbox-old") {
      throw { name: "SandboxNotFoundError", message: "sandbox old not found" };
    }
    return replacement.sdk;
  });

  await assert.rejects(manager.prepare(id), /Claude 原生会话恢复失败/);
  const failed = await fixture.store.require(id);
  assert.equal(failed.sandboxId, "sandbox-old");
  assert.equal(failed.pendingSandboxId, "sandbox-new");
  assert.match(failed.error, /candidate sandbox cleanup failed/);
  assert.deepEqual(fixture.provider.destroyed, ["sandbox-new"]);
  await manager.close();
});

test("OSS 布局配置变化后拒绝用新路径静默恢复旧会话", async (t) => {
  const fixture = await createFixture(t, { oss: true });
  const id = "session-layout-mismatch";
  await fixture.createBusinessSession(id, {
    ossPrefix: "/codeagent/v2/u/u/p/p/s/session-layout-mismatch",
    workspaceRoot: "/mnt/codeagent-persist/legacy-workspace",
  });
  let starts = 0;
  const manager = fixture.manager(async () => {
    starts += 1;
    throw new Error("must not start");
  });

  await assert.rejects(manager.prepare(id), /incompatible OSS layout/);
  assert.equal(starts, 0);
  assert.equal(fixture.provider.createCalls.length, 0);
  await manager.close();
});

test("远端删除失败时保留可见的 delete_failed 状态并允许重试", async (t) => {
  const fixture = await createFixture(t, {
    destroyError: Object.assign(new Error("FC kill temporarily unavailable"), { statusCode: 503 }),
  });
  const id = "session-delete-retry";
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-delete-retry",
    sandboxProviderId: "fc-e2b/sandbox-delete-retry",
  });
  const manager = fixture.manager(async () => { throw new Error("runtime should not start"); });

  await assert.rejects(manager.deleteSession(id), /FC kill temporarily unavailable/);
  const failed = await fixture.store.require(id);
  assert.equal(failed.status, "delete_failed");
  assert.equal(failed.sandboxId, "sandbox-delete-retry");
  assert.match(failed.error, /sandbox deletion failed/);
  assert.ok((await fixture.store.list()).some((session) => session.id === id));

  fixture.provider.destroyError = undefined;
  const deleted = await manager.deleteSession(id);
  assert.equal(deleted.status, "deleted");
  assert.equal((await fixture.store.list()).some((session) => session.id === id), false);
  await manager.close();
});

test("Preview manifest 只接受 FC 可公开端口并返回直连 origin", async (t) => {
  const fixture = await createFixture(t);
  const prompt = deferred();
  let manifest = { targetPort: 5173, healthPath: "/", projectRoot: "/home/user/workspace/app" };
  const sdk = fakeSdk("fc-e2b/sandbox-preview", "claude-preview", fixture.persist, prompt.promise, {
    readFsFile: async () => Buffer.from(JSON.stringify(manifest)),
  });
  const fetched = [];
  const manager = fixture.manager(async () => sdk.sdk, {
    previewFetch: async (url) => {
      fetched.push(String(url));
      return new Response("<html></html>", { status: 200 });
    },
  });

  await fixture.createBusinessSession("session-preview");
  const ready = await manager.getPreviewStatus("session-preview");
  assert.deepEqual(ready, {
    status: "ready",
    origin: "https://sandbox-preview-5173.example.test",
    port: 5173,
    projectRoot: "/home/user/workspace/app",
    updatedAt: undefined,
  });
  assert.deepEqual(fetched, ["https://sandbox-preview-5173.example.test/"]);

  manifest = { targetPort: 2999, healthPath: "/" };
  assert.deepEqual(await manager.getPreviewStatus("session-preview"), { status: "unavailable" });
  assert.equal(fetched.length, 1, "非法低端口不应访问 FC 公网入口");
  await manager.close();
});

test("replacement 沙箱丢失 Preview 进程后只发送一次隐藏恢复任务", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-preview-recovery";
  let published = false;
  const manifest = {
    targetPort: 5173,
    healthPath: "/",
    projectRoot: "/home/user/workspace/app",
    startCommand: "npm run dev -- --host 0.0.0.0 --port 5173",
  };
  const runtime = fakeSdk("fc-e2b/sandbox-preview-new", "claude-preview", fixture.persist, Promise.resolve(), {
    runProcess() {
      return { exitCode: 1, stdout: "", stderr: "start failed" };
    },
    onPrompt(parts) {
      assert.match(parts[0].text, /^\[CODEAGENT_INTERNAL_PREVIEW_RECOVERY\]/);
      published = true;
    },
    readFsFile: async () => {
      if (!published) throw Object.assign(new Error("preview manifest missing"), { code: "ENOENT" });
      return Buffer.from(JSON.stringify(manifest));
    },
  });
  const manager = fixture.manager(async () => runtime.sdk, {
    previewFetch: async () => new Response("<html></html>", { status: 200 }),
  });

  await fixture.persist.updateSession(sessionRecord(
    id,
    "claude-preview",
    "fc-e2b/sandbox-preview-new",
    "/home/user/workspace",
  ));
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-preview-new",
    sandboxProviderId: "fc-e2b/sandbox-preview-new",
    agentSessionId: "claude-preview",
    claudeSessionDurable: true,
    recoveryEpoch: 2,
    previewIntent: {
      desired: true,
      projectRoot: "/home/user/workspace/app",
      port: 5173,
      healthPath: "/",
      startCommand: "npm run dev -- --host 0.0.0.0 --port 5173",
      lastReadyAt: new Date(0).toISOString(),
      recoveryEpoch: 1,
      recoveryStatus: "ready",
    },
  });

  assert.equal((await manager.getPreviewStatus(id)).status, "recovering");
  await waitUntil(
    async () => {
      const intent = (await fixture.store.require(id)).previewIntent;
      return intent?.recoveryEpoch === 2 && intent.recoveryStatus === "ready";
    },
    "Preview 自动恢复未完成",
  );
  assert.equal(
    runtime.calls.filter(([name, request]) =>
      name === "runProcess" && request.cwd === "/home/user/workspace/app").length,
    1,
  );
  assert.equal(runtime.calls.filter(([name]) => name === "prompt").length, 1);
  assert.equal((await manager.getPreviewStatus(id)).status, "ready");
  assert.equal(runtime.calls.filter(([name]) => name === "prompt").length, 1, "轮询不应重复触发恢复 Prompt");
  await manager.close();
});

test("replacement 沙箱优先执行 preview.json 中的准确启动命令", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-preview-command-recovery";
  let published = false;
  const startCommand = "npm run dev -- --host 0.0.0.0 --port 5173";
  const manifest = {
    targetPort: 5173,
    healthPath: "/",
    projectRoot: "/home/user/workspace/app",
    startCommand,
  };
  const runtime = fakeSdk("fc-e2b/sandbox-preview-command", "claude-preview", fixture.persist, Promise.resolve(), {
    runProcess(request) {
      if (request.cwd !== "/home/user/workspace/app") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      assert.equal(request.cwd, "/home/user/workspace/app");
      assert.match(request.args[1], /codeagent-preview publish/);
      assert.ok(request.args[1].includes(startCommand));
      published = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readFsFile: async () => {
      if (!published) throw Object.assign(new Error("preview manifest missing"), { code: "ENOENT" });
      return Buffer.from(JSON.stringify(manifest));
    },
  });
  const manager = fixture.manager(async () => runtime.sdk, {
    previewFetch: async () => new Response("<html></html>", { status: 200 }),
  });

  await fixture.persist.updateSession(sessionRecord(
    id,
    "claude-preview",
    "fc-e2b/sandbox-preview-command",
    "/home/user/workspace",
  ));
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-preview-command",
    sandboxProviderId: "fc-e2b/sandbox-preview-command",
    agentSessionId: "claude-preview",
    claudeSessionDurable: true,
    recoveryEpoch: 2,
    previewIntent: {
      desired: true,
      projectRoot: "/home/user/workspace/app",
      port: 5173,
      healthPath: "/",
      startCommand,
      lastReadyAt: new Date(0).toISOString(),
      recoveryEpoch: 1,
      recoveryStatus: "ready",
    },
  });

  assert.equal((await manager.getPreviewStatus(id)).status, "recovering");
  await waitUntil(
    async () => {
      const intent = (await fixture.store.require(id)).previewIntent;
      return intent?.recoveryEpoch === 2 && intent.recoveryStatus === "ready";
    },
    "准确启动命令未完成 Preview 恢复",
  );
  assert.equal(
    runtime.calls.filter(([name, request]) =>
      name === "runProcess" && request.cwd === "/home/user/workspace/app").length,
    1,
  );
  assert.equal(runtime.calls.filter(([name]) => name === "prompt").length, 0);
  assert.equal((await manager.getPreviewStatus(id)).status, "ready");
  await manager.close();
});

test("旧 epoch 的 Preview 恢复不会阻止新沙箱重新恢复", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-preview-stale-recovery";
  const stalePrompt = deferred();
  let published = false;
  let recoveryPrompts = 0;
  const runtime = fakeSdk("fc-e2b/sandbox-preview-current", "claude-preview", fixture.persist, stalePrompt.promise, {
    prompt(parts) {
      if (!parts[0].text.startsWith("[CODEAGENT_INTERNAL_PREVIEW_RECOVERY]")) {
        return Promise.resolve({ stopReason: "end_turn" });
      }
      recoveryPrompts += 1;
      if (recoveryPrompts === 1) return stalePrompt.promise;
      published = true;
      return Promise.resolve({ stopReason: "end_turn" });
    },
    readFsFile: async () => {
      if (!published) throw Object.assign(new Error("preview manifest missing"), { code: "ENOENT" });
      return Buffer.from(JSON.stringify({
        targetPort: 5173,
        healthPath: "/",
        projectRoot: "/home/user/workspace/app",
      }));
    },
  });
  const manager = fixture.manager(async () => runtime.sdk, {
    previewFetch: async () => new Response("<html></html>", { status: 200 }),
  });

  await fixture.persist.updateSession(sessionRecord(
    id,
    "claude-preview",
    "fc-e2b/sandbox-preview-current",
    "/home/user/workspace",
  ));
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-preview-current",
    sandboxProviderId: "fc-e2b/sandbox-preview-current",
    agentSessionId: "claude-preview",
    claudeSessionDurable: true,
    recoveryEpoch: 1,
    previewIntent: {
      desired: true,
      projectRoot: "/home/user/workspace/app",
      port: 5173,
      healthPath: "/",
      lastReadyAt: new Date(0).toISOString(),
      recoveryEpoch: 0,
      recoveryStatus: "ready",
    },
  });

  assert.equal((await manager.getPreviewStatus(id)).status, "recovering");
  await waitUntil(
    () => runtime.calls.filter(([name]) => name === "prompt").length === 1,
    "旧 epoch 的 Preview 恢复未启动",
  );
  await fixture.store.update(id, (current) => ({ ...current, recoveryEpoch: 2 }));

  await manager.sendMessage(id, "优先处理用户消息");
  await waitForStatus(fixture.store, id, "ready");
  assert.equal(runtime.calls.filter(([name]) => name === "prompt").length, 2);
  assert.equal(runtime.calls.filter(([name]) => name === "prompt")[1][1][0].text, "优先处理用户消息");

  const visibleEvents = [];
  const unsubscribe = manager.subscribeEvents(id, (event) => visibleEvents.push(event));
  await fixture.persist.insertEvent(id, {
    ...sessionUpdateEvent(id, 999, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "用户消息可见" },
    }),
    connectionId: "connection-resumed",
  });
  unsubscribe();
  assert.equal(visibleEvents.length, 1, "旧恢复任务不应继续隐藏用户消息");

  assert.equal((await manager.getPreviewStatus(id)).status, "recovering");
  await waitUntil(
    () => runtime.calls.filter(([name]) => name === "prompt").length === 3,
    "新 epoch 被旧 Preview 恢复任务阻塞",
  );
  await waitUntil(
    async () => {
      const intent = (await fixture.store.require(id)).previewIntent;
      return intent?.recoveryEpoch === 2 && intent.recoveryStatus === "ready";
    },
    "新 epoch 的 Preview 自动恢复未完成",
  );

  stalePrompt.resolve({ stopReason: "cancelled" });
  await manager.close();
});

test("Preview 恢复 Prompt 超时后会取消并释放任务", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-preview-timeout";
  const prompt = deferred();
  const runtime = fakeSdk("fc-e2b/sandbox-preview-timeout", "claude-preview", fixture.persist, prompt.promise, {
    readFsFile: async () => {
      throw Object.assign(new Error("preview manifest missing"), { code: "ENOENT" });
    },
  });
  const manager = fixture.manager(async () => runtime.sdk, {
    previewRecoveryTimeoutMs: 25,
  });

  await fixture.persist.updateSession(sessionRecord(
    id,
    "claude-preview",
    "fc-e2b/sandbox-preview-timeout",
    "/home/user/workspace",
  ));
  await fixture.createBusinessSession(id, {
    status: "ready",
    sandboxId: "sandbox-preview-timeout",
    sandboxProviderId: "fc-e2b/sandbox-preview-timeout",
    agentSessionId: "claude-preview",
    claudeSessionDurable: true,
    recoveryEpoch: 1,
    previewIntent: {
      desired: true,
      projectRoot: "/home/user/workspace/app",
      port: 5173,
      healthPath: "/",
      lastReadyAt: new Date(0).toISOString(),
      recoveryEpoch: 0,
      recoveryStatus: "ready",
    },
  });

  assert.equal((await manager.getPreviewStatus(id)).status, "recovering");
  await waitUntil(
    async () => (await fixture.store.require(id)).previewIntent?.recoveryStatus === "failed",
    "Preview 恢复超时后未进入失败状态",
  );
  assert.equal(runtime.calls.filter(([name]) => name === "cancel").length, 1);
  assert.equal((await manager.getPreviewStatus(id)).status, "unavailable");

  prompt.resolve({ stopReason: "cancelled" });
  await manager.close();
});

test("事件 API 隐藏 Preview 内部恢复 Prompt 及其完整输出", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-preview-hidden-events";
  await fixture.createBusinessSession(id, { status: "ready" });
  const events = [
    sessionPromptEvent(id, 1, "创建一个页面"),
    sessionPromptEvent(id, 2, "[CODEAGENT_INTERNAL_PREVIEW_RECOVERY]\n恢复页面"),
    sessionUpdateEvent(id, 3, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在恢复" } }),
    sessionUpdateEvent(id, 4, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "启动服务" }),
    agentResponseEvent(id, 5, 2),
    sessionPromptEvent(id, 6, "继续修改页面"),
  ];
  for (const event of events) await fixture.persist.insertEvent(id, event);
  const manager = fixture.manager(async () => { throw new Error("不应连接 runtime"); });

  assert.deepEqual((await manager.listEvents(id, 0)).map((event) => event.eventIndex), [1, 6]);
  await manager.close();
});

test("SSE 实时订阅隐藏 Preview 恢复事件但不会吞掉后续用户对话", async (t) => {
  const fixture = await createFixture(t);
  const id = "session-preview-live-filter";
  await fixture.createBusinessSession(id, { status: "ready" });
  const manager = fixture.manager(async () => { throw new Error("不应连接 runtime"); });
  const visibleEvents = [];
  const unsubscribe = manager.subscribeEvents(id, (event) => visibleEvents.push(event));

  await fixture.persist.insertEvent(id, sessionPromptEvent(id, 1, "[CODEAGENT_INTERNAL_PREVIEW_RECOVERY]\n恢复页面"));
  await fixture.persist.insertEvent(id, sessionUpdateEvent(id, 2, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "内部恢复输出" },
  }));
  await fixture.persist.insertEvent(id, agentResponseEvent(id, 3, 1));
  await fixture.persist.insertEvent(id, sessionPromptEvent(id, 4, "真正的用户消息"));
  await fixture.persist.insertEvent(id, sessionUpdateEvent(id, 5, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "实时可见回复" },
  }));

  unsubscribe();
  assert.deepEqual(visibleEvents.map((event) => event.eventIndex), [4, 5]);
  await manager.close();
});

async function createFixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-manager-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const persist = new FileSessionPersistDriver(root);
  const store = new BusinessSessionStore(root);
  await persist.init();
  await store.init();
  const provider = {
    name: "fc-e2b",
    usesOss: Boolean(overrides.oss),
    destroyed: [],
    portUrls: [],
    createCalls: [],
    nextSandboxIds: [],
    destroyError: overrides.destroyError,
    async createForSession(context) {
      this.createCalls.push(structuredClone(context));
      const sandboxId = this.nextSandboxIds.shift();
      assert.ok(sandboxId, "测试未配置 replacement sandboxId");
      return sandboxId;
    },
    async destroy(sandboxId) {
      this.destroyed.push(sandboxId);
      if (this.destroyError) throw this.destroyError;
    },
    async getPortUrl(sandboxId, port) {
      this.portUrls.push([sandboxId, port]);
      return `https://${sandboxId}-${port}.example.test`;
    },
  };
  const workspaceRoot = overrides.oss ? "/mnt/codeagent-persist/workspace" : "/home/user/workspace";
  const claudeConfigDir = overrides.oss ? "/mnt/codeagent-persist/.claude" : "/home/user/.claude";
  const config = {
    host: "127.0.0.1",
    port: 8000,
    dataDir: root,
    webDistDir: root,
    workspaceRoot,
    claudeConfigDir,
    agentStateRoot: "/home/user/.codeagent",
    fc: {
      apiKey: "test",
      apiUrl: "https://api.example.test",
      domain: "example.test",
      region: "test",
      template: "template-test",
      agentPort: 3001,
      timeoutMs: 1_800_000,
      requestTimeoutMs: 5_000,
      runtimeIdleMs: overrides.runtimeIdleMs ?? 10_000,
      oss: {
        enabled: Boolean(overrides.oss),
        bucketName: "test-fc-sdx",
        endpoint: "http://oss.example.test",
        roleArn: "acs:ram::123:role/test",
        rootPrefix: "/codeagent/v2",
        mountDir: "/mnt/codeagent-persist",
        claudeConfigSubdir: ".claude",
        workspaceSubdir: "workspace",
      },
    },
    claude: {
      authToken: "test",
      baseUrl: "https://models.example.test",
      model: "test-model",
      sessionModel: "default",
      mode: "bypassPermissions",
      haikuModel: "test-model",
      sonnetModel: "test-model",
      opusModel: "test-model",
      subagentModel: "test-model",
    },
  };
  return {
    persist,
    store,
    provider,
    manager(startSandboxAgent, dependencies = {}) {
      return new AgentSessionManager(config, provider, persist, store, { startSandboxAgent, ...dependencies });
    },
    createBusinessSession(id, sessionOverrides = {}) {
      return store.create({
        id,
        runtimeProvider: "fc-e2b",
        userId: "user-1",
        projectId: "project-1",
        title: id,
        status: "creating",
        templateName: "template-test",
        workspaceRoot,
        claudeConfigDir,
        ...sessionOverrides,
        id,
      });
    },
  };
}

function fakeSdk(sandboxId, agentSessionId, persist, promptPromise, options = {}) {
  const calls = [];
  const session = {
    id: "",
    cwd: "",
    agent: "claude",
    agentSessionId,
    toRecord() {
      return {
        id: this.id,
        agent: this.agent,
        agentSessionId: this.agentSessionId,
        lastConnectionId: "connection-created",
        createdAt: Date.now(),
        sandboxId,
        sessionInit: { cwd: this.cwd, mcpServers: [] },
      };
    },
    onPermissionRequest() {
      return () => undefined;
    },
    async respondPermission() {},
    prompt(parts) {
      calls.push(["prompt", parts]);
      options.onPrompt?.(parts);
      return options.prompt?.(parts, calls.filter(([name]) => name === "prompt").length) ?? promptPromise;
    },
    async setMode(mode) {
      calls.push(["mode", mode]);
    },
    async setModel(model) {
      calls.push(["model", model]);
    },
  };
  const sdk = {
    sandboxId,
    async runProcess(request) {
      calls.push(["runProcess", request]);
      return options.runProcess?.(request) ?? { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFsFile(request) {
      calls.push(["readFsFile", request]);
      if (!options.readFsFile) throw new Error("readFsFile 未配置");
      return options.readFsFile(request);
    },
    async createSession(request) {
      calls.push(["create", request]);
      session.id = request.id;
      session.cwd = request.cwd;
      await persist.updateSession({
        id: request.id,
        agent: request.agent,
        agentSessionId,
        lastConnectionId: "connection-created",
        createdAt: Date.now(),
        sandboxId,
        sessionInit: { cwd: request.cwd, mcpServers: [] },
      });
      return session;
    },
    async getLiveConnection(agent) {
      calls.push(["live", agent]);
      return {
        connectionId: "connection-resumed",
        bindSession(localId, remoteId) {
          calls.push(["bind", localId, remoteId]);
        },
        acp: {
          async cancel(request) {
            calls.push(["cancel", request]);
          },
          async unstableResumeSession(request) {
            calls.push(["resume", request]);
            return options.resume ? options.resume(request) : {};
          },
        },
      };
    },
    upsertSessionHandle(record) {
      calls.push(["upsert", record]);
      session.id = record.id;
      return session;
    },
    async dispose() {
      calls.push(["dispose"]);
      if (options.disposePromise) await options.disposePromise;
    },
  };
  return { sdk, session, calls };
}

function sessionRecord(id, agentSessionId, sandboxId, cwd) {
  return {
    id,
    agent: "claude",
    agentSessionId,
    lastConnectionId: "connection-old",
    createdAt: Date.now(),
    sandboxId,
    sessionInit: { cwd, mcpServers: [] },
  };
}

function resourceNotFound(agentSessionId) {
  return Object.assign(new Error(`Resource not found: ${agentSessionId}`), {
    name: "AcpRpcError",
    code: -32002,
  });
}

function sessionNewEvent(sessionId, eventIndex) {
  return {
    id: `event-${eventIndex}`,
    eventIndex,
    sessionId,
    createdAt: Date.now(),
    connectionId: "connection-old",
    sender: "client",
    payload: {
      jsonrpc: "2.0",
      id: eventIndex,
      method: "session/new",
      params: { cwd: "/home/user/workspace", mcpServers: [] },
    },
  };
}

function sessionPromptEvent(sessionId, eventIndex, text) {
  return {
    id: `event-${eventIndex}`,
    eventIndex,
    sessionId,
    createdAt: Date.now(),
    connectionId: "connection-old",
    sender: "client",
    payload: {
      jsonrpc: "2.0",
      id: eventIndex,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text }] },
    },
  };
}

function sessionUpdateEvent(sessionId, eventIndex, update) {
  return {
    id: `event-${eventIndex}`,
    eventIndex,
    sessionId,
    createdAt: Date.now(),
    connectionId: "connection-old",
    sender: "agent",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { update },
    },
  };
}

function agentResponseEvent(sessionId, eventIndex, requestId) {
  return {
    id: `event-${eventIndex}`,
    eventIndex,
    sessionId,
    createdAt: Date.now(),
    connectionId: "connection-old",
    sender: "agent",
    payload: {
      jsonrpc: "2.0",
      id: requestId,
      result: { stopReason: "end_turn" },
    },
  };
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function waitForStatus(store, sessionId, expected) {
  await waitUntil(async () => (await store.require(sessionId)).status === expected, `状态未变为 ${expected}`);
}

async function waitUntil(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
