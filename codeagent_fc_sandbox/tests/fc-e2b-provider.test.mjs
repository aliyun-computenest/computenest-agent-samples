import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FcE2BSandboxProvider,
  isFcSandboxNotFoundError,
} from "../packages/fc-e2b-provider/dist/index.js";

const RUNTIME_ASSETS_DIR = fileURLToPath(new URL("../sandbox_image", import.meta.url));

test("create 使用公开直连配置并在服务就绪后返回沙箱", async () => {
  const calls = [];
  const sandbox = fakeSandbox("sandbox-created", calls);
  const client = fakeClient(calls, { create: sandbox });
  const fetchImpl = sequenceFetch(calls, [503, 200]);
  const provider = new FcE2BSandboxProvider({
    config: providerConfig(),
    client,
    fetchImpl,
  });

  const sandboxId = await provider.create();

  assert.equal(sandboxId, "sandbox-created");
  assert.deepEqual(calls.find(([name]) => name === "create"), [
    "create",
    "base",
    {
      apiKey: "e2b-test-key",
      apiUrl: "https://api.cn-hangzhou.e2b.fc.aliyuncs.com",
      domain: "cn-hangzhou.e2b.fc.aliyuncs.com",
      requestTimeoutMs: 4_321,
      timeoutMs: 123_456,
      secure: false,
      envs: {
        WORKSPACE: "/home/user/workspace",
        CLAUDE_CONFIG_DIR: "/home/user/.claude",
        CODEAGENT_STATE_ROOT: "/home/user/.codeagent",
        ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
        ANTHROPIC_MODEL: "qwen-max",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen-max",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen-max",
        CLAUDE_CODE_SUBAGENT_MODEL: "qwen-max",
        ANTHROPIC_AUTH_TOKEN: "anthropic-test-token",
        DASHSCOPE_API_KEY: "anthropic-test-token",
      },
    },
  ]);

  const command = calls.find(([name, value]) =>
    name === "run" && value.includes("SANDBOX_AGENT_PORT=4321"));
  assert.match(command[1], /SANDBOX_AGENT_PORT=4321/);
  assert.match(command[1], /sandbox-agent server --no-token --host 0\.0\.0\.0 --port 4321/);
  assert.deepEqual(command[2], {
    background: true,
    timeoutMs: 0,
    envs: {
      WORKSPACE: "/home/user/workspace",
      CLAUDE_CONFIG_DIR: "/home/user/.claude",
      CODEAGENT_STATE_ROOT: "/home/user/.codeagent",
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
      ANTHROPIC_MODEL: "qwen-max",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen-max",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen-max",
      CLAUDE_CODE_SUBAGENT_MODEL: "qwen-max",
      ANTHROPIC_AUTH_TOKEN: "anthropic-test-token",
      DASHSCOPE_API_KEY: "anthropic-test-token",
    },
  });
  assert.deepEqual(
    calls.filter(([name]) => name === "fetch").map(([, url]) => url),
    [
      "https://sandbox-created-4321.preview.test/v1/health",
      "https://sandbox-created-4321.preview.test/v1/health",
    ],
  );

  assert.equal(
    await provider.getPortUrl(sandboxId, 5173),
    "https://sandbox-created-5173.preview.test",
  );
  await assert.rejects(provider.getPortUrl(sandboxId, 2_999), /Invalid FC E2B port/);
  assert.equal(calls.filter(([name]) => name === "cancelBody").length, 2);
  assert.equal(await provider.getUrl(sandboxId), "https://sandbox-created-4321.preview.test");
  assert.equal(calls.some(([name]) => name === "connect"), false);
  assert.equal(calls.filter(([name]) => name === "write").length, 3);
  assert.match(
    calls.find(([name, value]) => name === "run" && value.includes("npm install -g"))[1],
    /registry\.npmmirror\.com/,
  );

  await provider.destroy(sandboxId);
  assert.equal(calls.filter(([name]) => name === "kill").length, 1);
});

test("connect 和 ensureServer 使用连接参数并分别识别健康状态与拉起服务", async () => {
  const calls = [];
  const sandbox = fakeSandbox("sandbox-existing", calls, { runtimeReady: true });
  const client = fakeClient(calls, { connect: sandbox });
  const fetchImpl = sequenceFetch(calls, [200, 503, 200]);
  const provider = new FcE2BSandboxProvider({
    config: providerConfig(),
    client,
    fetchImpl,
  });

  assert.equal(await provider.connect("sandbox-existing"), sandbox);
  assert.equal(calls.some(([name, value]) => name === "run" && value.includes("npm install -g")), false);

  await provider.ensureServer("sandbox-existing");

  assert.deepEqual(
    calls.filter(([name]) => name === "connect"),
    [
      ["connect", "sandbox-existing", connectionOptions()],
      ["connect", "sandbox-existing", connectionOptions()],
    ],
  );
  assert.equal(
    calls.filter(([name, value]) => name === "run" && value.includes("SANDBOX_AGENT_PORT=4321")).length,
    1,
  );
  assert.equal(calls.filter(([name]) => name === "fetch").length, 3);
  assert.equal(calls.filter(([name]) => name === "cancelBody").length, 3);
});

