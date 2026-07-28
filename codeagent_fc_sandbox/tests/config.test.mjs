import assert from "node:assert/strict";
import test from "node:test";
import { assertConfig, fcApiUrl, fcDomain, loadConfig } from "../src/apps/api/dist/config.js";

test("客户配置 FC 地域和模型凭证，默认使用内置 base 模板", () => {
  withCleanEnvironment(() => {
    process.env.E2B_API_KEY = "customer-fc-key";
    process.env.FC_E2B_REGION = "cn-hangzhou";
    process.env.DASHSCOPE_API_KEY = "customer-model-key";
    process.env.DASHSCOPE_MODEL_NAME = "qwen-customer-model";
    process.env.BAILIAN_BASE_URL = "https://model.example.test/apps/anthropic";

    const config = loadConfig();
    assert.equal(config.fc.apiKey, "customer-fc-key");
    assert.equal(config.fc.region, "cn-hangzhou");
    assert.equal(config.fc.apiUrl, "https://api.cn-hangzhou.e2b.fc.aliyuncs.com");
    assert.equal(config.fc.domain, "cn-hangzhou.e2b.fc.aliyuncs.com");
    assert.equal(config.fc.template, "base");
    assert.match(config.fc.runtimeAssetsDir, /sandbox_image$/);
    assert.equal(config.fc.runtimeIdleMs, 600_000);
    assert.equal(config.fc.oss.enabled, false);
    assert.equal(config.workspaceRoot, "/home/user/workspace");
    assert.equal(config.claudeConfigDir, "/home/user/.claude");
    assert.equal(config.claude.authToken, "customer-model-key");
    assert.equal(config.claude.model, "qwen-customer-model");
    assert.equal(config.claude.baseUrl, "https://model.example.test/apps/anthropic");
    assert.doesNotThrow(() => assertConfig(config));
  });
});

test("启用 OSS 时使用独立挂载目录并校验必填配置", () => {
  withCleanEnvironment(() => {
    process.env.E2B_API_KEY = "customer-fc-key";
    process.env.DASHSCOPE_API_KEY = "customer-model-key";
    process.env.FC_OSS_PERSISTENCE_ENABLED = "true";
    process.env.FC_OSS_BUCKET = "customer-bucket";
    process.env.FC_OSS_ENDPOINT = "http://oss-cn-beijing-internal.aliyuncs.com";
    process.env.FC_OSS_ROLE_ARN = "acs:ram::123:role/CodeAgentRole";

    const config = loadConfig();
    assert.equal(config.fc.oss.enabled, true);
    assert.equal(config.fc.oss.bucketName, "customer-bucket");
    assert.equal(config.workspaceRoot, "/mnt/codeagent-persist/workspace");
    assert.equal(config.claudeConfigDir, "/mnt/codeagent-persist/.claude");
    assert.doesNotThrow(() => assertConfig(config));

    process.env.FC_OSS_BUCKET = "";
    assert.throws(() => assertConfig(loadConfig()), /FC_OSS_BUCKET/);
  });
});

test("缺少客户 FC 密钥时启动检查明确失败", () => {
  withCleanEnvironment(() => {
    process.env.DASHSCOPE_API_KEY = "customer-model-key";
    const config = loadConfig();
    assert.throws(() => assertConfig(config), /E2B_API_KEY/);
  });
});

test("FC E2B Endpoint 由地域确定", () => {
  assert.equal(fcApiUrl("cn-shanghai"), "https://api.cn-shanghai.e2b.fc.aliyuncs.com");
  assert.equal(fcDomain("cn-shanghai"), "cn-shanghai.e2b.fc.aliyuncs.com");
});

function withCleanEnvironment(run) {
  const names = [
    "E2B_API_KEY",
    "E2B_API_URL",
    "E2B_DOMAIN",
    "FC_E2B_REGION",
    "FC_E2B_TEMPLATE",
    "FC_RUNTIME_ASSETS_DIR",
    "FC_E2B_AGENT_PORT",
    "FC_RUNTIME_IDLE_MS",
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_MODEL_NAME",
    "BAILIAN_BASE_URL",
    "FC_OSS_PERSISTENCE_ENABLED",
    "FC_OSS_BUCKET",
    "FC_OSS_ENDPOINT",
    "FC_OSS_ROLE_ARN",
    "FC_OSS_ROOT_PREFIX",
    "FC_OSS_MOUNT_DIR",
    "FC_OSS_WORKSPACE_SUBDIR",
    "FC_OSS_CLAUDE_CONFIG_SUBDIR",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