test("create 拉起服务失败时回收新沙箱并保留原始错误", async () => {
  const calls = [];
  const startupError = new Error("sandbox-agent start failed");
  const sandbox = fakeSandbox("sandbox-failed", calls, {
    run: async (command) => {
      if (command.includes("SANDBOX_AGENT_PORT=4321")) throw startupError;
    },
  });
  const client = fakeClient(calls, { create: sandbox });
  const provider = new FcE2BSandboxProvider({
    config: providerConfig(),
    client,
    fetchImpl: sequenceFetch(calls, [503]),
  });

  await assert.rejects(provider.create(), (error) => error === startupError);
  assert.equal(calls.filter(([name]) => name === "kill").length, 1);
  assert.equal(calls.filter(([name]) => name === "cancelBody").length, 1);

  await provider.destroy("sandbox-failed");
  assert.equal(calls.filter(([name]) => name === "connect").length, 1);
  assert.equal(calls.filter(([name]) => name === "kill").length, 2);
});

test("OSS 会话创建使用稳定独立前缀并把 FC metadata 序列化为字符串", async () => {
  const calls = [];
  const sandbox = fakeSandbox("sandbox-oss", calls);
  const config = {
    ...providerConfig(),
    workspaceRoot: "/mnt/codeagent-persist/workspace",
    claudeConfigDir: "/mnt/codeagent-persist/.claude",
    oss: {
      bucketName: "test-fc-sdx",
      endpoint: "http://oss-cn-beijing-internal.aliyuncs.com",
      roleArn: "acs:ram::123:role/AliyunFcDefaultRole",
      rootPrefix: "/codeagent/v2",
      mountDir: "/mnt/codeagent-persist",
    },
  };
  const provider = new FcE2BSandboxProvider({
    config,
    client: fakeClient(calls, { create: sandbox }),
    fetchImpl: sequenceFetch(calls, [200]),
  });
  const identity = { userId: "tenant/a", projectId: "project-1", sessionId: "session/a" };
  const prefix = provider.storagePrefixFor(identity);
  const collisionCandidate = provider.storagePrefixFor({ ...identity, sessionId: "session-a" });

  assert.equal(provider.storagePrefixFor(identity), prefix);
  assert.notEqual(collisionCandidate, prefix);
  assert.match(prefix, /^\/codeagent\/v2\/u\/.+\/p\/.+\/s\/.+$/);
  assert.ok(Buffer.byteLength(prefix) <= 128);
  assert.equal(await provider.createForSession({ ossPrefix: prefix }), "sandbox-oss");

  const options = calls.find(([name]) => name === "create")[2];
  assert.equal(typeof options.metadata["fc.sandbox.storage.oss"], "string");
  assert.deepEqual(JSON.parse(options.metadata["fc.sandbox.storage.oss"]), {
    mountPoints: [{
      bucketName: "test-fc-sdx",
      bucketPath: prefix,
      mountDir: "/mnt/codeagent-persist",
      endpoint: "http://oss-cn-beijing-internal.aliyuncs.com",
      readOnly: false,
    }],
  });
  assert.equal(options.metadata["fc.sandbox.auth.role"], "acs:ram::123:role/AliyunFcDefaultRole");
  assert.equal(options.envs.WORKSPACE, "/mnt/codeagent-persist/workspace");
  assert.equal(options.envs.CLAUDE_CONFIG_DIR, "/mnt/codeagent-persist/.claude");
  assert.equal(options.envs.FC_OSS_BUCKET_PATH, prefix);
  assert.equal(options.envs.FC_OSS_MOUNT_DIR, "/mnt/codeagent-persist");
  await assert.rejects(provider.create(), /immutable session context/);
  await assert.rejects(
    provider.createForSession({ ossPrefix: "/another-root/session" }),
    /must be below root prefix/,
  );
});

test("仅明确的 Sandbox NotFound 被识别为可替换", () => {
  assert.equal(isFcSandboxNotFoundError({ name: "SandboxNotFoundError", message: "sandbox missing" }), true);
  assert.equal(isFcSandboxNotFoundError({ code: "SandboxNotFound", message: "request failed" }), true);
  assert.equal(
    isFcSandboxNotFoundError(new Error("outer", {
      cause: Object.assign(new Error("sandbox old not found"), { statusCode: 404 }),
    })),
    true,
  );
  assert.equal(
    isFcSandboxNotFoundError(Object.assign(new Error("GET /v1/health: route not found"), { statusCode: 404 })),
    false,
  );
  assert.equal(
    isFcSandboxNotFoundError(Object.assign(new Error("control plane unavailable"), { statusCode: 503 })),
    false,
  );
  assert.equal(
    isFcSandboxNotFoundError(new Error("sandbox command terminated with exit code 137")),
    false,
  );
  assert.equal(isFcSandboxNotFoundError(new Error("sandbox old terminated")), false);
});

test("OSS workspace 与 Claude 配置目录必须是互不重叠的兄弟目录", () => {
  const base = {
    ...providerConfig(),
    workspaceRoot: "/mnt/codeagent-persist/workspace",
    claudeConfigDir: "/mnt/codeagent-persist/.claude",
    oss: {
      bucketName: "test-fc-sdx",
      endpoint: "http://oss-cn-beijing-internal.aliyuncs.com",
      roleArn: "acs:ram::123:role/test",
      rootPrefix: "/codeagent/v2",
      mountDir: "/mnt/codeagent-persist",
    },
  };
  assert.throws(
    () => new FcE2BSandboxProvider({
      config: { ...base, claudeConfigDir: base.workspaceRoot },
    }),
    /separate sibling trees/,
  );
  assert.throws(
    () => new FcE2BSandboxProvider({
      config: { ...base, claudeConfigDir: `${base.workspaceRoot}/.claude` },
    }),
    /separate sibling trees/,
  );
});

function providerConfig() {
  return {
    apiKey: "e2b-test-key",
    apiUrl: "https://api.cn-hangzhou.e2b.fc.aliyuncs.com",
    domain: "cn-hangzhou.e2b.fc.aliyuncs.com",
    template: "base",
    timeoutMs: 123_456,
    requestTimeoutMs: 4_321,
    runtimeAssetsDir: RUNTIME_ASSETS_DIR,
    workspaceRoot: "/home/user/workspace",
    claudeConfigDir: "/home/user/.claude",
    agentStateRoot: "/home/user/.codeagent",
    agentPort: 4_321,
    claude: {
      authToken: "anthropic-test-token",
      baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      model: "qwen-max",
      haikuModel: "qwen-flash",
      sonnetModel: "qwen-max",
      opusModel: "qwen-max",
      subagentModel: "qwen-max",
    },
  };
}

function connectionOptions() {
  return {
    apiKey: "e2b-test-key",
    apiUrl: "https://api.cn-hangzhou.e2b.fc.aliyuncs.com",
    domain: "cn-hangzhou.e2b.fc.aliyuncs.com",
    requestTimeoutMs: 4_321,
    timeoutMs: 123_456,
  };
}

function fakeClient(calls, handles) {
  return {
    async create(template, options) {
      calls.push(["create", template, options]);
      assert.ok(handles.create, "测试未配置 create 返回值");
      return handles.create;
    },
    async connect(sandboxId, options) {
      calls.push(["connect", sandboxId, options]);
      assert.ok(handles.connect ?? handles.create, "测试未配置 connect 返回值");
      return handles.connect ?? handles.create;
    },
  };
}

function fakeSandbox(sandboxId, calls, overrides = {}) {
  let runtimeReady = overrides.runtimeReady ?? false;
  return {
    sandboxId,
    commands: {
      async run(command, options) {
        calls.push(["run", command, options]);
        const overridden = overrides.run ? await overrides.run(command, options) : undefined;
        if (overridden) return overridden;
        if (command.startsWith("if test -f /home/user/.codeagent-runtime/")) {
          return commandResult(0, runtimeReady ? "ready" : "missing");
        }
        if (command.includes("touch /home/user/.codeagent-runtime/")) runtimeReady = true;
        return commandResult(0);
      },
    },
    files: {
      async write(path, data) {
        calls.push(["write", path, data.length]);
        return {};
      },
    },
    getHost(port) {
      calls.push(["getHost", port]);
      return `${sandboxId}-${port}.preview.test`;
    },
    async kill() {
      calls.push(["kill", sandboxId]);
      return true;
    },
  };
}

function commandResult(exitCode, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

function sequenceFetch(calls, statuses) {
  let index = 0;
  return async (url, options) => {
    calls.push(["fetch", url, options]);
    const status = statuses[index++];
    assert.notEqual(status, undefined, `意外的额外请求：${url}`);
    return new Response(new ReadableStream({
      cancel() {
        calls.push(["cancelBody", status]);
      },
    }), { status });
  };
}
